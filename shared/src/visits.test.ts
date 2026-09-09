import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  APPROVER,
  CHECK_OPENS_HOURS,
  approvalRequestNote,
  cancelWindow,
  dueForCheck,
  sortByUrgency,
  visitCancelledMessage,
  visitStillNeededNote,
  type VisitRecord,
} from './index';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-09T09:00:00Z');

const visit = (over: Partial<VisitRecord> = {}): VisitRecord => ({
  id: 'v1',
  ticketId: '48213',
  reason: 'ont-no-light',
  access: 'inside',
  state: 'booked',
  bookedAt: '2026-09-08T10:00:00Z',
  ...over,
});

/* ---- When to ask ---------------------------------------------------- */

test('the chase opens two days out, not the day before', () => {
  // The whole point: cancelling inside 24 hours is charged, so a check on the
  // morning of the visit has already lost the choice it exists to inform.
  const far = visit({ slot: { date: '2026-09-20', window: 'AM' } });
  const near = visit({ slot: { date: '2026-09-10', window: 'AM' } });
  assert.equal(dueForCheck(far, NOW), false);
  assert.equal(dueForCheck(near, NOW), true);
  assert.ok(CHECK_OPENS_HOURS > 24, 'opening inside the free window would be pointless');
});

test('a closed visit is never due again', () => {
  const slot = { date: '2026-09-10', window: 'AM' };
  assert.equal(dueForCheck(visit({ slot, state: 'cancelled' }), NOW), false);
  assert.equal(dueForCheck(visit({ slot, state: 'attended' }), NOW), false);
  assert.equal(dueForCheck(visit({ slot, state: 'confirmed' }), NOW), true, 'confirmed still gets re-checked');
});

test('with no slot the clock runs from the booking instead', () => {
  assert.equal(dueForCheck(visit({ bookedAt: NOW.toISOString() }), NOW), false);
  assert.equal(
    dueForCheck(visit({ bookedAt: new Date(NOW.getTime() - 49 * HOUR).toISOString() }), NOW),
    true,
    'a supplier that has not given a slot in two days is worth chasing',
  );
});

/* ---- The window ----------------------------------------------------- */

test('the free-cancellation window is counted in hours left', () => {
  // Slot is midday on the 11th; free until midday on the 10th; now is 09:00
  // on the 9th — 27 hours.
  const w = cancelWindow(visit({ slot: { date: '2026-09-11', window: 'AM' } }), NOW);
  assert.equal(w?.chargeable, false);
  assert.equal(w?.hoursLeft, 27);
  assert.match(w!.label, /27 hours left/);
});

test('inside the window it says the charge applies either way', () => {
  const w = cancelWindow(visit({ slot: { date: '2026-09-09', window: 'PM' } }), NOW);
  assert.equal(w?.chargeable, true);
  assert.match(w!.label, /£165 \+ VAT/);
});

test('no slot is not the same answer as plenty of time', () => {
  assert.equal(cancelWindow(visit(), NOW), null);
});

test('one hour reads as one hour', () => {
  const slot = { date: '2026-09-10', window: 'AM' };
  const now = new Date('2026-09-09T11:00:00Z');
  const w = cancelWindow(visit({ slot }), now);
  assert.equal(w?.hoursLeft, 1);
  assert.match(w!.label, /^1 hour left/);
});

test('the ones about to become chargeable are chased first', () => {
  const soon = visit({ id: 'soon', slot: { date: '2026-09-10', window: 'AM' } });
  const later = visit({ id: 'later', slot: { date: '2026-09-15', window: 'AM' } });
  const noSlot = visit({ id: 'none' });
  assert.deepEqual(sortByUrgency([later, noSlot, soon]).map((v) => v.id), ['soon', 'later', 'none']);
});

/* ---- What gets written ---------------------------------------------- */

test('the approval note notifies the approver and leads with the deadline', () => {
  const note = approvalRequestNote({
    visit: visit({ slot: { date: '2026-09-11', window: '08:00 – 13:00' }, supplier: 'Zen Internet', bookedBy: 'Joe Kane' }),
    deepLink: 'https://comms.supportwizard.net/#/visits/v1',
    requestedBy: 'Joe Kane',
    now: NOW,
  });
  assert.match(note, /^@Sam Roffey/, 'the handle is what makes Zendesk tell him');
  assert.equal(APPROVER.email, 'sam@supportwizard.net');
  assert.match(note, /27 hours left to cancel without a charge/);
  assert.match(note, /Slot: Friday 11 September, 08:00 – 13:00/);
  assert.match(note, /Reason booked: ONT reporting loss of light \(network side\)/);
  assert.match(note, /https:\/\/comms\.supportwizard\.net\/#\/visits\/v1/);
});

test('with no deep link the note still says where to go', () => {
  const note = approvalRequestNote({ visit: visit(), now: NOW });
  assert.match(note, /in NetKit, under Visits/);
  assert.doesNotMatch(note, /undefined/);
});

test('inside the window the approval note says so up front', () => {
  const note = approvalRequestNote({ visit: visit({ slot: { date: '2026-09-09', window: 'PM' } }), now: NOW });
  assert.match(note, /already inside the 24-hour window/);
  assert.match(note, /£165 \+ VAT/);
});

test('the cancellation message tells the customer there is nothing to pay', () => {
  // The last thing they were told about this appointment was that it could
  // cost them £165 + VAT, so silence on the point is not reassurance.
  const message = visitCancelledMessage({
    contactName: 'Jane',
    slot: { date: '2026-09-11', window: 'AM' },
    because: 'the fibre path was repaired at the cabinet on Tuesday',
  });
  assert.match(message.body, /^Hello Jane,/);
  assert.match(message.body, /Friday 11 September, AM/);
  assert.match(message.body, /nothing to pay/);
  assert.match(message.body, /repaired at the cabinet on Tuesday/);
  assert.match(message.body, /SupportWizard Network Support Team$/);
});

test('the cancellation message works with no slot and no reason given', () => {
  const message = visitCancelledMessage({});
  assert.match(message.body, /^Hello,/);
  assert.match(message.body, /working normally again/);
  assert.doesNotMatch(message.body, /undefined|null/);
});

test('the still-needed note forbids the supplier rebooking quietly', () => {
  // A rebooked visit is a new date the customer has not been told about,
  // which is exactly how somebody ends up out when the engineer arrives.
  const note = visitStillNeededNote({
    visit: visit({ slot: { date: '2026-09-11', window: 'AM' } }),
    checkedBy: 'Sam Roffey',
    evidence: ['Line test still reports loss of light', 'No change since Monday'],
  });
  assert.match(note, /Slot to keep: Friday 11 September, AM/);
  assert.match(note, /Do not let the supplier rebook/);
  assert.match(note, /· Line test still reports loss of light/);
  assert.match(note, /Checked by Sam Roffey/);
});
