import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asCoverage, extractRows } from './ofcomMobileChecker';

/* ---- The spec contradicts itself in three places --------------------- */

test('the schema’s object shape is read', () => {
  const rows = extractRows({
    PostCode: 'SE231AB',
    Availability: [{ uprn: 100023336956, postcode: 'SE231AB', Mc_EE: 4, Mc_TH: 3, Mc_O2: 2, Mc_VO: 1 }],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.ratings, { EE: 4, Three: 3, O2: 2, Vodafone: 1 });
  assert.equal(rows[0]?.uprn, '100023336956');
});

test('the example’s array shape is read too', () => {
  // The schema says one object; the published example is an array of them.
  // Picking one and finding out in production is the avoidable version.
  const rows = extractRows([
    { PostCode: 'SE231AB', Availability: [{ uprn: 1, Mc_EE: 4 }] },
    { PostCode: 'SE231AC', Availability: [{ uprn: 2, Mc_EE: 0 }] },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.uprn), ['1', '2']);
});

test('keys with the example’s stray spaces are read', () => {
  // Every key in the published example is wrapped in spaces: `" uprn "`,
  // `" Mc_EE "`. Almost certainly a documentation artefact; trimming costs
  // one line and guessing wrong costs a morning.
  const rows = extractRows({
    ' PostCode ': 'SE231AB',
    ' Availability ': [{ ' uprn ': '55', ' Mc_EE ': 4, ' Mc_TH ': 3 }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.uprn, '55');
  assert.deepEqual(rows[0]?.ratings, { EE: 4, Three: 3 });
});

test('both spellings of the address field are read', () => {
  // The schema says `AddressShortDescription`; the example says
  // `address_short_description`.
  assert.equal(
    extractRows({ Availability: [{ uprn: 1, AddressShortDescription: '12 Willow Road' }] })[0]?.address,
    '12 Willow Road',
  );
  assert.equal(
    extractRows({ Availability: [{ uprn: 1, address_short_description: '12 Willow Road' }] })[0]?.address,
    '12 Willow Road',
  );
});

test('a bare row or a bare array of rows still works', () => {
  // What a proxy that unwraps envelopes would send.
  assert.equal(extractRows({ uprn: 1, Mc_EE: 4 }).length, 1);
  assert.equal(extractRows([{ uprn: 1, Mc_EE: 4 }, { uprn: 2, Mc_EE: 3 }]).length, 2);
});

/* ---- What is and is not an answer ----------------------------------- */

test('a row with no operator figures and no UPRN is discarded', () => {
  // Returning it would have the caller report "coverage found" for an
  // address with none.
  assert.deepEqual(extractRows({ Availability: [{ district_code: 'SE' }] }), []);
});

test('a zero rating is kept, because zero is a real answer', () => {
  const rows = extractRows({ Availability: [{ uprn: 1, Mc_EE: 0, Mc_TH: 0, Mc_O2: 0, Mc_VO: 0 }] });
  assert.deepEqual(rows[0]?.ratings, { EE: 0, Three: 0, O2: 0, Vodafone: 0 });
});

test('nothing at all is an empty list rather than a throw', () => {
  assert.deepEqual(extractRows(null), []);
  assert.deepEqual(extractRows(undefined), []);
  assert.deepEqual(extractRows([]), []);
  assert.deepEqual(extractRows('nonsense'), []);
});

/* ---- Mapping to the portal's model ---------------------------------- */

test('voice and data carry the same figure, and say why', () => {
  // Ofcom merged them. Deriving a separate voice and data figure from one
  // number would invent a distinction they deliberately removed.
  const [ee] = asCoverage({ uprn: '1', ratings: { EE: 3 } });
  assert.deepEqual(ee?.voice, ee?.data4g);
  assert.ok(ee?.notes.some((n) => /same measurement/i.test(n)));
  assert.equal(ee?.data3g, undefined, '3G is no longer reported, so it is absent rather than guessed');
});

test('an operator with no figure is left out, not reported as zero', () => {
  const rows = asCoverage({ uprn: '1', ratings: { EE: 4 } });
  assert.deepEqual(rows.map((r) => r.operator), ['EE']);
});

test('a postcode-level answer says it is not this doorstep', () => {
  const [ee] = asCoverage({ ratings: { EE: 4 } });
  assert.ok(ee?.notes.some((n) => /not this doorstep/i.test(n)));
});
