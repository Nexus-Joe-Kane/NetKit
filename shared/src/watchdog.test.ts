import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CHECK_INTERVAL_MS,
  EXCEPTION_INTERVAL_MS,
  FAILURES_TO_RAISE,
  FOREVER,
  SUCCESSES_TO_CLEAR,
  UNSTABLE_DISCONNECTS,
  checkIntervalFor,
  siteDueForCheck,
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

test('a known cause stops the alerts and keeps the history', () => {
  // Failing kit the customer will not replace. Nothing is fixed, so no
  // counter is reset -- what changes is that nobody is told about it any
  // more. Resetting the history here would have the site read as healthy.
  let state = newWatchState('willow', 'Willow Road');
  for (let i = 0; i < 12; i += 2) {
    state = applyCheck(state, down(i), at(i)).state;
    state = applyCheck(state, up(i + 1), at(i + 1)).state;
  }
  const after = applyClearance(state, { disposition: 'known-cause', at: at(12) });
  assert.equal(after.countingFrom, undefined, 'the drops still happened');
  assert.equal(isUnstable(after, at(12)), true, 'and the site is still bad');
  assert.equal(after.openEventId, undefined, 'but the event is closed');

  // And nothing is raised about it again.
  const later = run({ ...after, consecutiveFailures: 0 }, [
    { n: 13, results: down(13) },
    { n: 14, results: down(14) },
    { n: 15, results: down(15) },
  ]);
  assert.deepEqual(later.actions, ['nothing', 'nothing', 'nothing']);
});

test('a known cause has no end date, because there is no date it stops being true', () => {
  const after = applyClearance(newWatchState('willow', 'Willow Road'), {
    disposition: 'known-cause',
    at: at(0),
  });
  assert.equal(after.suppressedUntil, FOREVER);
});

test('an exception drops the site to a monthly check', () => {
  const after = applyClearance(newWatchState('willow', 'Willow Road'), {
    disposition: 'exception',
    at: at(0),
    resolution: 'Line tested clean, console back up, customer accepts the ADSL fallback.',
    exceptionReason: 'Fibre is 14 months out on this street and they will not pay for a bonded pair.',
    signedOffBy: 'Sam Roffey',
  });

  assert.equal(after.cadence, 'sparse');
  assert.equal(checkIntervalFor(after), EXCEPTION_INTERVAL_MS);
  assert.equal(after.exception?.signedOffBy, 'Sam Roffey');
  assert.match(after.exception?.reason ?? '', /14 months/);

  // Monthly, not never: checked once and then left alone.
  assert.equal(siteDueForCheck({ ...after, lastCheckedAt: at(0) }, at(1)), false);
  const monthLater = new Date(Date.parse(at(0)) + EXCEPTION_INTERVAL_MS).toISOString();
  assert.equal(siteDueForCheck({ ...after, lastCheckedAt: at(0) }, monthLater), true);
});

test('an exception needs a reason and a name, and the API cannot be talked past', () => {
  // In six months this is the only record of why the site stopped being
  // checked every five minutes.
  const base = { disposition: 'exception' as const, at: at(0), resolution: 'Tested clean.' };
  assert.match(clearanceProblem(base) ?? '', /reason/i);
  assert.match(clearanceProblem({ ...base, exceptionReason: 'because' }) ?? '', /name against it/i);
  assert.equal(
    clearanceProblem({ ...base, exceptionReason: 'because', signedOffBy: 'Sam Roffey' }),
    undefined,
  );
});

test('resolving and excepting both need a closure report; dismissing does not', () => {
  // The report goes on the ticket, so an empty one is a ticket closed with
  // nothing on it.
  assert.match(clearanceProblem({ disposition: 'resolved', at: at(0) }) ?? '', /what was done/i);
  assert.match(clearanceProblem({ disposition: 'resolved', at: at(0), resolution: '   ' }) ?? '', /what was done/i);
  assert.equal(clearanceProblem({ disposition: 'resolved', at: at(0), resolution: 'Reseated the ONT.' }), undefined);
  // Nothing was closed, so there is nothing to report.
  assert.equal(clearanceProblem({ disposition: 'known-cause', at: at(0) }), undefined);
  assert.equal(clearanceProblem({ disposition: 'not-ours', at: at(0) }), undefined);
});

test('a genuine fix puts an excepted site back on the normal cadence', () => {
  // The fibre finally arrived. It should be watched properly again rather
  // than staying on a monthly check because of a decision from last year.
  const excepted = applyClearance(newWatchState('willow', 'Willow Road'), {
    disposition: 'exception',
    at: at(0),
    resolution: 'Tested clean.',
    exceptionReason: 'No fibre available.',
    signedOffBy: 'Sam Roffey',
  });
  const fixed = applyClearance(excepted, {
    disposition: 'resolved',
    at: at(20),
    resolution: 'FTTP installed and tested.',
  });
  assert.equal(fixed.cadence, 'normal');
  assert.equal(fixed.exception, undefined);
  assert.equal(checkIntervalFor(fixed), CHECK_INTERVAL_MS);
});

test('an unrecognised way of closing an event is refused', () => {
  assert.ok(clearanceProblem({ disposition: 'whatever' as never, at: at(0) }));
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

/* ---- An open event puts the site to one side ------------------------- */

test('an open event is reported as answering again once, not 288 times a day', () => {
  // This was live. With an event open and the site back up, every subsequent
  // check returned `recovered` — a follow-up every five minutes on an event
  // nobody had closed yet, which is exactly the bombardment to avoid.
  let state: SiteWatchState = { ...newWatchState('willow', 'Willow Road'), openEventId: 'evt-1' };
  const actions: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const outcome = applyCheck(state, up(i), at(i));
    state = outcome.state;
    actions.push(outcome.action);
  }
  assert.equal(actions.filter((a) => a === 'recovered').length, 1, actions.join(','));
});

test('coming back up does not close the event — only a person does', () => {
  let state: SiteWatchState = { ...newWatchState('willow', 'Willow Road'), openEventId: 'evt-1' };
  for (let i = 0; i < 6; i += 1) state = applyCheck(state, up(i), at(i)).state;
  assert.equal(state.openEventId, 'evt-1', 'up is not the same as fixed');
});

test('while an event is open nothing is tested, raised or chased again', () => {
  // "Once the line test has run and the ticket is open, no further automatic
  // tests and no further follow-ups — it just puts them to one side."
  let state: SiteWatchState = { ...newWatchState('willow', 'Willow Road'), openEventId: 'evt-1' };
  const actions: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    // A flapping site: down, down, up, repeat. Every one of these would have
    // been a candidate to raise or report something.
    const results = i % 3 === 2 ? up(i) : down(i);
    const outcome = applyCheck(state, results, at(i));
    state = outcome.state;
    actions.push(outcome.action);
  }
  assert.deepEqual(
    [...new Set(actions)],
    ['nothing'],
    'an open event means the work is on somebody’s desk already',
  );
});

test('the checks keep running while the event is open, so the history is complete', () => {
  // Put to one side is not switched off: the drops still need counting, or
  // the closure report has nothing to say about how bad it was.
  let state: SiteWatchState = { ...newWatchState('willow', 'Willow Road'), openEventId: 'evt-1' };
  for (let i = 0; i < 12; i += 3) {
    state = applyCheck(state, down(i), at(i)).state;
    state = applyCheck(state, down(i + 1), at(i + 1)).state;
    state = applyCheck(state, up(i + 2), at(i + 2)).state;
  }
  assert.equal(state.disconnections.length, 4);
  assert.ok(state.lastCheckedAt, 'and the site is still being looked at');
});

test('a resolved event re-arms the recovery note for next time', () => {
  const state: SiteWatchState = {
    ...newWatchState('willow', 'Willow Road'),
    openEventId: 'evt-1',
    recoveryNotedAt: at(4),
  };
  const after = applyClearance(state, { disposition: 'resolved', at: at(5), resolution: 'Reseated the ONT.' });
  assert.equal(after.recoveryNotedAt, undefined);
  assert.equal(after.openEventId, undefined);
});
