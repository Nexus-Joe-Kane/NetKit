import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStatus } from './downdetector';

const AT = '2026-09-09T08:00:00.000Z';
const of = (payload: unknown) => toStatus({ provider: 'BT', payload, checkedAt: AT });

/* ---- Their judgement beats our arithmetic --------------------------- */

test('a stated status is preferred over counting reports', () => {
  // It is their data and their call. Our thresholds are a fallback for
  // payloads that only give numbers.
  assert.equal(of({ indicator: 'major', reports: 3, baseline: 100 }).state, 'outage');
  assert.equal(of({ indicator: 'minor' }).state, 'degraded');
  assert.equal(of({ indicator: 'none', reports: 9000, baseline: 10 }).state, 'ok');
});

test('an unrecognised stated status falls back to the numbers', () => {
  assert.equal(of({ indicator: 'wibble', reports: 900, baseline: 100 }).state, 'outage');
  assert.equal(of({ indicator: 'wibble' }).state, 'unknown');
});

/* ---- Reports are read against that provider's own normal ------------ */

test('a count is only meaningful next to a baseline', () => {
  // BT's quiet afternoon is more reports than G.Network's worst day, so an
  // absolute number cannot be graded and saying "unknown" is the honest
  // answer rather than picking a threshold per provider.
  assert.equal(of({ reports: 4000 }).state, 'unknown');
  assert.equal(of({ reports: 4000, baseline: 40 }).state, 'outage');
  assert.equal(of({ reports: 120, baseline: 40 }).state, 'degraded');
  assert.equal(of({ reports: 45, baseline: 40 }).state, 'ok');
});

test('a handful of reports is never an outage, whatever the baseline', () => {
  // Three reports against a baseline of one is a multiple of three and
  // means nothing at all.
  assert.equal(of({ reports: 3, baseline: 1 }).state, 'ok');
});

/* ---- Tolerance ------------------------------------------------------ */

test('a nested payload is read as well as a flat one', () => {
  assert.equal(of({ data: { reports: 4000, baseline: 40 } }).state, 'outage');
  assert.equal(of({ status: { indicator: 'major' } }).state, 'outage');
});

test('the alternate field names are all read', () => {
  assert.equal(of({ num_reports: 4000, baseline_24h: 40 }).state, 'outage');
  assert.equal(of({ count: 4000, expected: 40 }).state, 'outage');
  assert.equal(of({ severity: 'critical' }).state, 'outage');
});

test('nothing at all is unknown rather than a throw or a false all-clear', () => {
  // "We could not find out" and "nothing is wrong" are different answers.
  assert.equal(of(null).state, 'unknown');
  assert.equal(of({}).state, 'unknown');
  assert.equal(of('nonsense').state, 'unknown');
});

test('the baseline is stated so a number on screen can be judged', () => {
  const row = of({ reports: 4000, baseline: 41.6 });
  assert.equal(row.reports, 4000);
  assert.match(row.detail ?? '', /against a normal 42/);
});

test('every row carries when it was checked and where it came from', () => {
  const row = of({ indicator: 'none' });
  assert.equal(row.checkedAt, AT);
  assert.equal(row.source, 'downdetector');
  assert.equal(row.provider, 'BT');
});
