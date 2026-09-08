import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapFixedHeader } from './ofcomFixedDataset';

const dir = mkdtempSync(join(tmpdir(), 'netkit-fixed-'));
process.env.DATA_DIR = dir;

test('Ofcom’s published column names are all found', () => {
  const map = mapFixedHeader([
    'postcode_space',
    'postcode',
    'All Premises',
    'All Matched Premises',
    'SFBB availability (% premises)',
    'UFBB availability (% premises)',
    'FTTP availability (% premises)',
    'Gigabit availability (% premises)',
    '% of premises unable to receive 10Mbit/s',
    'Median download speed (Mbit/s)',
    'Maximum download speed (Mbit/s)',
    'Maximum upload speed (Mbit/s)',
  ]);

  assert.equal(map.postcode, 0, 'postcode_space is the formatted variant and is preferred');
  assert.equal(map.premises, 2);
  assert.equal(map.superfast, 4);
  assert.equal(map.ultrafast, 5);
  assert.equal(map.fttp, 6);
  assert.equal(map.gigabit, 7);
  assert.equal(map.belowUso, 8);
  assert.equal(map.medianDown, 9);
  assert.equal(map.maxDown, 10);
  assert.equal(map.maxUp, 11);
});

test('a maximum column is never mistaken for the median', () => {
  // Order of testing matters here: scanning for "download" alone reads the
  // maximum as the median and quotes a headline figure nobody gets.
  const map = mapFixedHeader(['postcode', 'Maximum download speed (Mbit/s)', 'Median download speed (Mbit/s)']);
  assert.equal(map.maxDown, 1);
  assert.equal(map.medianDown, 2);
});

test('upload and download are not confused', () => {
  const map = mapFixedHeader(['postcode', 'Maximum upload speed (Mbit/s)', 'Maximum download speed (Mbit/s)']);
  assert.equal(map.maxUp, 1);
  assert.equal(map.maxDown, 2);
});

test('a renamed column is still understood', () => {
  // Ofcom have worded this both ways across releases.
  const map = mapFixedHeader(['pcds', '% of premises with SFBB availability', 'Full fibre availability (%)']);
  assert.equal(map.postcode, 0);
  assert.equal(map.superfast, 1);
  assert.equal(map.fttp, 2);
});

test('the matched-premises column is not read as the premises count', () => {
  const map = mapFixedHeader(['postcode', 'All Matched Premises', 'All Premises']);
  assert.equal(map.premises, 2, 'matched premises is a different figure');
});

test('a column nobody recognises is left out rather than guessed at', () => {
  const map = mapFixedHeader(['postcode', 'Some new Ofcom metric']);
  assert.equal(map.postcode, 0);
  assert.equal(map.gigabit, -1);
  assert.equal(map.superfast, -1);
});

test('a file with no postcode column is rejected rather than indexed', () => {
  const path = join(dir, 'not-postcode.csv');
  writeFileSync(path, 'laua,laua_name,SFBB availability (% premises)\nE09000023,Lewisham,99\n');
  const map = mapFixedHeader(['laua', 'laua_name', 'SFBB availability (% premises)']);
  assert.equal(map.postcode, -1);
});
