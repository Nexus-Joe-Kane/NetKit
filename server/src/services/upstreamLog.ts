import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { upstreamFailure, type UpstreamFailure } from '@sw/shared';
import { config } from '../config';

/**
 * The record of upstream refusals, on disk.
 *
 * On disk rather than in memory because Passenger runs several worker
 * processes: the 401 an engineer saw happened in one worker, and the admin
 * page asking about it is served by another. An in-memory ring buffer would
 * show an empty log to the person trying to report the problem.
 *
 * Append-only JSONL, written with a single `appendFileSync`. Appends under
 * O_APPEND do not interleave for writes this small, so several workers can
 * write to it without the read-modify-write dance the credential vault
 * needs — there is nothing to read first.
 */

const FILENAME = 'upstream-failures.log';
/** Rotated at this size, keeping one previous file. */
const MAX_BYTES = 512 * 1024;
/** How many entries an admin page will ever want. */
const DEFAULT_LIMIT = 40;

let overrideDir: string | null = null;

/** Test hook. */
export function useUpstreamLogDir(dir: string | null): void {
  overrideDir = dir;
}

function logPath(): string | null {
  try {
    const dir = overrideDir ?? config().dataDir;
    if (!dir) return null;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, FILENAME);
  } catch {
    return null;
  }
}

function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    /* Rotation is housekeeping. Failing it must not lose the new entry. */
  }
}

/**
 * Records one failed upstream call.
 *
 * Never throws. It is called from the error path of every provider request,
 * and a diagnostics log that can turn a provider outage into a crashed
 * request is worse than no log at all.
 */
export function recordUpstreamFailure(entry: Omit<UpstreamFailure, 'at'>): void {
  try {
    const path = logPath();
    if (!path) return;
    rotateIfLarge(path);
    appendFileSync(path, `${JSON.stringify(upstreamFailure(entry))}\n`, { mode: 0o600 });
  } catch {
    /* ignored on purpose */
  }
}

const parseLines = (text: string): UpstreamFailure[] => {
  const out: UpstreamFailure[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as UpstreamFailure;
      if (parsed && typeof parsed.at === 'string' && typeof parsed.label === 'string') out.push(parsed);
    } catch {
      /* A truncated last line from a rotation is not worth failing over. */
    }
  }
  return out;
};

/**
 * The most recent failures, newest first.
 *
 * `label` matches loosely and case-insensitively, so "zen" finds both
 * `Zen assurance` and `Zen self-service` — which is what somebody asking
 * "what is Zen doing" means.
 */
export function recentFailures(options: { label?: string; limit?: number } = {}): UpstreamFailure[] {
  const path = logPath();
  if (!path) return [];
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const needle = options.label?.trim().toLowerCase();
  return parseLines(text)
    .filter((e) => !needle || e.label.toLowerCase().includes(needle))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(1, options.limit ?? DEFAULT_LIMIT));
}

/** Empties the log. Used by the admin page's "clear" and by tests. */
export function clearUpstreamLog(): void {
  const path = logPath();
  if (!path) return;
  for (const candidate of [path, `${path}.1`]) {
    try {
      if (existsSync(candidate)) unlinkSync(candidate);
    } catch {
      /* ignored */
    }
  }
}
