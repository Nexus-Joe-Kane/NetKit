import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  WATCH_HISTORY_LIMIT,
  describeChanges,
  type SiteReport,
  type WatchRecord,
  type WatchSnapshot,
} from '@sw/shared';
import { config } from '../config';

/**
 * Watched premises, per user.
 *
 * Stored server-side, because the whole point is that a check happens while
 * nobody is looking at the page — a browser-side list could not do that.
 * Same flat-file discipline as the rest of `DATA_DIR`: read once, written
 * atomically, and never worth failing a request over.
 */

interface WatchFile {
  [userId: string]: WatchRecord[];
}

/**
 * A ceiling per person.
 *
 * Every watch is a real availability check on a schedule, so an unbounded
 * list would quietly become a standing load on the wholesale account. Twenty
 * is more than anyone tracks by hand and small enough to be honest about.
 */
export const WATCH_LIMIT_PER_USER = 20;

const watchPath = (): string => join(resolvePath(config().dataDir), 'watches.json');

let cache: WatchFile | null = null;

function state(): WatchFile {
  if (!cache) {
    try {
      cache = existsSync(watchPath()) ? (JSON.parse(readFileSync(watchPath(), 'utf8')) as WatchFile) : {};
    } catch {
      cache = {};
    }
  }
  return cache;
}

function persist(): void {
  try {
    const path = watchPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state()), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Losing a watch is bad; failing the request that created it is worse.
  }
}

/** Reduces a report to the handful of facts a change is judged against. */
export function snapshotOf(report: SiteReport): WatchSnapshot {
  const offers = report.broadband?.offers ?? [];
  const sellable = offers.filter((o) => o.serviceability !== 'footprint');
  const orderable = sellable.filter((o) => o.status === 'available');
  const headline = report.broadband?.headline;
  const fttp = report.broadband?.openreach?.fttp;

  return {
    ...(headline?.technology ? { bestTechnology: headline.technology } : {}),
    ...(headline?.downMbps != null ? { bestDownMbps: headline.downMbps } : {}),
    orderableCount: orderable.length,
    // Sorted so the comparison is about content rather than provider order.
    technologies: [...new Set(sellable.map((o) => o.technology))].sort(),
    ...(fttp?.buildStatus ? { fttpBuildStatus: fttp.buildStatus } : {}),
    ...(fttp?.rfsDate ? { fttpRfsDate: fttp.rfsDate } : {}),
    takenAt: new Date().toISOString(),
  };
}

export function listWatches(userId: string): WatchRecord[] {
  if (!userId) return [];
  return state()[userId] ?? [];
}

/** Every watch across every user, for the scheduled sweep. */
export function allWatches(): Array<{ userId: string; watch: WatchRecord }> {
  return Object.entries(state()).flatMap(([userId, watches]) =>
    watches.map((watch) => ({ userId, watch })),
  );
}

export type AddWatchResult =
  | { ok: true; watch: WatchRecord }
  | { ok: false; reason: 'duplicate' | 'limit' | 'no_uprn'; message: string };

export function addWatch(userId: string, report: SiteReport): AddWatchResult {
  const uprn = report.uprn ?? report.address.uprn;
  if (!uprn) {
    return {
      ok: false,
      reason: 'no_uprn',
      message: 'This premises has no UPRN, so there is nothing stable to re-check it by.',
    };
  }

  const existing = state()[userId] ?? [];
  if (existing.some((w) => w.uprn === uprn)) {
    return { ok: false, reason: 'duplicate', message: 'You are already watching this premises.' };
  }
  if (existing.length >= WATCH_LIMIT_PER_USER) {
    return {
      ok: false,
      reason: 'limit',
      message: `${WATCH_LIMIT_PER_USER} watches is the limit — each one is a scheduled availability check against the wholesale account.`,
    };
  }

  const watch: WatchRecord = {
    id: randomUUID(),
    uprn,
    address: report.address.singleLine,
    postcode: report.address.postcode,
    createdAt: new Date().toISOString(),
    // Seeded from the report already in hand, so adding a watch costs no
    // extra call and the first comparison is against what the person saw.
    snapshot: snapshotOf(report),
    history: [],
  };

  state()[userId] = [...existing, watch];
  persist();
  return { ok: true, watch };
}

export function removeWatch(userId: string, id: string): boolean {
  const existing = state()[userId] ?? [];
  const next = existing.filter((w) => w.id !== id);
  if (next.length === existing.length) return false;
  state()[userId] = next;
  persist();
  return true;
}

/**
 * Records the result of a check.
 *
 * Returns the differences so the caller can decide whether to email — this
 * function does not send anything, because a store that sends email is a
 * store nobody can test.
 */
export function applyCheck(userId: string, id: string, report: SiteReport): string[] {
  const watches = state()[userId] ?? [];
  const watch = watches.find((w) => w.id === id);
  if (!watch) return [];

  const next = snapshotOf(report);
  const changes = describeChanges(watch.snapshot, next);
  const now = new Date().toISOString();

  watch.snapshot = next;
  watch.lastCheckedAt = now;
  delete watch.lastError;
  if (changes.length) {
    watch.lastChangedAt = now;
    watch.history = [{ at: now, changes }, ...watch.history].slice(0, WATCH_HISTORY_LIMIT);
  }

  persist();
  return changes;
}

/** Records a failed check, so a watch cannot fail silently for weeks. */
export function recordCheckFailure(userId: string, id: string, message: string): void {
  const watch = (state()[userId] ?? []).find((w) => w.id === id);
  if (!watch) return;
  watch.lastCheckedAt = new Date().toISOString();
  watch.lastError = message;
  persist();
}

/**
 * Test hook — forgets every watch, in memory and on disk.
 *
 * Both halves matter: dropping only the cache would leave the previous
 * test's watches in the file for the next read to find, which is a very
 * confusing way to fail.
 */
export function resetWatches(): void {
  cache = {};
  persist();
}

/** Test hook — drops only the in-memory copy, so the file is re-read. */
export function reloadWatches(): void {
  cache = null;
}
