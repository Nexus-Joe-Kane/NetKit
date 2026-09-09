import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { formatPostcode, identify, toSuggestion, type ApiResult } from '@sw/shared';
import { config } from '../config';
import { badRequest, HttpError, notFound, rateLimited, uprnNotFound } from '../lib/errors';
import { consumeQuota, quotaState } from '../services/quota';
import { clearRecentLookups, recentLookups, recordLookup } from '../services/recents';
import { providers } from '../providers/registry';
import { findServices } from '../services/lookup';
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

/**
 * The fair-use budget, as a hook the resolver calls only when a lookup will
 * actually cost an upstream availability check.
 *
 * Zen are explicit that availability is not for bulk work, and the quota is
 * per account rather than per user — so one operator working through a list
 * of postcodes can spend everyone else's allowance. This makes that a refusal
 * with a number in it rather than a silent degradation later in the day.
 */
function availabilityBudget(req: Request): { budget: () => void } | Record<string, never> {
  const userId = req.user?.id;
  if (!userId) return {};
  return {
    budget: () => {
      const state = quotaState('availability', userId);
      if (!state.allowed) {
        throw rateLimited(
          `You have used your ${state.limit} premises lookups for today. The budget resets at midnight UTC — ask an administrator if you need it raised.`,
          { used: state.used, limit: state.limit },
        );
      }
      consumeQuota('availability', userId);
    },
  };
}

/**
 * Files a completed lookup in the user's recent list.
 *
 * Only called once a search actually landed on something, so a typo that
 * returned nothing does not clutter the list.
 */
function remember(req: Request, query: string, kind: string, report?: { address: { singleLine: string; postcode: string; uprn?: string } }): void {
  const userId = req.user?.id;
  if (!userId) return;
  recordLookup(userId, {
    query,
    kind,
    ...(report
      ? {
          label: report.address.singleLine,
          postcode: report.address.postcode,
          ...(report.address.uprn ? { uprn: report.address.uprn } : {}),
        }
      : {}),
  });
}

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
        // With no demo engine behind it, nothing live means nothing works.
        status: anyLive ? ('ok' as const) : ('degraded' as const),
        version: cfg.version,
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
      const result = await resolveQuery(q, {
        ...(uprn ? { uprn } : {}),
        ...(limit ? { limit } : {}),
        ...availabilityBudget(req),
      });
      // Only a lookup that resolved to a premises is worth remembering; a
      // postcode that returned a picker is still mid-question.
      if (result.report) remember(req, uprn ? result.report.address.singleLine : q, result.query.kind, result.report);
      return result;
    }),
  );

  // ---- Typeahead ----------------------------------------------------
  router.get(
    '/suggest',
    handler(async (req) => {
      const q = String(req.query.q ?? '').trim();
      const limit = Number.parseInt(String(req.query.limit ?? '12'), 10) || 12;

      /*
       * Premises and services, together.
       *
       * In parallel because they are independent and the box is being typed
       * into: making the address list wait for a supplier's inventory would
       * make the common case feel worse to fix the rarer one. Either failing
       * is a shorter list, not an error.
       */
      const [result, services] = await Promise.all([
        suggest(q, limit),
        findServices(q).catch(() => ({
          clients: [],
          broadband: [],
          mobile: [],
          broadbandNeedsIdentifier: false,
        })),
      ]);

      // Partial postcodes get postcode-level completions so the user can get
      // to a full postcode without knowing it exactly.
      const postcodes =
        result.query.kind === 'address' && /^[a-z]{1,2}\d/i.test(q) && q.length <= 5
          ? (await autocompletePostcode(q)).slice(0, 8)
          : ([] as string[]);

      return { ...result, postcodes, ...services };
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
      if (!address) throw uprnNotFound(uprn);
      return address;
    }),
  );

  // ---- The full site report -----------------------------------------
  router.get(
    '/site/:uprn',
    handler(async (req) => {
      const uprn = String(req.params.uprn);
      const address = await addressByUprn(uprn);
      if (!address) throw uprnNotFound(uprn);
      const report = await buildSiteReport(address, identify(uprn), availabilityBudget(req));
      remember(req, address.singleLine, 'uprn', report);
      return report;
    }),
  );

  // ---- Individual sections, for deep links and refresh --------------
  router.get(
    '/availability/:uprn',
    handler(async (req) => {
      const address = await addressByUprn(String(req.params.uprn));
      if (!address) throw uprnNotFound(String(req.params.uprn));
      const report = await buildSiteReport(address, identify(String(req.params.uprn)), {
        includeSiblings: false,
        ...availabilityBudget(req),
      });
      if (!report.broadband) throw notFound('No broadband availability data for this premises.');
      return report.broadband;
    }),
  );

  router.get(
    '/signal/:uprn',
    handler(async (req) => {
      const address = await addressByUprn(String(req.params.uprn));
      if (!address) throw uprnNotFound(String(req.params.uprn));
      const report = await buildSiteReport(address, identify(String(req.params.uprn)), {
        includeSiblings: false,
        ...availabilityBudget(req),
      });
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
        if (!address) throw uprnNotFound(uprn);
        const { lines, nearby, status } = await allLinesAtPremises(address);
        return {
          address,
          lines,
          ...(nearby.length ? { nearbyLines: nearby } : {}),
          status,
          checkedAt: new Date().toISOString(),
          sources: ['registry'],
        };
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

  // ---- Recent lookups, per user -------------------------------------
  router.get(
    '/recent',
    handler(async (req) => ({ recent: recentLookups(req.user?.id ?? '') })),
  );

  router.delete(
    '/recent',
    handler(async (req) => {
      clearRecentLookups(req.user?.id ?? '');
      return { cleared: true };
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
