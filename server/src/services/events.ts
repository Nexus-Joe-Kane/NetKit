import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  applyCheck,
  applyClearance,
  clearEvent,
  newWatchState,
  openEvent,
  sortEvents,
  withDiagnosis,
  type CheckOutcome,
  type CheckResult,
  type Clearance,
  type EventKind,
  type NetEvent,
  type SiteWatchState,
} from '@sw/shared';
import { config } from '../config';

/**
 * Events and the watcher's memory of each site.
 *
 * Shared, not per-user. An event belongs to the desk: whoever is on at seven
 * needs to see what the sweep found at three, and an outage only its
 * discoverer can see is an outage nobody deals with.
 *
 * One file for both halves, because they are written together on every
 * sweep — an event opening is the same moment as a watch state changing, and
 * splitting them means a crash between two writes can leave a site with an
 * event that its watch state does not know about, which is how a site ends
 * up with a second ticket every five minutes.
 *
 * Same flat-file discipline as the rest of DATA_DIR: read once, written
 * atomically, never worth failing a request over.
 */

interface EventFile {
  events: NetEvent[];
  /** Watch state, keyed by client-index key. */
  watches: Record<string, SiteWatchState>;
}

/**
 * How many cleared events to keep.
 *
 * Enough to answer "how often does this site go off" across a couple of
 * quarters, bounded so the file cannot grow without limit. Open events are
 * never trimmed.
 */
export const CLEARED_HISTORY = 500;

const eventPath = (): string => join(resolvePath(config().dataDir), 'events.json');

let cache: EventFile | null = null;

function state(): EventFile {
  if (!cache) {
    try {
      cache = existsSync(eventPath())
        ? (JSON.parse(readFileSync(eventPath(), 'utf8')) as EventFile)
        : { events: [], watches: {} };
    } catch {
      cache = { events: [], watches: {} };
    }
    if (!Array.isArray(cache.events)) cache.events = [];
    if (!cache.watches || typeof cache.watches !== 'object') cache.watches = {};
  }
  return cache;
}

function persist(): void {
  try {
    const path = eventPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state()), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Losing an event is bad. Failing the sweep that found it, and so never
    // checking the other two hundred sites, is worse.
  }
}

/** Trims cleared events, oldest first, keeping every open one. */
function trim(): void {
  const file = state();
  const cleared = file.events.filter((e) => e.status === 'cleared');
  if (cleared.length <= CLEARED_HISTORY) return;
  const drop = new Set(
    [...cleared]
      .sort((a, b) => (a.clearedAt ?? a.openedAt).localeCompare(b.clearedAt ?? b.openedAt))
      .slice(0, cleared.length - CLEARED_HISTORY)
      .map((e) => e.id),
  );
  file.events = file.events.filter((e) => !drop.has(e.id));
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export function listEvents(options: { includeCleared?: boolean } = {}): NetEvent[] {
  const all = sortEvents(state().events);
  return options.includeCleared ? all : all.filter((e) => e.status === 'open');
}

export function getEvent(id: string): NetEvent | null {
  return state().events.find((e) => e.id === id) ?? null;
}

/** The open event for a site, where there is one. */
export function openEventFor(clientKey: string, kind?: EventKind): NetEvent | null {
  return (
    state().events.find(
      (e) => e.status === 'open' && e.clientKey === clientKey && (kind ? e.kind === kind : true),
    ) ?? null
  );
}

export function watchState(clientKey: string, siteName: string): SiteWatchState {
  return state().watches[clientKey] ?? newWatchState(clientKey, siteName);
}

export function listWatchStates(): SiteWatchState[] {
  return Object.values(state().watches);
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Folds a check in and saves the result.
 *
 * The state is written whatever the action, because the counters moving is
 * itself the thing worth remembering — a site on its first failed check must
 * still be on its first failed check after a restart, or an outage never
 * reaches two and nothing is ever raised.
 */
export function recordCheck(
  clientKey: string,
  siteName: string,
  results: readonly CheckResult[],
  now = new Date().toISOString(),
): CheckOutcome {
  const outcome = applyCheck(watchState(clientKey, siteName), results, now);
  state().watches[clientKey] = outcome.state;
  persist();
  return outcome;
}

export interface RaiseInput {
  kind: EventKind;
  clientKey: string;
  clientName: string;
  siteName?: string;
  address?: string;
  uprn?: string;
  because: string;
  by?: { name?: string; email?: string };
  automatic?: boolean;
  checks?: CheckResult[];
  at?: string;
}

/**
 * Opens an event, unless one of the same kind is already open for the site.
 *
 * The guard is here rather than at the caller because there are three
 * callers — the sweep, the manual button and the fault flow — and a second
 * ticket for an outage already on the board is the failure that makes
 * somebody switch the whole thing off.
 */
export function raiseEvent(input: RaiseInput): { event: NetEvent; created: boolean } {
  const existing = openEventFor(input.clientKey, input.kind);
  if (existing) return { event: existing, created: false };

  const at = input.at ?? new Date().toISOString();
  const event = openEvent({
    id: `evt_${randomUUID().slice(0, 12)}`,
    kind: input.kind,
    clientKey: input.clientKey,
    clientName: input.clientName,
    ...(input.siteName ? { siteName: input.siteName } : {}),
    ...(input.address ? { address: input.address } : {}),
    ...(input.uprn ? { uprn: input.uprn } : {}),
    because: input.because,
    at,
    ...(input.by ? { by: input.by } : {}),
    ...(input.automatic !== undefined ? { automatic: input.automatic } : {}),
    ...(input.checks?.length ? { checks: [...input.checks] } : {}),
    watch: state().watches[input.clientKey] ?? newWatchState(input.clientKey, input.siteName ?? input.clientName),
  });

  state().events.unshift(event);

  // An outage event is pinned to the watch state so the next check knows not
  // to raise another. A stability report is not: the site is up, and the next
  // good check would read the pin as a recovery.
  if (input.kind === 'outage' || input.kind === 'fault') {
    const watch = watchState(input.clientKey, input.siteName ?? input.clientName);
    state().watches[input.clientKey] = { ...watch, openEventId: event.id };
  }

  trim();
  persist();
  return { event, created: true };
}

function replace(event: NetEvent): NetEvent {
  const file = state();
  const index = file.events.findIndex((e) => e.id === event.id);
  if (index >= 0) file.events[index] = event;
  persist();
  return event;
}

export function attachDiagnosis(
  id: string,
  diagnosis: Parameters<typeof withDiagnosis>[1],
  at = new Date().toISOString(),
): NetEvent | null {
  const event = getEvent(id);
  if (!event) return null;
  return replace(withDiagnosis(event, diagnosis, at));
}

export function attachTicket(id: string, ticketId: string, ticketUrl?: string): NetEvent | null {
  const event = getEvent(id);
  if (!event) return null;
  return replace({
    ...event,
    ticketId,
    ...(ticketUrl ? { ticketUrl } : {}),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Clears an event and applies the chosen disposition to the watch state.
 *
 * One call, because the two must not come apart. Clearing the event without
 * moving the watermark is exactly the "another email five minutes later"
 * failure the dispositions exist to prevent.
 */
export function clear(id: string, clearance: Clearance): { event: NetEvent; watch: SiteWatchState } | null {
  const event = getEvent(id);
  if (!event) return null;

  const cleared = clearEvent(event, clearance);
  const file = state();
  const index = file.events.findIndex((e) => e.id === id);
  if (index >= 0) file.events[index] = cleared;

  const watch = applyClearance(
    watchState(event.clientKey, event.siteName ?? event.clientName),
    clearance,
  );
  if (clearance.disposition === 'not-ours') {
    delete file.watches[event.clientKey];
  } else {
    file.watches[event.clientKey] = watch;
  }

  persist();
  return { event: cleared, watch };
}

/** Test hook — empties the store. */
export function resetEvents(): void {
  cache = { events: [], watches: {} };
  persist();
}

/** Drops the in-memory copy so the file is re-read, as a restart would. */
export function reloadEvents(): void {
  cache = null;
}
