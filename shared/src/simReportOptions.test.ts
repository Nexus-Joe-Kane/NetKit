import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SIM_SECTIONS,
  availableSimSections,
  formatPence,
  rollupByClient,
  simUsedPercent,
} from './simReportOptions';
import type { SimEstate, SimRecord } from './operations';

const GB = 1024 * 1024 * 1024;

const sim = (over: Partial<SimRecord> = {}): SimRecord => ({
  iccid: `894411${Math.random().toString().slice(2, 14)}`,
  state: 'active',
  provider: 'Jola SIM Portal',
  source: 'jola',
  ...over,
});

const estate = (sims: SimRecord[]): SimEstate => ({
  sims,
  checkedAt: new Date().toISOString(),
  sources: ['jola'],
});

test('a bolt-on counts towards the allowance a percentage is measured against', () => {
  // Without this a SIM sitting comfortably inside what it pays for reads as
  // 140%, and somebody chases an overage that does not exist.
  const withBoltOn = sim({ allowanceBytes: 5 * GB, boltOnBytes: 5 * GB, usedBytes: 7 * GB });
  assert.equal(simUsedPercent(withBoltOn), 70);
  assert.equal(simUsedPercent(sim({ allowanceBytes: 5 * GB, usedBytes: 7 * GB })), 140);
});

test('no usage figure is undefined, never nought', () => {
  assert.equal(simUsedPercent(sim({ allowanceBytes: 5 * GB })), undefined);
  assert.equal(simUsedPercent(sim({ usedBytes: 1 * GB })), undefined);
  assert.equal(simUsedPercent(sim({ allowanceBytes: 0, usedBytes: 1 * GB })), undefined);
});

test('only sections the estate can fill are offered', () => {
  const bare = availableSimSections(estate([sim()]));
  assert.ok(bare.has('summary') && bare.has('sims'), 'those two always have something to say');
  assert.equal(bare.has('cost'), false, 'no tariff and no cost on any SIM');
  assert.equal(bare.has('usage'), false);
  assert.equal(bare.has('clients'), false);
  assert.ok(bare.has('unassigned'), 'a SIM with no client is itself the finding');
});

test('cost is offered on a tariff name alone', () => {
  // The tariff is worth a page even where the provider withholds the price.
  const withTariff = availableSimSections(estate([sim({ tariff: 'Data 20GB' })]));
  assert.ok(withTariff.has('cost'));
});

test('the attention sections appear only when something needs attention', () => {
  const clean = availableSimSections(estate([sim({ clientName: 'Willow', allowanceBytes: 10 * GB, usedBytes: 1 * GB })]));
  assert.equal(clean.has('overage'), false);
  assert.equal(clean.has('barred'), false);
  assert.equal(clean.has('offline'), false);
  assert.equal(clean.has('suspended'), false);

  const messy = availableSimSections(
    estate([
      sim({ clientName: 'A', allowanceBytes: 10 * GB, usedBytes: 10 * GB }),
      sim({ clientName: 'B', bars: ['data bar'] }),
      sim({ clientName: 'C', attached: false }),
      sim({ clientName: 'D', state: 'suspended' }),
    ]),
  );
  assert.ok(messy.has('overage') && messy.has('barred') && messy.has('offline') && messy.has('suspended'));
});

test('a ceased SIM with a bar is not counted as barred', () => {
  // It is not passing traffic because it is gone, not because of the bar.
  const ceased = availableSimSections(estate([sim({ state: 'ceased', bars: ['data bar'] })]));
  assert.equal(ceased.has('barred'), false);
});

test('clients roll up heaviest use first, and never invent a zero', () => {
  const rows = rollupByClient([
    sim({ clientName: 'Light', usedBytes: 1 * GB, allowanceBytes: 5 * GB }),
    sim({ clientName: 'Heavy', usedBytes: 40 * GB, allowanceBytes: 50 * GB, site: 'Head office' }),
    sim({ clientName: 'Heavy', usedBytes: 10 * GB, allowanceBytes: 20 * GB, site: 'Warehouse' }),
    sim({ clientName: 'Unmeasured' }),
  ]);

  assert.deepEqual(rows.map((r) => r.clientName), ['Heavy', 'Light', 'Unmeasured']);
  assert.equal(rows[0]?.simCount, 2);
  assert.equal(rows[0]?.usedBytes, 50 * GB);
  assert.deepEqual(rows[0]?.sites, ['Head office', 'Warehouse']);
  assert.equal(
    rows[2]?.usedBytes,
    undefined,
    'a zero next to a client reads as "used nothing", which is a different claim from "not reported"',
  );
});

test('SIMs with no client group under one heading rather than vanishing', () => {
  const rows = rollupByClient([sim(), sim({ clientName: 'Willow' })]);
  assert.ok(rows.some((r) => r.clientName === 'Not assigned'));
});

test('the default report is the estate and the money, not the tellings-off', () => {
  assert.deepEqual([...DEFAULT_SIM_SECTIONS], ['summary', 'clients', 'sims', 'usage', 'cost']);
});

test('pence become pounds without losing a penny', () => {
  assert.equal(formatPence(1250), '£12.50');
  assert.equal(formatPence(999999), '£9,999.99');
  assert.equal(formatPence(0), '£0.00');
  assert.equal(formatPence(undefined), undefined);
});
