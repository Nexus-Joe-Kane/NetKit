import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NetworkSite, WanHealth } from '@sw/shared';
import {
  DIAGNOSE_BUDGET,
  __sweepTesting,
  SWEEP_INTERVAL_MS,
  reachabilityFromCounts,
  reachabilityFromWan,
  resetSweepClock,
  sweepDue,
  sweepOutages,
  sweepOutagesIfDue,
} from './outageSweep';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'netkit-sweep-'));

const site = (counts?: NetworkSite['counts']): NetworkSite => ({
  siteId: 's1',
  hostId: 'h1',
  name: 'Market Halls Victoria',
  ...(counts ? { counts } : {}),
});

/* ---- Is the site up, judged cheaply --------------------------------- */

test('a console that can reach none of its own kit means the site is off', () => {
  assert.equal(reachabilityFromCounts(site({ totalDevices: 4, offlineDevices: 4 })), 'down');
});

test('a console that can reach some of it means the site is up', () => {
  // One dead access point is not an outage. Somebody will notice it in the
  // equipment list; nobody needs a ticket at three in the morning.
  assert.equal(reachabilityFromCounts(site({ totalDevices: 4, offlineDevices: 3 })), 'up');
  assert.equal(reachabilityFromCounts(site({ totalDevices: 4, offlineDevices: 0 })), 'up');
});

test('a site with nothing to judge by is unknown, not off', () => {
  // Real cases: a newly adopted console, or a site that is all cloud keys
  // and no devices. Calling those `down` raises a ticket for every empty
  // site on the account.
  assert.equal(reachabilityFromCounts(site()), 'unknown');
  assert.equal(reachabilityFromCounts(site({ totalDevices: 0, offlineDevices: 0 })), 'unknown');
  assert.equal(reachabilityFromCounts(site({ totalDevices: 4 })), 'unknown');
});

test('more devices offline than the console admits to is still off', () => {
  // Counts from two different fields on the same payload; they can disagree.
  assert.equal(reachabilityFromCounts(site({ totalDevices: 2, offlineDevices: 3 })), 'down');
});

/* ---- What the WAN feed says ----------------------------------------- */

const wan = (uptimePercent?: number): WanHealth => ({
  siteId: 's1',
  interval: '5m',
  ...(uptimePercent === undefined ? {} : { latest: { uptimePercent } }),
  samples: [],
  downtimeSeconds: 0,
});

test('zero uptime in the last sample is down, and no sample is unknown', () => {
  assert.equal(reachabilityFromWan(wan(0)), 'down');
  assert.equal(reachabilityFromWan(wan(99)), 'up');
  assert.equal(reachabilityFromWan(wan()), 'unknown');
  assert.equal(reachabilityFromWan(null), 'unknown');
});

/* ---- Pacing ---------------------------------------------------------- */

test('the five-minute promise is kept whatever interval drives the sweep', () => {
  // It rides the supervisor's timer, and that interval is configurable. Five
  // minutes is the promise, so it is enforced here rather than assumed.
  resetSweepClock();
  const t0 = Date.parse('2026-09-09T08:00:00.000Z');
  assert.equal(sweepDue(t0), true, 'never run is always due');
  assert.equal(sweepDue(SWEEP_INTERVAL_MS), true, 'and so is the first interval after the epoch');
  assert.equal(sweepDue(SWEEP_INTERVAL_MS - 1), false, 'but not a millisecond before it');
});

test('a sweep run twice in a minute only checks once', async () => {
  resetSweepClock();
  const first = await sweepOutagesIfDue('2026-09-09T08:00:00.000Z');
  const second = await sweepOutagesIfDue('2026-09-09T08:01:00.000Z');
  assert.match(second.skipped ?? '', /less than five minutes/);
  // The first ran — it skipped for a different reason, having no UniFi key.
  assert.notEqual(first.skipped, second.skipped);
});

test('and it is due again once the interval has passed', async () => {
  resetSweepClock();
  await sweepOutagesIfDue('2026-09-09T08:00:00.000Z');
  const later = new Date(Date.parse('2026-09-09T08:00:00.000Z') + SWEEP_INTERVAL_MS).toISOString();
  const next = await sweepOutagesIfDue(later);
  assert.doesNotMatch(next.skipped ?? '', /less than five minutes/);
});

/* ---- Nothing connected ---------------------------------------------- */

test('with UniFi not connected the sweep says so rather than reporting all clear', async () => {
  // "0 sites off" and "we cannot see any sites" are different answers, and
  // only one of them is reassuring.
  resetSweepClock();
  const outcome = await sweepOutages('2026-09-09T08:00:00.000Z');
  assert.match(outcome.skipped ?? '', /not connected/);
  assert.equal(outcome.checked, 0);
  assert.equal(outcome.raised, 0);
});

/* ---- The budget ------------------------------------------------------ */

test('the diagnosis budget is small enough that a national outage cannot self-inflict', () => {
  // Two hundred sites going off at once must not fire two hundred line
  // tests inside a minute. The rest are counted and picked up next pass.
  assert.ok(DIAGNOSE_BUDGET <= 10, `${DIAGNOSE_BUDGET} is too many line tests for one sweep`);
  assert.ok(DIAGNOSE_BUDGET >= 3, 'and too few would take an hour to work through a bad morning');
});

/* ---- The watch key is the site, never its name ----------------------- */

test('two consoles with a site called "Default" do not share one counter', () => {
  // This was live, and the ticket showed it: an event opened saying "5 drops"
  // while the stored state had 6, because the sixth belonged to a different
  // building. "Default" is what an unrenamed console calls its site, so most
  // of them are called that.
  const a = { ...site({ totalDevices: 2, offlineDevices: 0 }), siteId: 'site-a', name: 'Default' };
  const b = { ...site({ totalDevices: 2, offlineDevices: 0 }), siteId: 'site-b', name: 'Default' };

  const keyA = __sweepTesting.clientForSite(a).key;
  const keyB = __sweepTesting.clientForSite(b).key;
  assert.notEqual(keyA, keyB, 'same name, different buildings');
  assert.match(keyA, /site-a/);
});

test('one client with two sites gets two counters', () => {
  // Market Halls Victoria and Market Halls Oxford Street are two buildings
  // and two lines. Pooling them is the same bug wearing a tie.
  const victoria = { ...site(), siteId: 'site-vic', name: 'Market Halls Victoria' };
  const oxford = { ...site(), siteId: 'site-oxf', name: 'Market Halls Oxford Street' };
  assert.notEqual(__sweepTesting.clientForSite(victoria).key, __sweepTesting.clientForSite(oxford).key);
});

test('the watch key survives a site being renamed', () => {
  // Somebody tidying up console names must not reset every counter.
  const before = { ...site(), siteId: 'site-a', name: 'Default' };
  const after = { ...site(), siteId: 'site-a', name: 'Market Halls Victoria' };
  assert.equal(__sweepTesting.clientForSite(before).key, __sweepTesting.clientForSite(after).key);
});
