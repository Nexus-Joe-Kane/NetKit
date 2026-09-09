/**
 * Chart geometry, as arithmetic.
 *
 * No charting library. Three reasons, in order of how much they matter.
 *
 * The charts here are small and fixed: a usage bar, a stability sparkline, a
 * ranked list. A library that draws anything is a hundred kilobytes to draw
 * three shapes, and every one of them would still need this much code to
 * decide what the shapes mean.
 *
 * Nothing in this application has a runtime dependency it does not need, and
 * a chart that fails to render because a CDN is having a bad afternoon is a
 * chart on a page an engineer is using to fix an outage.
 *
 * And the interesting part of a chart is never the drawing. It is what
 * counts as a gap, what counts as an outlier, and what to do when there is
 * one data point — and those are decisions worth testing rather than
 * configuring.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Series {
  /** Ordered oldest first. */
  points: Array<{ at: string; value: number }>;
  label?: string;
}

/* ------------------------------------------------------------------ *
 * Sparklines
 * ------------------------------------------------------------------ */

export interface SparkOptions {
  width: number;
  height: number;
  /** Space for the stroke, so a line at the maximum is not clipped. */
  padding?: number;
  /** Force the vertical scale rather than reading it from the data. */
  min?: number;
  max?: number;
}

export interface Spark {
  /** An SVG path, or an empty string where there is nothing to draw. */
  path: string;
  /** The same points, for dots and hit areas. */
  points: Point[];
  min: number;
  max: number;
  /** True where every value is identical, so the line is deliberately flat. */
  flat: boolean;
}

/**
 * A sparkline path.
 *
 * The two cases worth stating. A single point draws a dot rather than a
 * path, because a one-point line is invisible and reads as no data. And a
 * flat series is drawn through the vertical middle rather than at the bottom
 * — a line of 100% uptime pinned to the floor of the chart looks exactly
 * like a line of zeroes.
 */
export function sparkline(series: Series, options: SparkOptions): Spark {
  const values = series.points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (!values.length) return { path: '', points: [], min: 0, max: 0, flat: true };

  const pad = options.padding ?? 2;
  const w = Math.max(1, options.width - pad * 2);
  const h = Math.max(1, options.height - pad * 2);

  const dataMin = options.min ?? Math.min(...values);
  const dataMax = options.max ?? Math.max(...values);
  const flat = dataMax === dataMin;

  const scaleY = (value: number): number => {
    if (flat) return pad + h / 2;
    return pad + h - ((value - dataMin) / (dataMax - dataMin)) * h;
  };

  const points: Point[] = values.map((value, i) => ({
    x: pad + (values.length === 1 ? w / 2 : (i / (values.length - 1)) * w),
    y: scaleY(value),
  }));

  const path =
    points.length === 1
      ? ''
      : points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ');

  return { path, points, min: dataMin, max: dataMax, flat };
}

const round = (n: number): number => Math.round(n * 10) / 10;

/**
 * An area path under a line, for a filled sparkline.
 *
 * Returned separately so a caller can fill without stroking or the other way
 * round, and empty where a line would be — a filled area under one point is
 * a rectangle that means nothing.
 */
export function sparkArea(spark: Spark, options: SparkOptions): string {
  if (spark.points.length < 2) return '';
  const pad = options.padding ?? 2;
  const floor = options.height - pad;
  const first = spark.points[0]!;
  const last = spark.points[spark.points.length - 1]!;
  return `${spark.path} L${round(last.x)} ${round(floor)} L${round(first.x)} ${round(floor)} Z`;
}

/* ------------------------------------------------------------------ *
 * Usage against an allowance
 * ------------------------------------------------------------------ */

export type UsageVerdict = 'fine' | 'watch' | 'close' | 'over';

/**
 * How much of an allowance is gone, and whether that is a problem *yet*.
 *
 * The pace matters more than the number, which is the whole reason this is
 * not just a percentage. Eighty per cent used on the twenty-eighth of the
 * month is fine; eighty per cent on the fourth is a bill nobody has budgeted
 * for. So the verdict compares how much is gone against how much of the
 * period has passed.
 */
export function usageVerdict(input: {
  usedPercent?: number;
  /** 0..1 through the billing period, where it is known. */
  periodElapsed?: number;
}): { verdict: UsageVerdict; because: string } {
  const used = input.usedPercent;
  if (used === undefined || !Number.isFinite(used)) {
    return { verdict: 'fine', because: 'No usage figure was reported.' };
  }
  if (used >= 100) {
    return { verdict: 'over', because: 'The allowance is gone. Anything further is charged as an overage.' };
  }

  const elapsed = input.periodElapsed;
  if (elapsed === undefined || elapsed <= 0) {
    // No sense of pace, so fall back to the flat thresholds. Stated, because
    // "90% used" with three days left is a different fact from "90% used"
    // with three weeks left and this cannot tell them apart.
    const verdict: UsageVerdict = used >= 90 ? 'close' : used >= 75 ? 'watch' : 'fine';
    return {
      verdict,
      because: `${Math.round(used)}% of the allowance is used. How far through the billing period they are is not known.`,
    };
  }

  const pace = used / (elapsed * 100);
  if (pace >= 1.5) {
    return {
      verdict: 'close',
      because:
        `${Math.round(used)}% used with ${Math.round((1 - elapsed) * 100)}% of the period left — running at ` +
        `${pace.toFixed(1)}× the rate that would just reach the allowance.`,
    };
  }
  if (pace >= 1.15) {
    return {
      verdict: 'watch',
      because: `${Math.round(used)}% used, a little ahead of the period. Worth a look before month end.`,
    };
  }
  return { verdict: 'fine', because: `${Math.round(used)}% used, in line with the period.` };
}

/* ------------------------------------------------------------------ *
 * Stability
 * ------------------------------------------------------------------ */

/**
 * Drops per day, as bars.
 *
 * Days with no drops are included as zeroes rather than skipped, which is
 * the point: a gap in the bars would read as a quiet day, and a line that
 * dropped forty times on Tuesday and nothing since looks identical to one
 * dropping steadily unless the empty days are drawn.
 */
export function dailyBars(input: {
  drops: ReadonlyArray<{ at: string }>;
  from: string;
  to: string;
}): Array<{ date: string; drops: number }> {
  const start = Date.parse(input.from);
  const end = Date.parse(input.to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const DAY = 24 * 60 * 60 * 1000;
  const days = Math.min(120, Math.floor((end - start) / DAY) + 1);

  const counts = new Map<string, number>();
  for (let i = 0; i < days; i += 1) {
    counts.set(new Date(start + i * DAY).toISOString().slice(0, 10), 0);
  }

  for (const drop of input.drops) {
    const key = (drop.at ?? '').slice(0, 10);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()].map(([date, drops]) => ({ date, drops }));
}

/**
 * The worst day in a set of bars, for a caption.
 *
 * A chart without a number next to it makes somebody count bars.
 */
export function worstDay(bars: ReadonlyArray<{ date: string; drops: number }>): { date: string; drops: number } | undefined {
  const worst = [...bars].sort((a, b) => b.drops - a.drops || a.date.localeCompare(b.date))[0];
  return worst && worst.drops > 0 ? worst : undefined;
}

/* ------------------------------------------------------------------ *
 * Ranked lists
 * ------------------------------------------------------------------ */

/**
 * Bars for a ranked comparison, scaled to the biggest.
 *
 * Scaled to the maximum rather than to a round number, because the question
 * a provider ranking answers is relative — who is worst here — and a bar
 * chart scaled to 100 when the worst is 12 is four rows of nothing.
 */
export function rankedBars<T>(
  rows: readonly T[],
  value: (row: T) => number,
  label: (row: T) => string,
): Array<{ label: string; value: number; percent: number }> {
  const scored = rows.map((row) => ({ label: label(row), value: value(row) }));
  const max = Math.max(0, ...scored.map((s) => s.value));
  return scored
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .map((s) => ({ ...s, percent: max > 0 ? Math.round((s.value / max) * 100) : 0 }));
}
