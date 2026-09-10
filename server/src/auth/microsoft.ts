import { createHash, createPublicKey, createVerify, randomBytes, type webcrypto } from 'node:crypto';

/** Node's own JWK shape, which `createPublicKey` accepts directly. */
type Jwk = webcrypto.JsonWebKey;
import { authorizeUrl, claimsProblem, discoveryUrl, type IdTokenClaims } from '@sw/shared';
import { config } from '../config';
import { fetchJson } from '../lib/http';

/**
 * The Microsoft Entra ID half of sign-in: discovery, the code exchange, and
 * verifying the identity token that comes back.
 *
 * Written against the OpenID Connect discovery document rather than
 * hard-coded endpoints, because Microsoft have moved them before and the
 * document is the supported way to find them. It costs one cached request
 * per hour.
 *
 * No JOSE library. Not out of principle — this project has no native
 * dependencies at all, and one signature check over an RSA key that Node's
 * own crypto module can already build from a JWK is a smaller thing to own
 * than a dependency tree. The parts that are easy to get wrong are the claim
 * checks, and those live in `@sw/shared/entra` where they are tested
 * exhaustively.
 */

/** How long the discovery document and the signing keys are trusted for. */
const METADATA_TTL_MS = 60 * 60 * 1000;

/**
 * Signing algorithms accepted.
 *
 * An allow-list, because the classic JWT forgery is a token whose header
 * says `none`, or says `HS256` so the "signature" is an HMAC the attacker
 * can compute with the public key. Entra sign with RS256.
 */
const ALLOWED_ALGORITHMS = new Set(['RS256']);

export interface Metadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuer: string;
}

interface Cached<T> {
  value: T;
  at: number;
}

let metadataCache: (Cached<Metadata> & { tenantId: string }) | null = null;
let keyCache: (Cached<Jwk[]> & { jwksUri: string }) | null = null;

/** Test hook. Drops the discovery and key caches. */
export function resetMicrosoftCache(): void {
  metadataCache = null;
  keyCache = null;
}

const fresh = (entry: Cached<unknown> | null, now = Date.now()): boolean =>
  Boolean(entry && now - entry.at < METADATA_TTL_MS);

interface DiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  issuer?: string;
}

/**
 * Fetches (and caches) the tenant's OpenID configuration.
 *
 * Throws rather than degrading: every caller is in the middle of signing
 * somebody in, and there is no partial answer worth having.
 */
export async function metadata(): Promise<Metadata> {
  const tenantId = config().microsoft.tenantId;
  if (!tenantId) throw new Error('Microsoft sign-in is not configured.');
  if (metadataCache && metadataCache.tenantId === tenantId && fresh(metadataCache)) return metadataCache.value;

  const doc = await fetchJson<DiscoveryDocument>(discoveryUrl(tenantId), {
    label: 'Microsoft sign-in',
    timeoutMs: 8000,
    retries: 1,
  });

  const value: Metadata = {
    authorizationEndpoint: doc?.authorization_endpoint ?? '',
    tokenEndpoint: doc?.token_endpoint ?? '',
    jwksUri: doc?.jwks_uri ?? '',
    issuer: doc?.issuer ?? '',
  };
  if (!value.authorizationEndpoint || !value.tokenEndpoint || !value.jwksUri) {
    throw new Error('Microsoft did not return a usable sign-in configuration for that directory.');
  }
  metadataCache = { value, at: Date.now(), tenantId };
  return value;
}

interface JwksDocument {
  keys?: Array<Jwk & { kid?: string; use?: string; alg?: string }>;
}

async function signingKeys(jwksUri: string, force = false): Promise<Array<Jwk & { kid?: string }>> {
  if (!force && keyCache && keyCache.jwksUri === jwksUri && fresh(keyCache)) {
    return keyCache.value as Array<Jwk & { kid?: string }>;
  }
  const doc = await fetchJson<JwksDocument>(jwksUri, { label: 'Microsoft signing keys', timeoutMs: 8000, retries: 1 });
  const keys = (doc?.keys ?? []).filter((k) => k.kty === 'RSA');
  if (!keys.length) throw new Error('Microsoft returned no signing keys.');
  keyCache = { value: keys, at: Date.now(), jwksUri };
  return keys;
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/* ------------------------------------------------------------------ *
 * The identity token
 * ------------------------------------------------------------------ */

const decodeSegment = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Verifies an identity token's signature against the tenant's published
 * keys, then its claims.
 *
 * Returns the claims, or throws with a sentence fit to show somebody. The
 * order is deliberate: the signature is checked first, so no unverified
 * claim ever influences a decision, not even which key to use — the key is
 * chosen by the header's `kid` and then checked to be one Microsoft
 * published for this tenant.
 */
export async function verifyIdToken(idToken: string, expected: { nonce: string }): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Microsoft returned an identity token that could not be read.');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeSegment(headerPart) as { alg?: string; kid?: string } | undefined;
  if (!header || !header.alg || !ALLOWED_ALGORITHMS.has(header.alg)) {
    throw new Error('Microsoft returned an identity token signed in a way NetKit does not accept.');
  }

  const { jwksUri } = await metadata();
  let keys = await signingKeys(jwksUri);
  let key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    /*
     * A `kid` we have never seen is the normal case when Microsoft roll
     * their signing keys, not an attack — so refetch once before refusing.
     * Bounded to one refetch so an unknown kid cannot be used to make the
     * server hammer Microsoft.
     */
    keys = await signingKeys(jwksUri, true);
    key = keys.find((k) => k.kid === header.kid);
  }
  if (!key) throw new Error('Microsoft signed that identity token with a key they do not publish.');

  const publicKey = createPublicKey({ key: key as Jwk, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerPart}.${payloadPart}`);
  let signatureOk = false;
  try {
    signatureOk = verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new Error('That identity token failed its signature check.');

  const claims = decodeSegment(payloadPart) as IdTokenClaims | undefined;
  const problem = claimsProblem(claims, {
    clientId: config().microsoft.clientId,
    tenantId: config().microsoft.tenantId,
    nonce: expected.nonce,
    now: Math.floor(Date.now() / 1000),
  });
  if (problem) throw new Error(problem);
  return claims!;
}

/* ------------------------------------------------------------------ *
 * The code exchange
 * ------------------------------------------------------------------ */

interface TokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Swaps an authorization code for an identity token.
 *
 * Form-encoded, not JSON: the OAuth token endpoint takes
 * `application/x-www-form-urlencoded` and answers a JSON body sent anything
 * else with an unhelpful `invalid_request`.
 */
export async function exchangeCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<string> {
  const { tokenEndpoint } = await metadata();
  const { clientId, clientSecret } = config().microsoft;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
    scope: 'openid profile email',
  });

  const res = await fetchJson<TokenResponse>(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    label: 'Microsoft sign-in',
    timeoutMs: 10_000,
    // Never retried. An authorization code is single-use, so a retry after a
    // response we failed to read would be rejected as already redeemed and
    // report the wrong cause.
    retries: 0,
  });

  if (!res?.id_token) {
    const detail = res?.error_description ?? res?.error;
    throw new Error(detail ? `Microsoft refused the sign-in: ${detail}` : 'Microsoft returned no identity token.');
  }
  return res.id_token;
}

/** The authorization URL to send the browser to, plus what to remember. */
export async function beginSignIn(options: {
  redirectUri: string;
  loginHint?: string;
  prompt?: 'select_account' | 'login';
}): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
  const { authorizationEndpoint } = await metadata();
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkce();
  return {
    url: authorizeUrl({
      authorizationEndpoint,
      clientId: config().microsoft.clientId,
      redirectUri: options.redirectUri,
      state,
      nonce,
      codeChallenge: challenge,
      ...(options.loginHint ? { loginHint: options.loginHint } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    }),
    state,
    nonce,
    verifier,
  };
}
