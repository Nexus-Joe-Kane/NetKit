import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CHECK_INTERVAL_MS,
  FAILURES_TO_RAISE,
  SUCCESSES_TO_CLEAR,
  UNSTABLE_DISCONNECTS,
  applyCheck,
  applyClearance,
  attribute,
  clearanceProblem,
  countingDisconnections,
  isUnstable,
  newWatchState,
  verdict,
  type CheckResult,
  type SiteWatchState,
} from './index';

const T0 = Date.parse('2026-09-09T08:00:00.000Z');
const at = (checkNumber: number): string => new Date(T0 + checkNumber * CHECK_INTERVAL_MS).toISOString();

const down = (n: number): CheckResult[] => [{ source: 'unifi', at: at(n), reachable: 'down' }];
const up = (n: number): CheckResult[] => [{ source: 'unifi', at: at(n), reachable: 'up' }];
const silent = (n: number): CheckResult[] => [{ source: 'unifi', at: at(n), reachable: 'unknown' }];

/** Runs a sequence of checks and hands back the state and every action taken. */
function run(
  start: SiteWatchState,
  sequence: Array<{ n: number; results: CheckResult[] }>,
): { state: SiteWatchState; actions: string[] } {
  let state = start;
  const actions: string[] = [];
  for (const step of sequence) {
    const outcome = applyCheck(state, step.results, at(step.n));
    state = outcome.state;
    actions.push(outcome.action);
    // The caller opens the event; the state machine only says to.
    if (outcome.action === 'raise') state = { ...state, openEventId: `evt-${step.n}` };
  }
  return { state, actions };
}

/* ---- What a check saw ------------------------------------------------ */

test('anything saying up beats anything saying down', () => {
  // A console that has lost its heartbeat while the circuit is passing
  // traffic is not the customer being off.
  assert.equal(
    verdict([
      { source: 'unifi', at: at(0), reachable: 'down' },
      { source: 'zen', at: at(0), reachable: 'up' },
    ]),
    'up',
  );
});

test('nothing answering is unknown, not down', () => {
  // The morning a credential expires, every site would otherwise read as off.
  assert.equal(verdict([]), 'unknown');
  assert.equal(verdict(silent(0)), 'unknown');
});

test('a silent check moves neither counter', () => {
  const { state } = run(newWatchState('willow', 'Willow Road'), [
    { n: 0, results: down(0) },
    { n: 1, results: silent(1) },
  ]);
  assert.equal(state.consecutiveFailures, 1, 'an outage in progress must not be forgotten');
  assert.equal(state.consecutiveSuccesses, 0, 'and it must not creep towards being called fixed');
});

test('a site does not creep towards a ticket because a console is down', () => {
  const { actions } = run(newWatchState('willow', 'Willow Road'), [
    { n: 0, results: silent(0) },
    { n: 1, results: silent(1) },
    { n: 2, results: silent(2) },
  ]);
  assert.deepEqual(actions, ['nothing', 'nothing', 'nothing']);
});

/* ---- Raising ---------------------------------------------------------- */

test('one failed check is a blip and raises nothing', () => {
  const { actions } = run(newWatchState('willow', 'Willow Road'), [{ n: 0, results: down(0) }]);
  assert.deepEqual(actions, ['nothing']);
});

test('two in a row is an outage', () => {
  const { actions, state } = run(newWatchState('willow', 'Willow Road'), [
    { n: 0, results: down(0) },
    { n: 1, results: down(1) },
  ]);
  assert.deepEqual(actions, ['nothing', 'raise']);
  assert.equal(state.downSince, at(0), 'the outage started at the first failed check, not the second');
});

test('a blip then a recovery then a blip does not add up to an outage', () => {
  // Two failures with a success between them is a flapping line, and the
  // stability threshold is what deals with that — not a fresh ticket.
  const { actions } = run(newWatchState('willow', 'Willow Road'), [
    { n: 0, results: down(0) },
    { n: 1, results: up(1) },
    { n: 2, results: down(2) },
  ]);
  assert.deepEqual(actions, ['nothing', 'nothing', 'nothing']);
});

test('an outage already open does not raise a second ticket every five minutes', () => {
  const { actions } = run(newWatchState('willow', 'Willow Road'), [
    { n: 0, results: down(0) },
    { n: 1, results: down(1) },
    { n: 2, results: down(2) },
    { n: 3, results: down(3) },
  ]);
  assert.deepEqual(actions, ['nothing', 'raise', 'nothing', 'nothing']);
});

test('the threshold is what the constant says, not what the code happens to do', () => {
  const sequence = Array.from({ length: FAILURES_TO_RAISE }, (_, i) => ({ n: i, results: down(i) }));
  const { actions } = run(newWatchState('willow', 'Willow Road'), sequence);
  assert.equal(actions.filter((a) => a === 'raise').length, 1);
});

/* ---- Recovering ------------------------------------------------------ */

test('one good check does not close an outage', () => {
  // A flapping line answers one check in three. Closing on the first success
  // opens and closes the same event all morning.
  const { actions } = run(newWatchState('willow', 'Willow Road'), [
    { n: 0, results: down(0) },
    { n: 1, results: down(1) },
    { n: 2, results: up(2) },
  ]);
  assert.deepEqual(actions, ['nothing', 'raise', 'nothing']);
});

test('two good checks in a row calls it recovered', () => {
  const { actions, state } = run(newWatchState('willow', 'Willow Road'), [
    { n: 0, results: down(0) },
    { n: 1, results: down(1) },
    { n: 2, results: up(2) },
    { n: 3, results: up(3) },
  ]);
  assert.deepEqual(actions, ['nothing', 'raise', 'nothing', 'recovered']);
  assert.equal(state.consecutiveSuccesses, SUCCESSES_TO_CLEAR);
  assert.equal(state.downSince, undefined);
});

/* ---- Stability ------------------------------------------------------- */

test('a drop is counted on the first failed check, not on the raise', () => {
  // Otherwise a site that drops for five minutes at a time all day never
  // trips the threshold, because it never gets to a second failed check.
  let state = newWatchState('willow', 'Willow Road');
  for (let i = 0; i < 8; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    state = applyCheck(state, up(i + 1), at(i + 1)).state;
  }
  assert.equal(state.disconnections.length, 4);
});

test('five drops in a day is unstable', () => {
  let state = newWatchState('willow', 'Willow Road');
  const actions: string[] = [];
  for (let i = 0; i < UNSTABLE_DISCONNECTS * 2; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    const outcome = applyCheck(state, up(i + 1), at(i + 1));
    state = outcome.state;
    actions.push(outcome.action);
  }
  assert.equal(actions.filter((a) => a === 'unstable').length, 1, 'reported once it crosses, not on every check');
  assert.equal(isUnstable(state, at(20)), true);
});

test('drops older than the window stop counting', () => {
  const state: SiteWatchState = {
    ...newWatchState('willow', 'Willow Road'),
    disconnections: [
      '2026-09-07T08:00:00.000Z',
      '2026-09-07T09:00:00.000Z',
      '2026-09-09T07:00:00.000Z',
    ],
  };
  assert.deepEqual(countingDisconnections(state, '2026-09-09T08:00:00.000Z'), ['2026-09-09T07:00:00.000Z']);
});

/* ---- The reset, which is the whole point of the dismiss options ------- */

test('resolving stops the drops that have just been dealt with arming the next event', () => {
  // The failure this exists to prevent, in the user's words: getting another
  // email five minutes later because the count is already over threshold.
  let state = newWatchState('willow', 'Willow Road');
  for (let i = 0; i < 12; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    state = applyCheck(state, up(i + 1), at(i + 1)).state;
  }
  assert.equal(isUnstable(state, at(12)), true, 'six drops, well over the threshold');

  state = applyClearance(state, { disposition: 'resolved', at: at(12) });
  assert.equal(isUnstable(state, at(12)), false, 'the drops before the fix no longer count');

  // And the history is still there to read.
  assert.equal(state.disconnections.length, 6);
});

test('a site resolved needs two fresh failures to raise again, not one', () => {
  let state = newWatchState('willow', 'Willow Road');
  state = applyCheck(state, down(0), at(0)).state;
  state = { ...applyCheck(state, down(1), at(1)).state, openEventId: 'evt-1' };
  state = applyClearance(state, { disposition: 'resolved', at: at(2) });

  const first = applyCheck(state, down(3), at(3));
  assert.equal(first.action, 'nothing', 'one failed check after a fix is still a blip');
  const second = applyCheck(first.state, down(4), at(4));
  assert.equal(second.action, 'raise', 'and two is an outage again');
});

test('acknowledging is not resolving', () => {
  // "I have seen it" must not quietly restart the history, or a genuinely
  // bad site reads as fine because somebody keeps clicking acknowledge.
  let state = newWatchState('willow', 'Willow Road');
  for (let i = 0; i < 12; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    state = applyCheck(state, up(i + 1), at(i + 1)).state;
  }
  const after = applyClearance(state, { disposition: 'monitoring', at: at(12) });
  assert.equal(after.countingFrom, undefined);
  assert.equal(isUnstable(after, at(12)), true);
  assert.equal(after.openEventId, undefined, 'but the event is closed either way');
});

test('planned works suppress alerting and then stop suppressing it', () => {
  const state = applyClearance(newWatchState('willow', 'Willow Road'), {
    disposition: 'expected',
    at: at(0),
    until: at(10),
  });

  const during = run(state, [
    { n: 1, results: down(1) },
    { n: 2, results: down(2) },
  ]);
  assert.deepEqual(during.actions, ['nothing', 'nothing'], 'nothing raised during the works');

  const after = run({ ...state, consecutiveFailures: 0 }, [
    { n: 11, results: down(11) },
    { n: 12, results: down(12) },
  ]);
  assert.deepEqual(after.actions, ['nothing', 'raise'], 'and alerting comes back on its own');
});

test('planned works with no end date are rejected', () => {
  // Alerting that is switched off with no date is alerting that is switched
  // off, and nobody would ever notice.
  assert.ok(clearanceProblem({ disposition: 'expected', at: at(0) }));
  assert.ok(clearanceProblem({ disposition: 'expected', at: at(0), until: 'whenever' }));
  assert.ok(clearanceProblem({ disposition: 'expected', at: at(5), until: at(1) }), 'a date in the past is not a date');
  assert.equal(clearanceProblem({ disposition: 'expected', at: at(0), until: at(10) }), undefined);
  assert.equal(clearanceProblem({ disposition: 'resolved', at: at(0) }), undefined);
});

test('resolving lifts a suppression somebody set earlier', () => {
  const suppressedState: SiteWatchState = {
    ...newWatchState('willow', 'Willow Road'),
    suppressedUntil: at(100),
  };
  const resolved = applyClearance(suppressedState, { disposition: 'resolved', at: at(1) });
  assert.equal(resolved.suppressedUntil, undefined, 'it is fixed, so start watching it properly again');
});

/* ---- Whose fault is it ----------------------------------------------- */

test('a line test finding a network fault settles it', () => {
  const { attribution } = attribute({ circuit: 'down', unifi: 'down', lineTest: 'network-fault' });
  assert.equal(attribution, 'supplier');
});

test('a live circuit with a dead console is ours', () => {
  const { attribution, because } = attribute({ circuit: 'up', unifi: 'down' });
  assert.equal(attribution, 'ours');
  assert.match(because, /between the socket and the network/);
});

test('a dead circuit that tests clean is power, not a supplier fault', () => {
  // Raising this with a supplier gets an engineer sent out, nothing found,
  // and the customer billed for the visit.
  const { attribution } = attribute({ circuit: 'down', unifi: 'down', lineTest: 'clean' });
  assert.equal(attribution, 'power-or-site');
});

test('everything hardwired down with the mobile backup carrying is the supplier', () => {
  const { attribution } = attribute({ circuit: 'down', unifi: 'down', backupCarrying: true });
  assert.equal(attribution, 'supplier');
});

test('not enough evidence is answered as not enough evidence', () => {
  // A confident wrong answer sends an engineer to the wrong place.
  assert.equal(attribute({}).attribution, 'unclear');
  assert.equal(attribute({ circuit: 'unknown', unifi: 'unknown', lineTest: 'not-run' }).attribution, 'unclear');
  assert.equal(attribute({ circuit: 'down', unifi: 'down', lineTest: 'not-run' }).attribution, 'unclear');
});

test('an unstable site is reported once, not on every check for a day', () => {
  // 288 checks a day. Without a guard, 288 identical reports.
  let state = newWatchState('willow', 'Willow Road');
  const actions: string[] = [];
  for (let i = 0; i < UNSTABLE_DISCONNECTS * 2; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    const outcome = applyCheck(state, up(i + 1), at(i + 1));
    state = outcome.state;
    actions.push(outcome.action);
  }
  assert.equal(actions.filter((a) => a === 'unstable').length, 1);

  // Twenty more good checks while still over the threshold.
  for (let i = 11; i < 31; i += 1) {
    const outcome = applyCheck(state, up(i), at(i));
    state = outcome.state;
    assert.equal(outcome.action, 'nothing', `check ${i} reported again`);
  }
});

test('a site that goes bad again after settling down is reported again', () => {
  let state: SiteWatchState = {
    ...newWatchState('willow', 'Willow Road'),
    disconnections: Array.from({ length: UNSTABLE_DISCONNECTS }, (_, i) => at(i * 2)),
    unstableNotifiedAt: at(10),
  };

  // Twenty-four hours later the old drops have aged out.
  const settled = applyCheck(state, up(500), at(500));
  assert.equal(settled.action, 'nothing');
  assert.equal(settled.state.unstableNotifiedAt, undefined, 'the report is armed again');

  // Then a fresh run of drops.
  state = settled.state;
  const actions: string[] = [];
  for (let i = 501; i < 501 + UNSTABLE_DISCONNECTS * 2; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    const outcome = applyCheck(state, up(i + 1), at(i + 1));
    state = outcome.state;
    actions.push(outcome.action);
  }
  assert.equal(actions.filter((a) => a === 'unstable').length, 1, 'reported the second run too');
});

test('an unstable report is not an outage, so it never reads as recovered', () => {
  // Hanging a stability report on `openEventId` would have the next good
  // check close it as fixed, when the site was up the whole time.
  let state = newWatchState('willow', 'Willow Road');
  let unstableAction = '';
  for (let i = 0; i < UNSTABLE_DISCONNECTS * 2; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    const outcome = applyCheck(state, up(i + 1), at(i + 1));
    state = outcome.state;
    if (outcome.action === 'unstable') unstableAction = outcome.action;
  }
  assert.equal(unstableAction, 'unstable');
  assert.equal(state.openEventId, undefined);
  assert.equal(applyCheck(state, up(40), at(40)).action, 'nothing');
});

test('resolving an unstable site arms the report again from scratch', () => {
  let state = newWatchState('willow', 'Willow Road');
  for (let i = 0; i < UNSTABLE_DISCONNECTS * 2; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    state = applyCheck(state, up(i + 1), at(i + 1)).state;
  }
  assert.ok(state.unstableNotifiedAt);

  state = applyClearance(state, { disposition: 'resolved', at: at(11) });
  assert.equal(state.unstableNotifiedAt, undefined);
  assert.equal(isUnstable(state, at(11)), false, 'and it is under the threshold again');
});
