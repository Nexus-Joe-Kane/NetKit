import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { actionPhrase, activityNote, actorLabel, trailPlacement, withTrail, worthReporting, type ActivityEntry } from './index';

const at = (hour: number) => `2026-09-09T${String(hour).padStart(2, '0')}:00:00.000Z`;

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  at: at(9),
  action: 'diagnostics.test_run',
  summary: 'Line test on ZEN123456',
  ...over,
});

/* ---- Who did it ------------------------------------------------------ */

test('automatic work is never credited to a person', () => {
  // The watch sweep audits under the watch owner's id while running at three
  // in the morning. If the trail read "Joe Kane ran a line test" he would go
  // looking for the call he never made.
  assert.equal(
    actorLabel(entry({ automatic: true, actor: { name: 'Joe Kane', email: 'joe@supportwizard.net' } })),
    'NetKit, automatically',
  );
});

test('a person is named, by name where we have one and email where we do not', () => {
  assert.equal(actorLabel(entry({ actor: { name: 'Joe Kane', email: 'joe@supportwizard.net' } })), 'Joe Kane');
  assert.equal(actorLabel(entry({ actor: { email: 'joe@supportwizard.net' } })), 'joe@supportwizard.net');
});

test('a step with nobody against it reads as automatic rather than as blank', () => {
  assert.equal(actorLabel(entry()), 'NetKit, automatically');
});

/* ---- Where the trail goes -------------------------------------------- */

test('a customer never sees the trail', () => {
  // The one rule that matters. A public note carrying "Ran a line test.
  // Raised a fault. Adjusted UniFi." tells the person paying the bill only
  // that we were flailing.
  assert.equal(trailPlacement('public'), 'separate');
  assert.equal(trailPlacement('private'), 'append');
});

test('a public note keeps its own wording and the trail follows privately', () => {
  const result = withTrail('An engineer is booked for Thursday morning.', 'public', [entry()]);
  assert.equal(result.primary, 'An engineer is booked for Thursday morning.');
  assert.ok(result.followUp);
  assert.match(result.followUp!, /Ran a line test/);
});

test('a private note carries the trail inline', () => {
  const result = withTrail('Fault raised with the supplier.', 'private', [entry()]);
  assert.match(result.primary, /^Fault raised with the supplier\./);
  assert.match(result.primary, /What has been done/);
  assert.equal(result.followUp, undefined);
});

test('no steps means the note goes out untouched', () => {
  // A first note on a fresh ticket must not gain an empty heading and a rule.
  const result = withTrail('Fault raised.', 'private', []);
  assert.equal(result.primary, 'Fault raised.');
  assert.equal(result.followUp, undefined);
});

/* ---- How it reads ---------------------------------------------------- */

test('steps read oldest first whatever order they arrive in', () => {
  const note = activityNote([
    entry({ at: at(11), action: 'fault.raised', summary: 'No sync on ZEN123456' }),
    entry({ at: at(9), action: 'diagnostics.test_run', summary: 'Line test on ZEN123456' }),
  ]);
  assert.ok(note.indexOf('Ran a line test') < note.indexOf('Raised a fault'), note);
});

test('an outcome is stated where there is one', () => {
  const note = activityNote([entry({ outcome: 'Fault found in the network' })]);
  assert.match(note, /Fault found in the network/);
});

test('a summary that only repeats the phrase is not printed twice', () => {
  const note = activityNote([entry({ action: 'visit.cancelled', summary: 'Cancelled the engineer visit' })]);
  assert.equal(note.match(/Cancelled the engineer visit/g)?.length, 1, note);
});

test('an action nobody has written a phrase for shows its own key', () => {
  // Better a bare `sim.tariff_changed` on the ticket than a wrong sentence,
  // and better than the step vanishing.
  assert.equal(actionPhrase('sim.tariff_changed'), 'sim.tariff_changed');
});

test('only actions worth reporting reach a ticket', () => {
  assert.equal(worthReporting('diagnostics.test_run'), true);
  assert.equal(worthReporting('fault.raised'), true);
  // Signing in is audit-log business, not something to put on a fault.
  assert.equal(worthReporting('auth.login'), false);
  assert.equal(worthReporting('bulk.lookup'), false);
  assert.equal(worthReporting('admin.credentials_saved'), false);
});

test('a bad timestamp is printed as-is rather than as "Invalid Date"', () => {
  const note = activityNote([entry({ at: 'not a date' })]);
  assert.match(note, /not a date/);
});
