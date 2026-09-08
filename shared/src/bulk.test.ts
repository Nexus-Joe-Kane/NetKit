import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseBulkInput } from './bulk';

test('a pasted spreadsheet column becomes one input per line', () => {
  assert.deepEqual(parseBulkInput('M1 1AE\nSE23 1JG\nW1G 0BD'), ['M1 1AE', 'SE23 1JG', 'W1G 0BD']);
});

test('commas, semicolons and tabs also separate', () => {
  assert.deepEqual(parseBulkInput('M1 1AE, SE23 1JG; W1G 0BD\tBN1 1NB'), [
    'M1 1AE',
    'SE23 1JG',
    'W1G 0BD',
    'BN1 1NB',
  ]);
});

test('a space is not a separator, because postcodes contain one', () => {
  assert.deepEqual(parseBulkInput('M1 1AE'), ['M1 1AE']);
  assert.deepEqual(parseBulkInput('45 Brockley Rise'), ['45 Brockley Rise']);
});

test('duplicates are charged once', () => {
  // The same postcode twice is one lookup; billing the budget twice for it
  // would be wrong.
  assert.deepEqual(parseBulkInput('M1 1AE\nm1  1ae\nM1 1AE'), ['M1 1AE']);
});

test('blank lines and stray separators are dropped', () => {
  assert.deepEqual(parseBulkInput('\n\nM1 1AE\n\n,,\nSE23 1JG\n'), ['M1 1AE', 'SE23 1JG']);
  assert.deepEqual(parseBulkInput('   '), []);
  assert.deepEqual(parseBulkInput(''), []);
});

test('the original text of each input is preserved', () => {
  // A row has to be matchable back to the customer's own list.
  assert.deepEqual(parseBulkInput('  45 Brockley Rise, London  '), ['45 Brockley Rise', 'London']);
  assert.deepEqual(parseBulkInput('Megan’s Richmond'), ['Megan’s Richmond']);
});
