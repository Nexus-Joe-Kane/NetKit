import { config, type GiacomScope } from '../../config';
import { fetchJson } from '../../lib/http';
import { notConfigured, upstream } from '../../lib/errors';

/**
 * Giacom Integrations API client.
 *
 * OAuth 2.0 client credentials, exactly as their published security scheme
 * specifies. Scope is bound to the token — Giacom define twenty-one distinct
 * scopes — so tokens are cached per scope, the same as Zen.
 *
 * Two differences from the Zen client, both from Giacom's own spec:
 *
 * 1. Giacom's token endpoint is a standard OAuth2 host (`auth.…/oauth2/token`)
 *    rather than a bespoke one, and accepts the credentials as HTTP Basic.
 * 2. Their scope strings are namespaced (`integrations/serviceInventory.read`),
 *    which matters because a token minted for the wrong scope fails at the
 *    call rather than at the token request — so the scope is named at every
 *    call site instead of being global.
 */

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

const tokens = new Map<GiacomScope, TokenState>();
/** In-flight requests, so a burst of calls mints one token per scope. */
const inflight = new Map<GiacomScope, Promise<string>>();

async function mintToken(scope: GiacomScope): Promise<string> {
  const giacom = config().giacom;
  const basic = Buffer.from(`${giacom.clientId}:${giacom.clientSecret}`).toString('base64');

  const res = await fetch(giacom.tokenUrl, {
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
        `Giacom rejected the token request for scope "${scope}" (${res.status}). ` +
          'Check GIACOM_CLIENT_ID / GIACOM_CLIENT_SECRET, and that your tenant is granted this scope — ' +
          'they are granted individually, so a working credential can still be refused one scope.',
      );
    }
    throw upstream(`Giacom token endpoint returned ${res.status}`, body.slice(0, 400));
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw upstream('Giacom token response contained no access_token');

  // A minute early, so a token never expires mid-request.
  tokens.set(scope, {
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  });
  return json.access_token;
}

async function tokenFor(scope: GiacomScope): Promise<string> {
  const giacom = config().giacom;
  if (!giacom.configured) {
    throw notConfigured('Giacom credentials are not configured. Set GIACOM_CLIENT_ID and GIACOM_CLIENT_SECRET.');
  }
  if (!giacom.scopes.includes(scope)) {
    throw notConfigured(
      `Giacom scope "${scope}" is not in GIACOM_SCOPES, so it is not attempted. ` +
        'Add it once Giacom confirm your tenant has it.',
    );
  }

  const cached = tokens.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const pending = inflight.get(scope);
  if (pending) return pending;

  const run = mintToken(scope).finally(() => inflight.delete(scope));
  inflight.set(scope, run);
  return run;
}

export interface GiacomCallOptions {
  scope: GiacomScope;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Treat 404 and an empty body as `null` rather than an error. */
  emptyAsNull?: boolean;
}

export async function giacomCall<T>(path: string, opts: GiacomCallOptions): Promise<T | null> {
  const cfg = config();
  const url = new URL(`${cfg.giacom.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);

  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const token = await tokenFor(opts.scope);

  return fetchJson<T>(url.toString(), {
    method: opts.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    label: `Giacom (${cfg.giacom.environment})`,
    timeoutMs: cfg.requestTimeoutMs,
    ...(opts.emptyAsNull ? { notFoundAsNull: true } : {}),
  });
}

/** True when credentials exist and this scope was granted. */
export function giacomReady(scope: GiacomScope): boolean {
  const giacom = config().giacom;
  return giacom.configured && giacom.scopes.includes(scope);
}

/** Verifies credentials by minting a token. Used by the admin health board. */
export async function giacomPing(scope: GiacomScope): Promise<{ ok: boolean; detail: string }> {
  try {
    await tokenFor(scope);
    return { ok: true, detail: `Token obtained for scope ${scope}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Recovery hook — drops cached tokens so the next call re-mints. */
export function resetGiacomTokens(): void {
  tokens.clear();
  inflight.clear();
}
