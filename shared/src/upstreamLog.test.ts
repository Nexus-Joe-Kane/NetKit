import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  BODY_LIMIT,
  REDACTED,
  failureReport,
  failuresByLabel,
  redactBody,
  redactUrl,
  supplierReport,
  upstreamFailure,
  type UpstreamFailure,
} from './index';

/* ---- Redaction ---------------------------------------------------- */

test('a credential in the query string is redacted, and the shape is kept', () => {
  const out = redactUrl('https://api.example.com/v1/thing?postcode=M1+1AE&subscription-key=abc123&apiKey=xyz');
  assert.ok(out.includes('postcode=M1+1AE'), out);
  assert.ok(!out.includes('abc123'), out);
  assert.ok(!out.includes('xyz'), out);
  assert.equal(new URL(out).searchParams.get('subscription-key'), REDACTED);
  assert.equal(new URL(out).searchParams.get('apiKey'), REDACTED);
});

test('every spelling of a credential parameter is caught', () => {
  for (const name of ['key', 'api_key', 'API-KEY', 'token', 'access_token', 'secret', 'password', 'pwd', 'auth', 'sig', 'signature', 'subscription-key']) {
    const out = redactUrl(`https://x.example/y?${name}=SENSITIVE`);
    assert.ok(!out.includes('SENSITIVE'), `${name} was not redacted: ${out}`);
  }
});

test('a password in the userinfo is redacted', () => {
  assert.ok(!redactUrl('https://user:hunter2@x.example/y').includes('hunter2'));
});

test('a URL that will not parse loses its query rather than leaking it', () => {
  const out = redactUrl('not a url at all?key=SENSITIVE');
  assert.ok(!out.includes('SENSITIVE'), out);
});

test('a JWT anywhere in a body is stripped', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWhlcmU';
  const out = redactBody(`{"error":"invalid_token","token":"${jwt}"}`);
  assert.ok(!out.includes(jwt), out);
  assert.ok(out.includes('invalid_token'), 'the useful part must survive');
});

test('an echoed secret field is stripped but its name is kept', () => {
  const out = redactBody('{"client_secret":"s3cr3t-value","error":"invalid_client"}');
  assert.ok(!out.includes('s3cr3t-value'), out);
  assert.ok(out.includes('client_secret'), out);
  assert.ok(out.includes('invalid_client'), out);
});

test('an Authorization header echoed in a body is stripped', () => {
  const out = redactBody('Request had header Authorization: Bearer abcdefghijklmnop');
  assert.ok(!out.includes('abcdefghijklmnop'), out);
  assert.match(out, /Bearer \[redacted\]/);
});

test('a body is truncated so one enormous error cannot fill the log', () => {
  const entry = upstreamFailure({ label: 'x', method: 'GET', url: 'https://x.example/y', body: 'a'.repeat(5000) });
  assert.equal(entry.body?.length, BODY_LIMIT);
});

test('building an entry stamps the time and redacts as it goes', () => {
  const entry = upstreamFailure({
    label: 'Zen assurance',
    method: 'GET',
    url: 'https://gateway.example/assurance/api/x?key=SENSITIVE',
    status: 401,
    statusText: 'Unauthorized',
    body: '{"message":"Authorization has been denied for this request."}',
    scope: 'read-outages',
  });
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!entry.url.includes('SENSITIVE'));
  assert.equal(entry.scope, 'read-outages');
  assert.equal(entry.status, 401);
});

test('absent fields are left out rather than written as undefined', () => {
  const entry = upstreamFailure({ label: 'x', method: 'GET', url: 'https://x.example/y' });
  assert.equal('status' in entry, false);
  assert.equal('body' in entry, false);
  assert.equal('scope' in entry, false);
});

/* ---- The report a supplier asked for ------------------------------ */

const entry: UpstreamFailure = {
  at: '2026-09-08T14:32:11.000Z',
  label: 'Zen assurance',
  method: 'GET',
  url: 'https://gateway.api.indirect.zen.co.uk/assurance/api/major-service-outages',
  status: 401,
  statusText: 'Unauthorized',
  body: '{"message":"Authorization has been denied for this request."}',
  scope: 'read-outages',
  requestId: 'abc-123',
};

test('one failure reads as something a systems team can act on', () => {
  const report = failureReport(entry);
  // Every question Zen's systems team actually asked.
  assert.ok(report.includes('major-service-outages'), 'which endpoint');
  assert.ok(report.includes('401 Unauthorized'), 'what came back');
  assert.ok(report.includes('read-outages'), 'under which scope');
  assert.ok(report.includes('Authorization has been denied'), 'the exact body');
  assert.ok(report.includes('abc-123'), 'their own correlation id');
  // The time is in UK terms, because that is what a UK supplier will search.
  // en-GB renders the month as "Sept"; the point is the date is local and
  // labelled, not the exact abbreviation.
  assert.ok(/8 Sept? 2026/.test(report) && report.includes('(UK)'), report);
  // 14:32 UTC in September is 15:32 in London — a supplier searching their
  // logs by the time we quote needs the offset applied, not ignored.
  assert.ok(report.includes('15:32:11'), report);
});

test('the supplier report names the account and the endpoints, and never the secret', () => {
  const report = supplierReport([entry], {
    provider: 'Zen Internet',
    clientId: 'ws-api-club-wizard-ltd',
    tokenUrl: 'https://id.zen.co.uk/connect/token',
    baseUrls: ['https://gateway.api.indirect.zen.co.uk/assurance'],
  });
  assert.ok(report.includes('ws-api-club-wizard-ltd'));
  assert.ok(report.includes('id.zen.co.uk/connect/token'));
  assert.ok(report.includes('production'));
  assert.ok(report.includes('1 of 1'));
  assert.ok(!/secret/i.test(report), 'a report pasted into an email must contain no secret');
});

test('an empty log says so instead of producing a report with nothing in it', () => {
  const report = supplierReport([], { provider: 'Zen Internet' });
  assert.ok(report.includes('No failed calls'), report);
});

test('failures group by label, most recent group first', () => {
  const grouped = failuresByLabel([
    { ...entry, label: 'Zen assurance', at: '2026-09-08T10:00:00.000Z' },
    { ...entry, label: 'Zen assurance', at: '2026-09-08T12:00:00.000Z' },
    { ...entry, label: 'Jola', at: '2026-09-09T09:00:00.000Z' },
  ]);
  assert.equal(grouped[0]?.label, 'Jola');
  assert.equal(grouped[1]?.label, 'Zen assurance');
  assert.equal(grouped[1]?.count, 2);
  assert.equal(grouped[1]?.latest, '2026-09-08T12:00:00.000Z');
});
