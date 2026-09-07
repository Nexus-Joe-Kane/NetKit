import { config, type ZenScope } from '../../config';
import { fetchJson } from '../../lib/http';
import { notConfigured, upstream } from '../../lib/errors';

/**
 * Zen Indirect API client.
 *
 * Implements the OAuth 2.0 client-credentials flow exactly as the Zen OAuth
 * overview specifies: credentials as HTTP Basic, form-encoded body, and the
 * scope named in the token request. Because scope is bound to the token,
 * tokens are cached per scope rather than globally.
 */

type Gateway = 'self-service' | 'assurance';

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

/** One cached token per scope. */
const tokens = new Map<ZenScope, TokenState>();
/** In-flight token requests, so a burst of calls mints one token. */
const inflight = new Map<ZenScope, Promise<string>>();

async function mintToken(scope: ZenScope): Promise<string> {
  const zen = config().zen;
  const basic = Buffer.from(`${zen.clientId}:${zen.clientSecret}`).toString('base64');

  const res = await fetch(zen.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 400 || res.status === 401) {
      throw notConfigured(
        `Zen rejected the token request for scope "${scope}" (${res.status}). ` +
          'Check ZEN_CLIENT_ID / ZEN_CLIENT_SECRET, and that your credentials are granted this scope.',
      );
    }
    throw upstream(`Zen token endpoint returned ${res.status}`, body.slice(0, 400));
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw upstream('Zen token response contained no access_token');

  // Refresh a minute early so a token never expires mid-request.
  tokens.set(scope, {
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  });
  return json.access_token;
}

async function tokenFor(scope: ZenScope): Promise<string> {
  const zen = config().zen;
  if (!zen.configured) {
    throw notConfigured('Zen API credentials are not configured. Set ZEN_CLIENT_ID and ZEN_CLIENT_SECRET.');
  }
  if (!zen.scopes.includes(scope)) {
    throw notConfigured(
      `Zen scope "${scope}" is not enabled for these credentials. Add it to ZEN_SCOPES once your account manager grants it.`,
    );
  }

  const cached = tokens.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const pending = inflight.get(scope);
  if (pending) return pending;

  const promise = mintToken(scope).finally(() => inflight.delete(scope));
  inflight.set(scope, promise);
  return promise;
}

export interface ZenCallOptions {
  gateway?: Gateway;
  scope: ZenScope;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Query parameters. Zen uses dotted names such as `request.postCode`. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Treat 404/204 as "no result" instead of throwing. */
  emptyAsNull?: boolean;
}

/** Issues an authenticated call against one of the two Zen gateways. */
export async function zenCall<T>(path: string, opts: ZenCallOptions): Promise<T | null> {
  const cfg = config();
  const base = opts.gateway === 'assurance' ? cfg.zen.assuranceBaseUrl : cfg.zen.selfServiceBaseUrl;
  const url = new URL(`${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);

  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const token = await tokenFor(opts.scope);

  return fetchJson<T>(url.toString(), {
    method: opts.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    label: `Zen ${opts.gateway ?? 'self-service'}`,
    timeoutMs: cfg.requestTimeoutMs,
    ...(opts.emptyAsNull ? { notFoundAsNull: true } : {}),
  });
}

/** Verifies credentials by minting a token. Used by the admin health check. */
export async function zenPing(scope: ZenScope): Promise<{ ok: boolean; detail: string }> {
  try {
    await tokenFor(scope);
    return { ok: true, detail: `Token obtained for scope ${scope}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Test/diagnostic hook — clears all cached tokens. */
export function resetZenTokens(): void {
  tokens.clear();
  inflight.clear();
}
