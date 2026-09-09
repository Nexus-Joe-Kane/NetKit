import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOWNTIME_STEP_MS, describeDuration, downtimeFrom, formatExact, msUntilNextStep } from './downtime';
import {
  NO_SHOW_CHARGE,
  accessProvider,
  addressParts,
  handoverFields,
  handoverState,
  handoverText,
  productLabel,
} from './lineHandover';
import { SITE_VISIT_REASONS, overallSide, reasonDef, translateTest } from './lineTestAdvice';
import type { LineRecord } from './types';
import type { LineTestResult } from './operations';

const address = {
  singleLine: '45 Brockley Rise, LONDON, SE23 1JG',
  lines: ['45 Brockley Rise'],
  postTown: 'LONDON',
  postcode: 'SE23 1JG',
  uprn: '100023253338',
  source: 'os-places' as const,
};

const line = (over: Partial<LineRecord> = {}): LineRecord => ({
  id: 'l1',
  status: 'active',
  technology: 'SOGEA',
  provider: 'Zen',
  address,
  discoveredVia: 'zen',
  notes: [],
  ...over,
});

const testResult = (over: Partial<LineTestResult> = {}): LineTestResult => ({
  zenReference: 'ZEN998',
  type: 'linetest',
  outcome: 'fail',
  pending: false,
  metrics: [],
  provider: 'Zen',
  source: 'zen',
  ...over,
});

/* ---- Downtime ------------------------------------------------------- */

test('the moment it went down is exact to the second and never rounded', () => {
  assert.equal(formatExact('2026-09-08T14:32:07'), '08/09/2026 at 14:32:07');
});

test('elapsed time rounds down to a five-minute step', () => {
  const now = new Date('2026-09-08T18:14:59');
  const d = downtimeFrom({ downSince: '2026-09-08T14:32:07', radius: { online: false } }, now);
  // 3h 42m 52s actual → 3h 40m after rounding down to the step.
  assert.equal(d?.elapsed, '3 hours 40 minutes');
  assert.equal(d?.elapsedMs % DOWNTIME_STEP_MS, 0);
  assert.equal(d?.exact, '08/09/2026 at 14:32:07', 'the timestamp itself is untouched');
});

test('a line that is up has no downtime, whatever timestamps it carries', () => {
  assert.equal(downtimeFrom({ radius: { online: true, lastAuthAt: '2026-01-01T00:00:00' } }), null);
});

test('the provider’s own answer beats anything we infer, and the basis is named', () => {
  const now = new Date('2026-09-08T15:00:00');
  const both = downtimeFrom(
    { downSince: '2026-09-08T14:00:00', radius: { online: false, lastAuthAt: '2026-09-08T13:00:00' } },
    now,
  );
  assert.equal(both?.basis, 'provider');

  const inferred = downtimeFrom({ radius: { online: false, lastAuthAt: '2026-09-08T13:00:00' } }, now);
  assert.equal(inferred?.basis, 'last-auth', 'an inference must never be quoted as a fact');
});

test('a future timestamp is refused rather than producing a negative age', () => {
  const now = new Date('2026-09-08T15:00:00');
  assert.equal(downtimeFrom({ downSince: '2026-12-01T00:00:00', radius: { online: false } }, now), null);
});

test('durations use two units at most', () => {
  assert.equal(describeDuration(30_000), 'less than a minute');
  assert.equal(describeDuration(60_000), '1 minute');
  assert.equal(describeDuration(3 * 3_600_000 + 40 * 60_000), '3 hours 40 minutes');
  assert.equal(describeDuration(4 * 86_400_000 + 3 * 3_600_000 + 25 * 60_000), '4 days 3 hours');
  assert.equal(describeDuration(86_400_000), '1 day');
});

test('the next tick lands exactly when the figure becomes wrong', () => {
  const now = new Date('2026-09-08T14:33:00');
  // Down at 14:32:07, so the step boundary is 14:37:07 — 4m 07s away.
  assert.equal(msUntilNextStep('2026-09-08T14:32:07', now), 4 * 60_000 + 7_000);
});

/* ---- The address, in copyable pieces -------------------------------- */

test('the address splits into street, postcode and whole', () => {
  const parts = addressParts(line());
  assert.equal(parts.street, '45 Brockley Rise, LONDON');
  assert.equal(parts.postcode, 'SE23 1JG');
  assert.equal(parts.whole, '45 Brockley Rise, LONDON, SE23 1JG');
});

/* ---- Fields --------------------------------------------------------- */

test('the password is a field of its own and marked secret', () => {
  const fields = handoverFields({
    line: line({ radius: { username: 'user@zen', online: true } }),
    password: 'not-a-real-one',
  });
  const secret = fields.find((f) => f.label === 'Broadband password');
  assert.equal(secret?.secret, true);
  assert.equal(fields.find((f) => f.label === 'Broadband username')?.secret, undefined);
});

test('a field with no value is left out rather than shown empty', () => {
  const fields = handoverFields({ line: line() });
  assert.equal(fields.some((f) => f.label === 'CLI'), false);
  assert.equal(fields.some((f) => f.value.trim() === ''), false);
});

/* ---- The copy-all block --------------------------------------------- */

test('the block opens with what and where and who', () => {
  const text = handoverText({
    line: line({
      productName: '80/20 SOGEA',
      customerReference: 'ZEN-44821',
      lineAccessId: 'ALK123456789',
      cli: '02071234567',
    }),
  });
  assert.match(
    text.split('\n')[0] ?? '',
    /^Details for Zen; SOGEA line at 45 Brockley Rise, LONDON, SE23 1JG provided by Openreach \(ZEN-44821\)$/,
  );
  assert.match(text, /\*\*ACCESS LINE ID:\*\* ALK123456789/);
  assert.match(text, /\*\*CLI:\*\* 02071234567/);
  assert.match(text, /\*\*UPRN:\*\* 100023253338/);
});

test('the password never reaches the copy-all block', () => {
  // A password pasted into a customer-visible ticket is an incident.
  const text = handoverText({ line: line({ radius: { username: 'user@zen' } }), password: 'hunter2' });
  assert.match(text, /BROADBAND USERNAME/);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /PASSWORD/);
});

test('an offline line states the exact moment and the rounded age', () => {
  const text = handoverText({
    line: line({ downSince: '2026-09-08T14:32:07', radius: { online: false } }),
    now: new Date('2026-09-08T18:14:59'),
  });
  assert.match(text, /\*\*CURRENT STATUS:\*\* Offline since 08\/09\/2026 at 14:32:07 \(3 hours 40 minutes ago\)/);
});

test('a line with no session recorded is told it may never have been provisioned', () => {
  const state = handoverState({ line: line() });
  assert.equal(state.radiusMissing, true);
  assert.match(handoverText({ line: line() }), /usually a provisioning problem rather than a router one/);
});

test('a leased line is not accused of a missing session', () => {
  // It does not authenticate, so there is nothing to be missing.
  assert.equal(handoverState({ line: line({ technology: 'Leased Line' }) }).radiusMissing, false);
});

test('no test run says so rather than leaving a gap', () => {
  assert.match(handoverText({ line: line() }), /None run\. Run one before raising a fault\./);
});

test('a test is quoted with its readings, its flags and what to do', () => {
  const text = handoverText({
    line: line({ technology: 'FTTP' }),
    latestTest: testResult({
      ranAt: '2026-09-08T17:00:00',
      ranBy: 'Joe Kane',
      outcome: 'fail',
      summary: 'ONT reporting loss of light.',
      metrics: [{ label: 'ONT status', value: 'LOS', verdict: 'fail' }],
    }),
  });
  assert.match(text, /run on 08\/09\/2026 at 17:00:00 by Joe Kane/);
  assert.match(text, /ONT status: LOS {2}← FAIL/);
  assert.match(text, /receiving no light from the network/);
  assert.match(text, /1\. Confirm with the customer that the ONT is powered/);
  assert.match(text, /Before booking a visit:/);
});

test('the site contact goes on the block when there is one', () => {
  const text = handoverText({
    line: line(),
    siteContact: { id: '1', name: 'Jane Okafor', email: 'jane@willow.example', phone: '07700 900123' },
  });
  assert.match(text, /\*\*ON SITE CONTACT:\*\* Jane Okafor · jane@willow\.example · 07700 900123/);
});

test('the access provider is derived, and left vague rather than wrong', () => {
  assert.equal(accessProvider(line({ technology: 'SOGEA' })), 'Openreach');
  assert.equal(accessProvider(line({ discoveredVia: 'giacom' })), 'BT Wholesale / Openreach');
  assert.equal(accessProvider(line({ technology: 'DOCSIS3.1' })), 'the access provider');
});

/* ---- Translations --------------------------------------------------- */

test('an unpowered ONT sends somebody to the phone, not to site', () => {
  const findings = translateTest(testResult({ summary: 'ONT has no power at the premises.' }));
  assert.equal(findings[0]?.kind, 'ont-power');
  assert.equal(findings[0]?.side, 'customer');
  assert.match(findings[0]?.steps[0] ?? '', /Ring the customer before anything else/);
  assert.match(findings[0]?.beforeBooking ?? '', /£165 \+ VAT/);
});

test('loss of light is the provider’s side and does go to site', () => {
  const findings = translateTest(testResult({ summary: 'ONT LOS asserted, dying gasp received.' }));
  assert.equal(findings[0]?.kind, 'ont-los');
  assert.equal(findings[0]?.side, 'network');
  assert.equal(findings[0]?.suggestedReason, 'ont-no-light');
});

test('power is matched before the general ONT pattern', () => {
  // Both mention the ONT and they need opposite first actions — one is a
  // plug, the other is a dig.
  const findings = translateTest(testResult({ summary: 'ONT unreachable: no power reported.' }));
  assert.equal(findings[0]?.kind, 'ont-power');
});

test('a clean test tells the engineer to believe it and check the customer’s kit', () => {
  const findings = translateTest(testResult({ outcome: 'pass', summary: 'No fault found on the line.' }));
  assert.equal(findings[0]?.kind, 'pass');
  assert.match(findings[0]?.steps.join(' ') ?? '', /5G backup/);
  assert.match(findings[0]?.steps.join(' ') ?? '', /will come back as no fault found and be charged/);
});

test('a clean pass alongside a critical finding is dropped as contradictory', () => {
  const findings = translateTest(
    testResult({ summary: 'Test passed on the copper, but ONT LOS asserted.' }),
  );
  assert.equal(findings.some((f) => f.kind === 'pass'), false);
  assert.ok(findings.some((f) => f.kind === 'ont-los'));
});

test('an unrecognised result admits it rather than inventing a meaning', () => {
  const findings = translateTest(testResult({ summary: 'Widget flange out of alignment.' }));
  assert.equal(findings[0]?.kind, 'untranslated');
  assert.match(findings[0]?.meaning ?? '', /has not been interpreted/);
});

test('the side of the fault is decided from the findings, and admits when unclear', () => {
  assert.equal(overallSide(translateTest(testResult({ summary: 'ONT LOS' }))), 'network');
  assert.equal(overallSide(translateTest(testResult({ summary: 'Fault on internal wiring' }))), 'customer');
  assert.equal(overallSide(translateTest(testResult({ summary: 'No dial tone' }))), 'unclear');
});

test('every site-visit reason has customer wording that is not the engineer’s', () => {
  for (const reason of SITE_VISIT_REASONS) {
    assert.ok(reason.customerWording.length > 10, `${reason.id} needs customer wording`);
    assert.notEqual(reason.customerWording, reason.label);
    assert.doesNotMatch(reason.customerWording, /ONT|DSLAM|MSAN|PCP/, `${reason.id} leaks jargon to the customer`);
  }
});

test('an unknown reason still reads as something rather than blank', () => {
  assert.equal(reasonDef('unknown').label, 'Cause not yet identified');
  assert.equal(reasonDef('not-a-reason' as never).id, 'unknown');
});

test('the speed is not said twice when the product name already has it', () => {
  const text = handoverText({ line: line({ productName: '80/20 SOGEA', bearerSpeed: '80/20' }) });
  assert.match(text, /\*\*PRODUCT:\*\* 80\/20 SOGEA$/m);
  assert.equal(productLabel(line({ productName: 'SOGEA', bearerSpeed: '80/20' })), 'SOGEA 80/20');
  assert.equal(productLabel(line({ bearerSpeed: '80/20' })), 'SOGEA 80/20');
  assert.equal(productLabel(line()), 'SOGEA');
});

test('the no-show charge lives in exactly one place', () => {
  assert.equal(NO_SHOW_CHARGE, '£165 + VAT');
});
