import type { ReactElement } from 'react';
import {
  compassPoint,
  formatMetres,
  plotCaption,
  rankedBars,
  sparkArea,
  sparkline,
  usageVerdict,
  worstDay,
  type MastPlot,
  type Series,
} from '@sw/shared';

/**
 * Charts, as inline SVG.
 *
 * No charting library, and no canvas. These are small fixed shapes, and
 * inline SVG means they are in the DOM: they print, they scale, they inherit
 * the brand colours, they survive a screenshot into a ticket, and a
 * screen reader can be given a real description rather than "image".
 *
 * Every one of them says its own number in words underneath. A chart with no
 * figure next to it makes somebody estimate from pixels, and an engineer
 * reading a fault at seven in the morning should not have to.
 */

const TONE: Record<string, string> = {
  fine: 'var(--sw-ok)',
  watch: 'var(--sw-amber-ink)',
  close: 'var(--sw-crit)',
  over: 'var(--sw-crit)',
};

/* ------------------------------------------------------------------ *
 * A line over time
 * ------------------------------------------------------------------ */

export function Sparkline({
  series,
  label,
  width = 220,
  height = 48,
  tone = 'var(--sw-series-1)',
  caption,
}: {
  series: Series;
  label: string;
  width?: number;
  height?: number;
  tone?: string;
  caption?: string;
}): ReactElement {
  const opts = { width, height, padding: 3 };
  const spark = sparkline(series, opts);

  if (!spark.points.length) {
    return (
      <div className="chart">
        <span className="chart__label">{label}</span>
        <p className="chart__empty">Nothing reported for this period.</p>
      </div>
    );
  }

  const area = sparkArea(spark, opts);

  return (
    <div className="chart">
      <span className="chart__label">{label}</span>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="chart__svg"
        role="img"
        aria-label={`${label}. ${caption ?? `${series.points.length} readings between ${spark.min} and ${spark.max}.`}`}
      >
        {area && <path d={area} fill={tone} opacity={0.12} />}
        {spark.path && <path d={spark.path} fill="none" stroke={tone} strokeWidth={1.75} strokeLinejoin="round" />}
        {/* The last reading gets a dot: it is the one somebody is looking for. */}
        <circle
          cx={spark.points[spark.points.length - 1]!.x}
          cy={spark.points[spark.points.length - 1]!.y}
          r={2.75}
          fill={tone}
        />
      </svg>
      <span className="chart__caption">
        {caption ??
          (spark.flat
            ? `Flat at ${spark.max} across ${series.points.length} readings.`
            : `${spark.min} to ${spark.max} across ${series.points.length} readings.`)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Usage against an allowance
 * ------------------------------------------------------------------ */

export function UsageBar({
  usedPercent,
  periodElapsed,
  label = 'Allowance used',
}: {
  usedPercent?: number;
  periodElapsed?: number;
  label?: string;
}): ReactElement {
  const { verdict, because } = usageVerdict({
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(periodElapsed === undefined ? {} : { periodElapsed }),
  });
  const filled = Math.min(100, Math.max(0, usedPercent ?? 0));

  return (
    <div className="chart">
      <span className="chart__label">{label}</span>
      <div className="usage" role="img" aria-label={`${label}. ${because}`}>
        <div className="usage__track">
          <div className="usage__fill" style={{ width: `${filled}%`, background: TONE[verdict] }} />
          {/*
            Where the period has got to, as a marker on the bar. It is the
            comparison that makes the number mean anything: 80% used is fine
            at month end and a problem on the fourth.
          */}
          {periodElapsed !== undefined && periodElapsed > 0 && periodElapsed < 1 && (
            <div className="usage__pace" style={{ left: `${periodElapsed * 100}%` }} aria-hidden="true" />
          )}
        </div>
        <span className="usage__figure">{usedPercent === undefined ? '—' : `${Math.round(usedPercent)}%`}</span>
      </div>
      <span className="chart__caption">{because}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Drops per day
 * ------------------------------------------------------------------ */

export function StabilityBars({
  bars,
  label = 'Drops per day',
}: {
  bars: ReadonlyArray<{ date: string; drops: number }>;
  label?: string;
}): ReactElement {
  if (!bars.length) {
    return (
      <div className="chart">
        <span className="chart__label">{label}</span>
        <p className="chart__empty">No stability history for this line.</p>
      </div>
    );
  }

  const worst = worstDay(bars);
  const max = Math.max(1, ...bars.map((b) => b.drops));

  return (
    <div className="chart">
      <span className="chart__label">{label}</span>
      <div
        className="bars"
        role="img"
        aria-label={
          worst
            ? `${label}. Worst day ${worst.date} with ${worst.drops} drops across ${bars.length} days.`
            : `${label}. No drops across ${bars.length} days.`
        }
      >
        {bars.map((bar) => (
          <span
            key={bar.date}
            className={`bars__bar${bar.drops === 0 ? ' bars__bar--empty' : ''}`}
            style={{ height: `${Math.max(bar.drops === 0 ? 2 : 8, (bar.drops / max) * 100)}%` }}
            title={`${bar.date}: ${bar.drops} drop${bar.drops === 1 ? '' : 's'}`}
          />
        ))}
      </div>
      <span className="chart__caption">
        {worst
          ? `Worst day ${worst.date}, ${worst.drops} drop${worst.drops === 1 ? '' : 's'}. ${bars.length} days shown.`
          : `No drops in ${bars.length} days.`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A ranked comparison
 * ------------------------------------------------------------------ */

export function RankedBars<T>({
  rows,
  value,
  label: rowLabel,
  title,
  unit = '',
}: {
  rows: readonly T[];
  value: (row: T) => number;
  label: (row: T) => string;
  title: string;
  unit?: string;
}): ReactElement {
  const bars = rankedBars(rows, value, rowLabel);
  if (!bars.length) {
    return (
      <div className="chart">
        <span className="chart__label">{title}</span>
        <p className="chart__empty">Nothing to compare yet.</p>
      </div>
    );
  }

  return (
    <div className="chart">
      <span className="chart__label">{title}</span>
      <div className="ranked">
        {bars.map((bar) => (
          <div key={bar.label} className="ranked__row">
            <span className="ranked__name">{bar.label}</span>
            <span className="ranked__track">
              <span className="ranked__fill" style={{ width: `${bar.percent}%` }} />
            </span>
            <span className="ranked__value">
              {bar.value}
              {unit}
            </span>
          </div>
        ))}
      </div>
      <span className="chart__caption">Scaled to the highest, not to a round number, so the comparison is visible.</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The locked mast plot
 * ------------------------------------------------------------------ */

/**
 * Where the masts are, relative to the premises.
 *
 * A drawing rather than a street map, and locked rather than pannable. The
 * question is about distance and direction — "why has this customer no
 * signal when the area is fine" — and a radial plot at a stated scale
 * answers it at a glance where a street map buries it. It also needs no tile
 * server, no key, and no third-party request from a page somebody is using
 * to fix an outage.
 */
export function MastMap({
  plot,
  exchangeMetres,
  label = 'What is nearby',
}: {
  plot: MastPlot | null;
  exchangeMetres?: number;
  label?: string;
}): ReactElement {
  const caption = plotCaption(plot, exchangeMetres);

  if (!plot) {
    return (
      <div className="chart">
        <span className="chart__label">{label}</span>
        <p className="chart__empty">{caption}</p>
      </div>
    );
  }

  const { size, centre, rings, masts } = plot;

  return (
    <div className="chart">
      <span className="chart__label">{label}</span>
      <svg viewBox={`0 0 ${size} ${size}`} className="mastmap" role="img" aria-label={`${label}. ${caption}`}>
        {rings.map((ring) => (
          <g key={ring.radius}>
            <circle cx={centre.x} cy={centre.y} r={ring.radius} className="mastmap__ring" />
            {/* The scale, written on the ring rather than in a legend. */}
            <text x={centre.x + 3} y={centre.y - ring.radius + 10} className="mastmap__scale">
              {formatMetres(ring.metres)}
            </text>
          </g>
        ))}

        {/* North, so the plot can be read without a compass rose. */}
        <text x={centre.x} y={11} className="mastmap__north" textAnchor="middle">N</text>

        {masts.map((m, i) => (
          <g key={`${m.mast.cellId ?? i}-${m.bearing}`}>
            <line x1={centre.x} y1={centre.y} x2={m.x} y2={m.y} className="mastmap__ray" />
            <circle
              cx={m.x}
              cy={m.y}
              r={m.clamped ? 3 : 4.5}
              className={`mastmap__mast${m.clamped ? ' mastmap__mast--beyond' : ''}`}
            />
          </g>
        ))}

        <circle cx={centre.x} cy={centre.y} r={5} className="mastmap__here" />
      </svg>

      <span className="chart__caption">{caption}</span>

      {masts.length > 0 && (
        <ul className="mastlist">
          {masts.slice(0, 5).map((m, i) => (
            <li key={`${m.mast.cellId ?? i}-list`}>
              <span className="mastlist__what">
                {m.mast.operator ?? m.mast.networkCode ?? 'Unknown network'}
                {m.mast.radio ? ` · ${m.mast.radio}` : ''}
              </span>
              <span className="mastlist__where">
                {formatMetres(m.distance)} {compassPoint(m.bearing)}
                {m.clamped ? ' (beyond the plot)' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
