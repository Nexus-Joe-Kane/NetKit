import { upstream } from './errors';

export interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Retries on 429/5xx and network errors, with exponential backoff. */
  retries?: number;
  /** Provider name, used in error messages. */
  label?: string;
  /** Treat 404 as an empty result rather than an error. */
  notFoundAsNull?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * JSON fetch with timeout, bounded retries and provider-labelled errors.
 * Upstream failures must never take the whole page down, so callers are
 * expected to catch and degrade — this just makes the failure legible.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T | null> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 12_000,
    retries = 2,
    label = 'upstream',
    notFoundAsNull = false,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (res.status === 404 && notFoundAsNull) return null;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (RETRYABLE.has(res.status) && attempt < retries) {
          lastError = new Error(`${label} responded ${res.status}`);
          await sleep(2 ** attempt * 250);
          continue;
        }
        throw upstream(`${label} responded ${res.status} ${res.statusText}`.trim(), text.slice(0, 500));
      }

      if (res.status === 204) return null;
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isHttpError = err instanceof Error && err.name === 'HttpError';
      if (isHttpError) throw err;
      if (attempt < retries) {
        await sleep(2 ** attempt * 250);
        continue;
      }
      throw upstream(isAbort ? `${label} timed out after ${timeoutMs}ms` : `${label} request failed`, String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw upstream(`${label} request failed`, String(lastError));
}

/**
 * Fills `{placeholder}` tokens in a configured endpoint path and
 * URL-encodes the values.
 */
export function expandPath(template: string, params: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => encodeURIComponent(params[key] ?? ''));
}

/** Runs tasks in parallel, capturing failures per task instead of rejecting. */
export async function settleAll<T>(
  tasks: Array<{ key: string; run: () => Promise<T> }>,
): Promise<Record<string, { ok: true; value: T; ms: number } | { ok: false; error: Error; ms: number }>> {
  const entries = await Promise.all(
    tasks.map(async ({ key, run }) => {
      const started = Date.now();
      try {
        const value = await run();
        return [key, { ok: true as const, value, ms: Date.now() - started }] as const;
      } catch (err) {
        return [
          key,
          { ok: false as const, error: err instanceof Error ? err : new Error(String(err)), ms: Date.now() - started },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
