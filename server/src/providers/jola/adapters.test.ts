import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __jolaTesting } from './adapters';

const dir = mkdtempSync(join(tmpdir(), 'netkit-jola-'));
process.env.DATA_DIR = dir;

const { mapJolaSim } = __jolaTesting;

/* ---- Client, site and labels ---------------------------------------- */

test('a SIM carries the client it was fetched under', () => {
  // The estate is assembled by walking customers, so the client is always
  // known — it was simply being thrown away, leaving every SIM unassigned.
  const sim = mapJolaSim(
    { ICCID: '8944110068683238245', MobileNumber: '07511178958', State: 'Active', Operator: 'O2' },
    { id: 'cust-9', name: 'Willow Estate Agents Ltd' },
  );
  assert.equal(sim?.clientId, 'cust-9');
  assert.equal(sim?.clientName, 'Willow Estate Agents Ltd');
});

test('a free-text label becomes the site, not a bar', () => {
  // "Van 3" in the bars column was the old behaviour: every tag became a
  // bar whenever a SIM had no real ones.
  const sim = mapJolaSim({ ICCID: '1', SimTag: ['Brockley Rise shop'] });
  assert.equal(sim?.site, 'Brockley Rise shop');
  assert.equal(sim?.bars, undefined);
  assert.deepEqual(sim?.tags, ['Brockley Rise shop']);
});

test('a label that names a restriction does become a bar', () => {
  const sim = mapJolaSim({ ICCID: '1', SimTag: ['Data barred', 'Head office'] });
  assert.deepEqual(sim?.bars, ['Data barred']);
  assert.deepEqual(sim?.tags, ['Head office']);
  assert.equal(sim?.site, 'Head office');
});

test('an explicit site field beats a label', () => {
  const sim = mapJolaSim({ ICCID: '1', Site: 'Warehouse', SimTag: ['spare'] });
  assert.equal(sim?.site, 'Warehouse');
});

test('a postcode in the labels is read as the postcode', () => {
  const sim = mapJolaSim({ ICCID: '1', SimTag: ['SE23 1JG', 'Brockley Rise'] });
  assert.equal(sim?.postcode, 'SE23 1JG');
  assert.equal(sim?.site, 'Brockley Rise', 'the postcode is not also the site name');
});

test('a single-string tag field is read as well as an array', () => {
  const sim = mapJolaSim({ ICCID: '1', SimTag: 'Van 3' });
  assert.deepEqual(sim?.tags, ['Van 3']);
  assert.equal(sim?.site, 'Van 3');
});

test('a cost in pounds becomes pence without losing a penny', () => {
  assert.equal(mapJolaSim({ ICCID: '1', MonthlyCost: 12.5 })?.monthlyCostPence, 1250);
  assert.equal(mapJolaSim({ ICCID: '1', monthlyCostPence: 1499 })?.monthlyCostPence, 1499);
  assert.equal(mapJolaSim({ ICCID: '1' })?.monthlyCostPence, undefined, 'no cost stays absent, never zero');
});

test('a tariff name is kept even with no price against it', () => {
  assert.equal(mapJolaSim({ ICCID: '1', TariffName: 'Data 20GB' })?.tariff, 'Data 20GB');
});
