import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __lookupTesting } from './lookup';

const { hits, SEARCHABLE_BROADBAND } = __lookupTesting;

/* ---- Matching a typed term against a record ------------------------- */

test('every word typed has to appear, which is what makes a second word narrow', () => {
  const willow = ['07700900123', '8944000000000000001', 'Willow Estate Agents', 'Brockley Rise', 'SE23 1JG'];
  assert.equal(hits(willow, 'willow'), true);
  assert.equal(hits(willow, 'willow brockley'), true);
  assert.equal(hits(willow, 'willow mayfair'), false, 'a second word must constrain, not widen');
});

test('a number matches however it is punctuated', () => {
  // 07700 900123 in the box, 447700900123 in the record, or the other way
  // round. Nobody types a number the way a provider stores it.
  const sim = ['+44 7700 900123', '8944 0000 0000 0000 001', 'Maru'];
  assert.equal(hits(sim, '07700900123'), true);
  assert.equal(hits(sim, '900123'), true);
  assert.equal(hits(sim, '8944000000000000001'), true);
  assert.equal(hits(sim, '900124'), false);
});

test('an apostrophe in the record does not stop a match', () => {
  assert.equal(hits(["Megan's Richmond"], 'megans'), true);
  assert.equal(hits(['Megans Richmond'], "megan's"), true);
});

test('an empty term matches nothing rather than everything', () => {
  assert.equal(hits(['Willow'], ''), false);
  assert.equal(hits(['Willow'], '   '), false);
});

test('empty fields in a record are ignored, not treated as matches', () => {
  assert.equal(hits(['Willow', '', ''], 'willow'), true);
  assert.equal(hits(['', ''], 'willow'), false);
});

/* ---- When broadband can be searched at all -------------------------- */

test('a postcode, a reference or a long number is searchable', () => {
  for (const term of ['SE23 1JG', 'se231jg', 'BBEU12345678', 'ZW1234567', '02071234567']) {
    assert.equal(SEARCHABLE_BROADBAND.test(term), true, `${term} should be searchable`);
  }
});

test('a customer name is not, and the list says so rather than looking empty', () => {
  // Suppliers match a reference, a postcode or a number — never a name. The
  // honest failure is telling the engineer that, not showing nothing.
  for (const term of ['willow', 'Willow Estate Agents', 'megans richmond']) {
    assert.equal(SEARCHABLE_BROADBAND.test(term), false, `${term} should not be searchable`);
  }
});

test('only the leading digits are rewritten', () => {
  // Rewriting a 0 in the middle would match an ICCID against a phone number
  // and put somebody else's SIM in the list.
  const { numberForms } = __lookupTesting;
  assert.deepEqual(numberForms('07700900123'), ['07700900123', '447700900123']);
  assert.deepEqual(numberForms('447700900123'), ['447700900123', '07700900123']);
  assert.deepEqual(numberForms('8944000000000000001'), ['8944000000000000001']);
  assert.deepEqual(numberForms('900123'), ['900123']);
});
