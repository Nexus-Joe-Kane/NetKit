import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { config } from '../config';

/**
 * Recent lookups, per user.
 *
 * Support work is repetitive in a specific way: the same premises comes back
 * three times in a morning as a customer calls, calls again, and then the
 * engineer calls. Retyping a twelve-digit UPRN each time is exactly the sort
 * of friction that makes people keep a Notepad file of references, so the
 * tool keeps the list instead.
 *
 * Stored server-side rather than in the browser, so it follows the person to
 * whichever machine they are sat at — which is the whole point for an
 * engineer moving between a desk and a laptop.
 */

export interface RecentLookup {
  /** What was typed, normalised — safe to re-submit verbatim. */
  query: string;
  kind: string;
  /** The premises it landed on, where it resolved to one. */
  label?: string;
  uprn?: string;
  postcode?: string;
  at: string;
}

/** Deliberately short. A list you have to scroll is not a shortcut. */
const PER_USER = 10;

interface RecentsFile {
  [userId: string]: RecentLookup[];
}

const recentsPath = (): string => join(resolvePath(config().dataDir), 'recents.json');

let cache: RecentsFile | null = null;

function state(): RecentsFile {
  if (!cache) {
    try {
      cache = existsSync(recentsPath()) ? (JSON.parse(readFileSync(recentsPath(), 'utf8')) as RecentsFile) : {};
    } catch {
      cache = {};
    }
  }
  return cache;
}

function persist(): void {
  try {
    const path = recentsPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state()), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // A convenience list is never worth failing a lookup over.
  }
}

/** The key two entries are considered the same lookup by. */
const identityOf = (entry: RecentLookup): string => (entry.uprn ? `uprn:${entry.uprn}` : `q:${entry.query.toLowerCase()}`);

/**
 * Records a lookup. Re-looking at the same premises moves it to the top
 * rather than adding a second row — a list of the same address ten times is
 * worse than no list.
 */
export function recordLookup(userId: string, entry: Omit<RecentLookup, 'at'>): void {
  if (!userId || !entry.query.trim()) return;
  const next: RecentLookup = { ...entry, at: new Date().toISOString() };
  const id = identityOf(next);
  const existing = state()[userId] ?? [];
  state()[userId] = [next, ...existing.filter((e) => identityOf(e) !== id)].slice(0, PER_USER);
  persist();
}

export function recentLookups(userId: string): RecentLookup[] {
  if (!userId) return [];
  return state()[userId] ?? [];
}

export function clearRecentLookups(userId: string): void {
  if (!userId || !state()[userId]) return;
  delete state()[userId];
  persist();
}

/** Test hook — drops the in-memory copy so the file is re-read. */
export function resetRecents(): void {
  cache = null;
}
