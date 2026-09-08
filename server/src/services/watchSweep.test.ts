import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_INTERVAL_MS, PER_SWEEP, selectDue } from './watchSweep';

const dir = mkdtempSync(join(tmpdir(), 'netkit-sweep-'));
process.env.DATA_DIR = dir;

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const row = (id: string, lastCheckedAt?: string) => ({
  userId: 'user-a',
  watch: { id, ...(lastCheckedAt ? { lastCheckedAt } : {}) },
});

test('a watch checked an hour ago is not checked again', () => {
  const due = selectDue([row('recent', ago(60 * 60 * 1000))]);
  assert.deepEqual(due, [], 'the interval is a day, not an hour');
});

test('a never-checked watch is due, and goes first', () => {
  const due = selectDue([row('old', ago(CHECK_INTERVAL_MS + 1000)), row('new')]);
  assert.deepEqual(
    due.map((d) => d.watch.id),
    ['new', 'old'],
    'a watch that has never been checked has waited longest',
  );
});

test('the oldest check goes first, so a long list cannot starve its tail', () => {
  const due = selectDue([
    row('b', ago(CHECK_INTERVAL_MS + 2 * 60 * 60 * 1000)),
    row('c', ago(CHECK_INTERVAL_MS + 1 * 60 * 60 * 1000)),
    row('a', ago(CHECK_INTERVAL_MS + 5 * 60 * 60 * 1000)),
  ]);
  assert.deepEqual(due.map((d) => d.watch.id), ['a', 'b', 'c']);
});

test('a sweep takes no more than its share', () => {
  const many = Array.from({ length: PER_SWEEP + 4 }, (_, i) => row(`w${i}`));
  assert.equal(selectDue(many).length, PER_SWEEP);
});

test('an unreadable timestamp is treated as due rather than never', () => {
  // A hand-edited or half-written data file should not park a watch forever.
  assert.equal(selectDue([row('broken', 'not a date')]).length, 1);
});
