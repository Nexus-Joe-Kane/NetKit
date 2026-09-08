import { config, type BtProductConfig } from '../../config';
import { fetchJson } from '../../lib/http';
import { notConfigured, upstream } from '../../lib/errors';

/**
 * BT developer platform client.
 *
 * BT does not publish base URLs, token endpoints or the auth scheme without
 * an account, so all of it is configuration. Two schemes are supported: a
 * static API key header, and OAuth2 client credentials — whichever the
 * credentials pack turns out to use, it is an env change rather than a code
 * change.
 */

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenState>();

async function bearerToken(key: string, product: BtProductConfig): Promise<string> {
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;

  if (!product.tokenUrl) {
    throw notConfigured(`No token URL configured for ${key}. Set ${envPrefix(key)}_TOKEN_URL or BT_TOKEN_URL.`);
  }

  const basic = Buffer.from(`${product.clientId}:${product.clientSecret}`).toString('base64');
  const res = await fetch(product.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw notConfigured(`BT token request for ${key} failed with ${res.status}. Check the client id and secret.`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw upstream(`BT token response for ${key} contained no access_token`);

  tokens.set(key, {
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  });
  return json.access_token;
}

const envPrefix = (key: string): string => `BT_${key.replace(/^bt-/, '').replace(/-/g, '_').toUpperCase()}`;

export interface BtCallOptions {
  /** Path appended to the product's base URL. */
  path?: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  emptyAsNull?: boolean;
}

/** Issues an authenticated call against one BT product. */
export async function btCall<T>(productKey: string, opts: BtCallOptions = {}): Promise<T | null> {
  const cfg = config();
  const product = cfg.bt.products[productKey];

  if (!product?.apiKey && !product?.clientId) {
    throw notConfigured(
      `${productKey} is not configured. Request access at developer.bt.com, then set ${envPrefix(productKey)}_KEY ` +
        `(or ${envPrefix(productKey)}_CLIENT_ID and _CLIENT_SECRET).`,
    );
  }
  if (!product.baseUrl) {
    throw notConfigured(
      `${productKey} has credentials but no base URL. Set ${envPrefix(productKey)}_BASE_URL from your BT credentials pack.`,
    );
  }

  const url = new URL(`${product.baseUrl.replace(/\/$/, '')}${opts.path ?? ''}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  // Client credentials take precedence when both are present.
  const headers: Record<string, string> = product.clientId
    ? { Authorization: `Bearer ${await bearerToken(productKey, product)}` }
    : { apikey: product.apiKey, 'X-API-Key': product.apiKey, Authorization: `Bearer ${product.apiKey}` };

  return fetchJson<T>(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    label: `BT ${productKey}`,
    timeoutMs: cfg.requestTimeoutMs,
    ...(opts.emptyAsNull ? { notFoundAsNull: true } : {}),
  });
}

export function resetBtTokens(): void {
  tokens.clear();
}
