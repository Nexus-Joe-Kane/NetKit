import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { finaliseAddress, type AddressRecord } from './index';
import {
  rankAddresses,
  rankAddressMatches,
  tokeniseQuery,
  tokenMatches,
  addressWords,
  samePremises,
  premisesFacts,
} from './addressMatch';

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

/* ---- samePremises --------------------------------------------------- */

test('the Willow case: Zen formatting matches OS Places for one premises', () => {
  // OS Places carry the organisation name; Zen do not. Capitalisation and
  // punctuation differ. Exact string equality failed and the line vanished.
  const os = addr({
    organisation: 'Willow Estate Agents Ltd',
    buildingNumber: '45',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    uprn: '100023253338',
  });
  const fromZen = addr({ buildingNumber: '45', thoroughfare: 'BROCKLEY RISE', postTown: 'LONDON', postcode: 'se231jg' });
  assert.equal(samePremises(fromZen, os), true);
});

test('street type abbreviations do not break a premises match', () => {
  const a = addr({ buildingNumber: '12', thoroughfare: 'Bath Road', postTown: 'READING', postcode: 'RG1 1AA' });
  const b = addr({ buildingNumber: '12', thoroughfare: 'Bath Rd', postTown: 'READING', postcode: 'RG1 1AA' });
  assert.equal(samePremises(a, b), true);
});

test('a different postcode is never the same premises', () => {
  const a = addr({ buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  const b = addr({ buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JH' });
  assert.equal(samePremises(a, b), false);
});

test('a neighbour at the same postcode is not matched', () => {
  const a = addr({ buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  const b = addr({ buildingNumber: '47', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  assert.equal(samePremises(a, b), false);
});

test('two flats in one building are not the same premises', () => {
  const a = addr({ subBuilding: 'Flat 1', buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  const b = addr({ subBuilding: 'Flat 2', buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  assert.equal(samePremises(a, b), false);
});

test('a flat number the other side omits is not held against the match', () => {
  // Zen routinely omit a flat number that AddressBase carries.
  const withFlat = addr({ subBuilding: 'Flat 1', buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  const without = addr({ buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  assert.equal(samePremises(without, withFlat), true);
});

test('the same number on two streets sharing a postcode is separated', () => {
  const a = addr({ buildingNumber: '1', thoroughfare: 'Mill Lane', postTown: 'BATH', postcode: 'BA1 1AA' });
  const b = addr({ buildingNumber: '1', thoroughfare: 'Station Road', postTown: 'BATH', postcode: 'BA1 1AA' });
  assert.equal(samePremises(a, b), false);
});

test('a named building with no number matches on its name', () => {
  const a = addr({ buildingName: 'Kestrel House', thoroughfare: 'Mill Lane', postTown: 'BATH', postcode: 'BA1 1AA' });
  const b = addr({ buildingName: 'KESTREL HOUSE', thoroughfare: 'Mill Lane', postTown: 'BATH', postcode: 'BA1 1AA' });
  assert.equal(samePremises(a, b), true);
});

test('UPRNs decide outright when both sides have one', () => {
  const a = addr({ uprn: '111', postTown: 'X', postcode: 'AA1 1AA' });
  const b = addr({ uprn: '222', postTown: 'X', postcode: 'AA1 1AA' });
  assert.equal(samePremises(a, b), false);
  const c = addr({ uprn: '111', postTown: 'Y', postcode: 'BB2 2BB' });
  assert.equal(samePremises(a, c), true, 'the same UPRN is the same premises whatever else says');
});

test('a bare street and postcode is not enough to claim a premises', () => {
  // Claiming it would put a neighbour's circuit on the report.
  const a = addr({ thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  const b = addr({ thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  assert.equal(samePremises(a, b), false);
});

test('a missing postcode on either side is not a match', () => {
  const a = addr({ buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: '' });
  const b = addr({ buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  assert.equal(samePremises(a, b), false);
});

/* ---- samePremises: what a supplier actually hands back ---------------- */

test('a supplier that returns one formatted string still matches the premises', () => {
  // Some suppliers give an address as a single line and nothing else: no
  // building number, no thoroughfare, no organisation. The comparison used to
  // have nothing on that side to work with and gave up, which read on the
  // report as "no lines found" at a premises we demonstrably supply.
  const os = addr({
    organisation: 'Willow Estate Agents Ltd',
    buildingNumber: '45',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    uprn: '100023253338',
  });
  const fromSupplier = finaliseAddress({
    singleLine: '45 BROCKLEY RISE, LONDON, SE23 1JG',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    source: 'test',
  } as never);
  assert.equal(samePremises(fromSupplier, os), true);
});

test('a formatted line with the trading name in front of the number still matches', () => {
  const os = addr({
    organisation: 'Willow Estate Agents Ltd',
    buildingNumber: '45',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
  });
  const fromSupplier = finaliseAddress({
    singleLine: 'Willow Estate Agents, 45 Brockley Rise, LONDON, SE23 1JG',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    source: 'test',
  } as never);
  assert.equal(samePremises(fromSupplier, os), true);
});

test('the parsed number still rules out the neighbour', () => {
  const os = addr({ buildingNumber: '45', thoroughfare: 'Brockley Rise', postTown: 'LONDON', postcode: 'SE23 1JG' });
  const neighbour = finaliseAddress({
    singleLine: '43 BROCKLEY RISE, LONDON, SE23 1JG',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    source: 'test',
  } as never);
  assert.equal(samePremises(neighbour, os), false);
});

test('the postcode is not mistaken for a house number', () => {
  // "SE23" leads with digits once the letters are split off. Reading it as a
  // number would match every premises in the postcode against each other.
  const facts = premisesFacts(
    finaliseAddress({
      singleLine: 'Some Building, Brockley Rise, LONDON, SE23 1JG',
      postTown: 'LONDON',
      postcode: 'SE23 1JG',
      source: 'test',
    } as never),
  );
  assert.equal(facts.number, '');
  assert.ok(!facts.nameWords.includes('se23'));
  assert.ok(!facts.nameWords.includes('london'));
});

test('two UPRNs that disagree fall through to the address rather than deciding it', () => {
  // A supplier carries whatever UPRN it was handed at order time, which is
  // routinely the parent shell record for a building. Treating a mismatch as
  // proof of two different premises threw away a live circuit at the right
  // doorstep.
  const os = addr({
    buildingNumber: '45',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    uprn: '100023253338',
  });
  const parentShell = addr({
    buildingNumber: '45',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    uprn: '10009876543',
  });
  assert.equal(samePremises(parentShell, os), true);

  // But a different doorstep is still a different doorstep.
  const nextDoor = addr({
    buildingNumber: '43',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    uprn: '10009876544',
  });
  assert.equal(samePremises(nextDoor, os), false);
});

test('a flat number that disagrees still wins over a parsed line', () => {
  const flat1 = addr({
    subBuilding: 'Flat 1',
    buildingNumber: '12',
    thoroughfare: 'Hill Street',
    postTown: 'RICHMOND',
    postcode: 'TW9 1TN',
  });
  const flat2 = finaliseAddress({
    singleLine: 'FLAT 2, 12 HILL STREET, RICHMOND, TW9 1TN',
    subBuilding: 'Flat 2',
    postTown: 'RICHMOND',
    postcode: 'TW9 1TN',
    source: 'test',
  } as never);
  assert.equal(samePremises(flat2, flat1), false);
});
