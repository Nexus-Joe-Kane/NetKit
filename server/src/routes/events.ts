import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  DISPOSITIONS,
  activityNote,
  clearanceProblem,
  dispositionDef,
  deviceKind,
  displayName,
  eventSubject,
  handoffProblem,
  internalHandoffNote,
  publicHandoffNote,
  sortTickets,
  lookupableSites,
  glance,
  needsExtraCare,
  restartImpact,
  troubleHeadline,
  unassignedSites,
  wanLinesFrom,
  type ApiResult,
  type Clearance,
  type Disposition,
  type NetEvent,
  type NetworkDevice,
} from '@sw/shared';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../auth/store';
import { activityFor } from '../services/activity';
import { allClients, clientIndexStatus, findClients } from '../services/clientIndex';
import { assign, assignmentsForClient, listAssignments, unassign } from '../services/assignments';
import { buildClientProfile } from '../services/clientProfile';
import { clear, getEvent, listEvents, listWatchStates, watchState } from '../services/events';
import { sweepOutages } from '../services/outageSweep';
import { listVisits } from '../services/visits';
import { agents, comment, findTickets, zendeskConfigured } from '../providers/tickets/zendesk';
import { devicesForHost, unifiConfigured, wanHealth } from '../providers/network/unifi';
import { clientsForSite } from '../providers/network/unifiClients';
import { majorProviderStatus } from '../providers/status/downdetector';
import {
  consoleLinks,
  powerCyclePort,
  restartDevice,
  unifiActionsConfigured,
  unifiActionsUnavailableReason,
} from '../providers/network/unifiActions';
import { config } from '../config';
import * as ops from '../services/operations';

/**
 * Events: the board, one event, and closing it.
 *
 * The routes the engine has been missing. Everything the sweep does has been
 * happening with no way to see or touch it from the portal, which meant a
 * helpdesk ticket was the only thing the system could say — and the ticket
 * says one thing once, where the event stays live.
 */

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

/** The trail is attached on read rather than stored twice. */
function withActivity(event: NetEvent): NetEvent {
  const steps = activityFor({
    eventId: event.id,
    ...(event.ticketId ? { ticketId: event.ticketId } : {}),
    since: event.openedAt,
  });
  return steps.length ? { ...event, activity: steps } : event;
}

export function eventsRouter(): Router {
  const router = Router();

  /* ---- The board ---------------------------------------------------- */

  router.get(
    '/events',
    handler(async (req) => {
      const includeCleared = String(req.query.cleared ?? '') === 'true';
      const events = listEvents({ includeCleared }).map(withActivity);
      return { events, dispositions: DISPOSITIONS };
    }),
  );

  /**
   * The home page's four numbers, and the one headline worth a banner.
   *
   * One call rather than four, because the dashboard asks on every load and
   * four round trips to answer "is anything on fire" is three too many.
   */
  router.get(
    '/dashboard',
    handler(async () => {
      const events = listEvents().map(withActivity);
      const visits = listVisits();

      // Faults are best-effort: the assurance API is entitlement-gated and a
      // 401 there must not blank the whole dashboard.
      let faults = 0;
      let faultsError: string | undefined;
      try {
        const open = await ops.faults({ state: 'open' });
        faults = open.data.length;
      } catch (err) {
        faultsError = err instanceof Error ? err.message : String(err);
      }

      const counts = glance({ events, appointments: visits.open.length, faults });

      // Providers we actually sell, each with how many of its own sites are
      // in trouble. Zen and Daisy (which is Giacom under its former name)
      // are the managed ones; UniFi is the console's own view.
      const byProvider = new Map<string, { open: number; sites: string[] }>();
      for (const event of events) {
        for (const wan of event.wans ?? []) {
          const row = byProvider.get(wan.providerName) ?? { open: 0, sites: [] };
          if (wan.online === false) {
            row.open += 1;
            if (event.siteName) row.sites.push(event.siteName);
          }
          byProvider.set(wan.providerName, row);
        }
      }

      const watches = listWatchStates();

      // National supplier status. Best-effort by design: it is context
      // rather than evidence, and it must never blank the board.
      const national = await majorProviderStatus();

      return {
        glance: counts,
        national: national.rows,
        ...(national.error ? { nationalError: national.error } : {}),
        ...(troubleHeadline(national.rows) ? { nationalHeadline: troubleHeadline(national.rows)! } : {}),
        events,
        visits: visits.open,
        providers: [...byProvider.entries()].map(([provider, row]) => ({
          provider,
          openEvents: row.open,
          sites: [...new Set(row.sites)].slice(0, 6),
        })),
        watched: {
          total: watches.length,
          onException: watches.filter((w) => w.cadence === 'sparse').length,
          suppressed: watches.filter((w) => w.suppressedUntil).length,
        },
        ...(faultsError ? { faultsError } : {}),
      };
    }),
  );

  /* ---- One event ---------------------------------------------------- */

  router.get(
    '/events/:id',
    handler(async (req) => {
      const event = getEvent(String(req.params.id ?? ''));
      if (!event) throw notFound('No such event.');
      return {
        event: withActivity(event),
        watch: watchState(event.clientKey, event.siteName ?? event.clientName),
        dispositions: DISPOSITIONS,
      };
    }),
  );

  /**
   * Closes an event, with the closure report going on the ticket.
   *
   * The report is not optional for a resolution or an exception, and the
   * check is here rather than only in the form so the API cannot be talked
   * past. It goes on as a private note: it quotes internal diagnostics and
   * names the engineer, and none of it is written for the customer.
   */
  router.post(
    '/events/:id/clear',
    handler(async (req) => {
      const body = z
        .object({
          disposition: z.enum(['resolved', 'known-cause', 'exception', 'not-ours']),
          resolution: z.string().trim().max(4000).optional(),
          exceptionReason: z.string().trim().max(2000).optional(),
          signedOffBy: z.string().trim().max(120).optional(),
          note: z.string().trim().max(2000).optional(),
        })
        .parse(req.body ?? {});

      const event = getEvent(String(req.params.id ?? ''));
      if (!event) throw notFound('No such event.');
      if (event.status === 'cleared') throw badRequest('That event is already closed.');

      const clearance: Clearance = {
        disposition: body.disposition as Disposition,
        at: new Date().toISOString(),
        ...(req.user?.name ? { by: req.user.name } : {}),
        ...(body.resolution ? { resolution: body.resolution } : {}),
        ...(body.exceptionReason ? { exceptionReason: body.exceptionReason } : {}),
        ...(body.signedOffBy ? { signedOffBy: body.signedOffBy } : {}),
        ...(body.note ? { note: body.note } : {}),
      };

      const problem = clearanceProblem(clearance);
      if (problem) throw badRequest(problem);

      const result = clear(event.id, clearance);
      if (!result) throw notFound('No such event.');

      // The closure report, on the same ticket, private.
      let ticket: { posted: boolean; error?: string } = { posted: false };
      if (event.ticketId && zendeskConfigured()) {
        try {
          await comment({
            ticketId: event.ticketId,
            visibility: 'private',
            body: closureReport(event, clearance, withActivity(event)),
          });
          ticket = { posted: true };
        } catch (err) {
          // The event is closed either way. Failing the request would have
          // an operator close it twice.
          ticket = { posted: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: body.disposition === 'resolved' ? 'event.resolved' : 'event.dismissed',
        detail: {
          eventId: event.id,
          ...(event.ticketId ? { ticketId: event.ticketId } : {}),
          disposition: body.disposition,
          ...(body.signedOffBy ? { signedOffBy: body.signedOffBy } : {}),
          cadence: result.watch.cadence ?? 'normal',
          reportPosted: ticket.posted,
        },
        ip: req.ip,
      });

      return { event: result.event, watch: result.watch, ticket };
    }),
  );

  /**
   * A note on the event's ticket, from the portal.
   *
   * Public notes get the network team sign-off, because a customer-facing
   * message that trails off unsigned reads as a fragment. Private ones do
   * not: an internal note signed off like a letter is noise.
   */
  router.post(
    '/events/:id/note',
    handler(async (req) => {
      const body = z
        .object({
          visibility: z.enum(['private', 'public']),
          body: z.string().trim().min(1).max(8000),
        })
        .parse(req.body ?? {});

      const event = getEvent(String(req.params.id ?? ''));
      if (!event) throw notFound('No such event.');
      if (!event.ticketId) throw badRequest('This event has no ticket to write to yet.');
      if (!zendeskConfigured()) {
        throw badRequest('Zendesk is not connected, so nothing can be written. Admin portal → Service status.');
      }

      const text =
        body.visibility === 'public'
          ? `${body.body}\n\n${SIGN_OFF}`
          : body.body;

      await comment({ ticketId: event.ticketId, visibility: body.visibility, body: text });

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'event.note_added',
        detail: { eventId: event.id, ticketId: event.ticketId, visibility: body.visibility },
        ip: req.ip,
      });

      return { posted: true, visibility: body.visibility };
    }),
  );

  /* ---- One site's kit, and what can be done to it ------------------ */

  /**
   * Devices and clients for a UniFi site.
   *
   * Both halves degrade on their own: the device list is worth having with
   * no client list, and the client list is worth having when the metrics
   * feed is down. Neither failure takes the page with it.
   */
  router.get(
    '/unifi/sites/:hostId/:siteId',
    handler(async (req) => {
      const hostId = String(req.params.hostId ?? '');
      const siteId = String(req.params.siteId ?? '');
      if (!unifiConfigured()) {
        return {
          devices: [],
          clients: [],
          error: 'UniFi Site Manager is not connected. Admin portal → Credentials.',
          actions: { available: false, reason: unifiActionsUnavailableReason() },
        };
      }

      let devices: NetworkDevice[] = [];
      let deviceError: string | undefined;
      try {
        devices = await devicesForHost(hostId, siteId);
      } catch (err) {
        deviceError = err instanceof Error ? err.message : String(err);
      }

      // Names for the `via` field, keyed by both id and MAC because which
      // one the client payload carries varies by firmware.
      const named = new Map<string, string>();
      for (const device of devices) {
        if (device.id) named.set(device.id.toLowerCase(), device.name);
        if (device.mac) named.set(device.mac.toLowerCase(), device.name);
      }

      const { clients, error: clientError } = await clientsForSite({ consoleId: hostId, siteId, devices: named });

      let wan: Awaited<ReturnType<typeof wanHealth>> = null;
      try {
        wan = await wanHealth(hostId, siteId);
      } catch {
        // Metrics are decoration next to the device list.
      }

      return {
        devices,
        clients,
        wan,
        wans: wanLinesFrom({ health: wan, ...(wan?.uplinks ? { uplinks: wan.uplinks } : {}) }),
        ...(deviceError ? { deviceError } : {}),
        ...(clientError ? { clientError } : {}),
        actions: {
          available: unifiActionsConfigured(),
          ...(unifiActionsUnavailableReason() ? { reason: unifiActionsUnavailableReason() } : {}),
        },
        consoleLinks: consoleLinks({ consoleId: hostId, siteId }),
      };
    }),
  );

  /**
   * Restarts one device.
   *
   * The impact is worked out server-side and audited with the action, so the
   * log says "restarted the gateway, which takes the site off" rather than
   * "restarted a device". A gateway or an unclassifiable device needs
   * `confirmImpact` in the body — a second, explicit statement of what is
   * about to happen, so a mis-click on a list cannot take an office off.
   */
  router.post(
    '/unifi/sites/:hostId/:siteId/devices/:deviceId/restart',
    handler(async (req) => {
      const body = z.object({ confirmImpact: z.string().trim().max(40).optional() }).parse(req.body ?? {});
      const hostId = String(req.params.hostId ?? '');
      const siteId = String(req.params.siteId ?? '');
      const deviceId = String(req.params.deviceId ?? '');

      const devices = await devicesForHost(hostId, siteId).catch(() => [] as NetworkDevice[]);
      const device = devices.find((d) => d.id === deviceId);
      const kind = device ? deviceKind(device) : 'other';
      const { impact, warning } = restartImpact(kind);

      if (needsExtraCare(kind) && body.confirmImpact !== impact) {
        throw badRequest(
          `${warning} Send confirmImpact: "${impact}" to go ahead.`,
        );
      }

      const outcome = await restartDevice({ consoleId: hostId, siteId, deviceId });

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'unifi.device_restarted',
        detail: {
          siteId,
          deviceId,
          ...(device?.name ? { device: device.name } : {}),
          kind,
          impact,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { error: outcome.detail }),
        },
        ip: req.ip,
      });

      if (!outcome.ok) throw badRequest(outcome.detail);
      return { ...outcome, kind, impact };
    }),
  );

  /** Power-cycles one switch port, which is how a hung camera comes back. */
  router.post(
    '/unifi/sites/:hostId/:siteId/devices/:deviceId/ports/:port/cycle',
    handler(async (req) => {
      const hostId = String(req.params.hostId ?? '');
      const siteId = String(req.params.siteId ?? '');
      const deviceId = String(req.params.deviceId ?? '');
      const port = Number.parseInt(String(req.params.port ?? ''), 10);
      if (!Number.isInteger(port) || port < 1 || port > 64) throw badRequest('That is not a port number.');

      const outcome = await powerCyclePort({ consoleId: hostId, siteId, deviceId, portIndex: port });

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'unifi.port_cycled',
        detail: { siteId, deviceId, port, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.detail }) },
        ip: req.ip,
      });

      if (!outcome.ok) throw badRequest(outcome.detail);
      return outcome;
    }),
  );

  /* ---- Clients ------------------------------------------------------ */

  /** The client list, searchable by registered or trading name. */
  router.get(
    '/clients',
    handler(async (req) => {
      const term = String(req.query.q ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const entries = term ? findClients(term, limit) : allClients().slice(0, limit);
      return {
        clients: entries.map((entry) => ({
          key: entry.key,
          name: entry.name,
          display: displayName(entry),
          ...(entry.tradingName ? { tradingName: entry.tradingName } : {}),
          sites: entry.sites.length,
          lookupable: lookupableSites(entry).length,
          serviceRefs: entry.serviceRefs.length,
          sources: entry.sources,
        })),
        total: clientIndexStatus().entries,
      };
    }),
  );

  router.get(
    '/clients/:key',
    handler(async (req) => {
      const key = String(req.params.key ?? '');
      const [entry] = findClients(key, 1);
      const profile = await buildClientProfile({ key, name: entry?.name ?? key });
      return {
        profile,
        unassigned: unassignedSites(profile.entry),
        assignments: assignmentsForClient(profile.entry.key),
      };
    }),
  );

  /* ---- Claiming an address for a client ---------------------------- */

  router.get(
    '/assignments',
    handler(async () => ({ assignments: listAssignments() })),
  );

  router.post(
    '/assignments',
    handler(async (req) => {
      const body = z
        .object({
          uprn: z.string().trim().min(1).max(20),
          clientKey: z.string().trim().min(1).max(200),
          clientName: z.string().trim().min(1).max(200),
          addressLine: z.string().trim().max(300).optional(),
          postcode: z.string().trim().max(12).optional(),
          siteName: z.string().trim().max(200).optional(),
          note: z.string().trim().max(1000).optional(),
        })
        .parse(req.body ?? {});

      const result = assign({
        ...body,
        ...(req.user?.name ? { assignedBy: req.user.name } : {}),
      });
      if (!result.ok) throw badRequest(result.error);

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'client.address_assigned',
        detail: { uprn: body.uprn, clientKey: body.clientKey, clientName: body.clientName },
        ip: req.ip,
      });

      return { assignment: result.assignment };
    }),
  );

  router.delete(
    '/assignments/:uprn',
    handler(async (req) => {
      const uprn = String(req.params.uprn ?? '');
      const removed = unassign(uprn);
      if (removed) {
        audit({
          actorId: req.user?.id,
          actorEmail: req.user?.email,
          action: 'client.address_unassigned',
          detail: { uprn },
          ip: req.ip,
        });
      }
      return { uprn, removed };
    }),
  );

  /* ---- Sending a document to a ticket ------------------------------ */

  /** Agents whose queues can be searched. Live, never a cached list. */
  router.get(
    '/queues',
    handler(async (req) => {
      if (!zendeskConfigured()) return { queues: [], error: 'Zendesk is not connected.' };
      const list = await agents();
      const mine = req.user?.email?.toLowerCase();
      const queues = list.map((agent) => ({
        ...agent,
        // Pre-selecting the signed-in engineer's own queue is the common
        // case; the other queues are there for the uncommon one.
        ...(mine && agent.email?.toLowerCase() === mine ? { me: true } : {}),
      }));
      return { queues };
    }),
  );

  /**
   * Tickets, searched live.
   *
   * Always a search: a queue is hundreds of tickets, and the one somebody
   * wants is identified by a customer name or a number read off something
   * else.
   */
  router.get(
    '/tickets/search',
    handler(async (req) => {
      if (!zendeskConfigured()) return { tickets: [], error: 'Zendesk is not connected.' };
      const term = String(req.query.q ?? '').trim();
      const queue = String(req.query.queue ?? '').trim();
      const tickets = await findTickets({
        ...(term ? { term } : {}),
        ...(queue ? { assigneeId: queue } : {}),
        limit: 15,
      });
      return { tickets: sortTickets(tickets) };
    }),
  );

  /**
   * Puts a document on a ticket.
   *
   * The internal and public paths differ in what they say, not just in a
   * flag. An internal note is a filing action — the file, who asked, when.
   * A public reply is a message, and gets the network team sign-off added
   * rather than typed, so it cannot drift from every other customer-facing
   * message this portal sends.
   *
   * The engineer's own notes go on the internal note and never on the public
   * one. Notes written on an internal document are written for the desk, and
   * putting them in front of a customer is how "the customer is being
   * difficult about the wiring" ends up in an inbox.
   */
  router.post(
    '/tickets/:id/document',
    handler(async (req) => {
      const body = z
        .object({
          visibility: z.enum(['private', 'public']),
          filename: z.string().trim().min(1).max(200),
          kind: z.string().trim().min(1).max(80),
          about: z.string().trim().max(300).optional(),
          engineerNotes: z.string().trim().max(4000).optional(),
          /** What the engineer wrote, for a public reply. */
          message: z.string().trim().max(8000).optional(),
        })
        .parse(req.body ?? {});

      const ticketId = String(req.params.id ?? '').trim();
      if (!zendeskConfigured()) {
        throw badRequest('Zendesk is not connected, so nothing can be sent. Admin portal → Service status.');
      }

      const problem = handoffProblem({
        visibility: body.visibility,
        ticketId,
        ...(body.message ? { body: body.message } : {}),
      });
      if (problem) throw badRequest(problem);

      const document = {
        filename: body.filename,
        kind: body.kind,
        ...(body.about ? { about: body.about } : {}),
        ...(body.engineerNotes ? { engineerNotes: body.engineerNotes } : {}),
      };

      const text =
        body.visibility === 'public'
          ? publicHandoffNote({ document, body: body.message ?? '' })
          : internalHandoffNote({
              document,
              ...(req.user?.name ? { by: req.user.name } : {}),
              at: new Date().toISOString(),
            });

      await comment({ ticketId, visibility: body.visibility, body: text });

      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'document.sent_to_ticket',
        detail: {
          ticketId,
          visibility: body.visibility,
          filename: body.filename,
          kind: body.kind,
          hadEngineerNotes: Boolean(body.engineerNotes),
        },
        ip: req.ip,
      });

      return { posted: true, ticketId, visibility: body.visibility };
    }),
  );

  /* ---- Checking now ------------------------------------------------- */

  /**
   * Runs the sweep on demand.
   *
   * The paced version is what the timer calls; this one always runs, because
   * somebody pressing "check now" means now.
   */
  router.post(
    '/events/sweep',
    handler(async (req) => {
      const outcome = await sweepOutages();
      audit({
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: 'event.sweep_manual',
        detail: { ...outcome },
        ip: req.ip,
      });
      return outcome;
    }),
  );

  return router;
}

/**
 * The network team sign-off.
 *
 * The same wording as every other customer-facing message this portal
 * sends, in one place, so a note written here and an email sent by the visit
 * flow do not read as coming from two different companies.
 */
const SIGN_OFF = 'Kind regards,\nThe Network Team\nSupportWizard';

/**
 * The closure report.
 *
 * What a ticket needs to be closed on: what was done, whether the line tests
 * clean now, whether the console is back, and — for an exception — the
 * reason and whose name is on it. Written from the event rather than from a
 * form, so the technical half is the same evidence the ticket was opened
 * with rather than a retyping of it.
 */
export function closureReport(event: NetEvent, clearance: Clearance, withTrail: NetEvent): string {
  const def = dispositionDef(clearance.disposition);
  const lines: string[] = [];

  lines.push(`Closing: ${eventSubject(event)}`);
  lines.push('');
  lines.push(`Outcome: ${def?.label ?? clearance.disposition}${clearance.by ? ` — ${clearance.by}` : ''}`);

  if (clearance.resolution) {
    lines.push('');
    lines.push('What was done');
    lines.push(clearance.resolution);
  }

  if (clearance.disposition === 'exception') {
    lines.push('');
    lines.push('Exception');
    lines.push(clearance.exceptionReason ?? '');
    lines.push(`Signed off by: ${clearance.signedOffBy ?? 'not recorded'}`);
    lines.push(
      'This site now gets a monthly check instead of one every five minutes. It will not raise a ticket ' +
        'again unless somebody puts it back on the normal cadence.',
    );
  }

  if (clearance.disposition === 'known-cause') {
    lines.push('');
    lines.push(
      'Alerting is off for this site until somebody puts it back on watch. The drops already recorded are ' +
        'kept, so the history still shows how bad it has been.',
    );
  }

  /* ---- Where it was left, from the event -------------------------- */
  const wans = event.wans ?? [];
  if (wans.length) {
    lines.push('');
    lines.push('Where the connectivity was left');
    for (const wan of wans) {
      const state = wan.online === true ? 'up' : wan.online === false ? 'down' : 'state unknown';
      const test = wan.managed
        ? ` — line test ${wan.lineTestRun === 'yes' ? (wan.lineTestResult === 'pass' ? 'clean' : 'fault found') : 'not run'}`
        : ' — not managed by us';
      lines.push(`· ${wan.label} — ${wan.providerName} — ${state}${test}`);
    }
  }

  const env = event.environment;
  if (env?.totalDevices !== undefined) {
    lines.push('');
    lines.push(
      `Console at close of the event: ${env.totalDevices - (env.offlineDevices ?? 0)} of ${env.totalDevices} ` +
        'devices reachable.',
    );
  }

  if (clearance.note) {
    lines.push('');
    lines.push(clearance.note);
  }

  const trail = activityNote(withTrail.activity ?? [], 'What has been done');
  return trail ? `${lines.join('\n')}\n\n${trail}` : lines.join('\n');
}
