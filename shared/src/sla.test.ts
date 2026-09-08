import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { slaState } from './sla';

const at = (iso: string): Date => new Date(iso);
const NOW = at('2026-09-08T12:00:00Z');

test('time remaining is shown in hours and minutes', () => {
  const s = slaState({ slaTarget: '2026-09-08T16:20:00Z' }, NOW);
  assert.equal(s?.label, '4h 20m');
  assert.equal(s?.tone, 'ok');
  assert.equal(s?.breached, false);
  assert.equal(s?.live, true);
});

test('a target under two hours away is urgent', () => {
  const s = slaState({ slaTarget: '2026-09-08T13:30:00Z' }, NOW);
  assert.equal(s?.tone, 'soon');
  assert.equal(s?.label, '1h 30m');
});

test('a passed target reads as over, not as negative time', () => {
  const s = slaState({ slaTarget: '2026-09-08T09:55:00Z' }, NOW);
  assert.equal(s?.breached, true);
  assert.equal(s?.tone, 'breached');
  assert.equal(s?.label, '2h 05m over');
});

test('a long target is shown in days', () => {
  const s = slaState({ slaTarget: '2026-09-11T14:00:00Z' }, NOW);
  assert.equal(s?.label, '3d 02h');
});

test('the supplier commitment beats a generic target', () => {
  // Both present: the committed date is the one they are held to.
  const s = slaState({ slaTarget: '2026-09-20T12:00:00Z', committedAt: '2026-09-08T14:00:00Z' }, NOW);
  assert.equal(s?.label, '2h 00m');
});

test('a cleared fault is judged when it cleared, not now', () => {
  // Cleared two hours inside its target a week ago. Measuring against now
  // would report it as days late for ever.
  const s = slaState(
    { slaTarget: '2026-09-01T12:00:00Z', clearedAt: '2026-09-01T10:00:00Z' },
    NOW,
  );
  assert.equal(s?.breached, false);
  assert.equal(s?.metOnClear, true);
  assert.equal(s?.live, false);
  assert.match(s?.label ?? '', /to spare/);
});

test('a fault cleared late still says so', () => {
  const s = slaState(
    { slaTarget: '2026-09-01T12:00:00Z', clearedAt: '2026-09-01T15:30:00Z' },
    NOW,
  );
  assert.equal(s?.breached, true);
  assert.equal(s?.tone, 'breached');
  assert.match(s?.label ?? '', /3h 30m late/);
});

test('no target means nothing to show', () => {
  assert.equal(slaState({}, NOW), null);
  assert.equal(slaState({ slaTarget: '' }, NOW), null);
  assert.equal(slaState({ slaTarget: 'next Tuesday' }, NOW), null);
});

test('an unparseable cleared date falls back to the live clock', () => {
  const s = slaState({ slaTarget: '2026-09-08T16:00:00Z', clearedAt: 'soon' }, NOW);
  assert.equal(s?.live, true);
  assert.equal(s?.label, '4h 00m');
});

test('minutes alone once it is close', () => {
  const s = slaState({ slaTarget: '2026-09-08T12:12:00Z' }, NOW);
  assert.equal(s?.label, '12m');
  assert.equal(s?.tone, 'soon');
});
