import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { finaliseAddress, type AddressRecord } from './index';
import { rankAddresses, rankAddressMatches, tokeniseQuery, tokenMatches, addressWords } from './addressMatch';

const addr = (over: Partial<AddressRecord> & { postTown: string; postcode: string }): AddressRecord =>
  finaliseAddress({ ...over, source: 'test' } as never);

/* The exact results the live site returned for `megans richmond`. */
const MEGANS: AddressRecord[] = [
  addr({ buildingName: 'Megans Cottage', thoroughfare: 'Newgate', postTown: 'MORPETH', postcode: 'NE65 0AA' }),
  addr({ organisation: 'Megans', dependentLocality: 'Old Town', postTown: 'SWINDON', postcode: 'SN1 3AA' }),
  addr({ organisation: 'Megans Restaurant', postTown: 'LONDON', dependentLocality: 'Wimbledon', postcode: 'SW19 1AA' }),
  addr({ organisation: 'Megans', thoroughfare: 'Howardsgate', postTown: 'WELWYN GARDEN CITY', postcode: 'AL8 6AA' }),
  addr({ buildingName: 'Megans Cottage', postTown: 'LISKEARD', dependentLocality: 'Pensilva', postcode: 'PL14 5AA' }),
  addr({ organisation: 'Megans on West Street', thoroughfare: 'West Street', postTown: 'FARNHAM', postcode: 'GU9 7AA' }),
  addr({ organisation: 'Megans Skin & Beauty', postTown: 'LURGAN', postcode: 'BT66 6AA' }),
];

const MEGANS_IN_RICHMOND = addr({
  organisation: 'Megans Kitchen',
  thoroughfare: 'Hill Street',
  postTown: 'RICHMOND',
  postcode: 'TW9 1TN',
});

test('a second word constrains the search instead of being ignored', () => {
  const results = rankAddresses([...MEGANS, MEGANS_IN_RICHMOND], 'megans richmond', 10);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.postTown, 'RICHMOND');
});

test('no full match degrades to closest rather than returning nothing', () => {
  // This is the honest fallback: the person still sees something, but the
  // list is not padded when a full match exists.
  const results = rankAddresses(MEGANS, 'megans richmond', 10);
  assert.ok(results.length > 0, 'should not dead-end the user');
  assert.ok(results.every((r) => r.postTown !== 'RICHMOND'));
});

test('the live `13 Hill St, Richmond` failures are excluded', () => {
  const wrong = [
    addr({ buildingNumber: '13', thoroughfare: 'Hill Rise', postTown: 'RICHMOND', postcode: 'TW10 6UQ' }),
    addr({ buildingNumber: '13', thoroughfare: 'St. Hill Close', postTown: 'WOKING', postcode: 'GU22 0AA' }),
    addr({ buildingNumber: '13', thoroughfare: 'St. Johns Hill', postTown: 'LONDON', postcode: 'SW11 1AA' }),
    addr({ buildingNumber: '13', thoroughfare: 'St. Clements Hill', postTown: 'NORWICH', postcode: 'NR3 4AA' }),
  ];
  const right = addr({ buildingNumber: '13', thoroughfare: 'Hill Street', postTown: 'RICHMOND', postcode: 'TW9 1TN' });

  const results = rankAddresses([...wrong, right], '13 Hill St, Richmond', 10);
  assert.equal(results[0]?.thoroughfare, 'Hill Street');
  assert.equal(results[0]?.postTown, 'RICHMOND');
  // 13 Hill Rise is in Richmond but is not Hill Street: it may rank, never lead.
  assert.notEqual(results[0]?.thoroughfare, 'Hill Rise');
});

test('commas and filler words do not become unsatisfiable tokens', () => {
  assert.deepEqual(tokeniseQuery('13 Hill St, Richmond'), ['13', 'hill', 'st', 'richmond']);
  assert.deepEqual(tokeniseQuery('The Bell at Ramsbury'), ['bell', 'ramsbury']);
  assert.deepEqual(tokeniseQuery('  '), []);
});

test('street-type abbreviations match both ways', () => {
  const words = addressWords(addr({ buildingNumber: '13', thoroughfare: 'Hill Street', postTown: 'RICHMOND', postcode: 'TW9 1TN' }));
  assert.ok(tokenMatches('st', words), '`st` should match Street');
  assert.ok(tokenMatches('street', words));

  const abbreviated = addressWords(addr({ thoroughfare: 'Bath Rd', postTown: 'READING', postcode: 'RG1 1AA' }));
  assert.ok(tokenMatches('road', abbreviated), '`road` should match an address written Rd');
});

test('a house number is not satisfied by a longer number', () => {
  const words = addressWords(addr({ buildingNumber: '130', thoroughfare: 'High Street', postTown: 'LEEDS', postcode: 'LS1 1AA' }));
  assert.equal(tokenMatches('13', words), false, '13 must not match 130');

  const suffixed = addressWords(addr({ buildingNumber: '13A', thoroughfare: 'High Street', postTown: 'LEEDS', postcode: 'LS1 1AA' }));
  assert.ok(tokenMatches('13', suffixed), '13 should match 13A -- same doorstep');
});

test('two-letter tokens must match a whole word', () => {
  const words = addressWords(addr({ thoroughfare: 'Richmond Road', postTown: 'LONDON', postcode: 'E8 3AA' }));
  assert.equal(tokenMatches('ri', words), false, 'a 2-char prefix is too loose to mean anything');
});

test('postcode fragments are matchable', () => {
  const words = addressWords(addr({ thoroughfare: 'Newton Street', postTown: 'MANCHESTER', postcode: 'M1 1AE' }));
  assert.ok(tokenMatches('m1', words));
  assert.ok(tokenMatches('1ae', words));
});

test('provider order is kept within a tier', () => {
  const a = addr({ buildingNumber: '1', thoroughfare: 'High Street', postTown: 'BATH', postcode: 'BA1 1AA' });
  const b = addr({ buildingNumber: '2', thoroughfare: 'High Street', postTown: 'BATH', postcode: 'BA1 1AB' });
  const ranked = rankAddressMatches([a, b], 'high street bath');
  assert.ok(ranked.every((m) => m.complete));
  assert.equal(ranked[0]?.address.buildingNumber, '1', 'equal scores keep provider order');
});

test('an empty query passes results through untouched', () => {
  const results = rankAddresses(MEGANS, '', 3);
  assert.equal(results.length, 3);
  assert.equal(results[0]?.buildingName, 'Megans Cottage');
});

test('limit is respected', () => {
  assert.equal(rankAddresses(MEGANS, 'megans', 2).length, 2);
});
