import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_UNIT_OPTIONS,
  distinguishedBy,
  resolveUnitAnswer,
  shareStreetAddress,
  unitLabel,
  unitQuestion,
  type AddressRecord,
} from './index';

const at = (over: Partial<AddressRecord>): AddressRecord => ({
  singleLine: '14 Oxford Street, London, W1D 1AN',
  lines: ['14 Oxford Street'],
  postTown: 'London',
  postcode: 'W1D 1AN',
  buildingNumber: '14',
  thoroughfare: 'Oxford Street',
  source: 'os-places',
  ...over,
});

/* ---- When to ask ---------------------------------------------------- */

test('a building of units is asked about', () => {
  // The failure this prevents: somebody types "Market Halls, Oxford Street",
  // gets the door number, and every lookup after it is about the wrong
  // premises — with nothing to say so, because a plausible answer came back.
  const q = unitQuestion({
    addresses: [
      at({ subBuilding: 'Unit 1', buildingName: 'Market Halls' }),
      at({ subBuilding: 'Unit 4', buildingName: 'Market Halls' }),
      at({ subBuilding: 'Unit 12', buildingName: 'Market Halls' }),
    ],
  });
  assert.equal(q.ask, true);
  assert.equal(q.distinction, 'sub-building');
  assert.match(q.question ?? '', /Which unit at Market Halls/);
  assert.match(q.because ?? '', /wrong place/);
  assert.deepEqual(q.options?.map((o) => o.label), ['Unit 1', 'Unit 4', 'Unit 12'], 'sorted numerically');
});

test('a single result is never asked about', () => {
  assert.equal(unitQuestion({ addresses: [at({ subBuilding: 'Unit 4' })] }).ask, false);
  assert.equal(unitQuestion({ addresses: [] }).ask, false);
});

test('different streets is an ambiguous search, not a building with units', () => {
  // The address picker handles that better than a unit prompt would.
  const q = unitQuestion({
    addresses: [at({ thoroughfare: 'Oxford Street' }), at({ thoroughfare: 'Oxford Road' })],
  });
  assert.equal(q.ask, false);
  assert.equal(q.distinction, 'street');
});

test('different door numbers is the same — they typed the number or they did not', () => {
  // Asking "which door number?" when the person typed a door number reads as
  // though the search did not work.
  const q = unitQuestion({ addresses: [at({ buildingNumber: '14' }), at({ buildingNumber: '16' })] });
  assert.equal(q.ask, false);
  assert.equal(q.distinction, 'number');
});

test('an answer already in the query is not asked again', () => {
  // Being asked something you just typed is the search failing to listen.
  const addresses = [
    at({ subBuilding: 'Unit 1', buildingName: 'Market Halls' }),
    at({ subBuilding: 'Unit 4', buildingName: 'Market Halls' }),
  ];
  assert.equal(unitQuestion({ addresses, query: 'market halls unit 4 oxford street' }).ask, false);
  assert.equal(unitQuestion({ addresses, query: 'market halls oxford street' }).ask, true);
});

test('too many candidates is a list, not a question', () => {
  // Forty radio buttons is not a question.
  const many = Array.from({ length: MAX_UNIT_OPTIONS + 1 }, (_, i) =>
    at({ subBuilding: `Unit ${i + 1}`, buildingName: 'Market Halls' }),
  );
  assert.equal(unitQuestion({ addresses: many }).ask, false);
  assert.equal(unitQuestion({ addresses: many.slice(0, MAX_UNIT_OPTIONS) }).ask, true);
});

/* ---- How it is phrased ---------------------------------------------- */

test('businesses at one address are asked about as businesses, not units', () => {
  // "Which unit?" is right for a market hall and wrong for two firms sharing
  // a serviced office.
  const q = unitQuestion({
    addresses: [
      at({ organisation: 'Willow Cafe', buildingName: 'Sandringham House' }),
      at({ organisation: 'Doyle Accountants', buildingName: 'Sandringham House' }),
    ],
  });
  assert.equal(q.distinction, 'organisation');
  assert.match(q.question ?? '', /Which business at Sandringham House/);
});

test('the label carries both parts when both differ', () => {
  assert.equal(unitLabel(at({ subBuilding: 'Unit 4', organisation: 'Willow Cafe' })), 'Unit 4 — Willow Cafe');
  assert.equal(unitLabel(at({ subBuilding: 'Unit 4' })), 'Unit 4');
  assert.equal(unitLabel(at({ organisation: 'Willow Cafe' })), 'Willow Cafe');
  assert.equal(unitLabel(at({})), undefined);
});

/* ---- Sharing a street address --------------------------------------- */

test('candidates must actually share the street address before units are offered', () => {
  assert.equal(
    shareStreetAddress([at({ subBuilding: 'Unit 1' }), at({ subBuilding: 'Unit 4' })]),
    true,
  );
  assert.equal(
    shareStreetAddress([at({ subBuilding: 'Unit 1', postcode: 'W1D 1AN' }), at({ subBuilding: 'Unit 4', postcode: 'SE23 1AB' })]),
    false,
  );
  assert.equal(shareStreetAddress([at({})]), false, 'one address shares nothing');
});

test('a postcode written with different spacing still counts as the same', () => {
  assert.equal(
    shareStreetAddress([
      at({ subBuilding: 'Unit 1', postcode: 'W1D 1AN' }),
      at({ subBuilding: 'Unit 4', postcode: 'W1D1AN' }),
    ]),
    true,
  );
});

test('identical candidates are distinguished by nothing, so nothing is asked', () => {
  assert.equal(distinguishedBy([at({}), at({})]), 'none');
  assert.equal(unitQuestion({ addresses: [at({}), at({})] }).ask, false);
});

/* ---- Reading the answer back ---------------------------------------- */

test('an answer is matched on its label, not on a position in the list', () => {
  // The failure this avoids: an answer arriving after the candidates were
  // re-fetched in a different order, selecting the wrong premises.
  const q = unitQuestion({
    addresses: [
      at({ subBuilding: 'Unit 1', buildingName: 'Market Halls', uprn: '1' }),
      at({ subBuilding: 'Unit 4', buildingName: 'Market Halls', uprn: '4' }),
    ],
  });
  assert.equal(resolveUnitAnswer(q, 'Unit 4')?.uprn, '4');
  assert.equal(resolveUnitAnswer(q, 'unit 4')?.uprn, '4', 'case does not matter');
  assert.equal(resolveUnitAnswer(q, '4')?.uprn, '4', 'a partial that is unique is enough');
  assert.equal(resolveUnitAnswer(q, 'Unit 9'), undefined);
  assert.equal(resolveUnitAnswer(q, ''), undefined);
});

test('an ambiguous partial answer selects nothing rather than guessing', () => {
  const q = unitQuestion({
    addresses: [
      at({ subBuilding: 'Unit 1', buildingName: 'Market Halls', uprn: '1' }),
      at({ subBuilding: 'Unit 12', buildingName: 'Market Halls', uprn: '12' }),
    ],
  });
  // "Unit 1" is inside "Unit 12", so this is genuinely ambiguous — except
  // that it is also an exact match for the first, which wins.
  assert.equal(resolveUnitAnswer(q, 'Unit 1')?.uprn, '1');
  assert.equal(resolveUnitAnswer(q, 'Uni'), undefined, 'matches both, so neither');
});
