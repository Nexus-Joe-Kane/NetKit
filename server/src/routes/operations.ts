import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { confirmMatches, formatPostcode, identify, normaliseCli, type ApiResult, type LineTestType } from '@sw/shared';
import { badRequest, forbidden, notFound, rateLimited } from '../lib/errors';
import { consumeQuota, refundQuota } from '../services/quota';
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

/**
 * The order payload.
 *
 * Every field that identifies the premises comes from an availability check
 * the operator already ran, so none of it is typed by hand — except
 * `confirmAddressLine`, which is typed by hand *on purpose*. See below.
 */
const placeOrderSchema = z.object({
  availabilityReference: z.string().trim().min(1, 'Run an availability check first.').max(120),
  productCode: z.string().trim().min(1, 'Pick a product.').max(64),
  productName: z.string().trim().max(200).optional(),
  goldAddressKey: z.string().trim().min(1, 'The premises has no Gold Address Key.').max(64),
  districtCode: z.string().trim().max(16).default(''),
  uprn: z.string().trim().regex(/^\d{1,12}$/, 'A UPRN is up to 12 digits.').optional(),
  addressLine: z.string().trim().min(1).max(300),
  postcode: z.string().trim().min(5).max(10),
  phoneNumber: z.string().trim().max(40).optional(),
  accessLineId: z.string().trim().max(64).optional(),
  ontSerialNumber: z.string().trim().max(64).optional(),
  workingLineTakeover: z.boolean().optional(),
  appointmentToken: z.string().trim().max(400).optional(),
  contractTermMonths: z.coerce.number().int().min(1).max(60).optional(),
  preferredActivationDate: z.string().trim().max(40).optional(),
  customerReference: z.string().trim().max(120).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactNumber: z.string().trim().max(40).optional(),
  contactEmail: z.string().trim().email().max(320).optional(),
  notes: z.string().trim().max(2000).optional(),
  /**
   * The operator retypes the first line of the address before the order goes.
   * The same guard the user-removal dialog uses, for the same reason: an
   * order to the wrong premises costs money, books an engineer and is slow
   * and embarrassing to unwind. Ticking a box does not make anyone read.
   */
  confirmAddressLine: z.string().trim().min(1, 'Retype the address to confirm the order.').max(300),
});

/**
 * Registering an Openreach address.
 *
 * Thoroughfare and post town are required because Openreach reject anything
 * without them, and a building name *or* number is required because an
 * address with neither identifies a street rather than a premises.
 */
const registerAddressSchema = z
  .object({
    postcode: z.string().trim().min(5).max(10),
    buildingName: z.string().trim().max(120).optional(),
    buildingNumber: z.string().trim().max(20).optional(),
    thoroughfare: z.string().trim().min(2, 'Give the street name.').max(160),
    postTown: z.string().trim().min(2, 'Give the post town.').max(80),
    county: z.string().trim().max(80).optional(),
    uprn: z.string().trim().regex(/^\d{1,12}$/, 'A UPRN is up to 12 digits.').optional(),
  })
  .refine((v) => Boolean(v.buildingName?.trim() || v.buildingNumber?.trim()), {
    message: 'Give a building name or a building number — a street on its own is not a premises.',
    path: ['buildingNumber'],
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

  /**
   * Why the "place order" button is or is not available. The UI reads this
   * before showing the flow, so the reason is on screen rather than in a
   * disabled tooltip.
   */
  router.get(
    '/orders/gate',
    handler(async (req) => ops.orderingGate(req.user?.id ?? '')),
  );

  /**
   * Places a real order. The only endpoint in NetKit that spends money.
   *
   * Five guards, in order: the environment flag, the admin switch, the
   * per-user daily cap, the retyped address, and an audit line written
   * *before* the call as well as after — so a request that vanishes still
   * leaves evidence of what was attempted.
   */
  router.post(
    '/orders',
    handler(async (req) => {
      const parsed = placeOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? 'The order is incomplete.', parsed.error.issues);
      }
      const { confirmAddressLine, ...request } = parsed.data;
      const userId = req.user?.id ?? '';

      const gate = ops.orderingGate(userId);
      if (!gate.allowed) {
        // The cap is a rate limit; the switches are a permission.
        throw gate.usedToday >= gate.dailyCap && gate.dailyCap > 0
          ? rateLimited(gate.reason ?? 'Your daily order limit has been reached.', gate)
          : forbidden(gate.reason ?? 'Ordering is not enabled.', gate);
      }

      if (!confirmMatches(confirmAddressLine, request.addressLine)) {
        throw badRequest(
          `That does not match the address on the order. Retype it exactly: "${request.addressLine}"`,
        );
      }

      // Charged before the call, not after. If the request is the one that
      // hangs, the budget has still been spent — which is the safe direction
      // for a cap whose whole job is to stop a loop. A rehearsal with no
      // credentials spends nothing, so it costs nothing.
      if (!gate.demo) consumeQuota('order', userId);

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'order.submitting',
        detail: {
          ...request,
          ...(gate.demo
            ? { demo: true, note: 'No provider credentials — nothing will be sent.' }
            : { ordersToday: gate.usedToday + 1, dailyCap: gate.dailyCap }),
        },
        ip: req.ip,
      });

      const result = await ops.placeOrder(request);

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: result.data.accepted ? 'order.placed' : 'order.rejected',
        detail: {
          productCode: request.productCode,
          addressLine: request.addressLine,
          postcode: request.postcode,
          mode: result.mode,
          accepted: result.data.accepted,
          ...(result.data.zenReference ? { zenReference: result.data.zenReference } : {}),
          ...(result.data.messages ? { messages: result.data.messages } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        ip: req.ip,
      });

      // A rejection that the provider explicitly returned created nothing, so
      // the cap gives the unit back. An *unconfirmed* failure does not: the
      // order may well have landed, and re-trying is the wrong instinct.
      if (!gate.demo && !result.data.accepted && !result.error) refundQuota('order', userId);

      return {
        ...result.data,
        mode: result.mode,
        gate: ops.orderingGate(userId),
        ...(result.error ? { providerError: result.error } : {}),
      };
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

  /* ---- Address references ------------------------------------------ */

  router.get(
    '/tools/address-match',
    handler(async (req) => {
      const postcode = String(req.query.postcode ?? '').trim();
      if (!postcode) throw badRequest('Provide ?postcode=');
      const result = await ops.addressMatch({
        postcode: formatPostcode(postcode),
        ...(String(req.query.postTown ?? '').trim() ? { postTown: String(req.query.postTown).trim() } : {}),
        ...(String(req.query.premiseName ?? '').trim() ? { premiseName: String(req.query.premiseName).trim() } : {}),
        ...(String(req.query.thoroughfareNumber ?? '').trim()
          ? { thoroughfareNumber: String(req.query.thoroughfareNumber).trim() }
          : {}),
      });
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /**
   * Registers a premises with Openreach.
   *
   * A write against the national address database, so it is audited — an
   * address key created in error is a support call for someone else later.
   */
  router.post(
    '/tools/address-register',
    handler(async (req) => {
      const parsed = registerAddressSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? 'The address is incomplete.', parsed.error.issues);
      }
      const request = { ...parsed.data, postcode: formatPostcode(parsed.data.postcode) };

      const result = await ops.registerAddress(request);
      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: result.data.created ? 'address.registered' : 'address.register_failed',
        detail: {
          ...request,
          mode: result.mode,
          ...(result.data.addressReference ? { addressReference: result.data.addressReference } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        ip: req.ip,
      });
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Service history --------------------------------------------- */

  router.get(
    '/diagnostics/:zenReference/history',
    handler(async (req) => {
      const result = await ops.serviceHistory(String(req.params.zenReference));
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Provider notifications -------------------------------------- */

  router.get(
    '/network/notifications',
    handler(async (req) => {
      const searchTerm = String(req.query.q ?? '').trim();
      const days = Number.parseInt(String(req.query.days ?? ''), 10);
      const since = Number.isFinite(days) && days > 0
        ? new Date(Date.now() - days * 86_400_000).toISOString()
        : undefined;
      const result = await ops.notifications({
        ...(searchTerm ? { searchTerm } : {}),
        ...(since ? { since } : {}),
      });
      return {
        notifications: result.data,
        mode: result.mode,
        ...(result.error ? { providerError: result.error } : {}),
        checkedAt: new Date().toISOString(),
      };
    }),
  );

  /* ---- Network management ------------------------------------------ */

  router.get(
    '/tools/network-config',
    handler(async (req) => {
      const zenReference = String(req.query.zenReference ?? '').trim() || undefined;
      const result = await ops.networkConfiguration(zenReference);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Company context --------------------------------------------- */

  router.get(
    '/tools/companies',
    handler(async (req) => {
      const postcode = String(req.query.postcode ?? '').trim();
      if (!postcode) throw badRequest('Provide ?postcode=');
      const result = await ops.companies(formatPostcode(postcode));
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  /* ---- Estate-wide usage ------------------------------------------- */

  router.get(
    '/tools/estate-usage',
    handler(async (req) => {
      const period = String(req.query.period ?? '').trim();
      if (period && !/^\d{4}-\d{2}$/.test(period)) throw badRequest('A period looks like 2026-09.');
      const result = await ops.estateUsage(period || undefined);
      return { ...result.data, mode: result.mode, ...(result.error ? { providerError: result.error } : {}) };
    }),
  );

  return router;
}
