import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmMatches } from './confirm';

test('forgives the things that do not change which building it is', () => {
  const address = 'Flat 3, 12 High Street, Manchester';
  assert.ok(confirmMatches('flat 3 12 high street manchester', address));
  assert.ok(confirmMatches('Flat 3,  12  High  Street,  Manchester', address));
  assert.ok(confirmMatches('FLAT 3, 12 HIGH STREET, MANCHESTER', address));
  assert.ok(confirmMatches('  Flat 3, 12 High Street, Manchester  ', address));
});

test('refuses the things that do', () => {
  const address = 'Flat 3, 12 High Street, Manchester';
  // The whole reason the guard exists: the neighbouring flat.
  assert.equal(confirmMatches('Flat 4, 12 High Street, Manchester', address), false);
  // And the house next door.
  assert.equal(confirmMatches('Flat 3, 12A High Street, Manchester', address), false);
  assert.equal(confirmMatches('Flat 3, 12 High Street, Salford', address), false);
  // A partial retype is not a confirmation.
  assert.equal(confirmMatches('Flat 3', address), false);
});

test('an empty confirmation never matches, even against an empty expectation', () => {
  assert.equal(confirmMatches('', 'Flat 3, 12 High Street'), false);
  assert.equal(confirmMatches('', ''), false);
  assert.equal(confirmMatches('   ', ',,,'), false);
});
