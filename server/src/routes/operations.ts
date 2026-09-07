import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { formatPostcode, identify, normaliseCli, type ApiResult, type LineTestType } from '@sw/shared';
import { badRequest, notFound } from '../lib/errors';
import { addressByUprn, addressesByPostcode } from '../services/resolve';
import * as ops from '../services/operations';
import { audit } from '../auth/store';

/**
 * Operational routes: network status, faults, diagnostics, orders, SIMs and
 * the standalone tools.
 *
 * Everything that changes state — raising a fault, requesting a profile
 * change, cancelling an order — is audited with the acting user.
 */

const handler =
  <T>(fn: (req: Request) => Promise<T>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json({ ok: true, data: await fn(req) } satisfies ApiResult<T>);
    } catch (err) {
      next(err);
    }
  };

const TEST_TYPES = ['linetest', 'xdsltest', 'tamtest', 'kbdtest', 'servicetest', 'profilechange'] as const;

const raiseFaultSchema = z.object({
  zenReference: z.string().trim().min(1, 'A service reference is required.').max(64),
  category: z.enum(['synchronisation', 'performance', 'authentication', 'voice', 'other']),
  frequency: z.enum(['intermittent', 'permanent']),
  summary: z.string().trim().min(10, 'Describe the fault in at least a sentence.').max(1000),
  testsCarriedOut: z.string().trim().max(2000).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactNumber: z.string().trim().max(40).optional(),
  contactEmail: z.string().trim().email().max(320).optional(),
  siteNotes: z.string().trim().max(2000).optional(),
  hazardNotes: z.string().trim().max(2000).optional(),
});

/** Pulls a phone number out of a query string, normalised. */
function requireCli(raw: unknown, field = 'q'): string {
  const value = String(raw ?? '').trim();
  if (!value) throw badRequest(`Provide a phone number in ?${field}=`);
  const normalised = normaliseCli(value);
  if (!normalised) throw badRequest(`"${value}" is not a valid UK phone number.`);
  return normalised;
}

export function operationsRouter(): Router {
  const router = Router();

  /* ---- Network status --------------------------------------------- */

  router.get(
    '/network/status',
    handler(async (req) => {
      const past = String(req.query.past ?? '') === 'true';
      const result = await ops.networkStatus({ past });
      return {
        ...result.data,
        mode: result.mode,
        ...(result.error ? { providerError: result.error } : {}),
        checkedAt: new Date().toISOString(),
      };
    }),
  );

  router.get(
    '/network/status/:zenReference',
    handler(async (req) => {
      const result = await ops.outagesForService(String(req.params.zenReference));
      return { outages: result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Faults ------------------------------------------------------ */

  router.get(
    '/faults',
    handler(async (req) => {
      const state = String(req.query.state ?? 'open') === 'closed' ? 'closed' : 'open';
      const zenReference = String(req.query.zenReference ?? '').trim();
      const result = await ops.faults({ state, ...(zenReference ? { zenReference } : {}) });
      return { faults: result.data, state, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.post(
    '/faults',
    handler(async (req) => {
      const parsed = raiseFaultSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid fault details.');

      const result = await ops.raiseFault(parsed.data);
      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'fault.raised',
        detail: {
          zenReference: parsed.data.zenReference,
          category: parsed.data.category,
          reference: result.data.reference,
          mode: result.mode,
        },
        ip: req.ip,
      });
      return { fault: result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Diagnostics ------------------------------------------------- */

  router.get(
    '/diagnostics/:zenReference/tests',
    handler(async (req) => {
      const technology = String(req.query.technology ?? '') || undefined;
      const result = await ops.availableTests(String(req.params.zenReference), technology);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/diagnostics/:zenReference/tests/:type',
    handler(async (req) => {
      const type = String(req.params.type);
      if (!TEST_TYPES.includes(type as (typeof TEST_TYPES)[number])) {
        throw badRequest(`Unknown test type "${type}". Expected one of: ${TEST_TYPES.join(', ')}`);
      }
      const technology = String(req.query.technology ?? '') || undefined;
      const result = await ops.latestTest(String(req.params.zenReference), type as LineTestType, technology);
      return { result: result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.post(
    '/diagnostics/:zenReference/tests/:type',
    handler(async (req) => {
      const type = String(req.params.type);
      if (!TEST_TYPES.includes(type as (typeof TEST_TYPES)[number])) {
        throw badRequest(`Unknown test type "${type}".`);
      }
      const zenReference = String(req.params.zenReference);
      const technology = String((req.body as { technology?: string })?.technology ?? '') || undefined;

      const result = await ops.runTest(zenReference, type as LineTestType, technology);
      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'diagnostics.test_run',
        detail: { zenReference, type, outcome: result.data.outcome, mode: result.mode },
        ip: req.ip,
      });
      return { result: result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/diagnostics/:zenReference/profile',
    handler(async (req) => {
      const result = await ops.profileOptions(String(req.params.zenReference));
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.post(
    '/diagnostics/:zenReference/profile',
    handler(async (req) => {
      const zenReference = String(req.params.zenReference);
      const profileCode = String((req.body as { profileCode?: string })?.profileCode ?? '').trim();
      if (!profileCode) throw badRequest('Provide { "profileCode": "…" }.');

      const result = await ops.requestProfileChange(zenReference, profileCode);
      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'diagnostics.profile_change',
        detail: { zenReference, profileCode, mode: result.mode },
        ip: req.ip,
      });
      return { result: result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/diagnostics/:zenReference/stability',
    handler(async (req) => {
      const days = Math.min(90, Math.max(7, Number.parseInt(String(req.query.days ?? '30'), 10) || 30));
      const result = await ops.stability(String(req.params.zenReference), days);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/diagnostics/:zenReference/usage',
    handler(async (req) => {
      const raw = String(req.query.period ?? 'current_month');
      const period = raw === 'day' || raw === 'month' ? raw : 'current_month';
      const result = await ops.usage(String(req.params.zenReference), period);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Orders ------------------------------------------------------ */

  router.get(
    '/orders',
    handler(async (req) => {
      const searchTerm = String(req.query.q ?? '').trim();
      const raw = String(req.query.view ?? 'status');
      const view = raw === 'wip' || raw === 'search' ? raw : 'status';
      const result = await ops.orders({ ...(searchTerm ? { searchTerm } : {}), view });
      return { orders: result.data, view, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.post(
    '/orders/:zenReference/cancel',
    handler(async (req) => {
      const zenReference = String(req.params.zenReference);
      const reason = String((req.body as { reason?: string })?.reason ?? '').trim();
      if (reason.length < 5) throw badRequest('Give a reason for the cancellation.');

      const result = await ops.cancelOrder(zenReference, reason);
      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'order.cancelled',
        detail: { zenReference, reason, mode: result.mode },
        ip: req.ip,
      });
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/orders/pricing',
    handler(async (req) => {
      const productCode = String(req.query.productCode ?? '').trim();
      if (!productCode) throw badRequest('Provide ?productCode=');
      const productName = String(req.query.productName ?? '').trim() || undefined;
      const result = await ops.pricing(productCode, productName);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/orders/appointments',
    handler(async (req) => {
      const availabilityReference = String(req.query.availabilityReference ?? '').trim();
      const productCode = String(req.query.productCode ?? '').trim();
      const goldAddressKey = String(req.query.goldAddressKey ?? '').trim();
      const districtCode = String(req.query.districtCode ?? '').trim();
      if (!availabilityReference || !productCode) {
        throw badRequest('An availability reference and product code are required — run an availability check first.');
      }
      const result = await ops.appointments({ availabilityReference, productCode, goldAddressKey, districtCode });
      return { slots: result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- SIMs -------------------------------------------------------- */

  router.get(
    '/sims',
    handler(async () => {
      const result = await ops.simEstate();
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Tools ------------------------------------------------------- */

  router.get(
    '/tools/number-port',
    handler(async (req) => {
      const cli = requireCli(req.query.q);
      const result = await ops.numberPortCheck(cli);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/tools/connectivity',
    handler(async (req) => {
      const cli = requireCli(req.query.q);
      const result = await ops.networkConnectivity(cli);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/tools/imei',
    handler(async (req) => {
      const cli = requireCli(req.query.q);
      const result = await ops.imeiLookup(cli);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/tools/footfall',
    handler(async (req) => {
      const raw = String(req.query.q ?? '').trim();
      const parsed = identify(raw);
      if (parsed.kind !== 'postcode') throw badRequest('Provide a full UK postcode.');
      const postcode = formatPostcode(parsed.normalised);
      const result = await ops.footfall(postcode);
      return {
        ...result.data,
        // BT's product is London-only, so warn rather than return a blank.
        ...(ops.isLikelyLondon(postcode) ? {} : { outOfArea: true }),
        mode: result.mode,
        ...(result.error ? { providerError: result.error } : {}),
      };
    }),
  );

  router.get(
    '/tools/ethernet',
    handler(async (req) => {
      const uprn = String(req.query.uprn ?? '').trim();
      const postcodeRaw = String(req.query.postcode ?? '').trim();

      const address = uprn
        ? await addressByUprn(uprn)
        : postcodeRaw
          ? (await addressesByPostcode(formatPostcode(postcodeRaw)))[0]
          : null;
      if (!address) throw notFound('Could not resolve that address. Provide ?uprn= or ?postcode=');

      const result = await ops.ethernetQuotes(address);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  router.get(
    '/tools/cdrs',
    handler(async (req) => {
      // Zen limits the window to two days, so the default is one.
      const to = req.query.to ? new Date(String(req.query.to)) : new Date();
      const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 86_400_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('Invalid from/to date.');
      if (to.getTime() - from.getTime() > 2 * 86_400_000) {
        throw badRequest('Zen limits call record queries to a two-day window.');
      }

      const result = await ops.callRecords(from, to);
      return {
        records: result.data,
        from: from.toISOString(),
        to: to.toISOString(),
        mode: result.mode,
        ...(result.error ? { providerError: result.error } : {}),
      };
    }),
  );

  router.get(
    '/tools/rdns',
    handler(async (req) => {
      const zenReference = String(req.query.zenReference ?? '').trim() || undefined;
      const result = await ops.rdns(zenReference);
      return { records: result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  return router;
}
