/**
 * Microsoft Entra ID sign-in, as data and pure functions.
 *
 * Shared rather than server-only because the parts worth testing hardest are
 * the parts with no I/O in them: what the authorization URL says, and whether
 * a returned identity token is one we asked for. Both are decided here, where
 * a test can walk every branch without a tenant to talk to.
 *
 * The flow is the authorization code flow with PKCE. A confidential client on
 * a server does not strictly need PKCE — it has a secret — but adding the
 * verifier costs one hash and closes the case where an authorization code is
 * intercepted in a redirect, so it is not optional here.
 */

/** Where Entra lives. Not configurable: it is Microsoft's own front door. */
export const MICROSOFT_LOGIN_HOST = 'https://login.microsoftonline.com';

/**
 * Scopes asked for at sign-in.
 *
 * Deliberately the smallest set that answers "who is this": an identity
 * token, a display name and an email address. NetKit reads no mail, no
 * calendar and no directory — so it asks for none of it, and an
 * administrator approving the app consent screen can see that.
 */
export const ENTRA_SCOPES = ['openid', 'profile', 'email'] as const;

/** The redirect the app registration must list, relative to the portal root. */
export const CALLBACK_PATH = '/api/auth/microsoft/callback';

/** Tenant values that mean "any Microsoft account", not one organisation. */
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers']);

/**
 * Clock skew allowed when checking token times.
 *
 * Small, but not zero: the server's clock and Microsoft's differ by a second
 * or two routinely, and a token rejected for being issued half a second in
 * the future is an outage with no cause anybody can see.
 */
export const CLOCK_SKEW_SECONDS = 120;

export interface EntraSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /**
   * Domains allowed to create an account on first sign-in, lower case and
   * without the `@`. Empty means "anyone the tenant lets through", which is
   * only safe on a single-tenant registration — `provisioningProblem` is
   * what enforces that.
   */
  allowedDomains: string[];
}

/** True where the tenant is one named organisation rather than all of them. */
export const isSingleTenant = (tenantId: string): boolean =>
  Boolean(tenantId) && !MULTI_TENANT.has(tenantId.trim().toLowerCase());

/** The OpenID discovery document for a tenant. */
export const discoveryUrl = (tenantId: string): string =>
  `${MICROSOFT_LOGIN_HOST}/${encodeURIComponent(tenantId.trim())}/v2.0/.well-known/openid-configuration`;

/**
 * What is stopping Microsoft sign-in from being offered.
 *
 * Returned as a sentence for the sign-in screen and the admin portal, because
 * "the button is missing" is the worst possible way to communicate a
 * half-filled configuration.
 */
export function entraProblem(settings: Partial<EntraSettings> | undefined): string | undefined {
  const tenantId = settings?.tenantId?.trim();
  const clientId = settings?.clientId?.trim();
  const clientSecret = settings?.clientSecret?.trim();
  const missing: string[] = [];
  if (!tenantId) missing.push('directory (tenant) ID');
  if (!clientId) missing.push('application (client) ID');
  if (!clientSecret) missing.push('client secret');
  if (missing.length === 3) return 'Microsoft sign-in is not set up.';
  if (missing.length) {
    return `Microsoft sign-in is half configured — the ${missing.join(' and the ')} ${
      missing.length > 1 ? 'are' : 'is'
    } still missing.`;
  }
  return undefined;
}

export const entraConfigured = (settings: Partial<EntraSettings> | undefined): boolean =>
  entraProblem(settings) === undefined;

/** The full redirect URI, which must match the app registration exactly. */
export function redirectUri(publicUrl: string): string {
  const base = publicUrl.trim().replace(/\/+$/, '');
  return `${base}${CALLBACK_PATH}`;
}

export interface AuthorizeRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  /** The S256 challenge, base64url, derived from the verifier by the caller. */
  codeChallenge: string;
  /** Pre-fills the account picker when we already know who is signing in. */
  loginHint?: string;
  /**
   * Forces a fresh interactive sign-in.
   *
   * Used for the re-authentication case rather than the ordinary one: making
   * every sign-in prompt would defeat the point of single sign-on.
   */
  prompt?: 'select_account' | 'login' | 'none';
}

export function authorizeUrl(req: AuthorizeRequest): string {
  const url = new URL(req.authorizationEndpoint);
  const q = url.searchParams;
  q.set('client_id', req.clientId);
  q.set('response_type', 'code');
  q.set('redirect_uri', req.redirectUri);
  q.set('response_mode', 'query');
  q.set('scope', ENTRA_SCOPES.join(' '));
  q.set('state', req.state);
  q.set('nonce', req.nonce);
  q.set('code_challenge', req.codeChallenge);
  q.set('code_challenge_method', 'S256');
  if (req.loginHint) q.set('login_hint', req.loginHint);
  if (req.prompt) q.set('prompt', req.prompt);
  return url.toString();
}

/**
 * The claims NetKit reads out of an identity token.
 *
 * Everything is optional because the token is written by somebody else. A
 * tenant that does not emit `email` is a normal tenant, not a broken one, and
 * the code has to cope rather than throw.
 */
export interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  /** Immutable object id of the user within the tenant. */
  oid?: string;
  tid?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  preferred_username?: string;
  upn?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  /**
   * How the user authenticated. `mfa` in here is Entra saying a second
   * factor was satisfied — which is the whole basis for NetKit not then
   * emailing a code of its own.
   */
  amr?: string[];
  [key: string]: unknown;
}

export interface ClaimsCheck {
  clientId: string;
  tenantId: string;
  /** The nonce this sign-in was started with. */
  nonce: string;
  /** Seconds since the epoch. */
  now: number;
}

const audienceIncludes = (aud: IdTokenClaims['aud'], clientId: string): boolean =>
  Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;

/**
 * Why an identity token cannot be trusted, or `undefined` if it can.
 *
 * The signature is checked separately, by the caller, against the tenant's
 * published keys — a valid signature over the wrong claims is exactly the
 * attack this half exists to stop.
 */
export function claimsProblem(claims: IdTokenClaims | undefined, check: ClaimsCheck): string | undefined {
  if (!claims) return 'The identity token could not be read.';

  if (!audienceIncludes(claims.aud, check.clientId)) {
    return 'That identity token was issued for a different application.';
  }

  /*
   * The issuer must name the tenant we configured. Checking the tenant id
   * inside the issuer rather than only the `tid` claim matters: `tid` is a
   * claim like any other, while the issuer is what the signing keys were
   * fetched for.
   */
  if (isSingleTenant(check.tenantId)) {
    const tenant = check.tenantId.trim().toLowerCase();
    const issuer = (claims.iss ?? '').toLowerCase();
    if (!issuer.startsWith(`${MICROSOFT_LOGIN_HOST}/`) || !issuer.includes(tenant)) {
      return 'That identity token came from a different Microsoft directory.';
    }
    if (claims.tid && claims.tid.toLowerCase() !== tenant) {
      return 'That account belongs to a different Microsoft directory.';
    }
  } else if (!(claims.iss ?? '').toLowerCase().startsWith(`${MICROSOFT_LOGIN_HOST}/`)) {
    return 'That identity token did not come from Microsoft.';
  }

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < check.now) {
    return 'That sign-in took too long and has expired. Try again.';
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > check.now) {
    return 'That identity token is not valid yet — check the server clock.';
  }

  if (!claims.nonce || claims.nonce !== check.nonce) {
    return 'That sign-in did not match the one this browser started. Try again.';
  }

  if (!claims.oid && !claims.sub) return 'The identity token names no user.';

  return undefined;
}

/** True where Entra says a second factor was satisfied. */
export const mfaSatisfied = (claims: IdTokenClaims | undefined): boolean =>
  Boolean(claims?.amr?.some((m) => m.toLowerCase() === 'mfa'));

/*
 * Shape-checks an address before it is used as an account key.
 *
 * The `#` exclusion is the one that matters and is not obvious. Entra puts
 * values like `live.com#joe@example.com` in `preferred_username` for accounts
 * federated from a consumer Microsoft account: it parses as an email address
 * and is not one, so keying an account on it silently creates a second
 * account for somebody who already has one.
 */
const looksLikeEmail = (value: string | undefined): boolean =>
  typeof value === 'string' && /^[^\s@#]+@[^\s@#.]+\.[^\s@#]+$/.test(value.trim());

/**
 * The email address to key the account on.
 *
 * Order matters. `preferred_username` is what the person typed to sign in and
 * is what they will expect to see; `email` is only present when the tenant
 * emits it; `upn` is the fallback and is sometimes not an email at all, which
 * is why every candidate is shape-checked rather than trusted.
 */
export function emailFromClaims(claims: IdTokenClaims | undefined): string | undefined {
  for (const candidate of [claims?.preferred_username, claims?.email, claims?.upn]) {
    if (looksLikeEmail(candidate)) return candidate!.trim().toLowerCase();
  }
  return undefined;
}

/** A display name, falling back through the parts to the email local part. */
export function nameFromClaims(claims: IdTokenClaims | undefined, email?: string): string {
  const name = claims?.name?.trim();
  if (name) return name;
  const parts = [claims?.given_name, claims?.family_name].map((p) => p?.trim()).filter(Boolean);
  if (parts.length) return parts.join(' ');
  const local = email?.split('@')[0];
  return local ? local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Microsoft user';
}

export const emailDomain = (email: string): string => email.trim().toLowerCase().split('@')[1] ?? '';

/**
 * Whether a first-time Microsoft sign-in may create an account, and if not,
 * why not.
 *
 * This is the security decision in the whole feature. Signing an existing
 * account in is bounded — somebody already decided that person belongs here.
 * Creating one is not, so it is refused unless the registration names a
 * single directory, and refused again if a domain allow-list is set and the
 * address is not on it. A guest account invited into the tenant for one
 * SharePoint file does not become an engineer with a line-test button.
 */
export function provisioningProblem(
  email: string | undefined,
  settings: Pick<EntraSettings, 'tenantId' | 'allowedDomains'>,
): string | undefined {
  if (!email) {
    return 'Microsoft did not return an email address for that account, so no NetKit account could be matched to it.';
  }
  if (!isSingleTenant(settings.tenantId)) {
    return (
      'That Microsoft account has no NetKit account. New accounts are only created automatically when the app ' +
      'registration names one directory, and this one is set to accept any.'
    );
  }
  const allowed = settings.allowedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (allowed.length && !allowed.includes(emailDomain(email))) {
    return `${email} is not on a domain allowed to sign in. An administrator can add the account by hand instead.`;
  }
  return undefined;
}

/**
 * How the sign-in outcome is carried back to a browser.
 *
 * The callback is a top-level navigation, so it cannot answer with JSON: it
 * has to land the person on the app with something they can read. One query
 * parameter, one message, and the app clears it from the URL.
 */
export const SSO_ERROR_PARAM = 'sso_error';

export function callbackRedirect(message?: string): string {
  if (!message) return '/';
  return `/?${SSO_ERROR_PARAM}=${encodeURIComponent(message)}`;
}
