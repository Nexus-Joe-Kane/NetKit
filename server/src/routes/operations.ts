import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  HOUSE_CONTACT,
  confirmMatches,
  faultRaisedNote,
  formatPostcode,
  identify,
  lineTestNote,
  normaliseCli,
  parseBulkInput,
  siteVisitBookedMessage,
  type ApiResult,
  type LineTestType,
} from '@sw/shared';
import { comment, siteContactsForTicket, zendeskConfigured } from '../providers/tickets/zendesk';
import { badRequest, forbidden, notConfigured, notFound, rateLimited, uprnNotFound } from '../lib/errors';
import { consumeQuota, refundQuota } from '../services/quota';
import { addressByUprn, addressesByPostcode, buildSiteReport } from '../services/resolve';
import * as ops from '../services/operations';
import { audit } from '../auth/store';
import { runBulkLookup } from '../services/bulk';
import { addWatch, listWatches, removeWatch } from '../services/watches';

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

/**
 * Leaves a note on a customer's ticket, without letting it break the thing
 * it is a note about.
 *
 * A fault raised with a supplier cannot be un-raised, and a line test has
 * already run. If Zendesk is down, or the ticket number was a typo, the
 * answer is to say so on the response rather than to fail a request whose
 * real work already succeeded — an operator who sees an error assumes the
 * fault was not raised and raises it again.
 */
interface TicketNoteOutcome {
  attempted: boolean;
  posted: boolean;
  ticketId?: string;
  url?: string;
  ccEmails?: string[];
  error?: string;
}

async function noteOnTicket(input: {
  ticketId?: string;
  body: string;
  visibility: 'private' | 'public';
  ccEmails?: string[];
}): Promise<TicketNoteOutcome> {
  if (!input.ticketId) return { attempted: false, posted: false };
  if (!zendeskConfigured()) {
    return {
      attempted: true,
      posted: false,
      ticketId: input.ticketId,
      error: 'Zendesk is not connected, so nothing was written to the ticket. Admin portal → Service status.',
    };
  }

  try {
    const result = await comment({
      ticketId: input.ticketId,
      body: input.body,
      visibility: input.visibility,
      ...(input.ccEmails?.length ? { ccEmails: input.ccEmails } : {}),
    });
    return {
      attempted: true,
      posted: true,
      ticketId: result.ticketId,
      ...(result.url ? { url: result.url } : {}),
      ...(result.ccEmails.length ? { ccEmails: result.ccEmails } : {}),
    };
  } catch (err) {
    return {
      attempted: true,
      posted: false,
      ticketId: input.ticketId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}


/**
 * What the client may send when raising a fault.
 *
 * `contactEmail` and `contactNumber` are deliberately absent. The address and
 * number a supplier gets are the desk's, always, and that is enforced here
 * rather than defaulted in the form -- a default can be typed over, and a
 * supplier holding an engineer's direct line rings the engineer at six in the
 * evening instead of whoever is on.
 *
 * The engineer's own address has one use: `ccEngineer` adds them to our
 * Zendesk ticket, which is where the updates land anyway.
 */
const raiseFaultSchema = z.object({
  zenReference: z.string().trim().min(1, 'A service reference is required.').max(64),
  category: z.enum(['synchronisation', 'performance', 'authentication', 'voice', 'other']),
  frequency: z.enum(['intermittent', 'permanent']),
  summary: z.string().trim().min(10, 'Describe the fault in at least a sentence.').max(1000),
  testsCarriedOut: z.string().trim().max(2000).optional(),
  siteNotes: z.string().trim().max(2000).optional(),
  hazardNotes: z.string().trim().max(2000).optional(),
  /** The customer's own ticket, so the exchange is recorded against it. */
  ticketId: z.string().trim().max(16).optional(),
  /** Adds the signed-in engineer to the ticket, from their account email. */
  ccEngineer: z.boolean().optional(),
  /** Chosen from the customer's contacts, never typed. */
  siteContactId: z.string().trim().max(32).optional(),
  siteContactName: z.string().trim().max(160).optional(),
  siteContactEmail: z.string().trim().email().max(320).optional(),
  siteContactPhone: z.string().trim().max(40).optional(),
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
        checkedAt: new Date().toISOString(),
      };
    }),
  );

  router.get(
    '/network/status/:zenReference',
    handler(async (req) => {
      const result = await ops.outagesForService(String(req.params.zenReference));
      return { outages: result.data, mode: result.mode };
    }),
  );

  /* ---- Faults ------------------------------------------------------ */

  router.get(
    '/faults',
    handler(async (req) => {
      const state = String(req.query.state ?? 'open') === 'closed' ? 'closed' : 'open';
      const zenReference = String(req.query.zenReference ?? '').trim();
      const result = await ops.faults({ state, ...(zenReference ? { zenReference } : {}) });
      return { faults: result.data, state, mode: result.mode };
    }),
  );

  router.post(
    '/faults',
    handler(async (req) => {
      const parsed = raiseFaultSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid fault details.');
      const input = parsed.data;

      const siteContact = input.siteContactName
        ? {
            id: input.siteContactId ?? input.siteContactName,
            name: input.siteContactName,
            ...(input.siteContactEmail ? { email: input.siteContactEmail } : {}),
            ...(input.siteContactPhone ? { phone: input.siteContactPhone } : {}),
          }
        : undefined;

      // The supplier gets the desk's details and, where one was chosen, the
      // site contact's name and number so the engineer can get in. Never the
      // operator's own address.
      const result = await ops.raiseFault({
        zenReference: input.zenReference,
        category: input.category,
        frequency: input.frequency,
        summary: input.summary,
        ...(input.testsCarriedOut ? { testsCarriedOut: input.testsCarriedOut } : {}),
        ...(input.siteNotes ? { siteNotes: input.siteNotes } : {}),
        ...(input.hazardNotes ? { hazardNotes: input.hazardNotes } : {}),
        contactName: siteContact?.name ?? HOUSE_CONTACT.name,
        contactNumber: siteContact?.phone ?? HOUSE_CONTACT.phone,
        contactEmail: HOUSE_CONTACT.email,
      });

      // The ticket note is best-effort on purpose. The fault is raised with
      // the supplier by this point and cannot be un-raised, so a Zendesk
      // outage must not turn a successful fault into a failed request — it
      // reports what happened instead.
      const note = await noteOnTicket({
        ticketId: input.ticketId,
        visibility: 'private',
        body: faultRaisedNote({
          ...(result.data.reference ? { reference: result.data.reference } : {}),
          serviceReference: input.zenReference,
          category: input.category,
          frequency: input.frequency,
          summary: input.summary,
          ...(input.testsCarriedOut ? { testsCarriedOut: input.testsCarriedOut } : {}),
          ...(siteContact ? { siteContact } : {}),
          ...(req.user?.name ? { raisedBy: req.user.name } : {}),
          supplier: 'Zen',
        }),
        ...(input.ccEngineer && req.user?.email ? { ccEmails: [req.user.email] } : {}),
      });

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'fault.raised',
        detail: {
          zenReference: input.zenReference,
          category: input.category,
          reference: result.data.reference,
          mode: result.mode,
          ...(input.ticketId ? { ticketId: input.ticketId } : {}),
          ...(note.error ? { ticketNoteError: note.error } : {}),
          ...(siteContact ? { siteContact: siteContact.name } : {}),
          ccEngineer: Boolean(input.ccEngineer),
        },
        ip: req.ip,
      });
      return { fault: result.data, mode: result.mode, ticket: note };
    }),
  );

  /* ---- Tickets ------------------------------------------------------ */

  /**
   * The customer's own contacts for a ticket.
   *
   * Feeds the site-contact picker. Narrow by design: only the organisation
   * the ticket belongs to, so it cannot offer somebody from a different
   * customer — which is the one mistake that matters when handing a name to
   * an engineer about to knock on a door.
   */
  router.get(
    '/tickets/:id/contacts',
    handler(async (req) => {
      if (!zendeskConfigured()) {
        throw notConfigured('Zendesk is not connected, so site contacts cannot be looked up.');
      }
      const contacts = await siteContactsForTicket(String(req.params.id));
      return { contacts };
    }),
  );

  /**
   * Tells the customer a visit is booked.
   *
   * The one deliberately public message in here: somebody has to be on site,
   * and the notice period and the missed-appointment charge are things a
   * customer must learn before the visit rather than on an invoice after it.
   *
   * A button today. NetKit does not book appointments yet -- the engineer
   * books with the supplier and presses this -- and the moment it does, this
   * is what it will call.
   */
  router.post(
    '/tickets/:id/site-visit',
    handler(async (req) => {
      const ticketId = String(req.params.id);
      const body = (req.body ?? {}) as { supplier?: string; contactName?: string; ccEngineer?: boolean };

      const note = await noteOnTicket({
        ticketId,
        visibility: 'public',
        body: siteVisitBookedMessage({
          ...(body.supplier ? { supplier: String(body.supplier).slice(0, 80) } : {}),
          ...(body.contactName ? { contactName: String(body.contactName).slice(0, 120) } : {}),
        }),
        ...(body.ccEngineer && req.user?.email ? { ccEmails: [req.user.email] } : {}),
      });

      if (!note.posted) {
        throw badRequest(note.error ?? 'The update was not written to the ticket.');
      }

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'ticket.site_visit_notified',
        detail: { ticketId: note.ticketId, supplier: body.supplier ?? 'unspecified' },
        ip: req.ip,
      });
      return { ticket: note };
    }),
  );

  /* ---- Diagnostics ------------------------------------------------- */

  router.get(
    '/diagnostics/:zenReference/tests',
    handler(async (req) => {
      const technology = String(req.query.technology ?? '') || undefined;
      const result = await ops.availableTests(String(req.params.zenReference), technology);
      return { ...result.data, mode: result.mode };
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
      return { result: result.data, mode: result.mode };
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
      const body = (req.body ?? {}) as { technology?: string; ticketId?: string };
      const technology = String(body.technology ?? '') || undefined;

      const result = await ops.runTest(zenReference, type as LineTestType, technology);

      // Same best-effort note as a fault: the test has already run against
      // the line, so a ticket problem is reported rather than thrown.
      const note = await noteOnTicket({
        ...(body.ticketId ? { ticketId: String(body.ticketId).trim() } : {}),
        visibility: 'private',
        body: lineTestNote({
          testType: type,
          serviceReference: zenReference,
          outcome: result.data.outcome,
          ...(result.data.summary ? { summary: result.data.summary } : {}),
          ...(result.data.faultLocation ? { faultLocation: result.data.faultLocation } : {}),
          ...(result.data.metrics.length
            ? {
                detail: result.data.metrics.map((m) => ({
                  label: m.label,
                  value: m.unit ? `${m.value} ${m.unit}` : m.value,
                  ...(m.verdict && m.verdict !== 'info' ? { verdict: m.verdict } : {}),
                })),
              }
            : {}),
          ...(result.data.recommendations?.length ? { recommendations: result.data.recommendations } : {}),
          ...(req.user?.name ? { runBy: req.user.name } : {}),
        }),
      });

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'diagnostics.test_run',
        detail: {
          zenReference,
          type,
          outcome: result.data.outcome,
          mode: result.mode,
          ...(note.ticketId ? { ticketId: note.ticketId } : {}),
          ...(note.error ? { ticketNoteError: note.error } : {}),
        },
        ip: req.ip,
      });
      return { result: result.data, mode: result.mode, ticket: note };
    }),
  );

  router.get(
    '/diagnostics/:zenReference/profile',
    handler(async (req) => {
      const result = await ops.profileOptions(String(req.params.zenReference));
      return { ...result.data, mode: result.mode };
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
      return { result: result.data, mode: result.mode };
    }),
  );

  router.get(
    '/diagnostics/:zenReference/stability',
    handler(async (req) => {
      const days = Math.min(90, Math.max(7, Number.parseInt(String(req.query.days ?? '30'), 10) || 30));
      const result = await ops.stability(String(req.params.zenReference), days);
      return { ...result.data, mode: result.mode };
    }),
  );

  router.get(
    '/diagnostics/:zenReference/usage',
    handler(async (req) => {
      const raw = String(req.query.period ?? 'current_month');
      const period = raw === 'day' || raw === 'month' ? raw : 'current_month';
      const result = await ops.usage(String(req.params.zenReference), period);
      return { ...result.data, mode: result.mode };
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
      return { orders: result.data, view, mode: result.mode };
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
      return { ...result.data, mode: result.mode };
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
      return { ...result.data, mode: result.mode };
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
      return { slots: result.data, mode: result.mode };
    }),
  );

  /* ---- SIMs -------------------------------------------------------- */

  router.get(
    '/sims',
    handler(async () => {
      const result = await ops.simEstate();
      return { ...result.data, mode: result.mode };
    }),
  );

  /**
   * One SIM, with the figures the estate listing does not carry.
   *
   * Fetched when somebody opens a SIM rather than for every row, so the
   * provider is not asked for voice and SMS totals across a whole estate to
   * fill columns nobody is looking at.
   */
  router.get(
    '/sims/:identifier',
    handler(async (req) => {
      const identifier = String(req.params.identifier ?? '').trim();
      if (!identifier) throw badRequest('Provide an ICCID or a number.');
      const result = await ops.simDetail(identifier);
      return { sim: result.data, mode: result.mode };
    }),
  );

  /* ---- Tools ------------------------------------------------------- */

  router.get(
    '/tools/number-port',
    handler(async (req) => {
      const cli = requireCli(req.query.q);
      const result = await ops.numberPortCheck(cli);
      return { ...result.data, mode: result.mode };
    }),
  );

  router.get(
    '/tools/connectivity',
    handler(async (req) => {
      const cli = requireCli(req.query.q);
      const result = await ops.networkConnectivity(cli);
      return { ...result.data, mode: result.mode };
    }),
  );

  router.get(
    '/tools/imei',
    handler(async (req) => {
      const cli = requireCli(req.query.q);
      const result = await ops.imeiLookup(cli);
      return { ...result.data, mode: result.mode };
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
      return { ...result.data, mode: result.mode };
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
      };
    }),
  );

  router.get(
    '/tools/rdns',
    handler(async (req) => {
      const zenReference = String(req.query.zenReference ?? '').trim() || undefined;
      const result = await ops.rdns(zenReference);
      return { records: result.data, mode: result.mode };
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
      return { ...result.data, mode: result.mode };
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
      return { ...result.data, mode: result.mode };
    }),
  );

  /* ---- Service history --------------------------------------------- */

  router.get(
    '/diagnostics/:zenReference/history',
    handler(async (req) => {
      const result = await ops.serviceHistory(String(req.params.zenReference));
      return { ...result.data, mode: result.mode };
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
      return { ...result.data, mode: result.mode };
    }),
  );

  /* ---- Company context --------------------------------------------- */

  router.get(
    '/tools/companies',
    handler(async (req) => {
      const postcode = String(req.query.postcode ?? '').trim();
      if (!postcode) throw badRequest('Provide ?postcode=');

      // A UPRN narrows the answer to one doorstep. Optional, because the
      // register is postcode-indexed and the postcode-wide answer is still
      // the honest fallback when the premises cannot be resolved.
      const uprn = String(req.query.uprn ?? '').trim();
      const premises = uprn ? await addressByUprn(uprn) : null;

      const result = await ops.companies(formatPostcode(postcode), premises ?? undefined);
      return { ...result.data, mode: result.mode };
    }),
  );

  router.get(
    '/tools/companies/:number',
    handler(async (req) => {
      const number = String(req.params.number ?? '').trim();
      if (!number) throw badRequest('Provide a company number.');
      const result = await ops.companyDetail(number);
      return { ...result.data, mode: result.mode };
    }),
  );

  /* ---- Watched premises --------------------------------------------- */

  router.get(
    '/watches',
    handler(async (req) => ({ watches: listWatches(req.user?.id ?? 'anonymous') })),
  );

  router.post(
    '/watches',
    handler(async (req) => {
      const { uprn } = z.object({ uprn: z.string().min(1) }).parse(req.body ?? {});
      const address = await addressByUprn(uprn);
      if (!address) throw uprnNotFound(uprn);

      // The report is built here rather than taken from the client, so the
      // snapshot a watch is judged against is one the server produced.
      const report = await buildSiteReport(address, identify(uprn), { includeSiblings: false });
      const result = addWatch(req.user?.id ?? 'anonymous', report);
      if (!result.ok) throw badRequest(result.message);

      audit({
        action: 'watch.added',
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        detail: { uprn, address: address.singleLine },
        ip: req.ip,
      });

      return { watch: result.watch };
    }),
  );

  router.delete(
    '/watches/:id',
    handler(async (req) => {
      const id = String(req.params.id ?? '');
      const removed = removeWatch(req.user?.id ?? 'anonymous', id);
      if (!removed) throw notFound('No such watch.');
      audit({ action: 'watch.removed', actorId: req.user?.id, actorEmail: req.user?.email, detail: { id }, ip: req.ip });
      return { removed: true };
    }),
  );

  /* ---- Bulk lookup -------------------------------------------------- */

  router.post(
    '/tools/bulk',
    handler(async (req) => {
      const body = z
        .object({ text: z.string().max(20_000).optional(), entries: z.array(z.string()).optional() })
        .parse(req.body ?? {});

      // Either a pasted block or an already-split list, so the endpoint is
      // usable from a script as well as from the textarea.
      const entries = body.entries?.length
        ? parseBulkInput(body.entries.join('\n'))
        : parseBulkInput(body.text ?? '');

      const result = await runBulkLookup(entries, req.user?.id ?? 'anonymous');

      audit({
        action: 'bulk.lookup',
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        detail: {
          requested: result.requested,
          completed: result.completed,
          skippedForBudget: result.skippedForBudget,
        },
        ip: req.ip,
      });

      return result;
    }),
  );

  /* ---- Estate-wide usage ------------------------------------------- */

  router.get(
    '/tools/estate-usage',
    handler(async (req) => {
      const period = String(req.query.period ?? '').trim();
      if (period && !/^\d{4}-\d{2}$/.test(period)) throw badRequest('A period looks like 2026-09.');
      const result = await ops.estateUsage(period || undefined);
      return { ...result.data, mode: result.mode };
    }),
  );

  return router;
}
