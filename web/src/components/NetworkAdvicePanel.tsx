import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  OPERATORS,
  footfallLevel,
  ofcomCheckerUrl,
  recommendNetwork,
  type FootfallLevel,
  type MobileOperator,
  type SignalGrade,
  type SignalReport,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Chip, CopyButton, Label, Spinner } from './ui';

/**
 * Which network to put a phone on.
 *
 * Three sources, none of which answers alone: Ofcom's prediction, how far the
 * nearest mast is, and how crowded the area is. This panel says what it used,
 * what it is missing, and how much weight to put on the answer — because an
 * educated guess offered as a guess is useful and the same guess offered as a
 * fact sends an engineer to the wrong network.
 *
 * It appears only where there is something to combine. On a premises with a
 * full per-operator Ofcom answer and nothing else, the coverage grid above
 * already says it better.
 */

const GRADES: SignalGrade[] = ['unknown', 'none', 'poor', 'variable', 'good', 'excellent'];

const CONFIDENCE_TONE = { high: 'ok', medium: 'warn', low: 'idle' } as const;

const CONFIDENCE_WORD = {
  high: 'Two sources agree',
  medium: 'Worth acting on, worth testing',
  low: 'A starting point, not an answer',
} as const;

export function NetworkAdvicePanel({ report }: { report: SignalReport }): ReactElement | null {
  /*
   * What the engineer read off Ofcom's public checker.
   *
   * Kept in the component rather than saved: it is one person's reading of a
   * third-party page at a moment in time, and persisting it would turn a note
   * into a record that later looks like data we hold.
   */
  const [typed, setTyped] = useState<Partial<Record<MobileOperator, SignalGrade>>>({});
  const [entering, setEntering] = useState(false);

  /*
   * Footfall, fetched only when this panel is on screen.
   *
   * London-only and a paid BT product, so it is not part of every site
   * report. Crowding is the piece that decides how much weight mast distance
   * deserves, which is why it is worth one request here.
   */
  const [footfall, setFootfall] = useState<FootfallLevel | undefined>();
  const [footfallBusy, setFootfallBusy] = useState(false);
  const [footfallNote, setFootfallNote] = useState<string | null>(null);

  const postcode = report.address.postcode;

  /*
   * Crowding only matters for weighing mast distance, so there is no point
   * paying BT for it when there are no masts to weigh. Location Insights is a
   * paid product and this panel is on every mobile tab — without this guard
   * it would be a chargeable request per page view for a figure that could
   * not change the answer.
   */
  const footfallWorthAsking = (report.masts?.length ?? 0) > 0;

  useEffect(() => {
    if (!footfallWorthAsking) {
      setFootfall(undefined);
      setFootfallNote(null);
      return;
    }
    let live = true;
    setFootfallBusy(true);
    setFootfall(undefined);
    setFootfallNote(null);
    void (async () => {
      try {
        const result = await api.footfall(postcode);
        if (!live) return;
        if (result.outOfArea) {
          setFootfallNote('Outside the London footfall product, so crowding is unknown here.');
          return;
        }
        // Daily average across whatever window BT returned.
        const series = result.series ?? [];
        const average = series.length
          ? series.reduce((total, point) => total + point.visitors, 0) / series.length
          : undefined;
        setFootfall(footfallLevel(average));
      } catch (err) {
        if (live) {
          setFootfallNote(
            err instanceof ApiClientError && err.code === 'not_configured'
              ? 'BT Location Insights is not connected, so crowding is unknown.'
              : 'Footfall could not be read, so crowding is unknown.',
          );
        }
      } finally {
        if (live) setFootfallBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [postcode, footfallWorthAsking]);

  const advice = useMemo(
    () =>
      recommendNetwork({
        ...(report.operators.length ? { coverage: report.operators } : {}),
        ...(Object.keys(typed).length ? { manualGrades: typed } : {}),
        ...(report.masts?.length ? { masts: report.masts } : {}),
        ...(footfall ? { footfall } : {}),
        ...(report.areaCoverage && report.operators.length === 0 ? { areaOnly: true } : {}),
      }),
    [report.operators, report.masts, report.areaCoverage, typed, footfall],
  );

  // Nothing to combine: no prediction and no masts. The panel would be a
  // heading over an apology.
  if (!advice.best && advice.ranked.every((r) => r.score == null && r.nearestMastMetres == null)) {
    return null;
  }

  /*
   * Whether to offer Ofcom's own checker.
   *
   * Only when this premises has no per-operator prediction of its own — the
   * area file is in use, or nothing answered. With a real per-operator answer
   * in hand, sending somebody to a third-party page to retype what we already
   * know is busywork.
   */
  const onBackupData = report.operators.length === 0;
  const needsChecker = onBackupData;

  return (
    <div className="advice">
      <div className="advice__head">
        <div>
          <Label>Which network to try</Label>
          <div className="advice__verdict">
            {advice.best ? (
              <>
                <strong>{advice.best}</strong>
                <Chip tone={CONFIDENCE_TONE[advice.confidence]} dot>
                  {CONFIDENCE_WORD[advice.confidence]}
                </Chip>
              </>
            ) : (
              <span className="muted">Not enough to call it</span>
            )}
          </div>
        </div>

        {footfallBusy && <Spinner label="Checking how busy this area is" />}
      </div>

      <ul className="advice__reasons">
        {advice.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <div className="advice__grid">
        {advice.ranked.map((row) => (
          <div key={row.operator} className={`advice__op${row.operator === advice.best ? ' advice__op--best' : ''}`}>
            <span className="advice__op-name">{row.operator}</span>
            <span className="advice__op-fact">
              {row.grade && row.grade !== 'unknown' ? row.grade : 'no prediction'}
            </span>
            <span className="advice__op-fact">
              {row.nearestMastMetres == null
                ? 'no site recorded'
                : row.nearestMastMetres >= 1000
                  ? `${(row.nearestMastMetres / 1000).toFixed(1)} km away`
                  : `${Math.round(row.nearestMastMetres)} m away`}
              {/* The mast note the engineer asked for, right beside the
                  distance it is about. */}
              {advice.mastSuggestion?.operator === row.operator && (
                <Chip tone="warn" title="Nearer than the operator the prediction favours">
                  nearest site
                </Chip>
              )}
              {advice.closeCall?.operators.includes(row.operator) && advice.closeCall.settledBy === 'masts' && (
                <Chip tone="idle" title={`Within 5 points of ${advice.closeCall.operators.join(' and ')}`}>
                  too close to call on prediction
                </Chip>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="advice__sources">
        <span>
          <strong>Using:</strong> {advice.sourcesUsed.length ? advice.sourcesUsed.join(' · ') : 'nothing yet'}
        </span>
        {footfallNote && <span className="muted">{footfallNote}</span>}
      </div>

      {advice.missing.length > 0 && (
        <ul className="advice__missing">
          {advice.missing.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      )}

      {/* The route out of the backup-data case: Ofcom's own checker is
          per-operator, so reading it turns a ranking we cannot make into one
          we can.

          Offered only when we are on backup data or have no prediction at
          all. Where a real per-operator answer already exists, sending
          somebody to a third-party page to retype it is noise. */}
      {needsChecker && (
        <>
      <div className="advice__actions">
        <a className="btn btn--ghost btn--small" href={ofcomCheckerUrl(postcode)} target="_blank" rel="noreferrer">
          Open Ofcom’s coverage checker ↗
        </a>
        <CopyButton value={postcode} label="Copy postcode" />
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setEntering((v) => !v)}>
          {entering ? 'Hide' : 'Enter what it showed'}
        </button>
      </div>

      <p className="advice__hint">
        The checker may not accept the postcode from a link, so it is on your clipboard ready to paste. Its answer
        is per-network, which is what the Connected Nations file cannot give — enter the four ratings and this
        recommendation is built from them instead.
      </p>

        </>
      )}

      {entering && (
        <div className="advice__entry">
          {OPERATORS.map((operator) => (
            <label key={operator} className="field" style={{ marginBottom: 0 }}>
              <Label>{operator}</Label>
              <select
                className="field__input"
                value={typed[operator] ?? 'unknown'}
                onChange={(e) => setTyped({ ...typed, [operator]: e.target.value as SignalGrade })}
              >
                {GRADES.map((grade) => (
                  <option key={grade} value={grade}>
                    {grade === 'unknown' ? 'not entered' : grade}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {Object.keys(typed).length > 0 && (
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setTyped({})}>
              Clear
            </button>
          )}
        </div>
      )}

      {Object.values(typed).some((g) => g && g !== 'unknown') && (
        <Alert tone="info">
          This recommendation now uses what you entered from Ofcom’s checker, not our own data. It is not saved —
          reopening this premises starts again.
        </Alert>
      )}
    </div>
  );
}
