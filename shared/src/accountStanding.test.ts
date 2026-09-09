import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYG_PICKER_LIMIT,
  STORE_URL,
  barsForOnStop,
  firstName,
  onStopReminder,
  paygEmail,
  paygNudge,
  readStanding,
  standingDef,
} from './accountStanding';

test('an unrecognised standing is unknown, never optimistically "on support"', () => {
  // Assuming a contract exists is the expensive direction to be wrong in.
  assert.equal(readStanding('Gold tier widget plan'), 'unknown');
  assert.equal(readStanding(''), 'unknown');
  assert.equal(readStanding(undefined), 'unknown');
  assert.equal(readStanding(null), 'unknown');
});

test('on stop wins over any other wording in the same string', () => {
  assert.equal(readStanding('On Stop (was PAYG)'), 'on-stop');
  assert.equal(readStanding('Support contract — ON STOP for non-payment'), 'on-stop');
  assert.equal(readStanding('credit hold'), 'on-stop');
});

test('the ways people actually type PAYG all read as PAYG', () => {
  for (const raw of ['PAYG', 'Pay as you go', 'pay-as-you-go', 'Ad hoc', 'T&M', 'Time and materials']) {
    assert.equal(readStanding(raw), 'payg', raw);
  }
});

test('support wording reads as support, break-fix included', () => {
  for (const raw of ['Support contract', 'Managed', 'Retainer', 'Break-fix', 'Contracted']) {
    assert.equal(readStanding(raw), 'support', raw);
  }
});

test('PAYG and on stop are both blocking; support is quiet', () => {
  assert.equal(standingDef('payg').prominence, 'blocking');
  assert.equal(standingDef('on-stop').prominence, 'blocking');
  assert.equal(standingDef('support').prominence, 'quiet');
  assert.equal(standingDef('unknown').prominence, 'none');
});

test('the nudge greets the engineer by name where there is one', () => {
  assert.match(paygNudge({ clientName: 'Willow', engineerFirstName: 'Joe' }), /^Joe — just a reminder/);
  assert.match(paygNudge({ clientName: 'Willow' }), /^Just a reminder/);
  assert.match(paygNudge({ clientName: 'Willow' }), /purchased support time/);
});

test('the PAYG email is Joe’s wording, signed by whoever is sending it', () => {
  const email = paygEmail({ contactFirstName: 'Megan', clientName: 'Willow Estate Agents', fromFirstName: 'Joe' });
  assert.match(email.body, /^Hi Megan,/);
  assert.match(email.body, /Willow Estate Agents is on PAYG terms for IT Support currently/);
  assert.match(email.body, /purchase time from our website/);
  assert.ok(email.body.includes(STORE_URL));
  assert.match(email.body, /If you have any questions, feel free to let me know!/);
  assert.match(email.body, /All the best,\n\nJoe$/);
  assert.match(email.subject, /Willow Estate Agents/);
});

test('a first name comes out of a full one, and never blank', () => {
  assert.equal(firstName('Megan Fletcher'), 'Megan');
  assert.equal(firstName('  Sam  '), 'Sam');
  assert.equal(firstName(''), 'there');
  assert.equal(firstName(undefined), 'there');
});

test('the picker only appears while a list is recognisable', () => {
  assert.equal(PAYG_PICKER_LIMIT, 5);
});

/* ---- On stop -------------------------------------------------------- */

test('going on stop bars live SIMs and live broadband', () => {
  const bars = barsForOnStop({
    sims: [
      { iccid: '111', msisdn: '07700900001', state: 'active' },
      { iccid: '222', state: 'active' },
    ],
    lines: [{ serviceId: 'ZEN1', cli: '02071234567', technology: 'SOGEA', status: 'active' }],
  });
  assert.equal(bars.length, 3);
  assert.equal(bars.filter((b) => b.kind === 'sim').length, 2);
  assert.equal(bars.find((b) => b.kind === 'line')?.identifier, 'ZEN1');
  assert.equal(bars[0]?.label, '07700900001', 'a number is more use than an ICCID on a list');
});

test('anything already off is left alone', () => {
  const bars = barsForOnStop({
    sims: [
      { iccid: '111', state: 'ceased' },
      { iccid: '222', state: 'suspended' },
    ],
    lines: [{ serviceId: 'ZEN1', technology: 'SOGEA', status: 'ceased' }],
  });
  assert.deepEqual(bars, []);
});

test('a line with no identifier is skipped rather than barred blind', () => {
  const bars = barsForOnStop({ sims: [], lines: [{ technology: 'SOGEA', status: 'active' }] });
  assert.deepEqual(bars, []);
});

test('the reminder names the reason and who to ask, not just "barred"', () => {
  // The failure it exists to stop is somebody helpfully unbarring next week.
  const text = onStopReminder({ clientName: 'Willow', since: '01/09/2026', barred: 3 });
  assert.match(text, /ON STOP since 01\/09\/2026 for non-payment/);
  assert.match(text, /3 services have been barred on purpose/);
  assert.match(text, /clearing it with accounts first/);
  assert.match(onStopReminder({ clientName: 'X', barred: 1 }), /1 service has been barred/);
});
