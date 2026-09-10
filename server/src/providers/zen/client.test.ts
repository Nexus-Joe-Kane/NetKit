import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../config';
import { clearUpstreamLog, recentFailures, useUpstreamLogDir } from '../../services/upstreamLog';
import { resetZenScopeMemo, resetZenTokens, zenCall } from './client';

/**
 * The Zen client's scope handling.
 *
 * Written after a 401 that was diagnosed as an entitlement problem and was
 * not one: the outage endpoints are gated on `read-outages`, NetKit was
 * asking under `indirect-faults`, the token minted fine either way, and the
 * error message blamed Zen's account setup for it. These tests pin the
 * behaviour that would have made that obvious in minutes.
 */

const TOKEN_URL = 'https://id.example/connect/token';
const ASSURANCE = 'https://gateway.example/assurance';

interface Attempt {
  url: string;
  scope?: string;
  authorization?: string;
}

let attempts: Attempt[] = [];
/** Which scopes the fake gateway will accept on the call itself. */
let accepted = new Set<string>();

const realFetch = globalThis.fetch;

function install(scopes: string): void {
  attempts = [];
  resetZenTokens();
  resetZenScopeMemo();
  useUpstreamLogDir(mkdtempSync(join(tmpdir(), 'netkit-upstream-')));
  clearUpstreamLog();
  process.env.ZEN_CLIENT_ID = 'ws-api-club-wizard-ltd';
  process.env.ZEN_CLIENT_SECRET = 'not-a-real-secret';
  process.env.ZEN_TOKEN_URL = TOKEN_URL;
  process.env.ZEN_ASSURANCE_BASE_URL = ASSURANCE;
  process.env.ZEN_SCOPES = scopes;
  resetConfig();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === TOKEN_URL) {
      // The identity server issues a token for any scope it is asked for —
      // which is exactly why a scope mistake does not show up here.
      const scope = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      return new Response(JSON.stringify({ access_token: `token-for-${scope}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const scope = authorization?.replace('Bearer token-for-', '');
    attempts.push({ url, ...(scope ? { scope } : {}), ...(authorization ? { authorization } : {}) });
    if (scope && accepted.has(scope)) {
      return new Response(JSON.stringify({ outages: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{"message":"Authorization has been denied for this request."}', {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'Content-Type': 'application/json', 'request-id': 'zen-req-9' },
    });
  }) as typeof fetch;
}

function restore(): void {
  globalThis.fetch = realFetch;
  for (const key of ['ZEN_CLIENT_ID', 'ZEN_CLIENT_SECRET', 'ZEN_TOKEN_URL', 'ZEN_ASSURANCE_BASE_URL', 'ZEN_SCOPES']) {
    delete process.env[key];
  }
  resetConfig();
  resetZenTokens();
  resetZenScopeMemo();
  clearUpstreamLog();
  useUpstreamLogDir(null);
}

const outages = () =>
  zenCall<unknown>('/api/major-service-outages', {
    gateway: 'assurance',
    scope: ['read-outages', 'indirect-faults'] as const,
    emptyAsNull: true,
  });

test('the first granted scope that the endpoint accepts is used', async () => {
  install('read-outages,indirect-faults');
  accepted = new Set(['read-outages']);
  try {
    assert.deepEqual(await outages(), { outages: [] });
    assert.equal(attempts.length, 1, 'the right scope should be first, not found by trial');
    assert.equal(attempts[0]?.scope, 'read-outages');
  } finally {
    restore();
  }
});

test('a refused scope falls back to the next candidate rather than failing', async () => {
  install('read-outages,indirect-faults');
  accepted = new Set(['indirect-faults']);
  try {
    assert.deepEqual(await outages(), { outages: [] });
    assert.deepEqual(
      attempts.map((a) => a.scope),
      ['read-outages', 'indirect-faults'],
    );
  } finally {
    restore();
  }
});

test('the accepted scope is remembered, so the second call costs one request', async () => {
  install('read-outages,indirect-faults');
  accepted = new Set(['indirect-faults']);
  try {
    await outages();
    attempts = [];
    await outages();
    assert.deepEqual(
      attempts.map((a) => a.scope),
      ['indirect-faults'],
      'the scope that worked should be tried first next time',
    );
  } finally {
    restore();
  }
});

test('a scope the credentials do not have is skipped, not attempted', async () => {
  install('indirect-faults');
  accepted = new Set(['indirect-faults']);
  try {
    await outages();
    assert.deepEqual(
      attempts.map((a) => a.scope),
      ['indirect-faults'],
      'read-outages is not in ZEN_SCOPES, so asking for it teaches nobody anything',
    );
  } finally {
    restore();
  }
});

test('when every scope is refused, the error says it may be ours and points at the log', async () => {
  install('read-outages,indirect-faults');
  accepted = new Set();
  try {
    await assert.rejects(outages, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /read-outages/);
      assert.match(message, /indirect-faults/);
      // The old message asserted the account was not entitled. It was wrong,
      // and it sent somebody to their account manager for a bug in here.
      assert.match(message, /gated on a scope NetKit is not asking for/);
      assert.match(message, /upstream log/);
      return true;
    });
  } finally {
    restore();
  }
});

test('every refusal is written down with its scope, body and their request id', async () => {
  install('read-outages,indirect-faults');
  accepted = new Set();
  try {
    await outages().catch(() => undefined);
    const logged = recentFailures({ label: 'zen' });
    assert.equal(logged.length, 2, 'one entry per attempted scope');
    assert.deepEqual(
      logged.map((e) => e.scope).sort(),
      ['indirect-faults', 'read-outages'],
    );
    const entry = logged[0]!;
    assert.equal(entry.status, 401);
    assert.equal(entry.statusText, 'Unauthorized');
    assert.equal(entry.requestId, 'zen-req-9');
    assert.match(entry.body ?? '', /Authorization has been denied/);
    assert.match(entry.url, /major-service-outages/);
    // The bearer token must never reach the log.
    assert.ok(!JSON.stringify(entry).includes('token-for-'), JSON.stringify(entry));
  } finally {
    restore();
  }
});

test('a successful call writes nothing to the failure log', async () => {
  install('read-outages');
  accepted = new Set(['read-outages']);
  try {
    await outages();
    assert.equal(recentFailures().length, 0);
  } finally {
    restore();
  }
});
