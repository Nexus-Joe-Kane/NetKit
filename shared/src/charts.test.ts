import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bearingBetween,
  compassPoint,
  dailyBars,
  formatMetres,
  metresBetween,
  plotCaption,
  plotMasts,
  plotRadius,
  rankedBars,
  sparkArea,
  sparkline,
  usageVerdict,
  worstDay,
  type MastSite,
} from './index';

const opts = { width: 100, height: 40 };

/* ---- Sparklines ------------------------------------------------------ */

test('a flat line is drawn through the middle, not along the floor', () => {
  // A line of 100% uptime pinned to the bottom of the chart looks exactly
  // like a line of zeroes.
  const spark = sparkline({ points: [1, 2, 3].map((i) => ({ at: `d${i}`, value: 100 })) }, opts);
  assert.equal(spark.flat, true);

  // Stated as "all the same, and in the middle third" rather than as an
  // arithmetic expectation: my first version of this test recomputed the
  // padding wrongly and failed against correct code, which is the least
  // useful kind of test failure.
  const ys = new Set(spark.points.map((p) => p.y));
  assert.equal(ys.size, 1, 'a flat series is flat');
  const y = spark.points[0]!.y;
  assert.ok(y > opts.height / 3 && y < (opts.height * 2) / 3, `${y} is not in the middle third`);
});

test('a single point is a dot, not an invisible path', () => {
  // A one-point line has no length and reads as no data.
  const spark = sparkline({ points: [{ at: 'd1', value: 5 }] }, opts);
  assert.equal(spark.path, '');
  assert.equal(spark.points.length, 1);
  assert.equal(spark.points[0]!.x, 2 + 96 / 2, 'centred rather than jammed left');
});

test('no points draws nothing rather than throwing', () => {
  const spark = sparkline({ points: [] }, opts);
  assert.equal(spark.path, '');
  assert.deepEqual(spark.points, []);
});

test('the line spans the box, with the maximum at the top', () => {
  const spark = sparkline({ points: [{ at: 'a', value: 0 }, { at: 'b', value: 10 }] }, opts);
  assert.equal(spark.points[0]!.y > spark.points[1]!.y, true, 'y grows downwards on screen');
  assert.equal(spark.min, 0);
  assert.equal(spark.max, 10);
});

test('non-numbers are dropped rather than plotted as zero', () => {
  const spark = sparkline({ points: [{ at: 'a', value: 5 }, { at: 'b', value: NaN }, { at: 'c', value: 7 }] }, opts);
  assert.equal(spark.points.length, 2);
});

test('an area under one point is nothing, because it would be a meaningless block', () => {
  assert.equal(sparkArea(sparkline({ points: [{ at: 'a', value: 5 }] }, opts), opts), '');
  assert.match(sparkArea(sparkline({ points: [{ at: 'a', value: 1 }, { at: 'b', value: 2 }] }, opts), opts), /Z$/);
});

/* ---- Usage, where pace matters more than the number ----------------- */

test('80% used is fine at month end and a problem on the fourth', () => {
  // The whole reason this is not just a percentage. Same number, two
  // completely different conversations.
  assert.equal(usageVerdict({ usedPercent: 80, periodElapsed: 0.9 }).verdict, 'fine');
  assert.equal(usageVerdict({ usedPercent: 80, periodElapsed: 0.13 }).verdict, 'close');
});

test('running out is stated outright', () => {
  const over = usageVerdict({ usedPercent: 104 });
  assert.equal(over.verdict, 'over');
  assert.match(over.because, /charged as an overage/);
});

test('with no sense of the period, the flat thresholds are used and said to be', () => {
  // "90% used" with three days left is a different fact from "90% used" with
  // three weeks left, and this cannot tell them apart, so it says so.
  const result = usageVerdict({ usedPercent: 92 });
  assert.equal(result.verdict, 'close');
  assert.match(result.because, /not known/);
});

test('no figure is not a problem', () => {
  assert.equal(usageVerdict({}).verdict, 'fine');
  assert.match(usageVerdict({}).because, /No usage figure/);
});

/* ---- Stability ------------------------------------------------------ */

test('quiet days are drawn as zeroes, not skipped', () => {
  // A gap in the bars reads as a quiet day. A line that dropped forty times
  // on Tuesday and nothing since must not look like one dropping steadily.
  const bars = dailyBars({
    drops: [{ at: '2026-09-02T10:00:00Z' }, { at: '2026-09-02T11:00:00Z' }],
    from: '2026-09-01T00:00:00Z',
    to: '2026-09-04T00:00:00Z',
  });
  assert.deepEqual(bars.map((b) => b.drops), [0, 2, 0, 0]);
  assert.deepEqual(bars.map((b) => b.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
});

test('drops outside the window are ignored rather than folded into an edge day', () => {
  const bars = dailyBars({
    drops: [{ at: '2026-08-15T10:00:00Z' }],
    from: '2026-09-01T00:00:00Z',
    to: '2026-09-02T00:00:00Z',
  });
  assert.deepEqual(bars.map((b) => b.drops), [0, 0]);
});

test('a nonsense window produces nothing rather than a wrong chart', () => {
  assert.deepEqual(dailyBars({ drops: [], from: 'x', to: 'y' }), []);
  assert.deepEqual(dailyBars({ drops: [], from: '2026-09-05T00:00:00Z', to: '2026-09-01T00:00:00Z' }), []);
});

test('the worst day is named, or nothing where there were no drops', () => {
  // A chart with no number next to it makes somebody count bars.
  const bars = [{ date: '2026-09-01', drops: 0 }, { date: '2026-09-02', drops: 7 }];
  assert.deepEqual(worstDay(bars), { date: '2026-09-02', drops: 7 });
  assert.equal(worstDay([{ date: '2026-09-01', drops: 0 }]), undefined);
});

/* ---- Ranked bars ---------------------------------------------------- */

test('bars scale to the worst row, not to a round hundred', () => {
  // A ranking answers a relative question. Scaled to 100 when the worst is
  // 12, it is four rows of nothing.
  const bars = rankedBars(
    [{ n: 'BT', v: 12 }, { n: 'Zen', v: 6 }, { n: 'Sky', v: 3 }],
    (r) => r.v,
    (r) => r.n,
  );
  assert.deepEqual(bars.map((b) => b.percent), [100, 50, 25]);
  assert.deepEqual(bars.map((b) => b.label), ['BT', 'Zen', 'Sky']);
});

test('all-zero rows are all zero rather than all full', () => {
  const bars = rankedBars([{ n: 'BT', v: 0 }, { n: 'Zen', v: 0 }], (r) => r.v, (r) => r.n);
  assert.deepEqual(bars.map((b) => b.percent), [0, 0]);
});

/* ---- The mast plot -------------------------------------------------- */

const mast = (over: Partial<MastSite>): MastSite => ({
  latitude: 51.5,
  longitude: -0.12,
  distanceMetres: 300,
  ...over,
});

test('the outer ring is a number a person can read off', () => {
  // "The ring is 1km" is usable; "the ring is 837m" has to be thought about.
  assert.equal(plotRadius([120, 300]), 500);
  assert.equal(plotRadius([837]), 1000);
  assert.equal(plotRadius([]), 250);
  assert.equal(plotRadius([50_000]), 20_000, 'clamped rather than unbounded');
});

test('north is up, and east is right', () => {
  const centre = { latitude: 51.5, longitude: -0.12 };
  assert.equal(Math.round(bearingBetween(centre, { latitude: 51.52, longitude: -0.12 })), 0);
  assert.equal(Math.round(bearingBetween(centre, { latitude: 51.5, longitude: -0.09 })), 90);
  assert.equal(Math.round(bearingBetween(centre, { latitude: 51.48, longitude: -0.12 })), 180);
});

test('a mast due north plots above the centre, not below it', () => {
  // Screen y grows downwards, and getting this backwards puts every mast in
  // the wrong half of the plot.
  const plot = plotMasts({
    premises: { latitude: 51.5, longitude: -0.12 },
    masts: [mast({ latitude: 51.505, longitude: -0.12, distanceMetres: 550 })],
    size: 240,
    radiusMetres: 1000,
  })!;
  assert.equal(plot.masts[0]!.y < plot.centre.y, true);
  assert.equal(Math.round(plot.masts[0]!.x), plot.centre.x);
});

test('a mast beyond the ring is pinned to the edge, not dropped', () => {
  // "The nearest mast is off this plot" is the most useful thing the drawing
  // can say about a customer with no signal.
  const plot = plotMasts({
    premises: { latitude: 51.5, longitude: -0.12 },
    masts: [mast({ distanceMetres: 4000 })],
    radiusMetres: 1000,
  })!;
  assert.equal(plot.masts[0]!.clamped, true);
  assert.equal(plot.anyClamped, true);
});

test('no coordinates plots nothing, and says so', () => {
  assert.equal(plotMasts({ premises: {}, masts: [mast({})] }), null);
  assert.match(plotCaption(null), /No coordinates/);
});

test('an empty plot says crowdsourced, not "no masts"', () => {
  // OpenCelliD is handset reports. An empty plot means nobody has reported
  // one, which is not the same as there being none.
  const plot = plotMasts({ premises: { latitude: 51.5, longitude: -0.12 }, masts: [] })!;
  assert.match(plotCaption(plot), /nobody has reported one/);
});

test('the caption gives the nearest mast, its direction and the exchange', () => {
  const plot = plotMasts({
    premises: { latitude: 51.5, longitude: -0.12 },
    masts: [mast({ latitude: 51.503, longitude: -0.12, distanceMetres: 330, operator: 'EE' })],
  })!;
  const caption = plotCaption(plot, 1400);
  assert.match(caption, /330 m to the N/);
  assert.match(caption, /EE/);
  assert.match(caption, /exchange 1\.4 km/);
  assert.match(caption, /approximate/);
});

test('masts are ordered nearest first', () => {
  const plot = plotMasts({
    premises: { latitude: 51.5, longitude: -0.12 },
    masts: [mast({ distanceMetres: 900 }), mast({ distanceMetres: 120 }), mast({ distanceMetres: 400 })],
  })!;
  assert.deepEqual(plot.masts.map((m) => m.distance), [120, 400, 900]);
});

test('distances read as metres or kilometres, whichever a person would say', () => {
  assert.equal(formatMetres(330), '330 m');
  assert.equal(formatMetres(1400), '1.4 km');
  assert.equal(formatMetres(24_000), '24 km');
  assert.match(formatMetres(NaN), /unknown/);
});

test('compass points are the ones people use', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(45), 'NE');
  assert.equal(compassPoint(181), 'S');
  assert.equal(compassPoint(359), 'N');
});

test('our distance agrees with a known one', () => {
  // Sanity check on the sphere maths: a hundredth of a degree of latitude is
  // about 1.11 km anywhere.
  const d = metresBetween({ latitude: 51.5, longitude: -0.12 }, { latitude: 51.51, longitude: -0.12 });
  assert.ok(d > 1100 && d < 1120, `${d}`);
});
