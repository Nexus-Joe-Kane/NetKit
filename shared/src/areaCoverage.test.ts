import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allNetworks, areaKindLabel, atLeastOneNetwork, noNetwork, summariseArea } from './areaCoverage';
import type { AreaCoverage, AreaCoverageRow } from './areaCoverage';

const row = (
  technology: AreaCoverageRow['technology'],
  placement: AreaCoverageRow['placement'],
  bands: Array<[number, number]>,
): AreaCoverageRow => ({
  technology,
  measure: 'premises',
  placement,
  bands: bands.map(([operators, percent]) => ({ operators, percent })),
});

test('all four networks is the top band, not the last one listed', () => {
  const r = row('4G', 'indoor', [
    [4, 87.67],
    [0, 0.62],
    [3, 7.79],
  ]);
  assert.equal(allNetworks(r), 87.67);
});

test('no network reads the zero band', () => {
  assert.equal(noNetwork(row('4G', 'indoor', [[0, 0.62], [4, 87.67]])), 0.62);
});

test('an absent zero band is not read as missing data', () => {
  // Ofcom leave the cell empty rather than writing 0. "At least one" is the
  // sum of the bands above zero either way.
  const r = row('4G', 'outdoor', [
    [1, 0.1],
    [2, 0.18],
    [3, 1.29],
    [4, 98.43],
  ]);
  assert.equal(noNetwork(r), undefined);
  assert.equal(atLeastOneNetwork(r), 100);
});

test('at least one network sums the bands rather than inventing a column', () => {
  const r = row('5G', 'indoor', [
    [0, 20],
    [1, 30],
    [2, 25],
  ]);
  assert.equal(atLeastOneNetwork(r), 55);
});

test('the summary leads with 4G indoors, not 5G', () => {
  // Deliberate. 5G looks like the better headline but Ofcom publish it
  // outdoors only, so leading with it would answer a question nobody asked
  // about a site — the phone that is not working is inside the building.
  const coverage: AreaCoverage = {
    areaName: 'Lewisham West',
    kind: 'constituency',
    rows: [
      { ...row('5G', 'outdoor', [[4, 97]]), confidence: 'high' },
      row('4G', 'indoor', [[0, 1], [4, 90]]),
    ],
  };
  const text = summariseArea(coverage) ?? '';
  assert.match(text, /indoor 4G/);
  assert.match(text, /90% from all four/);
});

test('the summary says nothing rather than something wrong when there are no rows', () => {
  assert.match(summariseArea({ areaName: 'X', kind: 'area', rows: [row('4G', 'indoor', [[4, 91]])] }) ?? '', /4G/);
  assert.equal(summariseArea({ areaName: 'X', kind: 'area', rows: [] }), undefined);
});

test('a confidence qualifier is carried into the summary', () => {
  const coverage: AreaCoverage = {
    areaName: 'X',
    kind: 'area',
    rows: [{ ...row('5G', 'outdoor', [[4, 66]]), confidence: 'very-high' }],
  };
  assert.match(summariseArea(coverage) ?? '', /5G \(very high confidence\)/);
});

test('area kinds read as words a person would use', () => {
  assert.equal(areaKindLabel('constituency'), 'parliamentary constituency');
  assert.equal(areaKindLabel('local-authority'), 'local authority');
});
