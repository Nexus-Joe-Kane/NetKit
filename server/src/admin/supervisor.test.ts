import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __supervisorTesting } from './supervisor';

const { backoffFor, recoveryActionsFor, FAILURES_TO_RECOVER, FAILURES_TO_OPEN, BACKOFF_LADDER_SECONDS } =
  __supervisorTesting;

test('recovery is attempted before the breaker trips', () => {
  // A single failure is a blip. Recovery gets a chance at the second, so a
  // recoverable fault never opens the circuit at all.
  assert.ok(FAILURES_TO_RECOVER < FAILURES_TO_OPEN, 'recovery must come before the breaker');
  assert.equal(FAILURES_TO_RECOVER, 2);
  assert.equal(FAILURES_TO_OPEN, 3);
});

test('backoff climbs and then holds at the ceiling', () => {
  const first = backoffFor(FAILURES_TO_OPEN);
  assert.equal(first, BACKOFF_LADDER_SECONDS[0]);

  // Each further failure moves one rung up the ladder.
  const climb = [3, 4, 5, 6, 7].map(backoffFor);
  assert.deepEqual(climb, BACKOFF_LADDER_SECONDS);

  // Beyond the ladder it holds, rather than growing without bound.
  const ceiling = BACKOFF_LADDER_SECONDS[BACKOFF_LADDER_SECONDS.length - 1];
  for (const failures of [8, 20, 500]) assert.equal(backoffFor(failures), ceiling);
});

test('the backoff ladder is strictly increasing', () => {
  for (let i = 1; i < BACKOFF_LADDER_SECONDS.length; i += 1) {
    assert.ok(
      BACKOFF_LADDER_SECONDS[i]! > BACKOFF_LADDER_SECONDS[i - 1]!,
      `rung ${i} (${BACKOFF_LADDER_SECONDS[i]}) must exceed rung ${i - 1} (${BACKOFF_LADDER_SECONDS[i - 1]})`,
    );
  }
});

test('each integration family has the right recovery action', () => {
  // The token re-mint must come first for Zen: an expired or revoked token is
  // by far the most common real cause, and re-minting is the cheap fix.
  const zen = recoveryActionsFor('zen-availability');
  assert.ok(zen.length >= 2);
  assert.match(zen[0]!.name, /token/i);

  assert.match(recoveryActionsFor('bt-imei-lookup')[0]!.name, /token/i);
  assert.match(recoveryActionsFor('ofcom-coverage')[0]!.name, /dataset/i);
  assert.match(recoveryActionsFor('os-places')[0]!.name, /cache/i);
  assert.match(recoveryActionsFor('postcodes-io')[0]!.name, /cache/i);

  // Resend must have none: re-sending a test email unattended would spam the
  // administrator's inbox on every sweep.
  assert.equal(recoveryActionsFor('resend').length, 0);

  // Anything unrecognised still gets a safe default.
  assert.ok(recoveryActionsFor('something-new').length >= 1);
});

test('every recovery action is safe to run repeatedly', async () => {
  // Recovery runs unattended, so an action must be idempotent — running it
  // against a healthy system must not throw or change behaviour.
  for (const key of ['zen-availability', 'bt-imei-lookup', 'os-places', 'postcodes-io', 'something-new']) {
    for (const action of recoveryActionsFor(key)) {
      await action.run();
      await action.run();
    }
  }
});
