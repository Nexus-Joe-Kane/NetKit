import { readAudit, findUserById, type AuditEntry } from '../auth/store';
import { type ActivityEntry, actionPhrase, worthReporting } from '@sw/shared';

/**
 * The action trail, read back out of the audit log.
 *
 * Deliberately not a second log. Every step worth reporting is already
 * audited — a line test, a fault raise, a visit booked, a SIM barred — and a
 * parallel "activity" store would drift from it the first time somebody added
 * an action to one and not the other. The audit log is append-only and mode
 * 0600, so it is also the copy that can be trusted.
 *
 * Two things this file is careful about.
 *
 * What it renders is an allow-list. `detail` is a free-form bag: `order.*`
 * spreads a whole request object into it, and future actions will put things
 * in there that nobody thought about putting on a customer's ticket. So a row
 * contributes only the keys named below, and an action with no entry
 * contributes its phrase and nothing else. The alternative — render whatever
 * is in `detail` — is one careless audit call away from writing a credential
 * onto a ticket.
 *
 * And correlation is by the identifiers a row actually names. A profile
 * change audits `zenReference` and no ticket; an order audits neither. Asking
 * for a trail therefore means naming the things it is about, and a row that
 * names none of them appears on no trail rather than on every one.
 */

/**
 * How far back to read.
 *
 * Enough to cover a fault that has been open a fortnight on a busy desk,
 * bounded so a year-old log is not parsed to render one note. Rows are
 * filtered after reading, so this is a window on the log and not a limit on
 * the trail.
 */
const WINDOW = 4000;

/** The trail's own default ceiling — a ticket note is not a log viewer. */
const DEFAULT_LIMIT = 40;

export interface ActivityScope {
  /** The Zendesk ticket the note is going on. */
  ticketId?: string;
  /** The portal event, once events exist. */
  eventId?: string;
  /** The circuit, so a line test with no ticket still lands on the trail. */
  zenReference?: string;
  /** The premises. */
  uprn?: string;
  /** The visit, for the approve/cancel/confirm sequence. */
  visitId?: string;
  /** ISO timestamp. Rows at or before it are older news than this trail. */
  since?: string;
  limit?: number;
}

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

/**
 * One entry from a watch's change list.
 *
 * Stored either as a sentence or as a record, depending on how old the row
 * is, so both are read and anything else is dropped rather than stringified
 * into `[object Object]`.
 */
function changeText(change: unknown): string | undefined {
  if (typeof change === 'string') return change.trim() || undefined;
  if (change && typeof change === 'object') {
    const row = change as Record<string, unknown>;
    return text(row.summary) ?? text(row.label) ?? text(row.kind);
  }
  return undefined;
}

/**
 * What each action puts on the trail beyond its phrase.
 *
 * `summary` says what it was about, `outcome` how it went. Both may return
 * nothing: a row whose detail is missing the field reads as the bare phrase,
 * which is true, rather than as "undefined".
 */
interface Renderer {
  summary?: (d: Record<string, unknown>) => string | undefined;
  outcome?: (d: Record<string, unknown>) => string | undefined;
}

const RENDERERS: Record<string, Renderer> = {
  'diagnostics.test_run': {
    // The phrase already says "Ran a line test", so the summary says what it
    // was run against and not what it was. Repeating the word gave
    // "Ran a line test. Line test on ZEN123456." on a real ticket.
    summary: (d) => {
      const on = text(d.zenReference);
      const type = text(d.type);
      if (on && type && !/line/i.test(type)) return `${on} (${type})`;
      return on;
    },
    outcome: (d) => text(d.outcome) ?? (d.ticketNoteError ? 'The result did not reach the ticket' : undefined),
  },
  'diagnostics.profile_change': {
    summary: (d) => {
      const on = text(d.zenReference);
      const code = text(d.profileCode);
      return on && code ? `${on} to profile ${code}` : (code ? `To profile ${code}` : on);
    },
  },
  'fault.raised': {
    summary: (d) => {
      const category = text(d.category);
      const on = text(d.zenReference);
      return category && on ? `${category} on ${on}` : (category ?? on);
    },
    outcome: (d) => {
      const reference = text(d.reference);
      return reference ? `Supplier reference ${reference}` : undefined;
    },
  },
  'ticket.site_visit_notified': {
    // Note what is missing: `detail.supplier`. The supplier's name is not put
    // in front of a customer anywhere in this portal, and the trail rides on
    // customer tickets.
    summary: (d) => text(d.reason),
    outcome: (d) => {
      const slot = text(d.slot);
      return slot && slot !== 'unconfirmed' ? `Slot ${slot}` : 'No slot confirmed yet';
    },
  },
  'visit.approval_requested': {
    summary: (d) => {
      const approver = text(d.approver);
      return approver ? `Sent to ${approver}` : undefined;
    },
    outcome: (d) => (d.chargeable === true ? 'Cancelling from here would be chargeable' : undefined),
  },
  'visit.cancelled': {
    outcome: (d) => {
      if (d.chargeableAtDecision === true) return 'Inside the free-cancellation window, so chargeable';
      if (d.customerTold === true) return 'The customer was told';
      return undefined;
    },
  },
  'client.payg_request_sent': {
    summary: (d) => text(d.clientName),
  },
  'order.submitting': {
    summary: (d) => {
      const product = text(d.productCode);
      const where = text(d.postcode);
      return product && where ? `${product} at ${where}` : (product ?? where);
    },
    outcome: (d) => (d.demo === true ? 'Nothing was sent — no supplier credentials' : undefined),
  },
  'order.placed': {
    summary: (d) => text(d.productCode),
    outcome: (d) => {
      const reference = text(d.zenReference);
      return reference ? `Service reference ${reference}` : undefined;
    },
  },
  'order.rejected': {
    summary: (d) => text(d.productCode),
    outcome: (d) => text(d.error) ?? (Array.isArray(d.messages) ? d.messages.map(text).filter(Boolean).join('; ') : undefined),
  },
  'order.cancelled': {
    summary: (d) => text(d.zenReference),
    outcome: (d) => text(d.reason),
  },
  'address.registered': {
    outcome: (d) => {
      const reference = text(d.addressReference);
      return reference ? `Address reference ${reference}` : undefined;
    },
  },
  'watch.added': { summary: (d) => text(d.address) ?? text(d.uprn) },
  'watch.removed': { summary: (d) => text(d.uprn) },
  'watch.changed': {
    summary: (d) => text(d.address) ?? text(d.uprn),
    // Say what changed. A bare "1 change" against a twelve-digit UPRN is a
    // line on a ticket that nobody can act on without going and looking.
    outcome: (d) => {
      if (!Array.isArray(d.changes) || !d.changes.length) return undefined;
      const named = d.changes.map(changeText).filter((v): v is string => Boolean(v));
      if (!named.length) return d.changes.length === 1 ? '1 change' : `${d.changes.length} changes`;
      const shown = named.slice(0, 3).join('; ');
      return named.length > 3 ? `${shown}; and ${named.length - 3} more` : shown;
    },
  },
  'watch.notified': {
    outcome: (d) => {
      if (d.notifyFailed) return 'The notice did not go out';
      const delivered = typeof d.delivered === 'number' ? d.delivered : undefined;
      return delivered ? `${delivered} told` : undefined;
    },
  },
  'inbox.converted': { summary: (d) => text(d.id), outcome: (d) => text(d.resolution) },
  'inbox.dismissed': { summary: (d) => text(d.id), outcome: (d) => text(d.resolution) },
  'inbox.snoozed': { summary: (d) => text(d.id), outcome: (d) => text(d.snoozeReason) },
  'supervisor.recovered': { summary: (d) => text(d.name) ?? text(d.key) },
  'supervisor.escalated': { summary: (d) => text(d.name) ?? text(d.key) },
};

/** Every identifier a row names, so scoping does not need per-action code. */
function identifiers(entry: AuditEntry): {
  ticketId?: string;
  eventId?: string;
  zenReference?: string;
  uprn?: string;
  visitId?: string;
} {
  const d = entry.detail ?? {};
  return {
    ...(text(d.ticketId) ? { ticketId: text(d.ticketId) } : {}),
    ...(text(d.eventId) ? { eventId: text(d.eventId) } : {}),
    ...(text(d.zenReference) ? { zenReference: text(d.zenReference) } : {}),
    ...(text(d.uprn) ? { uprn: text(d.uprn) } : {}),
    ...(text(d.visitId) ? { visitId: text(d.visitId) } : {}),
  };
}

/**
 * Does this row belong on the trail being asked for?
 *
 * Any one identifier matching is enough. A fault raised on a circuit and a
 * test run on the same circuit are the same piece of work whether or not
 * somebody remembered to quote the ticket number on both.
 */
function inScope(entry: AuditEntry, scope: ActivityScope): boolean {
  const names = identifiers(entry);
  for (const key of ['ticketId', 'eventId', 'zenReference', 'uprn', 'visitId'] as const) {
    const want = scope[key];
    if (want && names[key] === want) return true;
  }
  // Nothing matched — and a scope that named nothing matches nothing, rather
  // than matching everything and pasting the whole log onto a ticket.
  return false;
}

/** `Joe Kane` from the stored user, falling back to the audited email. */
function actorOf(entry: AuditEntry): ActivityEntry['actor'] {
  const name = entry.actorId ? findUserById(entry.actorId)?.name : undefined;
  const email = entry.actorEmail;
  if (!name && !email) return undefined;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

export function toActivityEntry(entry: AuditEntry): ActivityEntry {
  const detail = entry.detail ?? {};
  const renderer = RENDERERS[entry.action] ?? {};
  const actor = actorOf(entry);
  const names = identifiers(entry);
  return {
    at: entry.at,
    action: entry.action,
    summary: renderer.summary?.(detail) ?? actionPhrase(entry.action),
    ...(renderer.outcome?.(detail) ? { outcome: renderer.outcome(detail)! } : {}),
    ...(entry.automatic ? { automatic: true as const } : {}),
    ...(actor && !entry.automatic ? { actor } : {}),
    ...(names.ticketId ? { ticketId: names.ticketId } : {}),
    ...(names.eventId ? { eventId: names.eventId } : {}),
  };
}

/**
 * The trail for one piece of work, oldest first.
 *
 * Never throws: a trail is decoration on a note whose real work has already
 * happened, and a malformed log line must not fail the request that is
 * recording a raised fault.
 */
export function activityFor(scope: ActivityScope): ActivityEntry[] {
  try {
    const since = scope.since ? Date.parse(scope.since) : undefined;
    const limit = scope.limit ?? DEFAULT_LIMIT;

    const rows = readAudit(WINDOW) // newest first
      .filter((entry) => worthReporting(entry.action))
      .filter((entry) => inScope(entry, scope))
      .filter((entry) => {
        if (since === undefined || Number.isNaN(since)) return true;
        const at = Date.parse(entry.at);
        return Number.isNaN(at) ? true : at >= since;
      })
      .slice(0, limit)
      .map(toActivityEntry);

    return rows.reverse();
  } catch {
    return [];
  }
}

export const __activityTesting = { RENDERERS, identifiers, inScope };
