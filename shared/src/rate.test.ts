import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mbpsFromRate } from './rate';

test('the rates seen live are corrected', () => {
  // "80 Gb down / 18.2 Gb up" on Apartment 1, 113 Newton Street.
  assert.equal(mbpsFromRate(80000), 80);
  assert.equal(mbpsFromRate(18200), 18.2);
});

test('Openreach kbit/s figures across the product range', () => {
  assert.equal(mbpsFromRate(20000), 20);
  assert.equal(mbpsFromRate(40000), 40);
  assert.equal(mbpsFromRate(330000), 330);
  assert.equal(mbpsFromRate(1000000), 1000);
});

test('genuine Mbit/s figures are left alone', () => {
  for (const v of [0.5, 8, 24, 40, 76, 80, 330, 500, 900, 1000, 1800, 2000]) {
    assert.equal(mbpsFromRate(v), v, `${v} Mb should be untouched`);
  }
});

test('a 10 Gb Ethernet tail is not mistaken for kbit/s', () => {
  // The boundary case, and the reason the threshold sits here.
  assert.equal(mbpsFromRate(10000), 10000);
});

test('just above the boundary is treated as kbit/s', () => {
  assert.equal(mbpsFromRate(10001), 10);
});

test('absent, zero and nonsense become undefined', () => {
  assert.equal(mbpsFromRate(undefined), undefined);
  assert.equal(mbpsFromRate(null), undefined);
  assert.equal(mbpsFromRate(0), undefined);
  assert.equal(mbpsFromRate(-5), undefined);
  assert.equal(mbpsFromRate(Number.NaN), undefined);
  assert.equal(mbpsFromRate(Number.POSITIVE_INFINITY), undefined);
});

test('no floating point noise in the result', () => {
  assert.equal(String(mbpsFromRate(18200)), '18.2');
  assert.equal(String(mbpsFromRate(76300)), '76.3');
});
