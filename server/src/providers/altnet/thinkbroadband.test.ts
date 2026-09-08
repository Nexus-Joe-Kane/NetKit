import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __thinkbroadbandTesting } from './thinkbroadband';

const { mapPayload, identifyOperator, statusFrom, technologyFrom, tidy } = __thinkbroadbandTesting;

/**
 * thinkbroadband publish their field specification to licensees only, so the
 * mapper is written to accept several plausible shapes. These tests pin that
 * tolerance: when the first real response arrives, whichever of these shapes
 * it turns out to be is already handled, and the others can be deleted.
 */

test('reads a keyed-object payload', () => {
  const offers = mapPayload({
    postcode: 'SW1A 1AA',
    virginmedia: { available: true, maxDownload: 1130, maxUpload: 104 },
    cityfibre: { status: 'Available', maxDownload: 1000, maxUpload: 1000 },
  });
  assert.equal(offers.length, 2);
  const virgin = offers.find((o) => o.operator === 'virgin-media');
  assert.equal(virgin?.operatorLabel, 'Virgin Media O2');
  assert.equal(virgin?.technology, 'DOCSIS3.1', 'Virgin is cable, not PON');
  assert.equal(virgin?.speeds.downMbpsHigh, 1130);
  assert.equal(offers.find((o) => o.operator === 'cityfibre')?.technology, 'XGS-PON');
});

test('reads an array payload under any of the plausible envelope names', () => {
  for (const key of ['networks', 'operators', 'providers', 'results']) {
    const offers = mapPayload({ [key]: [{ operator: 'Community Fibre', available: true, maxDownload: 3000 }] });
    assert.equal(offers.length, 1, `${key} envelope should be read`);
    assert.equal(offers[0]?.operator, 'community-fibre');
    assert.equal(offers[0]?.operatorLabel, 'Community Fibre');
  }
});

test('a bare boolean is a usable answer', () => {
  const offers = mapPayload({ hyperoptic: true, gigaclear: false });
  assert.equal(offers.length, 1, 'false means not available, so it is dropped');
  assert.equal(offers[0]?.operator, 'hyperoptic');
  assert.equal(offers[0]?.status, 'available');
});

test('field names are matched regardless of case and separators', () => {
  const snake = mapPayload({ networks: [{ operator: 'trooli', max_download: 900, max_upload: 900, is_available: true }] });
  const camel = mapPayload({ networks: [{ operator: 'trooli', maxDownload: 900, maxUpload: 900, isAvailable: true }] });
  assert.equal(snake[0]?.speeds.downMbpsHigh, 900);
  assert.deepEqual(snake[0]?.speeds, camel[0]?.speeds);
});

test('an operator we have never heard of is surfaced, not dropped', () => {
  // A new alt-net appearing is the normal case, not an error.
  const offers = mapPayload({ networks: [{ operator: 'brand_new_fibre_co', available: true }] });
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.operator, 'other');
  assert.equal(offers[0]?.operatorLabel, 'Brand New Fibre Co');
});

test('G.Network keeps its real name even without a slot in the operator union', () => {
  const offers = mapPayload({ gnetwork: { available: true, maxDownload: 10000 } });
  assert.equal(offers[0]?.operator, 'other');
  assert.equal(offers[0]?.operatorLabel, 'G.Network');
});

test('Openreach is skipped, because Zen answers for it authoritatively', () => {
  const offers = mapPayload({ openreach: { available: true }, cityfibre: { available: true } });
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.operator, 'cityfibre');
});

test('envelope fields are not mistaken for operators', () => {
  const offers = mapPayload({
    postcode: 'SW1A 1AA',
    uprn: '100023336956',
    timestamp: '2026-09-08T00:00:00Z',
    query: { postcode: 'SW1A 1AA' },
    cityfibre: { available: true },
  });
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.operator, 'cityfibre');
});

test('a postcode-level answer is footprint, never confirmed', () => {
  // The whole point of the serviceability field: only an explicit
  // per-premises answer may claim the address was checked.
  const footprint = mapPayload({ cityfibre: { available: true } });
  assert.equal(footprint[0]?.serviceability, 'footprint');

  const confirmed = mapPayload({ cityfibre: { available: true, premisesConfirmed: true } });
  assert.equal(confirmed[0]?.serviceability, 'confirmed');
});

test('every row says plainly that it is not resellable', () => {
  const offers = mapPayload({ cityfibre: { available: true }, hyperoptic: true });
  for (const offer of offers) {
    assert.ok(
      offer.notes.some((n) => /not resellable/i.test(n)),
      'the note that stops someone quoting it must always be present',
    );
  }
});

test('build and waiting-list states are not reported as available', () => {
  assert.equal(statusFrom({ status: 'In build' }), 'available_soon');
  assert.equal(statusFrom({ status: 'Planned' }), 'build_planned');
  assert.equal(statusFrom({ status: 'Register your interest' }), 'waiting_list');
  assert.equal(statusFrom({ status: 'Available' }), 'available');
  assert.equal(statusFrom({ status: 'Not available' }), 'not_available');
  assert.equal(statusFrom({}), 'unknown');
});

test('technology is read from the feed, and guessed sensibly when absent', () => {
  assert.equal(technologyFrom('cityfibre', { technology: 'XGS-PON' }), 'XGS-PON');
  assert.equal(technologyFrom('cityfibre', { technology: 'FTTP' }), 'FTTP');
  assert.equal(technologyFrom('virgin-media', { technology: 'HFC cable' }), 'DOCSIS3.1');
  assert.equal(technologyFrom('virgin-media', {}), 'DOCSIS3.1', 'Virgin defaults to cable');
  assert.equal(technologyFrom('cityfibre', {}), 'XGS-PON', 'alt-nets default to PON');
});

test('operator matching does not fire on a coincidental substring', () => {
  // `BT` is an alias for Openreach and appears inside `GIGABIT`. Matching
  // that would silently drop a real network as "Openreach".
  assert.equal(identifyOperator('gigabit_networks').operator, 'other');
  assert.equal(identifyOperator('BT').operator, 'openreach');
});

test('names with no entry are tidied rather than shown raw', () => {
  assert.equal(tidy('community_fibre'), 'Community Fibre');
  assert.equal(tidy('someNewNet'), 'Some New Net');
  assert.equal(tidy('ITS'), 'ITS');
});

test('an empty or unrecognisable payload yields nothing rather than throwing', () => {
  assert.deepEqual(mapPayload(null), []);
  assert.deepEqual(mapPayload({}), []);
  assert.deepEqual(mapPayload([]), []);
  assert.deepEqual(mapPayload('nonsense'), []);
});
