import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  OFCOM_MOBILE_FIELDS,
  backupVerdict,
  bandFromRating,
  bestOperator,
  gradeFromOfcom,
  mobileRatingLabel,
  toMobileRating,
  type MobileRating,
} from './index';

/* ---- The scale changed, and it does not mean the same thing ---------- */

test('a rating of 2 means good outdoors and NOTHING indoors', () => {
  // The trap. Ofcom's June 2025 methodology replaced a 0/3/4 quality grade
  // with a 0-4 scale where the low end is outdoor-only. Reading `2` with the
  // old mapper reports indoor coverage at an address Ofcom says has none —
  // the difference between telling a customer their phone works at their
  // desk and telling them it does not.
  assert.deepEqual(bandFromRating(2), { indoor: 'none', outdoor: 'good' });

  // For contrast, the legacy mapper still in the codebase for the old files:
  assert.equal(gradeFromOfcom(2), 'variable', 'which is why the new scale needed its own mapper');
});

test('every rating maps to the pair Ofcom describe', () => {
  assert.deepEqual(bandFromRating(0), { indoor: 'none', outdoor: 'poor' });
  assert.deepEqual(bandFromRating(1), { indoor: 'none', outdoor: 'variable' });
  assert.deepEqual(bandFromRating(2), { indoor: 'none', outdoor: 'good' });
  assert.deepEqual(bandFromRating(3), { indoor: 'variable', outdoor: 'good' });
  assert.deepEqual(bandFromRating(4), { indoor: 'good', outdoor: 'good' });
});

test('indoor coverage is never softened from none to poor', () => {
  // Softening it would put a number on something Ofcom declined to.
  for (const rating of [0, 1, 2] as MobileRating[]) {
    assert.equal(bandFromRating(rating).indoor, 'none', `rating ${rating}`);
  }
});

test('a rating is read from a number or a numeric string, and nothing else', () => {
  assert.equal(toMobileRating(3), 3);
  assert.equal(toMobileRating('3'), 3);
  assert.equal(toMobileRating(' 3 '), 3);
  assert.equal(toMobileRating(0), 0, 'zero is a real answer, not a missing one');
  assert.equal(toMobileRating(undefined), undefined);
  assert.equal(toMobileRating(''), undefined);
  assert.equal(toMobileRating('good'), undefined);
  assert.equal(toMobileRating(9), undefined, 'off the scale is not on it');
  assert.equal(toMobileRating(-1), undefined);
});

test('the field names are the ones Ofcom use, not the operator names', () => {
  // `TH` for Three and `VO` for Vodafone are not guessable.
  const map = new Map(OFCOM_MOBILE_FIELDS.map((f) => [f.operator, f.field]));
  assert.equal(map.get('Three'), 'Mc_TH');
  assert.equal(map.get('Vodafone'), 'Mc_VO');
  assert.equal(map.get('EE'), 'Mc_EE');
  assert.equal(map.get('O2'), 'Mc_O2');
});

/* ---- Which operator to recommend ------------------------------------- */

test('indoor coverage wins, because that is what is being asked about', () => {
  const best = bestOperator({ EE: 2, Three: 3, O2: 2, Vodafone: 1 });
  assert.equal(best.operator, 'Three');
  assert.equal(best.indoor, true);
});

test('the best of a bad lot is named as such, not as a winner', () => {
  const best = bestOperator({ EE: 2, Three: 1, O2: 2, Vodafone: 0 });
  assert.equal(best.indoor, false);
  assert.match(best.because, /No operator is predicted to work indoors/);
  assert.match(best.because, /external aerial/);
});

test('nothing reported is answered as nothing reported', () => {
  const best = bestOperator({});
  assert.equal(best.operator, undefined);
  assert.match(best.because, /No operator coverage/);
});

/* ---- What it means for a 5G unit in a cupboard ----------------------- */

test('a comms cupboard is indoors and usually the worst room in the building', () => {
  // The real question behind a mobile lookup: will the backup router hold.
  assert.deepEqual(backupVerdict(4), {
    usable: true,
    needsAerial: false,
    advice: 'Should hold indoors, cupboard included.',
  });

  const variable = backupVerdict(3);
  assert.equal(variable.usable, true);
  assert.equal(variable.needsAerial, true, 'variable indoors makes a cupboard a gamble');

  const outdoorOnly = backupVerdict(2);
  assert.equal(outdoorOnly.usable, false);
  assert.equal(outdoorOnly.needsAerial, true);
  assert.match(outdoorOnly.advice, /not optional/);

  assert.equal(backupVerdict(0).usable, false);
  assert.equal(backupVerdict(0).needsAerial, false, 'an aerial cannot fix no coverage');
});

test('no figure promises nothing', () => {
  const none = backupVerdict(undefined);
  assert.equal(none.usable, false);
  assert.match(none.advice, /nothing can be promised/);
});

test('the labels are Ofcom’s own wording', () => {
  assert.match(mobileRatingLabel(2), /outdoors/i);
  assert.match(mobileRatingLabel(4), /indoors and outdoors/i);
});
