import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { findNeverAuthenticated, isActionable, sortInbox, type InboxItem, type InboxState } from '@sw/shared';
import type { LineRecord } from '@sw/shared';
import { config } from '../config';

/**
 * The shared inbox.
 *
 * One list everybody sees, stored the same way as the rest of `DATA_DIR`:
 * read once, written atomically, never worth failing a request over.
 *
 * Shared rather than per-person deliberately. A per-user inbox becomes four
 * copies of the same finding, and the first person to fix it has no way of
 * telling the other three.
 */

interface InboxFile {
  items: InboxItem[];
}

/**
 * How many closed items to keep.
 *
 * The history is the point — "we dismissed this in March because the site
 * was not open" is what stops the same finding being re-investigated from
 * scratch — but it does not need to be unbounded.
 */
const CLOSED_HISTORY = 300;

const inboxPath = (): string => join(resolvePath(config().dataDir), 'inbox.json');

let cache: InboxFile | null = null;

function state(): InboxFile {
  if (!cache) {
    try {
      cache = existsSync(inboxPath()) ? (JSON.parse(readFileSync(inboxPath(), 'utf8')) as InboxFile) : { items: [] };
    } catch {
      cache = { items: [] };
    }
    if (!Array.isArray(cache.items)) cache = { items: [] };
  }
  return cache;
}

function persist(): void {
  try {
    const path = inboxPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state()), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Losing an inbox item is a nuisance; failing the request that closed one
    // is worse.
  }
}

/** Everything, newest signal first. */
export function listInbox(): { actionable: InboxItem[]; closed: InboxItem[] } {
  const now = new Date();
  const all = state().items;
  return {
    actionable: sortInbox(all.filter((i) => isActionable(i, now)), now),
    // Snoozed but not yet due sits with the closed ones: it is not
    // actionable, and hiding it entirely means nobody can find what they
    // snoozed.
    closed: all
      .filter((i) => !isActionable(i, now))
      .sort((a, b) => (b.actedAt ?? b.raisedAt).localeCompare(a.actedAt ?? a.raisedAt)),
  };
}

export interface RaiseOutcome {
  raised: number;
  seenAgain: number;
}

/**
 * Records what a sweep found.
 *
 * A finding already on the list is *not* re-raised — its `seenCount` goes up
 * and that is all. Re-raising would reset the age, lose the dismissal reason,
 * and make a thing somebody looked at last week look new again.
 *
 * A finding that has been dismissed comes back, on purpose. If the underlying
 * condition is still true a month later, the dismissal was either wrong or
 * the situation changed — and the old reason is still on the item, so
 * whoever sees it next has the history rather than a blank slate.
 */
export function raiseFindings(
  found: Array<Omit<InboxItem, 'state' | 'seenCount' | 'lastSeenAt'>>,
  now: Date = new Date(),
): RaiseOutcome {
  const items = state().items;
  const outcome: RaiseOutcome = { raised: 0, seenAgain: 0 };
  const stamp = now.toISOString();

  for (const finding of found) {
    const existing = items.find((i) => i.id === finding.id);

    if (!existing) {
      items.push({ ...finding, state: 'open', seenCount: 1, lastSeenAt: stamp });
      outcome.raised += 1;
      continue;
    }

    existing.seenCount += 1;
    existing.lastSeenAt = stamp;
    // Keep the wording fresh — "60 days" should not still say 30 next month.
    existing.subject = finding.subject;
    existing.detail = finding.detail;
    existing.evidence = finding.evidence;
    outcome.seenAgain += 1;

    // A dismissed finding that is still true is worth asking about again,
    // with its previous answer attached.
    if (existing.state === 'dismissed') {
      existing.state = 'open';
      existing.raisedAt = stamp;
    }
  }

  trim();
  persist();
  return outcome;
}

/** Keeps the closed history bounded without touching anything live. */
function trim(): void {
  const items = state().items;
  const now = new Date();
  const closed = items.filter((i) => !isActionable(i, now) && i.state !== 'snoozed');
  if (closed.length <= CLOSED_HISTORY) return;

  const doomed = new Set(
    closed
      .sort((a, b) => (a.actedAt ?? a.raisedAt).localeCompare(b.actedAt ?? b.raisedAt))
      .slice(0, closed.length - CLOSED_HISTORY)
      .map((i) => i.id),
  );
  cache = { items: items.filter((i) => !doomed.has(i.id)) };
}

export interface ActOnInput {
  id: string;
  state: Extract<InboxState, 'snoozed' | 'dismissed' | 'converted'>;
  /** Required for a dismissal: what it turned out to be. */
  resolution?: string;
  snoozedUntil?: string;
  snoozeReason?: string;
  ticketId?: string;
  actedBy?: string;
}

export type ActResult = { ok: true; item: InboxItem } | { ok: false; message: string };

/**
 * Closes, snoozes or converts an item.
 *
 * A dismissal needs a reason. Not paperwork — it is what turns a monthly nag
 * into a record of what the answer was last time, and it is the difference
 * between a list people read and a list people mute.
 */
export function actOnItem(input: ActOnInput, now: Date = new Date()): ActResult {
  const item = state().items.find((i) => i.id === input.id);
  if (!item) return { ok: false, message: 'No such inbox item.' };

  if (input.state === 'dismissed' && !input.resolution?.trim()) {
    return {
      ok: false,
      message: 'Say what it turned out to be. The next person to see this needs the answer, not a blank.',
    };
  }
  if (input.state === 'snoozed' && !input.snoozedUntil) {
    return { ok: false, message: 'A snooze needs a date to come back on.' };
  }
  if (input.state === 'converted' && !input.ticketId?.trim()) {
    return { ok: false, message: 'A converted item needs the ticket it became.' };
  }

  item.state = input.state;
  item.actedAt = now.toISOString();
  if (input.actedBy) item.actedBy = input.actedBy;
  if (input.resolution?.trim()) item.resolution = input.resolution.trim();
  if (input.snoozedUntil) item.snoozedUntil = input.snoozedUntil;
  if (input.snoozeReason?.trim()) item.snoozeReason = input.snoozeReason.trim();
  if (input.ticketId?.trim()) item.ticketId = input.ticketId.trim();

  persist();
  return { ok: true, item };
}

/** The detectors, run over whatever lines a sweep gathered. */
export function scanLines(lines: LineRecord[], now: Date = new Date()): RaiseOutcome {
  return raiseFindings(findNeverAuthenticated(lines, now), now);
}

/** Test hook — forgets everything, in memory and on disk. */
export function resetInbox(): void {
  cache = { items: [] };
  persist();
}

/** Test hook — drops only the in-memory copy, so the file is re-read. */
export function reloadInbox(): void {
  cache = null;
}
