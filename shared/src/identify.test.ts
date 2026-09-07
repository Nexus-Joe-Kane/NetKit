import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identify, formatPostcode, isFullPostcode, isUprn, normaliseCli, outcodeOf, cliType } from './identify';
import { addressLines, singleLineAddress, sortAddresses, scoreAddress, finaliseAddress } from './address';

test('postcodes are recognised and formatted', () => {
  for (const pc of ['SW1A 1AA', 'sw1a1aa', 'M1 1AE', 'ec1a1bb', 'B33 8TH', 'CR2 6XH', 'DN55 1PT', 'GIR 0AA']) {
    assert.equal(identify(pc).kind, 'postcode', `${pc} should be a postcode`);
  }
  assert.equal(formatPostcode('sw1a1aa'), 'SW1A 1AA');
  assert.equal(formatPostcode('m11ae'), 'M1 1AE');
  assert.equal(formatPostcode('GIR0AA'), 'GIR 0AA');
  assert.equal(outcodeOf('SW1A 1AA'), 'SW1A');
  assert.equal(outcodeOf('M1 1AE'), 'M1');
});

test('invalid postcodes are not postcodes', () => {
  // Q, V, X are not valid first letters; incode letters exclude C, I, K, M, O, V.
  assert.notEqual(identify('QW1A 1AA').kind, 'postcode');
  assert.ok(!isFullPostcode('SW1A 1CA'));
  assert.ok(!isFullPostcode('SW1A1'));
});

test('UPRNs are told apart from phone numbers', () => {
  assert.equal(identify('100023336956').kind, 'uprn');
  assert.equal(identify('10008345567').kind, 'uprn');
  // Leading zero means telephone, never a UPRN.
  assert.ok(!isUprn('01617501234'));
  assert.equal(identify('01617501234').kind, 'cli');
  assert.equal(identify('07700900123').kind, 'cli');
  assert.ok(isUprn('906700123'));
});

test('CLIs normalise from every common written form', () => {
  assert.equal(normaliseCli('+44 161 750 1234'), '01617501234');
  assert.equal(normaliseCli('0044 161 750 1234'), '01617501234');
  assert.equal(normaliseCli('44 161 750 1234'), '01617501234');
  assert.equal(normaliseCli('(0161) 750-1234'), '01617501234');
  assert.equal(normaliseCli('0161 750 1234'), '01617501234');
  assert.equal(normaliseCli('020 7946 0018'), '02079460018');
  assert.equal(normaliseCli('123'), null);
  assert.equal(cliType('01617501234'), 'geographic');
  assert.equal(cliType('07700900123'), 'mobile');
  assert.equal(cliType('03001234567'), 'non-geographic');
});

test('Openreach and provider references are classified', () => {
  assert.equal(identify('AL123456789').kind, 'lineAccessId');
  assert.equal(identify('BBEU12345678').kind, 'serviceId');
  assert.equal(identify('ANN123456').kind, 'serviceId');
  assert.equal(identify('ALCLFA1234AB').kind, 'ontSerial');
  assert.equal(identify('ZEN-123456').kind, 'serviceId');
});

test('free text falls through to an address search', () => {
  const r = identify('12 High Street');
  assert.equal(r.kind, 'address');
  assert.equal(r.normalised, '12 High Street');
  assert.equal(identify('  Flat 3   Ashley   Court ').normalised, 'Flat 3 Ashley Court');
});

test('an outcode is an address search, not a premises', () => {
  const r = identify('SW1A');
  assert.equal(r.kind, 'address');
  assert.match(r.reason, /district/i);
});

test('empty and junk input degrade cleanly', () => {
  assert.equal(identify('').kind, 'unknown');
  assert.equal(identify('   ').kind, 'unknown');
  assert.equal(identify('!!!').kind, 'unknown');
});

test('alternatives are offered when a string reads two ways', () => {
  // 9 digits: a plausible short UPRN, but not a valid phone number.
  const r = identify('906700123');
  assert.equal(r.kind, 'uprn');
  assert.ok(r.confidence > 0.5);
});

test('address lines join house number to street', () => {
  const lines = addressLines({
    buildingNumber: '12',
    thoroughfare: 'High Street',
    postTown: 'Manchester',
    postcode: 'M1 1AE',
  });
  assert.deepEqual(lines, ['12 High Street', 'Manchester']);

  assert.equal(
    singleLineAddress({
      subBuilding: 'Flat 3',
      buildingName: 'Ashley Court',
      buildingNumber: '12',
      thoroughfare: 'High Street',
      postTown: 'Manchester',
      postcode: 'm11ae',
    }),
    'Flat 3, Ashley Court, 12 High Street, Manchester, M1 1AE',
  );
});

test('finaliseAddress backfills lines and formats the postcode', () => {
  const a = finaliseAddress({
    buildingNumber: '1',
    thoroughfare: 'Test Road',
    postTown: 'Leeds',
    postcode: 'ls11aa',
    source: 'mock',
  });
  assert.equal(a.postcode, 'LS1 1AA');
  assert.equal(a.singleLine, '1 Test Road, Leeds, LS1 1AA');
  assert.deepEqual(a.lines, ['1 Test Road', 'Leeds']);
});

test('addresses sort numerically, not lexically', () => {
  const mk = (n: string) =>
    finaliseAddress({ buildingNumber: n, thoroughfare: 'High Street', postTown: 'Leeds', postcode: 'LS1 1AA', source: 'mock' });
  const sorted = sortAddresses([mk('10'), mk('2'), mk('1')]).map((a) => a.buildingNumber);
  assert.deepEqual(sorted, ['1', '2', '10']);
});

test('typeahead scoring requires every term to match', () => {
  const a = finaliseAddress({
    buildingNumber: '12',
    thoroughfare: 'High Street',
    postTown: 'Manchester',
    postcode: 'M1 1AE',
    source: 'mock',
  });
  assert.ok(scoreAddress('high street', a) > 0);
  assert.equal(scoreAddress('low street', a), 0);
  assert.equal(scoreAddress('', a), 0);
});
