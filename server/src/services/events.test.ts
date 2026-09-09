import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILURES_TO_RAISE, UNSTABLE_DISCONNECTS, isUnstable, type CheckResult } from '@sw/shared';
import {
  attachDiagnosis,
  attachTicket,
  clear,
  getEvent,
  listEvents,
  openEventFor,
  raiseEvent,
  recordCheck,
  reloadEvents,
  resetEvents,
  watchState,
} from './events';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'netkit-events-'));

const KEY = 'market-halls';
const NAME = 'Market Halls Ltd';
const T0 = Date.parse('2026-09-09T07:00:00.000Z');
const at = (n: number): string => new Date(T0 + n * 5 * 60 * 1000).toISOString();
const down = (n: number): CheckResult[] => [{ source: 'unifi', at: at(n), reachable: 'down' }];
const up = (n: number): CheckResult[] => [{ source: 'unifi', at: at(n), reachable: 'up' }];

const raise = (over: Partial<Parameters<typeof raiseEvent>[0]> = {}) =>
  raiseEvent({ kind: 'outage', clientKey: KEY, clientName: NAME, because: 'Two failed checks.', ...over });

/* ---- One event per site per kind ------------------------------------- */

test('a second outage is not opened for a site that already has one', () => {
  // The failure that makes somebody switch the whole thing off: a fresh
  // ticket every five minutes for an outage already on the board.
  resetEvents();
  const first = raise();
  const second = raise();
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.event.id, first.event.id);
  assert.equal(listEvents().filter((e) => e.clientKey === KEY).length, 1);
});

test('a stability report and an outage are different events', () => {
  resetEvents();
  raise();
  const unstable = raise({ kind: 'unstable', because: '6 drops in 24 hours.' });
  assert.equal(unstable.created, true);
  assert.equal(openEventFor(KEY, 'outage')?.kind, 'outage');
  assert.equal(openEventFor(KEY, 'unstable')?.kind, 'unstable');
});

test('a cleared event does not block the next one', () => {
  resetEvents();
  const first = raise();
  clear(first.event.id, { disposition: 'resolved', at: at(4), resolution: 'Reseated the ONT.' });
  const second = raise();
  assert.equal(second.created, true);
  assert.notEqual(second.event.id, first.event.id);
});

/* ---- The pin that stops a second ticket ------------------------------ */

test('an outage pins the watch state so the next check raises nothing', () => {
  resetEvents();
  recordCheck(KEY, NAME, down(0), at(0));
  const second = recordCheck(KEY, NAME, down(1), at(1));
  assert.equal(second.action, 'raise');

  raise();
  assert.equal(watchState(KEY, NAME).openEventId, getEvent(openEventFor(KEY)!.id)?.id);

  const third = recordCheck(KEY, NAME, down(2), at(2));
  assert.equal(third.action, 'nothing', 'already open');
});

test('a stability report is not pinned, so a good check does not read as a recovery', () => {
  // Pinning it would have the next good check close an event for a site
  // that was up the whole time.
  resetEvents();
  raise({ kind: 'unstable', because: '6 drops in 24 hours.' });
  assert.equal(watchState(KEY, NAME).openEventId, undefined);
  assert.equal(recordCheck(KEY, NAME, up(1), at(1)).action, 'nothing');
});

/* ---- Counters survive a restart -------------------------------------- */

test('a site on its first failed check is still on it after a restart', () => {
  // Without this an outage never reaches two failed checks, because the
  // count is lost every time the process recycles, and nothing is ever
  // raised. Passenger recycles the app more often than a fault lasts.
  resetEvents();
  recordCheck(KEY, NAME, down(0), at(0));
  assert.equal(watchState(KEY, NAME).consecutiveFailures, 1);

  reloadEvents(); // the process comes back
  assert.equal(watchState(KEY, NAME).consecutiveFailures, 1, 'read back off disk');

  const outcome = recordCheck(KEY, NAME, down(1), at(1));
  assert.equal(outcome.action, 'raise');
  assert.equal(FAILURES_TO_RAISE, 2);
});

/* ---- Clearing moves the watermark ------------------------------------ */

test('clearing an event and moving the watermark are one operation', () => {
  // Coming apart is exactly the "another email five minutes later" failure.
  resetEvents();
  let state = watchState(KEY, NAME);
  for (let i = 0; i < 12; i += 2) {
    recordCheck(KEY, NAME, down(i), at(i));
    recordCheck(KEY, NAME, up(i + 1), at(i + 1));
  }
  state = watchState(KEY, NAME);
  assert.equal(isUnstable(state, at(12)), true, 'six drops');

  const event = raise({ kind: 'unstable', because: '6 drops in 24 hours.' });
  const result = clear(event.event.id, {
    disposition: 'resolved',
    at: at(12),
    by: 'Joe Kane',
    resolution: 'Reseated the ONT and the line tested clean.',
  });

  assert.equal(result?.event.status, 'cleared');
  assert.equal(isUnstable(watchState(KEY, NAME), at(12)), false, 'the watermark moved with it');
});

test('a known cause closes the event and moves no watermark', () => {
  // Nothing was fixed, so the history is untouched — what changes is that
  // nobody is told about it again.
  resetEvents();
  for (let i = 0; i < 12; i += 2) {
    recordCheck(KEY, NAME, down(i), at(i));
    recordCheck(KEY, NAME, up(i + 1), at(i + 1));
  }
  const event = raise({ kind: 'unstable', because: '6 drops in 24 hours.' });
  clear(event.event.id, { disposition: 'known-cause', at: at(12) });

  assert.equal(openEventFor(KEY, 'unstable'), null, 'the event is closed');
  assert.equal(isUnstable(watchState(KEY, NAME), at(12)), true, 'but the site is still bad');
});

test('an exception is stored with its reason and who signed it off', () => {
  resetEvents();
  recordCheck(KEY, NAME, down(0), at(0));
  const event = raise();
  const result = clear(event.event.id, {
    disposition: 'exception',
    at: at(4),
    resolution: 'Line tested clean, console back up.',
    exceptionReason: 'Fibre is 14 months out on this street.',
    signedOffBy: 'Sam Roffey',
  });

  assert.equal(result?.watch.cadence, 'sparse');
  assert.equal(result?.watch.exception?.signedOffBy, 'Sam Roffey');
  // And it survives a restart, because an exception nobody can see is an
  // exception that gets quietly re-raised.
  reloadEvents();
  assert.equal(watchState(KEY, NAME).cadence, 'sparse');
  assert.match(watchState(KEY, NAME).exception?.reason ?? '', /14 months/);
});

test('a site marked not ours stops being watched at all', () => {
  resetEvents();
  recordCheck(KEY, NAME, down(0), at(0));
  const event = raise();
  clear(event.event.id, { disposition: 'not-ours', at: at(2) });
  assert.equal(watchState(KEY, NAME).consecutiveFailures, 0, 'the state is gone, not merely reset');
});

/* ---- What gets attached ---------------------------------------------- */

test('a diagnosis and a ticket both land on the event', () => {
  resetEvents();
  const { event } = raise();
  attachDiagnosis(event.id, {
    attribution: 'supplier',
    attributionBecause: 'The line test found a fault in the network.',
    findings: [{ source: 'line-test', label: 'Line test', value: 'No sync at the NTE', verdict: 'bad' }],
    inventory: { mobiles: [{ msisdn: '07700900123', operator: 'EE' }] },
  });
  attachTicket(event.id, '48213', 'https://supportwizard.zendesk.com/agent/tickets/48213');

  const stored = getEvent(event.id)!;
  assert.equal(stored.attribution, 'supplier');
  assert.equal(stored.findings?.length, 1);
  assert.equal(stored.inventory?.mobiles?.[0]?.operator, 'EE');
  assert.equal(stored.ticketId, '48213');
});

test('attaching to an event that is not there is answered, not thrown', () => {
  resetEvents();
  assert.equal(attachDiagnosis('evt_nope', { attribution: 'ours' }), null);
  assert.equal(attachTicket('evt_nope', '1'), null);
  assert.equal(clear('evt_nope', { disposition: 'resolved', at: at(0), resolution: 'x' }), null);
});

/* ---- Persistence ----------------------------------------------------- */

test('events survive a restart', () => {
  resetEvents();
  const { event } = raise({ clientKey: 'willow', clientName: 'Willow Road', because: 'Two failed checks.' });
  attachTicket(event.id, '48999');

  reloadEvents();
  const stored = getEvent(event.id);
  assert.equal(stored?.ticketId, '48999');
  assert.equal(stored?.clientName, 'Willow Road');
});

test('cleared events are hidden by default and available on request', () => {
  resetEvents();
  const { event } = raise({ clientKey: 'hidden', clientName: 'Hidden Ltd', because: 'Two failed checks.' });
  clear(event.id, { disposition: 'resolved', at: at(1), resolution: 'Reseated the ONT.' });

  assert.equal(listEvents().some((e) => e.id === event.id), false);
  assert.equal(listEvents({ includeCleared: true }).some((e) => e.id === event.id), true);
});

/* ---- One counter per site, not one for the estate -------------------- */

test('drops are counted per site, so a normal morning across the estate raises nothing', () => {
  // The thing to get wrong: one shared counter. Forty sites each dropping
  // once is a normal morning and is 40 drops — eight times the threshold —
  // so a shared counter would flag the whole estate as unstable by 07:00.
  resetEvents();
  const sites = Array.from({ length: 40 }, (_, i) => `site-${String(i).padStart(2, '0')}`);
  let n = 0;
  for (const key of sites) {
    const drops = key === 'site-07' ? UNSTABLE_DISCONNECTS + 1 : 1;
    for (let d = 0; d < drops; d += 1) {
      recordCheck(key, key, down(n), at(n));
      n += 1;
      recordCheck(key, key, up(n), at(n));
      n += 1;
    }
  }

  const now = at(n);
  const flagged = sites.filter((key) => isUnstable(watchState(key, key), now));
  assert.deepEqual(flagged, ['site-07'], 'only the site that actually flapped');

  const total = sites.reduce((sum, key) => sum + watchState(key, key).disconnections.length, 0);
  assert.equal(total, 39 + UNSTABLE_DISCONNECTS + 1, 'and the estate total is nowhere near any threshold');
});

test('one site’s drops never reach another site’s counter', () => {
  resetEvents();
  for (let i = 0; i < 20; i += 2) {
    recordCheck('noisy', 'Noisy Ltd', down(i), at(i));
    recordCheck('noisy', 'Noisy Ltd', up(i + 1), at(i + 1));
  }
  recordCheck('quiet', 'Quiet Ltd', down(21), at(21));
  recordCheck('quiet', 'Quiet Ltd', up(22), at(22));

  assert.equal(watchState('noisy', 'Noisy Ltd').disconnections.length, 10);
  assert.equal(watchState('quiet', 'Quiet Ltd').disconnections.length, 1);
  assert.equal(isUnstable(watchState('quiet', 'Quiet Ltd'), at(23)), false);
});
