import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, csvFilename, type CsvColumn } from './csv';

interface Row {
  ref: string;
  note?: string;
  cost?: number;
  engineer?: boolean;
}

const columns: Array<CsvColumn<Row>> = [
  { header: 'Reference', value: (r) => r.ref },
  { header: 'Note', value: (r) => r.note },
  { header: 'Cost', value: (r) => r.cost },
  { header: 'Engineer', value: (r) => r.engineer },
];

test('a plain table comes out as CRLF-delimited CSV', () => {
  const csv = toCsv([{ ref: 'ZEN1', cost: 42.5, engineer: true }], columns);
  assert.equal(csv, 'Reference,Note,Cost,Engineer\r\nZEN1,,42.5,true\r\n');
});

test('commas, quotes and newlines are quoted rather than breaking the row', () => {
  const csv = toCsv([{ ref: 'ZEN2', note: 'Flat 3, 12 High Street' }], columns);
  assert.match(csv, /"Flat 3, 12 High Street"/);

  const quoted = toCsv([{ ref: 'ZEN3', note: 'He said "no access"' }], columns);
  assert.match(quoted, /"He said ""no access"""/);

  const multiline = toCsv([{ ref: 'ZEN4', note: 'Line one\nLine two' }], columns);
  // One data row still, because the newline is inside quotes.
  assert.equal(multiline.split('\r\n').filter(Boolean).length, 2);
});

test('a value that a spreadsheet would execute is neutralised', () => {
  // The whole point: an address or note starting with one of these is a live
  // formula in Excel and Sheets, and formulas can exfiltrate.
  for (const dangerous of ['=1+1', '+44 7700 900123', '-- Flat 3', '@SUM(A1:A9)']) {
    const csv = toCsv([{ ref: 'ZEN5', note: dangerous }], columns);
    const cell = csv.split('\r\n')[1]!.split(',')[1]!;
    assert.ok(
      cell.startsWith('\t') || cell.startsWith('"\t'),
      `${dangerous} should be prefixed with a tab, got ${JSON.stringify(cell)}`,
    );
  }
});

test('false and zero are values, not blanks', () => {
  const csv = toCsv([{ ref: 'ZEN6', cost: 0, engineer: false }], columns);
  assert.equal(csv, 'Reference,Note,Cost,Engineer\r\nZEN6,,0,false\r\n');
});

test('an empty table still carries its header, so the file is readable', () => {
  assert.equal(toCsv([], columns), 'Reference,Note,Cost,Engineer\r\n');
});

test('the filename carries the date', () => {
  assert.match(csvFilename('orders'), /^orders-\d{4}-\d{2}-\d{2}\.csv$/);
});
