import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_SECTIONS,
  PRINT_SECTIONS,
  availableSections,
  hasOpenreachDetail,
  printDensity,
} from './printOptions';

const report = (over: Record<string, unknown>) =>
  ({ lines: [], address: { postcode: 'M1 1AE' }, ...over }) as never;

test('every default section is a real section', () => {
  for (const id of DEFAULT_SECTIONS) {
    assert.ok(PRINT_SECTIONS.some((s) => s.id === id), `${id} is not a defined section`);
  }
});

test('the two that need a decision are off by default', () => {
  // A customer-facing print should not carry a neighbour's circuits.
  assert.equal(DEFAULT_SECTIONS.includes('footprint'), false);
  assert.equal(DEFAULT_SECTIONS.includes('nearbyLines'), false);
});

test('address details are always available', () => {
  assert.ok(availableSections(report({})).has('identity'));
});

test('a section with no data is not offered as available', () => {
  const empty = availableSections(report({}));
  for (const id of ['headline', 'options', 'footprint', 'predicted', 'openreach', 'signal', 'lines'] as const) {
    assert.equal(empty.has(id), false, `${id} should be unavailable on an empty report`);
  }
});

test('sellable and footprint offers are told apart', () => {
  const sellableOnly = availableSections(
    report({ broadband: { offers: [{ serviceability: 'confirmed' }] } }),
  );
  assert.ok(sellableOnly.has('options'));
  assert.equal(sellableOnly.has('footprint'), false);

  const footprintOnly = availableSections(
    report({ broadband: { offers: [{ serviceability: 'footprint' }] } }),
  );
  assert.ok(footprintOnly.has('footprint'));
  assert.equal(footprintOnly.has('options'), false, 'a footprint row is not a sellable option');
});

test('mobile coverage needs at least one operator', () => {
  assert.equal(availableSections(report({ signal: { operators: [] } })).has('signal'), false);
  assert.ok(availableSections(report({ signal: { operators: [{ operator: 'EE' }] } })).has('signal'));
});

test('unmatched nearby lines are recognised separately from lines', () => {
  const a = availableSections(report({ nearbyLines: [{ id: '1' }] }));
  assert.ok(a.has('nearbyLines'));
  assert.equal(a.has('lines'), false);
});

test('the page gets tighter as more is ticked', () => {
  // One section in tight type reads as an afterthought; seven in roomy type
  // runs to three sheets.
  assert.equal(printDensity(1), 'roomy');
  assert.equal(printDensity(2), 'roomy');
  assert.equal(printDensity(3), 'normal');
  assert.equal(printDensity(4), 'normal');
  assert.equal(printDensity(5), 'tight');
  assert.equal(printDensity(9), 'tight');
});

test('a zero count still has a density', () => {
  // Nothing ticked prints only the letterhead, which must not be unstyled.
  assert.equal(printDensity(0), 'roomy');
});

test('a hollow Openreach object is not offered as printable', () => {
  // The mapper builds this from whatever the wholesale answer carried, so a
  // thin answer leaves every field undefined. Offering the tick anyway is
  // the exact fault the picker exists to avoid.
  assert.equal(hasOpenreachDetail(undefined), false);
  assert.equal(hasOpenreachDetail({} as never), false);
  assert.equal(hasOpenreachDetail({ exchange: {} } as never), false);
  assert.equal(hasOpenreachDetail({ flags: [] } as never), false);
  assert.equal(
    hasOpenreachDetail({ flags: [{ level: 'info', label: 'Nothing notable' }] } as never),
    false,
    'an info-only flag is not worth a section',
  );
  assert.equal(availableSections({ lines: [], broadband: { offers: [], openreach: {} } } as never).has('openreach'), false);
});

test('any real Openreach fact makes the section printable', () => {
  assert.ok(hasOpenreachDetail({ exchange: { name: 'MANCHESTER CENTRAL' } } as never));
  assert.ok(hasOpenreachDetail({ cabinet: { id: '17' } } as never));
  assert.ok(hasOpenreachDetail({ fttp: { available: true, buildStatus: 'RFS' } } as never));
  assert.ok(hasOpenreachDetail({ alk: 'ALK000123456' } as never));
  assert.ok(hasOpenreachDetail({ exchange: { name: '', distanceMetres: 0 } } as never), 'zero metres is a fact');
  assert.ok(hasOpenreachDetail({ flags: [{ level: 'critical', label: 'Stop sell' }] } as never));
});
