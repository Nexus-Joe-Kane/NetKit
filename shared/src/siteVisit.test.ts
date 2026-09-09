import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  GATE_ITEMS,
  gateBlockers,
  gateFor,
  gateNote,
  gateReady,
  reasonConflict,
  siteVisitMessage,
  suggestedReasons,
  visitBookedNote,
  visitDateLabel,
  type GateAnswer,
  type TestFinding,
} from './index';

const allDone = (ids: string[]): Record<string, GateAnswer> =>
  Object.fromEntries(ids.map((id) => [id, 'done' as GateAnswer]));

/* ---- The gate ------------------------------------------------------- */

test('an unanswered question blocks as hard as a failed one', () => {
  // Silence is not a yes. Treating a blank as a pass is how a checklist
  // becomes decoration.
  const items = gateFor('FTTP');
  assert.equal(gateReady(items, {}), false);
  assert.equal(gateBlockers(items, {}).length, items.length);

  const partial = { ...allDone(items.map((i) => i.id)) };
  delete (partial as Record<string, unknown>)['access'];
  assert.equal(gateReady(items, partial), false);
  assert.deepEqual(gateBlockers(items, partial).map((i) => i.id), ['access']);
});

test('"not applicable" clears a question and "not done" does not', () => {
  const items = gateFor('FTTP');
  const answers = allDone(items.map((i) => i.id));
  answers['second-router'] = 'not-applicable';
  assert.equal(gateReady(items, answers), true);
  answers['second-router'] = 'not-done';
  assert.equal(gateReady(items, answers), false);
});

test('the test socket is only asked of lines that have one', () => {
  const fttp = gateFor('FTTP').map((i) => i.id);
  const sogea = gateFor('SOGEA').map((i) => i.id);
  assert.ok(!fttp.includes('test-socket'), 'there is no test socket on a fibre line');
  assert.ok(fttp.includes('ont-lights'));
  assert.ok(sogea.includes('test-socket'));
  assert.ok(!sogea.includes('ont-lights'), 'there is no ONT on a copper line');
});

test('with no technology known, every question is asked', () => {
  // The safe direction: asking about a test socket on a fibre line wastes a
  // moment, and skipping it on a copper one costs the charge.
  assert.equal(gateFor(undefined).length, GATE_ITEMS.length);
});

test('what the line test asked for specifically joins the gate', () => {
  const findings: TestFinding[] = [
    {
      kind: 'ont-los',
      meaning: 'The fibre terminal reports loss of light.',
      side: 'network',
      steps: [],
      beforeBooking: 'Confirm the fibre is not simply unplugged at the terminal.',
      severity: 'critical',
    },
  ];
  const items = gateFor('FTTP', findings);
  assert.ok(items.some((i) => i.id === 'test:ont-los'));
  assert.ok(items.some((i) => i.question.includes('not simply unplugged')));
});

test('the charge is quoted on the questions that exist because of it', () => {
  const withCharge = GATE_ITEMS.filter((i) => i.why.includes('£165 + VAT'));
  assert.ok(withCharge.some((i) => i.id === 'access'), 'nobody on site is the classic charge');
  assert.ok(withCharge.some((i) => i.id === 'test-socket'));
  // Never added together, anywhere.
  for (const item of GATE_ITEMS) assert.doesNotMatch(item.why, /£198|£19[0-9]/);
});

test('the gate is written out for the ticket, including what was skipped', () => {
  const items = gateFor('SOGEA');
  const answers = allDone(items.map((i) => i.id));
  answers['known-outage'] = 'not-done';
  const note = gateNote(items, answers);
  assert.match(note, /Checks before booking:/);
  assert.match(note, /known outage.*NOT CHECKED/);
  assert.match(note, /test socket.*checked/);
});

/* ---- The reason ----------------------------------------------------- */

test('the reasons the test suggested come first, in severity order', () => {
  const findings: TestFinding[] = [
    { kind: 'a', meaning: '', side: 'network', steps: [], suggestedReason: 'ont-no-light', severity: 'critical' },
    { kind: 'b', meaning: '', side: 'unclear', steps: [], suggestedReason: 'intermittent-drops', severity: 'warning' },
    { kind: 'c', meaning: '', side: 'network', steps: [], suggestedReason: 'ont-no-light', severity: 'info' },
  ];
  assert.deepEqual(suggestedReasons(findings), ['ont-no-light', 'intermittent-drops']);
});

test('booking a network visit for a customer-side fault is called out', () => {
  const { conflict, warning } = reasonConflict('ont-no-light', 'customer');
  assert.equal(conflict, true);
  assert.match(warning!, /£165 \+ VAT/, 'the cost of being wrong is the point of the warning');
});

test('agreement, and an unclear test, raise nothing', () => {
  assert.equal(reasonConflict('ont-no-light', 'network').conflict, false);
  assert.equal(reasonConflict('ont-no-light', 'unclear').conflict, false);
  assert.equal(reasonConflict('unknown', 'customer').conflict, false);
});

/* ---- What the customer is told -------------------------------------- */

test('a date reads as a person would say it', () => {
  assert.equal(visitDateLabel('2026-09-15'), 'Tuesday 15 September');
  assert.equal(visitDateLabel('not a date'), 'not a date', 'junk is passed through, not turned into 1970');
});

test('both variants carry the charge and the notice period', () => {
  // The reason both do: the supplier confirms a slot when it suits them, so a
  // customer told the date a day later would otherwise never have been told
  // the charge at all.
  const withSlot = siteVisitMessage({
    reason: 'ont-no-light',
    access: 'inside',
    supplier: 'Openreach',
    slot: { date: '2026-09-15', window: '08:00 – 13:00' },
  });
  const without = siteVisitMessage({ reason: 'ont-no-light', access: 'inside', supplier: 'Openreach' });

  for (const message of [withSlot, without]) {
    assert.match(message.body, /£165 \+ VAT/);
    assert.match(message.body, /24 hours/);
    assert.match(message.body, /SupportWizard Network Support Team$/);
  }
  assert.match(withSlot.subject, /Tuesday 15 September, 08:00 – 13:00/);
  assert.match(withSlot.body, /Tuesday 15 September, 08:00 – 13:00/);
  assert.match(without.subject, /slot to follow/);
  assert.match(without.body, /not given us a time slot yet/);
});

test('the charge figure is never added up', () => {
  const message = siteVisitMessage({ reason: 'cabinet', access: 'unknown' });
  assert.doesNotMatch(message.body, /£198/);
  assert.match(message.body, /£165 \+ VAT/);
});

test('the customer is told why, in words that are not an accusation', () => {
  const message = siteVisitMessage({ reason: 'internal-wiring', access: 'inside' });
  assert.match(message.body, /a fault in the wiring inside the property/);
  assert.doesNotMatch(message.body, /your fault|you caused|customer’s fault/i);
});

test('no supplier contact details reach the customer', () => {
  // An alt-net's "call us direct" loses us the thread and gets the customer
  // nowhere: a supplier will not discuss a wholesale fault with an end user.
  const message = siteVisitMessage({ reason: 'cabinet', access: 'outside', supplier: 'Openreach' });
  assert.doesNotMatch(message.body, /\b0[0-9]{2,4}\s?[0-9]{3,4}\s?[0-9]{3,4}\b/, 'no phone numbers');
  assert.match(message.body, /reply to this ticket/);
});

test('access wording never lets the customer think nobody is needed', () => {
  for (const access of ['inside', 'outside', 'unknown'] as const) {
    const message = siteVisitMessage({ reason: 'cabinet', access });
    assert.match(message.body, /somebody/i, `the ${access} variant still asks for a person on site`);
  }
});

test('a nameless greeting is not an empty one', () => {
  assert.match(siteVisitMessage({ reason: 'cabinet', access: 'unknown' }).body, /^Hello,/);
  assert.match(
    siteVisitMessage({ reason: 'cabinet', access: 'unknown', contactName: 'Jane' }).body,
    /^Hello Jane,/,
  );
});

/* ---- The private record --------------------------------------------- */

test('the booking note records the basis, not just the booking', () => {
  const items = gateFor('FTTP');
  const note = visitBookedNote({
    reason: 'ont-no-light',
    access: 'inside',
    supplier: 'Openreach',
    slot: { date: '2026-09-15', window: 'AM' },
    testSide: 'network',
    bookedBy: 'Joe Kane',
    gate: gateNote(items, allDone(items.map((i) => i.id))),
  });
  assert.match(note, /Reason: ONT reporting loss of light \(network side\)/);
  assert.match(note, /Slot: Tuesday 15 September, AM/);
  assert.match(note, /Booked by: Joe Kane/);
  assert.match(note, /Checks before booking:/);
  assert.match(note, /Missed-appointment charge quoted to the customer: £165 \+ VAT/);
});

test('a disagreement between the reason and the test is on the record', () => {
  const note = visitBookedNote({ reason: 'ont-no-light', access: 'inside', testSide: 'customer' });
  assert.match(note, /Flagged at booking:/);
  assert.match(note, /£165 \+ VAT/);
});

test('an unconfirmed slot says so rather than reading as booked for today', () => {
  const note = visitBookedNote({ reason: 'cabinet', access: 'outside' });
  assert.match(note, /Slot: not yet confirmed by the supplier/);
});

test('the real supplier can never reach the customer’s message', () => {
  // Not a caller convention — the field is ignored on the customer side. A
  // customer told the fault is with Zen rings Zen, who will not discuss a
  // wholesale fault with an end customer, and now knows who we buy from.
  const message = siteVisitMessage({
    reason: 'cabinet',
    access: 'outside',
    supplier: 'Zen Internet',
    slot: { date: '2026-09-15', window: 'AM' },
  });
  assert.doesNotMatch(message.body, /Zen/i);
  assert.doesNotMatch(message.subject, /Zen/i);
  assert.match(message.body, /the network supplier/);
});

test('the private record does name the supplier, because engineers need it', () => {
  const note = visitBookedNote({ reason: 'cabinet', access: 'outside', supplier: 'Zen Internet' });
  assert.match(note, /Supplier: Zen Internet/);
});
