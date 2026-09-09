import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { dueForCheck, sortByUrgency, type VisitRecord, type VisitState } from '@sw/shared';
import { config } from '../config';

/**
 * Booked engineer visits, so somebody can be asked whether they are still
 * needed before the free-cancellation window closes.
 *
 * Shared rather than per-user, unlike watches. A visit belongs to the desk:
 * whoever booked it may be off the day it needs checking, and a chase that
 * only the booker can see is a chase that gets missed.
 *
 * Same flat-file discipline as the rest of DATA_DIR — read once, written
 * atomically, never worth failing a request over.
 */

interface VisitFile {
  visits: VisitRecord[];
}

/**
 * How many closed visits to keep.
 *
 * Enough to answer "what did we do about that one" for a season, and bounded
 * so the file cannot grow without limit. Open visits are never trimmed.
 */
export const CLOSED_HISTORY = 300;

const visitPath = (): string => join(resolvePath(config().dataDir), 'visits.json');

let cache: VisitFile | null = null;

function state(): VisitFile {
  if (!cache) {
    try {
      cache = existsSync(visitPath())
        ? (JSON.parse(readFileSync(visitPath(), 'utf8')) as VisitFile)
        : { visits: [] };
    } catch {
      cache = { visits: [] };
    }
    if (!Array.isArray(cache.visits)) cache.visits = [];
  }
  return cache;
}

function persist(): void {
  try {
    const path = visitPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state()), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Losing the record of a visit is bad; failing the booking that created
    // it — after the customer has already been told — is worse.
  }
}

const CLOSED: VisitState[] = ['cancelled', 'attended'];

/** Trims closed visits, oldest first, keeping every open one. */
function trim(): void {
  const file = state();
  const closed = file.visits.filter((v) => CLOSED.includes(v.state));
  if (closed.length <= CLOSED_HISTORY) return;
  const keep = new Set(
    closed
      .sort((a, b) => (b.closedAt ?? b.bookedAt).localeCompare(a.closedAt ?? a.bookedAt))
      .slice(0, CLOSED_HISTORY)
      .map((v) => v.id),
  );
  file.visits = file.visits.filter((v) => !CLOSED.includes(v.state) || keep.has(v.id));
}

export interface RecordVisitInput {
  ticketId: string;
  reason: VisitRecord['reason'];
  access: VisitRecord['access'];
  slot?: VisitRecord['slot'];
  supplier?: string;
  serviceReference?: string;
  faultReference?: string;
  bookedBy?: string;
  testSide?: VisitRecord['testSide'];
}

/**
 * Records a visit that has just been booked.
 *
 * Re-booking the same ticket replaces the open record rather than adding a
 * second: a ticket has one live appointment, and two rows for it would mean
 * two chases and, sooner or later, one of them cancelling a visit the other
 * had just confirmed.
 */
export function recordVisit(input: RecordVisitInput): VisitRecord {
  const file = state();
  const visit: VisitRecord = {
    id: randomUUID(),
    ticketId: input.ticketId,
    reason: input.reason,
    access: input.access,
    ...(input.slot ? { slot: input.slot } : {}),
    ...(input.supplier ? { supplier: input.supplier } : {}),
    ...(input.serviceReference ? { serviceReference: input.serviceReference } : {}),
    ...(input.faultReference ? { faultReference: input.faultReference } : {}),
    ...(input.bookedBy ? { bookedBy: input.bookedBy } : {}),
    ...(input.testSide ? { testSide: input.testSide } : {}),
    state: 'booked',
    bookedAt: new Date().toISOString(),
  };

  file.visits = [
    ...file.visits.filter((v) => !(v.ticketId === input.ticketId && !CLOSED.includes(v.state))),
    visit,
  ];
  trim();
  persist();
  return visit;
}

export function getVisit(id: string): VisitRecord | null {
  return state().visits.find((v) => v.id === id) ?? null;
}

/**
 * The board: open visits first, urgent end first, then recent history.
 *
 * `due` is computed rather than stored, so a visit becomes due by the clock
 * moving rather than by something having remembered to mark it.
 */
export function listVisits(now: Date = new Date()): {
  open: Array<VisitRecord & { due: boolean }>;
  closed: VisitRecord[];
} {
  const file = state();
  const open = sortByUrgency(
    file.visits.filter((v) => !CLOSED.includes(v.state)),
    now,
  ).map((v) => ({ ...v, due: dueForCheck(v, now) }));

  const closed = file.visits
    .filter((v) => CLOSED.includes(v.state))
    .sort((a, b) => (b.closedAt ?? b.bookedAt).localeCompare(a.closedAt ?? a.bookedAt));

  return { open, closed };
}

/** Every visit that needs somebody to look at it, for the chase sweep. */
export function dueVisits(now: Date = new Date()): VisitRecord[] {
  return sortByUrgency(state().visits.filter((v) => dueForCheck(v, now)), now);
}

/** Marks the approver as having been asked, so he is not asked twice a day. */
export function markApprovalAsked(id: string): VisitRecord | null {
  const visit = getVisit(id);
  if (!visit) return null;
  visit.approvalAskedAt = new Date().toISOString();
  if (visit.state === 'booked') visit.state = 'checking';
  persist();
  return visit;
}

export type CloseOutcome = 'cancelled' | 'confirmed' | 'attended';

/**
 * Records the decision.
 *
 * The evidence is stored with it. Not for tidiness: the next person to see
 * this ticket needs to know a visit was dropped *because the line came back*,
 * not because somebody was clearing a list.
 */
export function closeVisit(input: {
  id: string;
  outcome: CloseOutcome;
  by?: string;
  note?: string;
  evidence?: string[];
}): VisitRecord | null {
  const visit = getVisit(input.id);
  if (!visit) return null;

  visit.state = input.outcome;
  visit.closedAt = new Date().toISOString();
  if (input.by) visit.closedBy = input.by;
  if (input.note) visit.outcomeNote = input.note;
  if (input.evidence?.length) visit.evidence = input.evidence;

  // 'confirmed' is not closed — the visit is still going ahead, and it will
  // want checking again if the slot moves.
  trim();
  persist();
  return visit;
}

/** Test hooks. Reset clears memory and disk; reload drops only the cache. */
export function resetVisits(): void {
  cache = { visits: [] };
  persist();
}

export function reloadVisits(): void {
  cache = null;
}
