import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretHeader } from './ofcom';

test('underscore-separated Ofcom headers are understood', () => {
  // An underscore is a word character, so a \b-based regex silently matches
  // nothing here. This is the case that caught it.
  const { postcodeIndex, columns } = interpretHeader([
    'postcode',
    'EE_Voice_Indoor',
    'EE_Voice_Outdoor',
    'EE_4G_Indoor',
    'EE_5G_Outdoor',
    'VO_4G_Indoor',
    'TF_Voice_Outdoor',
    'H3_4G_Outdoor',
    'SomeIrrelevantColumn',
  ]);

  assert.equal(postcodeIndex, 0);
  assert.equal(columns.length, 7, 'every operator/service/placement column should be recognised');

  const find = (operator: string, service: string, placement: string) =>
    columns.find((c) => c.operator === operator && c.service === service && c.placement === placement);

  assert.ok(find('EE', 'voice', 'indoor'));
  assert.ok(find('EE', 'data4g', 'indoor'));
  assert.ok(find('EE', 'data5g', 'outdoor'));
  assert.ok(find('Vodafone', 'data4g', 'indoor'));
  assert.ok(find('O2', 'voice', 'outdoor'));
  assert.ok(find('Three', 'data4g', 'outdoor'));
});

test('other naming conventions are also understood', () => {
  const { columns } = interpretHeader([
    'pcds',
    'EE 4G premises indoor',
    'Vodafone-voice-outdoor',
    'TelefonicaLTEIndoor',
    'H3_5G_out',
  ]);
  assert.equal(columns.length, 4);
  assert.ok(columns.some((c) => c.operator === 'EE' && c.service === 'data4g' && c.placement === 'indoor'));
  assert.ok(columns.some((c) => c.operator === 'Vodafone' && c.service === 'voice' && c.placement === 'outdoor'));
  assert.ok(columns.some((c) => c.operator === 'O2' && c.service === 'data4g' && c.placement === 'indoor'));
  assert.ok(columns.some((c) => c.operator === 'Three' && c.service === 'data5g' && c.placement === 'outdoor'));
});

test('columns that are not coverage readings are ignored', () => {
  const { columns } = interpretHeader([
    'postcode',
    'local_authority',
    'premises_count',
    'total_4G_premises',
    'notes',
  ]);
  // `total_4G_premises` names a service but no operator and no placement, so
  // it must not be mistaken for a coverage reading.
  assert.equal(columns.length, 0);
});

test('short placement codes are not matched inside ordinary words', () => {
  // "IN" and "OUT" occur in a great many words, so they must only match as
  // whole tokens — otherwise "EE_4G_information" would read as indoor.
  const { columns } = interpretHeader([
    'postcode',
    'EE_4G_information',
    'EE_4G_throughput',
    'EE_4G_indoor',
  ]);
  assert.equal(columns.length, 1, 'only the genuine indoor column should match');
  assert.equal(columns[0]?.placement, 'indoor');
});

test('operator short codes are not matched inside ordinary words', () => {
  // "VO" inside "volume", "TF" inside a hash, "EE" inside "premises_seen".
  const { columns } = interpretHeader(['postcode', 'volume_4G_indoor', 'total_voice_outdoor']);
  assert.equal(columns.length, 0);
});

test('the postcode column is found even when it is not first', () => {
  const { postcodeIndex } = interpretHeader(['local_authority', 'Postcode', 'EE_4G_Indoor']);
  assert.equal(postcodeIndex, 1);
});
