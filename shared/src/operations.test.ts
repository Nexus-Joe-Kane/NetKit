import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { looksSpare } from './index';

/* ---- Spare SIMs ------------------------------------------------------ */

test('a tagged SIM with no number and no usage is stock, not unknown', () => {
  // An estate of 236 SIMs with 124 in a drawer was rendering 124 rows reading
  // "unknown", which looks like a broken integration rather than a bag.
  assert.equal(looksSpare({ state: 'unknown', tags: ['SIM Bag'] }), true);
  assert.equal(looksSpare({ state: 'unknown', tags: ['Sent iPhone SIMs'] }), true);
  assert.equal(looksSpare({ state: 'unknown', tags: ['Spare stock'] }), true);
});

test('a SIM with a number is somebody’s, whatever it is tagged', () => {
  assert.equal(looksSpare({ state: 'unknown', msisdn: '07700900123', tags: ['SIM Bag'] }), false);
});

test('a SIM with usage against it is in use, whatever it is tagged', () => {
  assert.equal(looksSpare({ state: 'unknown', usedBytes: 1024, tags: ['SIM Bag'] }), false);
  assert.equal(looksSpare({ state: 'unknown', usedBytes: 0, tags: ['SIM Bag'] }), true);
});

test('a state the provider actually gave is never overwritten', () => {
  // Reclassifying only fills a gap. A provider saying "active" is the
  // authority even on a SIM somebody has tagged as spare.
  for (const state of ['active', 'suspended', 'ceased', 'pending', 'test', 'spare'] as const) {
    assert.equal(looksSpare({ state, tags: ['SIM Bag'] }), false);
  }
});

test('an untagged SIM with no state stays unknown rather than being guessed as stock', () => {
  // "No state reported" and "in a drawer" are different answers, and only one
  // of them is safe to assume.
  assert.equal(looksSpare({ state: 'unknown' }), false);
  assert.equal(looksSpare({ state: 'unknown', tags: ['Head office'] }), false);
});
