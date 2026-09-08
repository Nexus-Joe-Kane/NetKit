import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeQuota, quotaState, refundQuota, quotaSummary, resetQuota } from './quota';

/**
 * The quota module reads `DATA_DIR` through the config singleton, which
 * caches on first call rather than at import — so setting the environment
 * here, before any of the functions below run, is enough. Each test file
 * gets its own process, so this cannot leak into another suite.
 */
const dir = mkdtempSync(join(tmpdir(), 'netkit-quota-'));
process.env.DATA_DIR = dir;
process.env.AVAILABILITY_DAILY_BUDGET = '3';

test('a budget counts down and then refuses', () => {
  resetQuota();
  const user = 'user-a';
  assert.equal(quotaState('availability', user).allowed, true);
  assert.equal(quotaState('availability', user).remaining, 3);

  consumeQuota('availability', user);
  consumeQuota('availability', user);
  const two = quotaState('availability', user);
  assert.equal(two.used, 2);
  assert.equal(two.remaining, 1);
  assert.equal(two.allowed, true);

  consumeQuota('availability', user);
  const spent = quotaState('availability', user);
  assert.equal(spent.used, 3);
  assert.equal(spent.remaining, 0);
  assert.equal(spent.allowed, false, 'the third check is the last one allowed');
});

test('budgets are per user, so one person cannot spend another', () => {
  resetQuota();
  consumeQuota('availability', 'user-a');
  consumeQuota('availability', 'user-a');
  consumeQuota('availability', 'user-a');
  assert.equal(quotaState('availability', 'user-a').allowed, false);
  assert.equal(quotaState('availability', 'user-b').allowed, true, 'user B is unaffected');
});

test('a refund gives back exactly one unit and never goes negative', () => {
  resetQuota();
  consumeQuota('order', 'user-c');
  refundQuota('order', 'user-c');
  assert.equal(quotaState('order', 'user-c').used, 0);

  // Refunding something never spent must not create credit.
  refundQuota('order', 'user-c');
  refundQuota('order', 'user-c');
  assert.equal(quotaState('order', 'user-c').used, 0);
});

test('the counters survive being dropped from memory', () => {
  resetQuota();
  consumeQuota('order', 'user-d');
  consumeQuota('order', 'user-d');
  resetQuota(); // as if the process had restarted
  assert.equal(quotaState('order', 'user-d').used, 2, 'counts are persisted, not just in memory');
});

test('the summary lists what was spent, biggest first', () => {
  resetQuota();
  consumeQuota('availability', 'heavy');
  consumeQuota('availability', 'heavy');
  consumeQuota('availability', 'light');

  const summary = quotaSummary();
  assert.equal(summary.day, new Date().toISOString().slice(0, 10));
  assert.equal(summary.limits.availability, 3);
  const rows = summary.rows.filter((r) => r.userId === 'heavy' || r.userId === 'light');
  assert.equal(rows[0]?.userId, 'heavy');
  assert.equal(rows[0]?.used, 2);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
