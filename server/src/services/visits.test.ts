import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { closeVisit, getVisit, listVisits, markApprovalAsked, recordVisit, resetVisits } from './visits';

const base = {
  ticketId: '48213',
  reason: 'ont-no-light' as const,
  access: 'inside' as const,
};

test('a re-booking replaces the open record rather than adding a second', () => {
  // Two rows for one ticket means two chases, and sooner or later one of them
  // cancels a visit the other has just confirmed.
  resetVisits();
  const first = recordVisit({ ...base, slot: { date: '2026-09-11', window: 'AM' } });
  const second = recordVisit({ ...base, slot: { date: '2026-09-18', window: 'PM' } });

  const { open } = listVisits();
  assert.equal(open.length, 1);
  assert.equal(open[0]?.id, second.id);
  assert.equal(getVisit(first.id), null);
});

test('a closed visit is kept when the same ticket books again', () => {
  // The history is the point: "we cancelled one and then booked another" is a
  // different story from "we booked one".
  resetVisits();
  const first = recordVisit(base);
  closeVisit({ id: first.id, outcome: 'cancelled', by: 'Sam Roffey' });
  recordVisit(base);

  const { open, closed } = listVisits();
  assert.equal(open.length, 1);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.id, first.id);
});

test('being asked moves a visit into checking without closing it', () => {
  resetVisits();
  const visit = recordVisit({ ...base, slot: { date: '2026-09-11', window: 'AM' } });
  const asked = markApprovalAsked(visit.id);
  assert.equal(asked?.state, 'checking');
  assert.ok(asked?.approvalAskedAt);
  assert.equal(listVisits().open.length, 1, 'still open — nothing has been decided');
});

test('confirming keeps the visit on the board', () => {
  // It is still going ahead, and it wants checking again if the slot moves.
  resetVisits();
  const visit = recordVisit({ ...base, slot: { date: '2026-09-11', window: 'AM' } });
  closeVisit({ id: visit.id, outcome: 'confirmed', by: 'Sam Roffey' });
  const { open, closed } = listVisits();
  assert.equal(open.length, 1);
  assert.equal(open[0]?.state, 'confirmed');
  assert.equal(closed.length, 0);
});

test('the evidence is stored with the decision, not just the decision', () => {
  // The next person needs to know a visit was dropped because the line came
  // back, not because somebody was clearing a list.
  resetVisits();
  const visit = recordVisit(base);
  const closed = closeVisit({
    id: visit.id,
    outcome: 'cancelled',
    by: 'Sam Roffey',
    note: 'repaired at the cabinet',
    evidence: ['Line test pass', 'No drops since Tuesday'],
  });
  assert.equal(closed?.outcomeNote, 'repaired at the cabinet');
  assert.deepEqual(closed?.evidence, ['Line test pass', 'No drops since Tuesday']);
  assert.equal(closed?.closedBy, 'Sam Roffey');
});

test('due is computed from the clock, not from a stored flag', () => {
  resetVisits();
  recordVisit({ ...base, slot: { date: '2026-09-11', window: 'AM' } });
  const early = listVisits(new Date('2026-09-01T09:00:00Z'));
  const late = listVisits(new Date('2026-09-10T09:00:00Z'));
  assert.equal(early.open[0]?.due, false);
  assert.equal(late.open[0]?.due, true);
});

test('an unknown id is a no-op rather than a throw', () => {
  resetVisits();
  assert.equal(closeVisit({ id: 'nope', outcome: 'cancelled' }), null);
  assert.equal(markApprovalAsked('nope'), null);
});
