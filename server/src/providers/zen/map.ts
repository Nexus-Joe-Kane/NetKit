/**
 * Tolerant field mapping for Zen API responses.
 *
 * The exact JSON keys Zen returns are confirmed from their API docs; until
 * then these helpers accept the several plausible spellings for each field
 * (camelCase, snake_case, SHOUTED) so a schema change is a one-line edit
 * rather than a rewrite. Anything unmapped is preserved on the record so
 * nothing is silently lost.
 */

export type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the first present value from a list of candidate key paths. */
export function pick<T = unknown>(source: unknown, ...paths: string[]): T | undefined {
  if (!isObject(source)) return undefined;
  for (const path of paths) {
    let cursor: unknown = source;
    let found = true;
    for (const segment of path.split('.')) {
      if (!isObject(cursor) || !(segment in cursor)) {
        found = false;
        break;
      }
      cursor = cursor[segment];
    }
    if (found && cursor !== null && cursor !== undefined && cursor !== '') return cursor as T;
  }
  return undefined;
}

export function pickString(source: unknown, ...paths: string[]): string | undefined {
  const v = pick(source, ...paths);
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

export function pickNumber(source: unknown, ...paths: string[]): number | undefined {
  const v = pick(source, ...paths);
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function pickBool(source: unknown, ...paths: string[]): boolean | undefined {
  const v = pick(source, ...paths);
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'available', 'enabled'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'unavailable', 'disabled'].includes(s)) return false;
  return undefined;
}

/** Normalises an ISO-ish date to `YYYY-MM-DD`, or undefined. */
export function pickDate(source: unknown, ...paths: string[]): string | undefined {
  const s = pickString(source, ...paths);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    // Accept UK-format dates too.
    const m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return undefined;
  }
  return d.toISOString().slice(0, 10);
}

/** Finds the array of results in a response that may or may not be wrapped. */
export function pickArray(source: unknown, ...paths: string[]): unknown[] {
  if (Array.isArray(source)) return source;
  const v = pick(source, ...paths);
  if (Array.isArray(v)) return v;
  return [];
}
