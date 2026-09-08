import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __ofcomBroadbandTesting } from './ofcomBroadband';

const { summarise } = __ofcomBroadbandTesting;

/**
 * Unlike the other integrations here, Ofcom publish an OpenAPI document, so
 * these field names are theirs verbatim rather than a tolerant guess. What
 * needs pinning is the summarising: which premises is used, and whether the
 * answer honestly says so.
 */

const payload = {
  PostCode: 'M11AE',
  Count: 3,
  Availability: [
    { UPRN: 100, MaxPredictedDown: 80, MaxPredictedUp: 20, MaxSfbbPredictedDown: 80 },
    { UPRN: 200, MaxPredictedDown: 1000, MaxPredictedUp: 1000, MaxUfbbPredictedDown: 1000, MaxSfbbPredictedDown: 80 },
    { UPRN: 300, MaxPredictedDown: 24, MaxPredictedUp: 1 },
  ],
};

test('an exact UPRN match is used and declared as such', () => {
  const result = summarise(payload, '100');
  assert.equal(result?.premisesMatched, true);
  assert.equal(result?.maxDownMbps, 80, 'must be this premises, not the best in the postcode');
  assert.equal(result?.maxUpMbps, 20);
  assert.equal(result?.premisesInPostcode, 3);
});

test('no UPRN match falls back to the postcode and says so', () => {
  const result = summarise(payload, '999');
  assert.equal(result?.premisesMatched, false, 'the UI must be able to label this a postcode figure');
  // The maximum, not the mean: this figure is only ever read as "what is
  // possible here", and an average would understate a premises that can get
  // fibre when its neighbours cannot.
  assert.equal(result?.maxDownMbps, 1000);
});

test('an address with no UPRN at all still gets the postcode answer', () => {
  const result = summarise(payload, undefined);
  assert.equal(result?.premisesMatched, false);
  assert.equal(result?.maxDownMbps, 1000);
});

test('the speed tiers are carried through separately', () => {
  const result = summarise(payload, '200');
  assert.equal(result?.superfastDownMbps, 80);
  assert.equal(result?.ultrafastDownMbps, 1000);
});

test('it falls back down the tiers when the overall figure is missing', () => {
  // Ofcom mark every speed field optional, so a premises can have a
  // superfast figure and no overall one.
  const partial = { Count: 1, Availability: [{ UPRN: 1, MaxSfbbPredictedDown: 66, MaxSfbbPredictedUp: 18 }] };
  const result = summarise(partial, '1');
  assert.equal(result?.maxDownMbps, 66);
  assert.equal(result?.maxUpMbps, 18);
});

test('zero is treated as absent, not as a real speed', () => {
  // A premises Ofcom predict nothing for reports 0, and "0 Mb predicted"
  // on screen reads as a measurement rather than a gap.
  const zeroes = { Count: 1, Availability: [{ UPRN: 1, MaxPredictedDown: 0, MaxPredictedUp: 0 }] };
  const result = summarise(zeroes, '1');
  assert.equal(result?.maxDownMbps, undefined);
  assert.equal(result?.maxUpMbps, undefined);
});

test('an empty or missing payload yields nothing rather than a false zero', () => {
  assert.equal(summarise(null, '100'), null);
  assert.equal(summarise({ Count: 0, Availability: [] }, '100'), null);
  assert.equal(summarise({}, '100'), null);
  // Rows present but every speed absent is still nothing to report.
  assert.equal(summarise({ Availability: [{ UPRN: 1 }] }, '2'), null);
});

test('a numeric UPRN from Ofcom matches our string UPRN', () => {
  // Ofcom type UPRN as an integer; ours is a string throughout. A mismatch
  // here would silently downgrade every lookup to a postcode average.
  const result = summarise({ Count: 1, Availability: [{ UPRN: 148575287842, MaxPredictedDown: 900 }] }, '148575287842');
  assert.equal(result?.premisesMatched, true);
  assert.equal(result?.maxDownMbps, 900);
});
