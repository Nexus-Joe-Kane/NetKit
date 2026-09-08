import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __openCellIdTesting } from './openCellId';

const { mapCell, chooseSites, mncKey } = __openCellIdTesting;
const HERE = { latitude: 53.4808, longitude: -2.2426 };

test('a cell maps with its operator, radio and distance', () => {
  const site = mapCell(
    { lat: 53.4855, lon: -2.2445, mcc: 234, mnc: 30, radio: 'lte', cellid: 12345, lac: 678, range: 900, samples: 42 },
    HERE,
  );
  assert.equal(site?.operator, 'EE');
  assert.equal(site?.radio, 'LTE');
  assert.equal(site?.samples, 42);
  assert.equal(site?.rangeMetres, 900);
  assert.equal(site?.cellId, '12345');
  assert.ok(site && site.distanceMetres > 400 && site.distanceMetres < 700, `got ${site?.distanceMetres}`);
});

test('a leading zero in the network code is significant', () => {
  // MNC 02 is O2; dropping the zero would make it 2, which is nobody.
  assert.equal(mncKey(2), '02');
  assert.equal(mncKey('02'), '02');
  assert.equal(mncKey(15), '15');
  assert.equal(mncKey(undefined), undefined);
  assert.equal(mapCell({ lat: 53.48, lon: -2.24, mnc: 2 }, HERE)?.operator, 'O2');
});

test('every UK network resolves', () => {
  const of = (mnc: number | string) => mapCell({ lat: 53.48, lon: -2.24, mnc }, HERE)?.operator;
  assert.equal(of(15), 'Vodafone');
  assert.equal(of(20), 'Three');
  assert.equal(of(30), 'EE');
  assert.equal(of(33), 'EE');
  assert.equal(of(10), 'O2');
});

test('an unrecognised network keeps its code rather than vanishing', () => {
  const site = mapCell({ lat: 53.48, lon: -2.24, mnc: 58 }, HERE);
  assert.equal(site?.operator, undefined);
  assert.equal(site?.networkCode, '58');
});

test('a cell with no position is discarded', () => {
  assert.equal(mapCell({ mcc: 234, mnc: 30 }, HERE), null);
  assert.equal(mapCell({ lat: 0, lon: 0, mnc: 30 }, HERE), null, 'null island is not a mast');
});

test('string coordinates are accepted', () => {
  const site = mapCell({ lat: '53.4855', lon: '-2.2445', mnc: '30' }, HERE);
  assert.equal(site?.operator, 'EE');
  assert.ok(site && site.distanceMetres > 0);
});

test('sites are closest first and capped at three per network', () => {
  // Twelve EE sites and nothing else answers nobody's question; the nearest
  // few for each network is the comparison being made.
  const sites = [
    ...[900, 400, 1500, 2200, 3000].map((d) => ({ operator: 'EE' as const, latitude: 0, longitude: 0, distanceMetres: d })),
    ...[600, 1200].map((d) => ({ operator: 'Vodafone' as const, latitude: 0, longitude: 0, distanceMetres: d })),
  ];
  const chosen = chooseSites(sites);
  assert.equal(chosen.filter((s) => s.operator === 'EE').length, 3);
  assert.equal(chosen.filter((s) => s.operator === 'Vodafone').length, 2);
  assert.deepEqual(
    chosen.map((s) => s.distanceMetres),
    [400, 600, 900, 1200, 1500],
    'ordered by distance across all networks',
  );
});

test('unmapped networks are grouped by their code, not lumped together', () => {
  const sites = [
    ...[100, 200, 300, 400].map((d) => ({ networkCode: '58', latitude: 0, longitude: 0, distanceMetres: d })),
    ...[150, 250, 350, 450].map((d) => ({ networkCode: '76', latitude: 0, longitude: 0, distanceMetres: d })),
  ];
  const chosen = chooseSites(sites);
  assert.equal(chosen.filter((s) => s.networkCode === '58').length, 3);
  assert.equal(chosen.filter((s) => s.networkCode === '76').length, 3);
});
