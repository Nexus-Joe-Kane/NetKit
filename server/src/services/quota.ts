import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { config } from '../config';
import { settings } from '../auth/store';

/**
 * Per-user daily counters.
 *
 * Two things in NetKit need to be rationed rather than merely logged:
 *
 * - **Availability checks.** Zen are explicit that `/api/availability/check`
 *   is not for bulk work, and the response carries a fair-use quota. Nothing
 *   stops an operator pasting a hundred postcodes in a row, so each user gets
 *   a daily budget and hits a clear refusal instead of burning the account's
 *   allowance for everyone.
 * - **Orders.** An order spends real money and books a real engineer. A loop
 *   bug that places forty provides is a very bad afternoon, so the count is
 *   capped low by default and the cap is adjustable by an admin.
 *
 * The counters live in a small JSON file next to the rest of the store, keyed
 * by day. They are deliberately *not* in the audit log: availability checks
 * are far too frequent to append a line each, and the audit log is
 * append-only evidence rather than a counter.
 *
 * The day rolls over at UTC midnight. That is a documented simplification —
 * for one to two hours of a British summer evening a budget resets slightly
 * early — and it avoids a timezone database for a fair-use guard.
 */

export type QuotaKind = 'availability' | 'order';

interface QuotaFile {
  day: string;
  counts: Record<string, number>;
}

export interface QuotaState {
  kind: QuotaKind;
  used: number;
  /** `0` means unlimited. */
  limit: number;
  remaining: number;
  allowed: boolean;
  day: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const quotaPath = (): string => join(resolvePath(config().dataDir), 'quota.json');

let cache: QuotaFile | null = null;

function state(): QuotaFile {
  if (!cache) {
    try {
      cache = existsSync(quotaPath())
        ? (JSON.parse(readFileSync(quotaPath(), 'utf8')) as QuotaFile)
        : { day: today(), counts: {} };
    } catch {
      cache = { day: today(), counts: {} };
    }
  }
  // A day boundary crossed while the process was running, or while it was
  // stopped, wipes the counts rather than carrying them forward.
  if (cache.day !== today()) cache = { day: today(), counts: {} };
  return cache;
}

function persist(): void {
  try {
    const path = quotaPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state()), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // A counter that cannot be written must not break the request. The
    // in-memory count still applies for the life of this process.
  }
}

const key = (kind: QuotaKind, userId: string): string => `${kind}:${userId}`;

/** The configured ceiling for a kind. `0` disables the limit entirely. */
export function quotaLimit(kind: QuotaKind): number {
  if (kind === 'order') return Math.max(0, settings().ordering?.dailyCapPerUser ?? 3);
  return Math.max(0, config().quotas.availabilityPerUserPerDay);
}

export function quotaUsed(kind: QuotaKind, userId: string): number {
  return state().counts[key(kind, userId)] ?? 0;
}

/** Reads the quota without spending any of it. */
export function quotaState(kind: QuotaKind, userId: string): QuotaState {
  const limit = quotaLimit(kind);
  const used = quotaUsed(kind, userId);
  return {
    kind,
    used,
    limit,
    remaining: limit === 0 ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    allowed: limit === 0 || used < limit,
    day: state().day,
  };
}

/**
 * Spends one unit and returns the state *after* spending.
 *
 * Callers check `allowed` before doing the work; this is called only once the
 * work is actually going ahead, so a refused request does not consume budget.
 */
export function consumeQuota(kind: QuotaKind, userId: string): QuotaState {
  const s = state();
  s.counts[key(kind, userId)] = (s.counts[key(kind, userId)] ?? 0) + 1;
  persist();
  return quotaState(kind, userId);
}

/** Gives a user their budget back — used when work was charged but failed. */
export function refundQuota(kind: QuotaKind, userId: string): void {
  const s = state();
  const k = key(kind, userId);
  if (!s.counts[k]) return;
  s.counts[k] -= 1;
  persist();
}

export interface QuotaRow {
  userId: string;
  kind: QuotaKind;
  used: number;
  limit: number;
}

/** Everything spent today, for the admin portal. */
export function quotaSummary(): { day: string; limits: Record<QuotaKind, number>; rows: QuotaRow[] } {
  const s = state();
  const rows: QuotaRow[] = Object.entries(s.counts)
    .map(([k, used]): QuotaRow | null => {
      const idx = k.indexOf(':');
      const kind = k.slice(0, idx);
      if (kind !== 'availability' && kind !== 'order') return null;
      return { userId: k.slice(idx + 1), kind, used, limit: quotaLimit(kind) };
    })
    .filter((r): r is QuotaRow => r !== null)
    .sort((a, b) => b.used - a.used);
  return {
    day: s.day,
    limits: { availability: quotaLimit('availability'), order: quotaLimit('order') },
    rows,
  };
}

/** Test hook — drops the in-memory copy so the file is re-read. */
export function resetQuota(): void {
  cache = null;
}
