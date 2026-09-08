import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_CALL_POINTS,
  footfallLevel,
  mastEdge,
  nearestByOperator,
  ofcomCheckerUrl,
  recommendNetwork,
  scoreFromGrade,
} from './networkAdvice';
import type { MastSite, MobileCoverage, MobileOperator, SignalGrade } from './types';

const coverage = (operator: MobileOperator, indoor: SignalGrade): MobileCoverage => ({
  operator,
  voice: { indoor, outdoor: indoor },
  data4g: { indoor, outdoor: indoor },
  source: 'ofcom',
  notes: [],
});

const mast = (operator: MobileOperator, distanceMetres: number): MastSite => ({
  operator,
  latitude: 51.5,
  longitude: -0.1,
  distanceMetres,
});

test('a grade lands on the same scale as a percentage', () => {
  assert.equal(scoreFromGrade('excellent'), 100);
  assert.equal(scoreFromGrade('good'), 80);
  assert.equal(scoreFromGrade('poor'), 40);
  assert.equal(scoreFromGrade('unknown'), 0);
});

test('the same grade is a close call; one grade apart is not', () => {
  // Ofcom's grades are coarse, so "within 5 points" means the same grade
  // until their API gives real percentages.
  assert.ok(scoreFromGrade('good') - scoreFromGrade('good') <= CLOSE_CALL_POINTS);
  assert.ok(scoreFromGrade('good') - scoreFromGrade('variable') > CLOSE_CALL_POINTS);
});

test('a mast edge needs to be both proportionally and absolutely real', () => {
  assert.equal(mastEdge(100, 120), false, '20 m is inside OpenCelliD’s own positional error');
  assert.equal(mastEdge(4000, 4300), false, '300 m at 4 km is noise');
  assert.equal(mastEdge(400, 2000), true);
  assert.equal(mastEdge(1200, 4200), true);
});

test('nearest per operator keeps the closest and counts the rest', () => {
  const map = nearestByOperator([mast('EE', 1800), mast('EE', 420), mast('O2', 900)]);
  assert.equal(map.get('EE')?.metres, 420);
  assert.equal(map.get('EE')?.count, 2);
  assert.equal(map.get('O2')?.metres, 900);
  assert.equal(map.get('Three'), undefined);
});

test('a clear prediction winner is the recommendation', () => {
  const advice = recommendNetwork({
    coverage: [coverage('EE', 'good'), coverage('O2', 'poor'), coverage('Three', 'poor')],
  });
  assert.equal(advice.best, 'EE');
  assert.equal(advice.quality, 'per-operator');
  assert.match(advice.reasons[0] ?? '', /EE has the best predicted indoor signal/);
});

test('a dead heat is decided by the masts, and does not credit the prediction', () => {
  // The prediction never picked one, so saying it "held" would credit Ofcom
  // with a call they did not make.
  const advice = recommendNetwork({
    coverage: [coverage('EE', 'good'), coverage('Vodafone', 'good')],
    masts: [mast('EE', 400), mast('Vodafone', 2100)],
  });
  assert.equal(advice.best, 'EE');
  assert.equal(advice.closeCall?.predictionHeld, true);
  assert.equal(advice.closeCall?.settledBy, 'masts');
  assert.equal(advice.confidence, 'high');
  assert.match(advice.reasons.join(' '), /same predicted grade, so the masts decided it/);
  assert.doesNotMatch(advice.reasons.join(' '), /holds it/);
});

test('a real five-point gap holds when the masts agree', () => {
  // Reachable only with percentages, which is what Ofcom's mobile API is
  // expected to carry. Grades are four coarse steps and cannot produce this.
  const advice = recommendNetwork({
    scores: { EE: 82, Vodafone: 79 },
    masts: [mast('EE', 400), mast('Vodafone', 2100)],
  });
  assert.equal(advice.best, 'EE');
  assert.equal(advice.closeCall?.predictionHeld, true);
  assert.match(advice.reasons.join(' '), /within 5 points of each other/);
  assert.match(advice.reasons.join(' '), /EE holds it, with a site at 400 m against 2\.1 km/);
});

test('a real five-point gap is overturned by a much nearer mast', () => {
  const advice = recommendNetwork({
    scores: { EE: 82, Vodafone: 79 },
    masts: [mast('EE', 2100), mast('Vodafone', 400)],
  });
  assert.equal(advice.best, 'Vodafone');
  assert.equal(advice.closeCall?.predictionHeld, false);
  assert.match(advice.reasons.join(' '), /On a tie, take the shorter path/);
});

test('a gap wider than five points is not a tie, even with a nearer mast', () => {
  const advice = recommendNetwork({
    scores: { EE: 90, Vodafone: 70 },
    masts: [mast('EE', 2100), mast('Vodafone', 400)],
  });
  assert.equal(advice.best, 'EE', 'twenty points is a real difference');
  assert.equal(advice.closeCall, undefined);
  assert.equal(advice.mastSuggestion?.operator, 'Vodafone', 'but the nearer mast is still raised');
});

test('a tie the other operator wins on masts flips the recommendation', () => {
  const advice = recommendNetwork({
    coverage: [coverage('EE', 'good'), coverage('Vodafone', 'good')],
    masts: [mast('EE', 2100), mast('Vodafone', 400)],
  });
  assert.equal(advice.best, 'Vodafone', 'on a tie, take the shorter path');
  assert.equal(advice.closeCall?.predictionHeld, false);
  assert.equal(advice.mastSuggestion?.operator, 'Vodafone');
  assert.equal(advice.mastSuggestion?.against, 'EE');
});

test('a tie with no mast data says so rather than picking one confidently', () => {
  const advice = recommendNetwork({ coverage: [coverage('EE', 'good'), coverage('O2', 'good')] });
  assert.equal(advice.closeCall?.settledBy, 'nothing');
  assert.equal(advice.confidence, 'low');
  assert.match(advice.reasons.join(' '), /no mast data to separate them/);
});

test('a nearer mast for a lower-ranked operator is raised without overruling the prediction', () => {
  const advice = recommendNetwork({
    coverage: [coverage('EE', 'good'), coverage('Three', 'poor')],
    masts: [mast('EE', 3000), mast('Three', 300)],
  });
  assert.equal(advice.best, 'EE', 'a whole grade apart is not a tie, so the prediction stands');
  assert.equal(advice.mastSuggestion?.operator, 'Three');
  assert.match(advice.reasons.join(' '), /Worth knowing: Three has a much nearer site/);
  assert.match(advice.reasons.join(' '), /do not know which way an antenna is pointed/);
});

test('a busy area makes the shorter path the stronger argument', () => {
  const advice = recommendNetwork({
    coverage: [coverage('EE', 'good'), coverage('Three', 'poor')],
    masts: [mast('EE', 3000), mast('Three', 300)],
    footfall: 'high',
  });
  const text = advice.reasons.join(' ');
  assert.match(text, /busy area/);
  assert.match(text, /Three's shorter path is the stronger argument/);
  assert.match(text, /Test both before committing a customer to a contract/);
});

test('a quiet area says the prediction is the better guide', () => {
  const advice = recommendNetwork({ coverage: [coverage('EE', 'good')], footfall: 'low' });
  assert.match(advice.reasons.join(' '), /congestion is unlikely to be the problem/);
});

test('masts alone give a low-confidence answer that admits what it is', () => {
  const advice = recommendNetwork({ masts: [mast('O2', 500), mast('EE', 2400)] });
  assert.equal(advice.best, 'O2');
  assert.equal(advice.confidence, 'low');
  assert.match(advice.reasons.join(' '), /Distance is not coverage/);
});

test('the area file is never allowed to rank operators', () => {
  // This is the whole point: Connected Nations counts networks and names
  // none, so a ranking attributed to it would be invented.
  const advice = recommendNetwork({ areaOnly: true, masts: [mast('EE', 500)] });
  assert.equal(advice.quality, 'area-only');
  assert.match(
    advice.missing.join(' '),
    /counts how many networks cover the area, not which/,
  );
  assert.match(advice.reasons.join(' '), /These rankings are not Ofcom's/);
});

test('what the engineer read off the checker counts as per-operator', () => {
  const advice = recommendNetwork({
    areaOnly: true,
    manualGrades: { EE: 'good', Vodafone: 'poor', O2: 'variable', Three: 'poor' },
  });
  assert.equal(advice.quality, 'per-operator');
  assert.equal(advice.best, 'EE');
  assert.match(advice.sourcesUsed.join(' '), /public checker, as read by the engineer/);
});

test('nothing at all is an honest nothing', () => {
  const advice = recommendNetwork({});
  assert.equal(advice.best, undefined);
  assert.equal(advice.confidence, 'low');
  assert.match(advice.missing.join(' '), /No mobile coverage prediction at all/);
});

test('every gap is named, so the engineer knows what would improve it', () => {
  const advice = recommendNetwork({ coverage: [coverage('EE', 'good')] });
  assert.match(advice.missing.join(' '), /OpenCelliD/);
  assert.match(advice.missing.join(' '), /Greater London only/);
});

test('the checker link carries the postcode and survives an empty one', () => {
  assert.equal(
    ofcomCheckerUrl('se23 1jg'),
    'https://www.ofcom.org.uk/mobile-coverage-checker?postcode=SE23%201JG',
  );
  assert.equal(ofcomCheckerUrl('  '), 'https://www.ofcom.org.uk/mobile-coverage-checker');
});

test('footfall levels bracket a London catchment', () => {
  assert.equal(footfallLevel(45_000), 'high');
  assert.equal(footfallLevel(3_000), 'medium');
  assert.equal(footfallLevel(400), 'low');
  assert.equal(footfallLevel(0), undefined);
  assert.equal(footfallLevel(undefined), undefined);
});
