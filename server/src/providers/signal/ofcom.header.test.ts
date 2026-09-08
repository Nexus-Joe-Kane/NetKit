import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { interpretHeader, normaliseArea } from './ofcom';

/**
 * Ofcom publish no postcode-level mobile file, so the header reader has to
 * recognise the area-keyed shape they do publish.
 */

test('an area-keyed header is recognised and not mistaken for postcode-keyed', () => {
  // The shape of the combined pcon + laua file.
  const header = [
    'release',
    'level',
    'area_code',
    'area_name',
    'EE_Voice_Indoor',
    'EE_4G_Outdoor',
    'Vodafone_Voice_Indoor',
  ];
  const meaning = interpretHeader(header);

  assert.equal(meaning.areaCodeIndex, 2);
  assert.equal(meaning.areaNameIndex, 3);
  assert.equal(meaning.postcodeIndex, -1, 'must not invent a postcode column');
  assert.equal(meaning.columns.length, 3);
});

test('a postcode-keyed header still wins when one exists', () => {
  const meaning = interpretHeader(['postcode', 'EE_Voice_Indoor']);
  assert.equal(meaning.postcodeIndex, 0);
  assert.equal(meaning.columns.length, 1);
});

test('the old fallback only fires when there is no key column at all', () => {
  // Without this guard an area-keyed file was read as postcode-keyed with
  // column 0 as the key, and every lookup missed.
  const guessed = interpretHeader(['something', 'EE_Voice_Indoor']);
  assert.equal(guessed.postcodeIndex, 0, 'no key at all: fall back to column 0');

  const areaKeyed = interpretHeader(['area_name', 'EE_Voice_Indoor']);
  assert.equal(areaKeyed.postcodeIndex, -1, 'an area key must suppress the guess');
});

test('a measure column is never mistaken for the area key', () => {
  // `AREA` appears inside plenty of measure names; joined-token equality is
  // what stops one of them being used to index the file.
  const meaning = interpretHeader(['area_name', 'EE_4G_Outdoor_Area_Percent', 'EE_Voice_Indoor']);
  assert.equal(meaning.areaNameIndex, 0);
});

test('the ONS code column is found under its various spellings', () => {
  for (const spelling of ['area_code', 'pcon', 'PCON_CODE', 'laua', 'gss_code']) {
    const meaning = interpretHeader([spelling, 'area_name', 'EE_Voice_Indoor']);
    assert.equal(meaning.areaCodeIndex, 0, `${spelling} should be read as the code column`);
  }
});

test('area names compare regardless of case and punctuation', () => {
  assert.equal(normaliseArea('Richmond Park'), normaliseArea('richmond park'));
  assert.equal(normaliseArea('Kingston upon Hull, East'), normaliseArea('KINGSTON UPON HULL EAST'));
  assert.equal(normaliseArea('  Bath  '), 'BATH');
});
