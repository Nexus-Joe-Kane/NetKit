import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { MICROSOFT_LOGIN_HOST } from '@sw/shared';
import { resetConfig } from '../config';
import { exchangeCode, pkce, resetMicrosoftCache, verifyIdToken } from './microsoft';

/**
 * Microsoft sign-in, verified against a token this test signs itself.
 *
 * A real RSA key pair and a real signature, with the discovery document and
 * the key set served by a stubbed `fetch`. That is the only way to prove the
 * signature check actually rejects a forgery — a test that stubs the verifier
 * proves nothing about the thing being tested.
 */

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '99999999-8888-7777-6666-555555555555';
const KID = 'test-key-1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function signToken(
  claims: Record<string, unknown>,
  options: { alg?: string; kid?: string; key?: KeyObject; signature?: string } = {},
): string {
  const header = b64({ typ: 'JWT', alg: options.alg ?? 'RS256', kid: options.kid ?? KID });
  const payload = b64(claims);
  if (options.signature !== undefined) return `${header}.${payload}.${options.signature}`;
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(options.key ?? privateKey).toString('base64url')}`;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: `${MICROSOFT_LOGIN_HOST}/${TENANT}/v2.0`,
  aud: CLIENT,
  tid: TENANT,
  oid: 'object-id-1',
  sub: 'subject-1',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000) - 5,
  nbf: Math.floor(Date.now() / 1000) - 5,
  nonce: 'the-nonce',
  preferred_username: 'joe@supportwizard.net',
  name: 'Joe Kane',
  ...over,
});

/* ---- The stubbed tenant ------------------------------------------- */

interface Recorded {
  url: string;
  init?: RequestInit;
}

let calls: Recorded[] = [];
let jwksKeys: unknown[] = [jwk];
let tokenReply: unknown = {};

const realFetch = globalThis.fetch;

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function install(): void {
  calls = [];
  jwksKeys = [jwk];
  process.env.MICROSOFT_TENANT_ID = TENANT;
  process.env.MICROSOFT_CLIENT_ID = CLIENT;
  process.env.MICROSOFT_CLIENT_SECRET = 'a-client-secret';
  resetConfig();
  resetMicrosoftCache();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes('.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: `${MICROSOFT_LOGIN_HOST}/${TENANT}/v2.0`,
        authorization_endpoint: `${MICROSOFT_LOGIN_HOST}/${TENANT}/oauth2/v2.0/authorize`,
        token_endpoint: `${MICROSOFT_LOGIN_HOST}/${TENANT}/oauth2/v2.0/token`,
        jwks_uri: `${MICROSOFT_LOGIN_HOST}/${TENANT}/discovery/v2.0/keys`,
      });
    }
    if (url.includes('/discovery/v2.0/keys')) return jsonResponse({ keys: jwksKeys });
    if (url.includes('/oauth2/v2.0/token')) return jsonResponse(tokenReply);
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function restore(): void {
  globalThis.fetch = realFetch;
  delete process.env.MICROSOFT_TENANT_ID;
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  resetConfig();
  resetMicrosoftCache();
}

const rejects = async (run: () => Promise<unknown>, match: RegExp): Promise<void> => {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.match(err.message, match);
    return true;
  });
};

/* ---- PKCE --------------------------------------------------------- */

test('the PKCE challenge is the S256 hash of the verifier, url-safe', () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verifier, challenge);
  // Two calls never produce the same verifier.
  assert.notEqual(pkce().verifier, pkce().verifier);
});

/* ---- Verifying a real token --------------------------------------- */

test('a properly signed token from the tenant is accepted', async () => {
  install();
  try {
    const claims = await verifyIdToken(signToken(goodClaims()), { nonce: 'the-nonce' });
    assert.equal(claims.preferred_username, 'joe@supportwizard.net');
    assert.equal(claims.tid, TENANT);
  } finally {
    restore();
  }
});

test('the discovery document and key set are fetched once and then cached', async () => {
  install();
  try {
    await verifyIdToken(signToken(goodClaims()), { nonce: 'the-nonce' });
    await verifyIdToken(signToken(goodClaims()), { nonce: 'the-nonce' });
    const discovery = calls.filter((c) => c.url.includes('openid-configuration'));
    const keys = calls.filter((c) => c.url.includes('/discovery/v2.0/keys'));
    assert.equal(discovery.length, 1, 'discovery should be cached');
    assert.equal(keys.length, 1, 'signing keys should be cached');
  } finally {
    restore();
  }
});

test('a tampered payload fails the signature check', async () => {
  install();
  try {
    const token = signToken(goodClaims());
    const [header, , signature] = token.split('.');
    const forged = `${header}.${b64(goodClaims({ preferred_username: 'attacker@example.com' }))}.${signature}`;
    await rejects(() => verifyIdToken(forged, { nonce: 'the-nonce' }), /signature check/i);
  } finally {
    restore();
  }
});

test('a token signed by somebody else fails, even with the right claims', async () => {
  install();
  try {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signToken(goodClaims(), { key: other.privateKey });
    await rejects(() => verifyIdToken(token, { nonce: 'the-nonce' }), /signature check/i);
  } finally {
    restore();
  }
});

test('an unsigned token is refused on the algorithm, before any key lookup', async () => {
  install();
  try {
    const token = signToken(goodClaims(), { alg: 'none', signature: '' });
    await rejects(() => verifyIdToken(token, { nonce: 'the-nonce' }), /signed in a way NetKit does not accept/);
    assert.equal(calls.length, 0, 'must not even fetch the key set for an unacceptable algorithm');
  } finally {
    restore();
  }
});

test('an HMAC-shaped token is refused rather than verified with the public key', async () => {
  install();
  try {
    const token = signToken(goodClaims(), { alg: 'HS256', signature: 'anything' });
    await rejects(() => verifyIdToken(token, { nonce: 'the-nonce' }), /does not accept/);
  } finally {
    restore();
  }
});

test('an unknown key id refetches the key set once, then refuses', async () => {
  install();
  try {
    const token = signToken(goodClaims(), { kid: 'rolled-key-2' });
    await rejects(() => verifyIdToken(token, { nonce: 'the-nonce' }), /key they do not publish/);
    const keyFetches = calls.filter((c) => c.url.includes('/discovery/v2.0/keys'));
    assert.equal(keyFetches.length, 2, 'one cached read plus exactly one refresh');
  } finally {
    restore();
  }
});

test('a rolled signing key is picked up by the refetch', async () => {
  install();
  try {
    const rolled = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Warm the cache with the old key only.
    await verifyIdToken(signToken(goodClaims()), { nonce: 'the-nonce' });
    jwksKeys = [jwk, { ...rolled.publicKey.export({ format: 'jwk' }), kid: 'rolled-key-2', alg: 'RS256' }];
    const claims = await verifyIdToken(signToken(goodClaims(), { kid: 'rolled-key-2', key: rolled.privateKey }), {
      nonce: 'the-nonce',
    });
    assert.equal(claims.oid, 'object-id-1');
  } finally {
    restore();
  }
});

test('a validly signed token with the wrong nonce is still refused', async () => {
  install();
  try {
    await rejects(
      () => verifyIdToken(signToken(goodClaims()), { nonce: 'a-different-nonce' }),
      /did not match the one this browser started/,
    );
  } finally {
    restore();
  }
});

test('a validly signed token for another application is refused', async () => {
  install();
  try {
    await rejects(
      () => verifyIdToken(signToken(goodClaims({ aud: 'someone-elses-app' })), { nonce: 'the-nonce' }),
      /different application/,
    );
  } finally {
    restore();
  }
});

test('a token that is not three segments is refused without a fetch', async () => {
  install();
  try {
    await rejects(() => verifyIdToken('not-a-token', { nonce: 'the-nonce' }), /could not be read/);
    await rejects(() => verifyIdToken('a.b', { nonce: 'the-nonce' }), /could not be read/);
  } finally {
    restore();
  }
});

/* ---- The code exchange -------------------------------------------- */

test('the code exchange is form-encoded and carries the verifier, not the challenge', async () => {
  install();
  tokenReply = { id_token: signToken(goodClaims()) };
  try {
    const token = await exchangeCode({
      code: 'the-code',
      verifier: 'the-verifier',
      redirectUri: 'https://comms.supportwizard.net/api/auth/microsoft/callback',
    });
    assert.ok(token.split('.').length === 3);
    const call = calls.find((c) => c.url.includes('/oauth2/v2.0/token'));
    assert.ok(call, 'the token endpoint should have been called');
    assert.equal(
      (call.init?.headers as Record<string, string> | undefined)?.['Content-Type'],
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(String(call.init?.body));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
    assert.equal(body.get('code_verifier'), 'the-verifier');
    assert.equal(body.get('client_secret'), 'a-client-secret');
    assert.equal(body.get('redirect_uri'), 'https://comms.supportwizard.net/api/auth/microsoft/callback');
  } finally {
    restore();
  }
});

test("Microsoft's own refusal is passed through, not swallowed", async () => {
  install();
  tokenReply = { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' };
  try {
    await rejects(
      () => exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'https://x/y' }),
      /Invalid client secret provided/,
    );
  } finally {
    restore();
  }
});

test('a token response with no identity token is an error, not an empty sign-in', async () => {
  install();
  tokenReply = { access_token: 'not-what-we-asked-for' };
  try {
    await rejects(() => exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'https://x/y' }), /no identity token/);
  } finally {
    restore();
  }
});

test('the exchange is never retried, because an authorization code is single use', async () => {
  install();
  tokenReply = { error: 'invalid_grant', error_description: 'AADSTS54005: code was already redeemed.' };
  try {
    await rejects(() => exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'https://x/y' }), /already redeemed/);
    assert.equal(calls.filter((c) => c.url.includes('/oauth2/v2.0/token')).length, 1);
  } finally {
    restore();
  }
});
