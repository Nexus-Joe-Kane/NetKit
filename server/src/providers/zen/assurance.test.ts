import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __assuranceTesting, testFamilyFor, looksLikeFault, mapFault } from './assurance';
import { __selfServiceTesting } from './selfservice';
import { toMsisdn, isLikelyLondon } from '../bt/adapters';
import { __jolaTesting } from '../jola/adapters';

const { incidentState, incidentImpact, faultCategory, faultState, testOutcome, metricsFrom } = __assuranceTesting;

test('incident state falls back to dates when the status string is opaque', () => {
  assert.equal(incidentState({ status: 'Resolved' }, 'outage'), 'resolved');
  assert.equal(incidentState({ status: 'In Progress' }, 'outage'), 'in_progress');
  assert.equal(incidentState({ status: 'Monitoring' }, 'outage'), 'monitoring');
  // No status at all, but a cleared date — unambiguous.
  assert.equal(incidentState({ clearedDate: '2026-01-01T00:00:00Z' }, 'outage'), 'resolved');
  // Nothing to go on: an outage defaults to open, planned work to scheduled.
  assert.equal(incidentState({}, 'outage'), 'open');
  assert.equal(incidentState({}, 'planned'), 'scheduled');
});

test('incident impact is read from any of the impact fields', () => {
  assert.equal(incidentImpact({ impact: 'Total loss of service' }), 'total_loss');
  assert.equal(incidentImpact({ severity: 'Partial' }), 'partial_loss');
  assert.equal(incidentImpact({ serviceImpact: 'Degraded throughput' }), 'degraded');
  assert.equal(incidentImpact({ impactDescription: 'At risk' }), 'at_risk');
  assert.equal(incidentImpact({ impact: 'No impact' }), 'no_impact');
  assert.equal(incidentImpact({}), 'unknown');
});

test('fault category and state are inferred from free text', () => {
  assert.equal(faultCategory({ category: 'Synchronisation' }), 'synchronisation');
  assert.equal(faultCategory({ faultType: 'Slow speed / throughput' }), 'performance');
  assert.equal(faultCategory({ type: 'Authentication failure' }), 'authentication');
  assert.equal(faultCategory({ category: 'No dial tone' }), 'voice');
  assert.equal(faultCategory({}), 'other');

  assert.equal(faultState({ status: 'Closed — no fault found' }), 'closed');
  assert.equal(faultState({ status: 'Open — engineer assigned' }), 'engineer_assigned');
  assert.equal(faultState({ status: 'Awaiting customer' }), 'awaiting_customer');
  // A cleared date closes the fault even with no usable status.
  assert.equal(faultState({ clearedDate: '2026-01-01' }), 'closed');
});

test('test outcome does not guess from the opaque state integer', () => {
  assert.equal(testOutcome({ testOutcome: 'Pass' }), 'pass');
  assert.equal(testOutcome({ result: 'No fault found' }), 'pass');
  assert.equal(testOutcome({ outcome: 'FAIL' }), 'fail');
  assert.equal(testOutcome({ testOutcome: 'Inconclusive' }), 'inconclusive');
  assert.equal(testOutcome({ errorMessage: 'Service not found' }), 'error');
  // Zen documents `state` as an integer with no value table, so it must not
  // be interpreted as an outcome.
  assert.equal(testOutcome({ state: 3 }), 'unknown');
  assert.equal(testOutcome({}), 'unknown');
});

test('the TAM test maps each stack layer with a verdict', () => {
  const metrics = metricsFrom({ modem: 'Responding', dsl: 'In sync', atm: 'No cells', ppp: 'Not authenticating' }, 'tamtest');
  const byLabel = Object.fromEntries(metrics.map((m) => [m.label, m]));
  assert.equal(byLabel.Modem?.verdict, 'ok');
  assert.equal(byLabel.DSL?.verdict, 'ok');
  assert.equal(byLabel.ATM?.verdict, 'fail');
  assert.equal(byLabel.PPP?.verdict, 'fail');
});

test('numeric readings carry their unit', () => {
  const metrics = metricsFrom({ snrMargin: 6.5, attenuation: 32, downstreamRate: 38000 }, 'xdsltest');
  const snr = metrics.find((m) => m.label === 'SNR margin');
  assert.equal(snr?.unit, 'dB');
  assert.equal(snr?.numeric, 6.5);
  assert.equal(snr?.value, '6.5 dB');
  assert.ok(metrics.some((m) => m.label === 'Downstream rate' && m.unit === 'kbps'));
});

test('the test family follows the access technology', () => {
  // Fibre products get a single service test; copper gets the full suite.
  assert.equal(testFamilyFor('FTTP'), 'fttp');
  assert.equal(testFamilyFor('XGS-PON'), 'fttp');
  assert.equal(testFamilyFor('SOGEA'), 'sogea');
  assert.equal(testFamilyFor('FTTC'), 'copper');
  assert.equal(testFamilyFor('ADSL2+'), 'copper');
  assert.equal(testFamilyFor(undefined), 'copper');
});

test('order state and type are inferred, with dates as the fallback', () => {
  const { orderState, orderType } = __selfServiceTesting;
  assert.equal(orderState({ fulfilmentStatus: 'Completed' }), 'completed');
  assert.equal(orderState({ status: 'Delayed — awaiting civils' }), 'delayed');
  assert.equal(orderState({ status: 'Cancelled' }), 'cancelled');
  assert.equal(orderState({ status: 'Awaiting appointment' }), 'awaiting_appointment');
  assert.equal(orderState({ providerCompletionDate: '2026-01-01' }), 'completed');
  assert.equal(orderState({}), 'unknown');

  assert.equal(orderType({ orderType: 'Provide' }), 'provide');
  assert.equal(orderType({ type: 'Cease' }), 'cease');
});

test('Jola state names map onto ours', () => {
  // The Zen half of this test went with the Zen SIM estate: mobile is Jola's
  // job now, and a mapper with no caller is a mapper nothing keeps honest.
  assert.equal(__jolaTesting.jolaState('Barred'), 'suspended');
  assert.equal(__jolaTesting.jolaState('Disconnected'), 'ceased');
  assert.equal(__jolaTesting.jolaState('Spare'), 'pending');
});

test('MSISDNs are converted to the international form BT expects', () => {
  assert.equal(toMsisdn('07700900123'), '447700900123');
  assert.equal(toMsisdn('+44 7700 900123'), '447700900123');
  assert.equal(toMsisdn('0161 496 9790'), '441614969790');
});

test('London postcode areas are recognised for the BT coverage warning', () => {
  assert.equal(isLikelyLondon('W8 5TT'), true);
  assert.equal(isLikelyLondon('EC2A 3AY'), true);
  assert.equal(isLikelyLondon('BR1 1AA'), true);
  // BT's product is London only, so these must be flagged as out of area.
  assert.equal(isLikelyLondon('M1 1AE'), false);
  assert.equal(isLikelyLondon('LS1 4DY'), false);
  assert.equal(isLikelyLondon('G2 1DY'), false);
});

test('an unrecognised payload does not become a phantom fault', () => {
  // The live symptom: the Faults page reported 1 open fault, referenced
  // "fault-1", service "–", category Other, state Unknown, summary "Fault".
  // Every one of those is mapFault's fallback, so nothing had mapped -- a
  // wrapper object had been run through the fault mapper.
  assert.equal(looksLikeFault({ totalCount: 0, pageSize: 50 }), false);
  assert.equal(looksLikeFault({}), false);
  assert.equal(looksLikeFault(null), false);
  assert.equal(looksLikeFault([]), false);
  assert.equal(looksLikeFault('nope'), false);
});

test('a real fault is recognised from any one identifying field', () => {
  assert.ok(looksLikeFault({ faultReference: 'FLT12345678' }));
  assert.ok(looksLikeFault({ summary: 'No sync since 03:00' }));
  assert.ok(looksLikeFault({ status: 'Engineer assigned' }));
  assert.ok(looksLikeFault({ faultCategory: 'BROADBAND' }));
  assert.ok(looksLikeFault({ zenReference: 'ZEN1234567' }));
  assert.ok(looksLikeFault({ raisedDate: '2026-09-08' }));
});

test('a fault that maps properly keeps its real values', () => {
  const fault = mapFault(
    {
      faultReference: 'FLT99887766',
      zenReference: 'ZEN1234567',
      faultCategory: 'BROADBAND',
      summary: 'Intermittent dropouts',
      status: 'Engineer assigned',
      raisedDate: '2026-09-01',
    },
    0,
  );
  assert.equal(fault.reference, 'FLT99887766');
  assert.equal(fault.summary, 'Intermittent dropouts');
  assert.notEqual(fault.status, 'Unknown');
});
