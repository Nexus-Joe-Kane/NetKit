import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  DISPOSITIONS,
  activityNote,
  clearanceProblem,
  dispositionDef,
  eventSubject,
  glance,
  troubleHeadline,
  type ApiResult,
  type Clearance,
  type Disposition,
  type NetEvent,
} from '@sw/shared';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../auth/store';
import { activityFor } from '../services/activity';
import { clear, getEvent, listEvents, listWatchStates, watchState } from '../services/events';
import { sweepOutages } from '../services/outageSweep';
import { listVisits } from '../services/visits';
import { comment, zendeskConfigured } from '../providers/tickets/zendesk';
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

      return {
        glance: counts,
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
