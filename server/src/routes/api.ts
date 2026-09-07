import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { formatPostcode, identify, toSuggestion, type ApiResult } from '@sw/shared';
import { config } from '../config';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { providers } from '../providers/registry';
import { autocompletePostcode } from '../providers/address/postcodesIo';
import {
  addressByUprn,
  addressesByPostcode,
  allLinesAtPremises,
  buildSiteReport,
  findLines,
  resolveQuery,
  searchAddresses,
  suggest,
} from '../services/resolve';

const startedAt = Date.now();

/** Wraps an async handler so rejections reach the error middleware. */
const handler =
  <T>(fn: (req: Request) => Promise<T>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await fn(req);
      res.json({ ok: true, data } satisfies ApiResult<T>);
    } catch (err) {
      next(err);
    }
  };

const searchSchema = z.object({
  q: z.string().trim().min(1, 'Enter something to search for').max(200),
  uprn: z.string().trim().regex(/^\d{1,12}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function apiRouter(): Router {
  const router = Router();

  // ---- Health / diagnostics -----------------------------------------
  router.get(
    '/health',
    handler(async () => {
      const cfg = config();
      const desc = providers().describe();
      const anyLive = Object.values(desc).some((p) => p.mode === 'live');
      return {
        status: cfg.dataMode === 'live' && !anyLive ? ('degraded' as const) : ('ok' as const),
        version: cfg.version,
        dataMode: cfg.dataMode,
        providers: desc,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      };
    }),
  );

  // ---- The one search box -------------------------------------------
  router.get(
    '/search',
    handler(async (req) => {
      const parsed = searchSchema.safeParse(req.query);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid search', parsed.error.issues);
      }
      const { q, uprn, limit } = parsed.data;
      return resolveQuery(q, { ...(uprn ? { uprn } : {}), ...(limit ? { limit } : {}) });
    }),
  );

  // ---- Typeahead ----------------------------------------------------
  router.get(
    '/suggest',
    handler(async (req) => {
      const q = String(req.query.q ?? '').trim();
      const limit = Number.parseInt(String(req.query.limit ?? '12'), 10) || 12;
      const result = await suggest(q, limit);

      // Partial postcodes get postcode-level completions so the user can get
      // to a full postcode without knowing it exactly.
      if (result.query.kind === 'address' && /^[a-z]{1,2}\d/i.test(q) && q.length <= 5) {
        const postcodes = await autocompletePostcode(q);
        return { ...result, postcodes: postcodes.slice(0, 8) };
      }
      return { ...result, postcodes: [] as string[] };
    }),
  );

  // ---- Addresses ----------------------------------------------------
  router.get(
    '/addresses',
    handler(async (req) => {
      const postcode = String(req.query.postcode ?? '').trim();
      const query = String(req.query.q ?? '').trim();
      if (postcode) {
        const list = await addressesByPostcode(formatPostcode(postcode));
        if (!list.length) throw notFound(`No premises found at ${formatPostcode(postcode)}.`);
        return { postcode: formatPostcode(postcode), addresses: list, suggestions: list.map(toSuggestion) };
      }
      if (query) {
        const list = await searchAddresses(query, 40);
        return { query, addresses: list, suggestions: list.map(toSuggestion) };
      }
      throw badRequest('Provide either ?postcode= or ?q=');
    }),
  );

  router.get(
    '/addresses/:uprn',
    handler(async (req) => {
      const uprn = String(req.params.uprn);
      const address = await addressByUprn(uprn);
      if (!address) throw notFound(`No premises found for UPRN ${uprn}.`);
      return address;
    }),
  );

  // ---- The full site report -----------------------------------------
  router.get(
    '/site/:uprn',
    handler(async (req) => {
      const uprn = String(req.params.uprn);
      const address = await addressByUprn(uprn);
      if (!address) throw notFound(`No premises found for UPRN ${uprn}.`);
      return buildSiteReport(address, identify(uprn));
    }),
  );

  // ---- Individual sections, for deep links and refresh --------------
  router.get(
    '/availability/:uprn',
    handler(async (req) => {
      const address = await addressByUprn(String(req.params.uprn));
      if (!address) throw notFound(`No premises found for UPRN ${req.params.uprn}.`);
      const report = await buildSiteReport(address, identify(String(req.params.uprn)), { includeSiblings: false });
      if (!report.broadband) throw notFound('No broadband availability data for this premises.');
      return report.broadband;
    }),
  );

  router.get(
    '/signal/:uprn',
    handler(async (req) => {
      const address = await addressByUprn(String(req.params.uprn));
      if (!address) throw notFound(`No premises found for UPRN ${req.params.uprn}.`);
      const report = await buildSiteReport(address, identify(String(req.params.uprn)), { includeSiblings: false });
      if (!report.signal) throw notFound('No mobile coverage data for this premises.');
      return report.signal;
    }),
  );

  // ---- Lines --------------------------------------------------------
  router.get(
    '/lines',
    handler(async (req) => {
      const q = String(req.query.q ?? '').trim();
      const uprn = String(req.query.uprn ?? '').trim();
      if (uprn) {
        const address = await addressByUprn(uprn);
        if (!address) throw notFound(`No premises found for UPRN ${uprn}.`);
        const { lines, status } = await allLinesAtPremises(address);
        return { address, lines, status, checkedAt: new Date().toISOString(), sources: ['registry'] };
      }
      if (!q) throw badRequest('Provide either ?q= (CLI, access line ID, service ID or ONT serial) or ?uprn=');

      const query = identify(q);
      const { lines, status } = await findLines(query);
      return {
        query,
        lines,
        status,
        ...(lines.length === 0
          ? { message: 'No line found for that identifier. It may belong to another provider or be archived.' }
          : {}),
        checkedAt: new Date().toISOString(),
        sources: ['registry'],
      };
    }),
  );

  // ---- Identifier classification, exposed for the UI chip -----------
  router.get(
    '/identify',
    handler(async (req) => identify(String(req.query.q ?? ''))),
  );

  return router;
}

/** Express error middleware — turns everything into the ApiResult envelope. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    // 300 is used internally to mean "ambiguous"; surface it as a 200 with
    // suggestions so the browser doesn't try to follow a redirect.
    const status = err.statusCode === 300 ? 200 : err.statusCode;
    res.status(status).json({ ok: false, error: err.toApiError() } satisfies ApiResult<never>);
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  if (config().env !== 'test') console.error('[netkit] unhandled error:', err);
  res.status(500).json({
    ok: false,
    error: { code: 'internal', message: config().env === 'production' ? 'Internal server error' : message },
  } satisfies ApiResult<never>);
}
