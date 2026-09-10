import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CLOUD_PROXY_BASE,
  CONTROLLER_RETRY_MS,
  INTEGRATION_PREFIX,
  cloudUrl,
  consoleIdFromUrl,
  controllerUrl,
  fingerprintProblem,
  fingerprintsMatch,
  normaliseControllerUrl,
  normaliseFingerprint,
  routeExplanation,
  shouldTryController,
  tlsExplanation,
  tlsMode,
} from './index';

const CONSOLE = 'fc86acb6-6dfa-4e61-8f5a-e8fba0456986';

/* ---- The two URLs ------------------------------------------------- */

test('both roads build the same path under the integration prefix', () => {
  assert.equal(controllerUrl('https://192.168.1.1', '/sites'), `https://192.168.1.1${INTEGRATION_PREFIX}/sites`);
  assert.equal(cloudUrl(CONSOLE, '/sites'), `${CLOUD_PROXY_BASE}/${CONSOLE}${INTEGRATION_PREFIX}/sites`);
  // The same path either way is what makes this a transport swap rather
  // than two implementations.
  const local = controllerUrl('https://192.168.1.1', '/sites/s1/clients');
  const cloud = cloudUrl(CONSOLE, '/sites/s1/clients');
  assert.ok(local.endsWith('/sites/s1/clients') && cloud.endsWith('/sites/s1/clients'));
});

test('a trailing slash or a missing leading slash does not double up', () => {
  assert.equal(controllerUrl('https://192.168.1.1/', 'sites'), `https://192.168.1.1${INTEGRATION_PREFIX}/sites`);
});

/* ---- What somebody actually pastes -------------------------------- */

test('a bare address gets https, and a path is dropped', () => {
  assert.equal(normaliseControllerUrl('192.168.1.1').url, 'https://192.168.1.1');
  assert.equal(normaliseControllerUrl('unifi.office.local/network/default').url, 'https://unifi.office.local');
  assert.equal(normaliseControllerUrl('https://10.0.0.1:8443').url, 'https://10.0.0.1:8443');
  assert.equal(normaliseControllerUrl('  ').url, undefined);
});

test('the Site Manager address pasted as the console address is refused', () => {
  // Otherwise every "local" call goes to Ubiquiti's cloud while the status
  // panel claims the connection is direct.
  const result = normaliseControllerUrl(`https://unifi.ui.com/consoles/${CONSOLE}/network/default`);
  assert.equal(result.url, undefined);
  assert.ok(result.problem?.includes('Site Manager address'), String(result.problem));
});

test('plain http is refused, because the API key would go in the clear', () => {
  const result = normaliseControllerUrl('http://192.168.1.1');
  assert.equal(result.url, undefined);
  assert.ok(result.problem?.includes('in the clear'), String(result.problem));
});

test('nonsense is reported rather than accepted', () => {
  assert.ok(normaliseControllerUrl('https://').problem);
});

test('the console id is lifted out of whatever page they copied', () => {
  assert.equal(consoleIdFromUrl(`https://unifi.ui.com/consoles/${CONSOLE}`), CONSOLE);
  assert.equal(consoleIdFromUrl(`https://unifi.ui.com/consoles/${CONSOLE}/network/default/dashboard`), CONSOLE);
  assert.equal(consoleIdFromUrl(CONSOLE), undefined, 'a bare id has no URL to lift it from');
  assert.equal(consoleIdFromUrl('https://unifi.ui.com/'), undefined);
});

/* ---- Trusting the console's certificate --------------------------- */

test('the certificate mode is decided in a fixed order of preference', () => {
  assert.equal(tlsMode(undefined), 'verified');
  assert.equal(tlsMode({}), 'verified');
  assert.equal(tlsMode({ insecure: true }), 'unverified');
  assert.equal(tlsMode({ fingerprint: 'AB'.repeat(32) }), 'pinned-fingerprint');
  // A supplied certificate beats a fingerprint, and both beat switching
  // checking off — so a leftover insecure flag cannot weaken a configured
  // pin.
  assert.equal(tlsMode({ caCert: '-----BEGIN CERTIFICATE-----', insecure: true }), 'pinned-ca');
  assert.equal(tlsMode({ fingerprint: 'AB'.repeat(32), insecure: true }), 'pinned-fingerprint');
  assert.equal(tlsMode({ caCert: '   ' }), 'verified', 'whitespace is not a certificate');
});

test('switching checking off is described as a warning, and says what it costs', () => {
  const off = tlsExplanation('unverified');
  assert.equal(off.tone, 'warn');
  assert.ok(off.text.includes('read the API key'), off.text);
});

test('plain verification is flagged as the trap it is for a local console', () => {
  // A console on a private address has its own certificate, so verification
  // fails and the cloud fallback covers for it — the portal looks like it is
  // talking to the console and never reached it.
  const plain = tlsExplanation('verified');
  assert.ok(plain.text.includes('silently fall back'), plain.text);
});

test('a fingerprint is compared however it was pasted', () => {
  const canonical = 'AB:CD'.repeat(16).slice(0, 95);
  assert.equal(normaliseFingerprint('ab:cd:ef'), 'ABCDEF');
  assert.equal(normaliseFingerprint('AB CD EF'), 'ABCDEF');
  assert.equal(fingerprintsMatch('ab:cd:ef', 'ABCDEF'), true);
  assert.equal(fingerprintsMatch('ab:cd:ef', 'ABCDE0'), false);
  assert.equal(fingerprintsMatch(undefined, 'ABCDEF'), false);
  assert.equal(fingerprintsMatch('', ''), false, 'two blanks are not a match');
  assert.ok(canonical.length > 0);
});

test('a fingerprint of the wrong length is rejected with its own length', () => {
  assert.equal(fingerprintProblem(''), undefined, 'empty means "not using this mode"');
  assert.equal(fingerprintProblem('AB'.repeat(32)), undefined);
  const problem = fingerprintProblem('AB:CD:EF');
  assert.ok(problem?.includes('64 hex'), String(problem));
  assert.ok(problem?.includes('has 6'), String(problem));
});

/* ---- When to stop trying the console ------------------------------ */

test('with no console configured, the console is never tried', () => {
  assert.equal(shouldTryController({}, { controllerConfigured: false }), false);
});

test('a console that has never failed is always tried', () => {
  assert.equal(shouldTryController(undefined, { controllerConfigured: true }), true);
  assert.equal(shouldTryController({ lastRoute: 'controller' }, { controllerConfigured: true }), true);
});

test('after a failure the console is left alone, then tried again', () => {
  const now = 1_760_000_000_000;
  const state = { unreachableAt: now };
  // Without this, every call pays the console's connect timeout before
  // reaching the cloud, and a six-panel page takes half a minute to load a
  // perfectly healthy site.
  assert.equal(shouldTryController(state, { controllerConfigured: true, now: now + 1000 }), false);
  assert.equal(shouldTryController(state, { controllerConfigured: true, now: now + CONTROLLER_RETRY_MS - 1 }), false);
  assert.equal(shouldTryController(state, { controllerConfigured: true, now: now + CONTROLLER_RETRY_MS }), true);
});

/* ---- Saying which road answered ----------------------------------- */

test('the status line distinguishes "no console set" from "console not answering"', () => {
  assert.ok(routeExplanation({}, false).includes('nothing local to try'));
  assert.equal(routeExplanation({ lastRoute: 'controller' }, true), 'Reading directly from the console.');

  const fallen = routeExplanation({ lastRoute: 'cloud', unreachableAt: Date.now(), lastError: 'connect ECONNREFUSED' }, true);
  assert.ok(fallen.includes('did not answer'), fallen);
  assert.ok(fallen.includes('ECONNREFUSED'), 'the reason is the useful part');
  assert.ok(fallen.includes('retried a minute'), fallen);
});

test('before anything has been read, it says so rather than claiming a road', () => {
  assert.equal(routeExplanation({}, true), 'Nothing read yet.');
});
