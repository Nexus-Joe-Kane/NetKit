import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __osPlacesTesting } from './osPlaces';

const { dedupeByUprn, lpiToRecord } = __osPlacesTesting;

test('an LPI-only premises maps with real fields, not just a UPRN', () => {
  // The shape behind the live failure: a sub-divided building Royal Mail has
  // no delivery point for, so it exists in LPI and not in DPA.
  const record = lpiToRecord({
    UPRN: '5121368',
    ORGANISATION: 'ACME LTD',
    SAO_TEXT: 'FLAT BASEMENT AND GROUND FLOOR',
    PAO_START_NUMBER: 2,
    STREET_DESCRIPTION: 'DOUGHTY STREET',
    LOCALITY_NAME: 'BLOOMSBURY',
    TOWN_NAME: 'LONDON',
    ADMINISTRATIVE_AREA: 'CAMDEN',
    POSTCODE_LOCATOR: 'WC1N2PH',
  });

  assert.equal(record.uprn, '5121368');
  assert.equal(record.buildingNumber, '2');
  assert.equal(record.thoroughfare, 'Doughty Street');
  assert.equal(record.postTown, 'LONDON');
  assert.equal(record.postcode, 'WC1N 2PH', 'postcode should be formatted');
  assert.match(record.subBuilding ?? '', /Flat Basement/);
  assert.ok(record.singleLine.length > 0, 'must produce a usable single line');
});

test('SAO and PAO numbering is recombined with its suffix', () => {
  const record = lpiToRecord({
    UPRN: '1',
    SAO_TEXT: 'FLAT',
    SAO_START_NUMBER: 3,
    PAO_START_NUMBER: 12,
    PAO_START_SUFFIX: 'A',
    STREET_DESCRIPTION: 'HIGH STREET',
    TOWN_NAME: 'BATH',
    POSTCODE_LOCATOR: 'BA1 1AA',
  });
  assert.equal(record.subBuilding, 'Flat 3');
  assert.equal(record.buildingNumber, '12A');
});

test('DPA wins when both views describe the same UPRN', () => {
  const rows = [
    {
      DPA: { UPRN: '100023463124', ADDRESS: 'X', BUILDING_NUMBER: '10', THOROUGHFARE_NAME: 'DOWNING STREET', POST_TOWN: 'LONDON', POSTCODE: 'SW1A 2AA' },
      LPI: { UPRN: '100023463124', PAO_START_NUMBER: 10, STREET_DESCRIPTION: 'DOWNING STREET', TOWN_NAME: 'LONDON', POSTCODE_LOCATOR: 'SW1A 2AA' },
    },
  ];
  const out = dedupeByUprn(rows);
  assert.equal(out.length, 1, 'the same premises must not appear twice');
  assert.equal(out[0]?.uprn, '100023463124');
});

test('an LPI-only row still makes it into the list', () => {
  const rows = [
    { DPA: { UPRN: '111', POST_TOWN: 'LONDON', POSTCODE: 'WC1N 2PH', BUILDING_NUMBER: '2', THOROUGHFARE_NAME: 'DOUGHTY STREET' } },
    { LPI: { UPRN: '5121368', PAO_START_NUMBER: 2, SAO_TEXT: 'FLAT BASEMENT', STREET_DESCRIPTION: 'DOUGHTY STREET', TOWN_NAME: 'LONDON', POSTCODE_LOCATOR: 'WC1N 2PH' } },
  ];
  const out = dedupeByUprn(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.uprn), ['111', '5121368'], 'OS order preserved');
});

test('the order OS returned is preserved', () => {
  const rows = ['300', '100', '200'].map((uprn) => ({
    DPA: { UPRN: uprn, POST_TOWN: 'LEEDS', POSTCODE: 'LS1 1AA', THOROUGHFARE_NAME: 'HIGH STREET' },
  }));
  assert.deepEqual(dedupeByUprn(rows).map((r) => r.uprn), ['300', '100', '200']);
});
