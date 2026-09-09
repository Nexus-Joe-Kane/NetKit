import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEVER_AUTH_AFTER_DAYS,
  SNOOZE_PRESETS,
  ageLabel,
  findNeverAuthenticated,
  isActionable,
  isDue,
  snoozeUntil,
  sortInbox,
  type InboxItem,
} from './inbox';
import type { LineRecord } from './types';

const NOW = new Date('2026-09-09T10:00:00Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

const line = (over: Partial<LineRecord> = {}): LineRecord => ({
  id: 'l1',
  status: 'active',
  technology: 'SOGEA',
  provider: 'Zen',
  serviceId: 'ZEN998',
  address: {
    singleLine: '45 Brockley Rise, LONDON, SE23 1JG',
    lines: ['45 Brockley Rise'],
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    uprn: '100023253338',
    source: 'os-places',
  },
  contract: { startDate: daysAgo(60) },
  discoveredVia: 'zen',
  notes: [],
  ...over,
});

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  kind: 'line-never-authenticated',
  subject: 's',
  detail: 'd',
  evidence: [],
  raisedAt: daysAgo(10),
  state: 'open',
  seenCount: 1,
  lastSeenAt: NOW.toISOString(),
  ...over,
});

test('a line live a month with no session ever is raised', () => {
  const found = findNeverAuthenticated([line()], NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, 'line-never-authenticated:ZEN998');
  assert.match(found[0]?.subject ?? '', /has never connected/);
  assert.match(found[0]?.detail ?? '', /billing for nothing, or the site is not open yet/);
  assert.equal(found[0]?.link, '#/site/100023253338/lines');
});

test('a line live for less than a month is left alone', () => {
  // The restaurant that got its line in a fortnight before opening.
  assert.deepEqual(findNeverAuthenticated([line({ contract: { startDate: daysAgo(14) } })], NOW), []);
  assert.equal(NEVER_AUTH_AFTER_DAYS, 30);
});

test('any evidence of a session, ever, and there is nothing to say', () => {
  for (const radius of [
    { online: true },
    { lastAuthAt: '2026-01-01T00:00:00Z' },
    { onlineSince: '2026-01-01T00:00:00Z' },
  ]) {
    assert.deepEqual(findNeverAuthenticated([line({ radius })], NOW), [], JSON.stringify(radius));
  }
});

test('a line with no start date is not judged rather than guessed at', () => {
  // Without one there is no way to know how long it has been live, and
  // guessing would fire on lines installed yesterday.
  assert.deepEqual(findNeverAuthenticated([line({ contract: {} })], NOW), []);
  assert.deepEqual(findNeverAuthenticated([line({ contract: { startDate: 'not a date' } })], NOW), []);
});

test('a leased line is not accused of never authenticating', () => {
  assert.deepEqual(findNeverAuthenticated([line({ technology: 'Leased Line' })], NOW), []);
});

test('a ceased line is not raised', () => {
  assert.deepEqual(findNeverAuthenticated([line({ status: 'ceased' })], NOW), []);
});

test('the evidence carries what somebody needs without looking it up', () => {
  const found = findNeverAuthenticated([line({ cli: '02071234567', customerName: 'Megans' })], NOW);
  const labels = (found[0]?.evidence ?? []).map((e) => e.label);
  assert.ok(labels.includes('Live since'));
  assert.ok(labels.includes('Days live'));
  assert.ok(labels.includes('CLI'));
  assert.ok(labels.includes('Client'));
  assert.equal(found[0]?.evidence.find((e) => e.label === 'Days live')?.value, '60');
});

/* ---- Snooze ---------------------------------------------------------- */

test('a snooze holds until its date and then comes back', () => {
  const snoozed = item({ state: 'snoozed', snoozedUntil: snoozeUntil(30, NOW) });
  assert.equal(isDue(snoozed, NOW), false);
  assert.equal(isActionable(snoozed, NOW), false);

  const later = new Date(NOW.getTime() + 31 * 86_400_000);
  assert.equal(isDue(snoozed, later), true);
  assert.equal(isActionable(snoozed, later), true);
});

test('an open item is always actionable and a dismissed one never is', () => {
  assert.equal(isActionable(item(), NOW), true);
  assert.equal(isActionable(item({ state: 'dismissed' }), NOW), false);
  assert.equal(isActionable(item({ state: 'converted' }), NOW), false);
});

test('the snooze presets cover the reasons these actually get snoozed', () => {
  assert.deepEqual(SNOOZE_PRESETS.map((p) => p.days), [14, 30, 90, 182]);
  assert.ok(SNOOZE_PRESETS.every((p) => p.hint.length > 5), 'each needs a reason a person recognises');
});

/* ---- The list -------------------------------------------------------- */

test('an item that came back off snooze sorts above everything', () => {
  // Somebody looked at it and expected it gone. It is the strongest signal
  // on the list.
  const sorted = sortInbox(
    [
      item({ id: 'fresh', seenCount: 9 }),
      item({ id: 'returned', state: 'snoozed', snoozedUntil: daysAgo(1), seenCount: 1 }),
    ],
    NOW,
  );
  assert.equal(sorted[0]?.id, 'returned');
});

test('persistence sorts up, because something seen five times is more likely real', () => {
  const sorted = sortInbox([item({ id: 'once', seenCount: 1 }), item({ id: 'often', seenCount: 5 })], NOW);
  assert.equal(sorted[0]?.id, 'often');
});

test('age reads as a person would say it', () => {
  assert.equal(ageLabel(item({ raisedAt: NOW.toISOString() }), NOW), 'today');
  assert.equal(ageLabel(item({ raisedAt: daysAgo(1) }), NOW), 'yesterday');
  assert.equal(ageLabel(item({ raisedAt: daysAgo(5) }), NOW), '5 days ago');
  assert.equal(ageLabel(item({ raisedAt: daysAgo(21) }), NOW), '3 weeks ago');
  assert.equal(ageLabel(item({ raisedAt: daysAgo(200) }), NOW), '6 months ago');
});
