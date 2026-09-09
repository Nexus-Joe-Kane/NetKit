import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snoozeUntil } from '@sw/shared';
import type { InboxItem } from '@sw/shared';
import { actOnItem, listInbox, raiseFindings, reloadInbox, resetInbox } from './inbox';

const dir = mkdtempSync(join(tmpdir(), 'netkit-inbox-'));
process.env.DATA_DIR = dir;

const finding = (id = 'line-never-authenticated:ZEN998', subject = 'never connected') =>
  ({
    id,
    kind: 'line-never-authenticated' as const,
    subject,
    detail: 'd',
    evidence: [{ label: 'Days live', value: '60' }],
    raisedAt: new Date().toISOString(),
  }) satisfies Omit<InboxItem, 'state' | 'seenCount' | 'lastSeenAt'>;

test('a new finding is raised once', () => {
  resetInbox();
  assert.deepEqual(raiseFindings([finding()]), { raised: 1, seenAgain: 0 });
  assert.equal(listInbox().actionable.length, 1);
});

test('the same finding on the next sweep is counted, not re-raised', () => {
  // Re-raising would reset the age and lose the history, making something
  // somebody looked at last week look new again.
  resetInbox();
  raiseFindings([finding()]);
  const first = listInbox().actionable[0]!;

  assert.deepEqual(raiseFindings([finding()]), { raised: 0, seenAgain: 1 });
  const after = listInbox().actionable[0]!;
  assert.equal(listInbox().actionable.length, 1);
  assert.equal(after.seenCount, 2);
  assert.equal(after.raisedAt, first.raisedAt, 'the age is not reset');
});

test('the wording is refreshed, so "30 days" does not still say 30 next month', () => {
  resetInbox();
  raiseFindings([finding('x', 'live 30 days')]);
  raiseFindings([finding('x', 'live 60 days')]);
  assert.equal(listInbox().actionable[0]?.subject, 'live 60 days');
});

test('a dismissal needs a reason, and refuses without one', () => {
  resetInbox();
  raiseFindings([finding()]);
  const refused = actOnItem({ id: finding().id, state: 'dismissed' });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.message : '', /needs the answer, not a blank/);
  assert.equal(listInbox().actionable.length, 1, 'still on the list');
});

test('a dismissal with a reason closes it and keeps the reason', () => {
  resetInbox();
  raiseFindings([finding()]);
  const done = actOnItem({
    id: finding().id,
    state: 'dismissed',
    resolution: 'Site not open until October — customer confirmed.',
    actedBy: 'Joe Kane',
  });
  assert.equal(done.ok, true);
  const list = listInbox();
  assert.equal(list.actionable.length, 0);
  assert.equal(list.closed[0]?.resolution, 'Site not open until October — customer confirmed.');
  assert.equal(list.closed[0]?.actedBy, 'Joe Kane');
});

test('a dismissed finding that is still true comes back, with its old answer attached', () => {
  resetInbox();
  raiseFindings([finding()]);
  actOnItem({ id: finding().id, state: 'dismissed', resolution: 'Not open yet' });
  assert.equal(listInbox().actionable.length, 0);

  raiseFindings([finding()]);
  const back = listInbox().actionable[0];
  assert.equal(back?.state, 'open');
  assert.equal(back?.resolution, 'Not open yet', 'the history survives, so nobody starts from scratch');
  assert.equal(back?.seenCount, 2);
});

test('a snooze needs a date, and holds the item until it', () => {
  resetInbox();
  raiseFindings([finding()]);
  assert.equal(actOnItem({ id: finding().id, state: 'snoozed' }).ok, false);

  actOnItem({
    id: finding().id,
    state: 'snoozed',
    snoozedUntil: snoozeUntil(90),
    snoozeReason: 'Restaurant opens in November',
  });
  const list = listInbox();
  assert.equal(list.actionable.length, 0);
  assert.equal(list.closed[0]?.snoozeReason, 'Restaurant opens in November');
});

test('a snoozed item is findable rather than hidden', () => {
  // Hiding it entirely means nobody can find what they snoozed.
  resetInbox();
  raiseFindings([finding()]);
  actOnItem({ id: finding().id, state: 'snoozed', snoozedUntil: snoozeUntil(30) });
  assert.equal(listInbox().closed.some((i) => i.state === 'snoozed'), true);
});

test('a conversion needs the ticket it became', () => {
  resetInbox();
  raiseFindings([finding()]);
  assert.equal(actOnItem({ id: finding().id, state: 'converted' }).ok, false);
  const done = actOnItem({ id: finding().id, state: 'converted', ticketId: '48213' });
  assert.equal(done.ok, true);
  assert.equal(listInbox().closed[0]?.ticketId, '48213');
});

test('acting on something that is not there fails rather than throwing', () => {
  resetInbox();
  const result = actOnItem({ id: 'nope', state: 'dismissed', resolution: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : '', /No such inbox item/);
});

test('the inbox survives being written and re-read', () => {
  resetInbox();
  raiseFindings([finding()]);
  actOnItem({ id: finding().id, state: 'snoozed', snoozedUntil: snoozeUntil(14), snoozeReason: 'Fit-out' });
  reloadInbox();
  assert.equal(listInbox().closed[0]?.snoozeReason, 'Fit-out');
});
