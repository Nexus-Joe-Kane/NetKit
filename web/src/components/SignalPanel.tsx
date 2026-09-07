import type { ReactElement } from 'react';
import { gradeScore, type MobileCoverage, type SignalGrade, type SignalReport } from '@sw/shared';
import { Card, Chip, Label, formatDate } from './ui';

/**
 * Mobile signal, one card per network.
 *
 * Indoor is shown alongside outdoor for every service, because indoor is the
 * number that actually decides whether a site needs Wi-Fi calling or a
 * repeater — and it is the one a coverage checker usually buries.
 */

/** Four pips, filled to the grade, coloured by how good that grade is. */
function Grade({ grade }: { grade: SignalGrade }): ReactElement {
  const score = gradeScore(grade); // 0 unknown … 5 excellent
  const filled = Math.max(0, score - 1); // none → 0 pips, excellent → 4
  const tone = filled >= 3 ? 'on' : filled === 2 ? 'on-weak' : 'on-bad';

  return (
    <span className="grade">
      <span className="grade__pips" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`grade__pip${i < filled ? ` grade__pip--${tone}` : ''}`} />
        ))}
      </span>
      <span className="grade__text">{grade === 'unknown' ? '—' : grade}</span>
    </span>
  );
}

function OperatorCard({ coverage }: { coverage: MobileCoverage }): ReactElement {
  const best = gradeScore(coverage.voice.indoor);
  const tone = best >= 4 ? 'ok' : best >= 3 ? 'info' : best >= 2 ? 'warn' : 'crit';

  return (
    <div className="operator">
      <div className="operator__head">
        <span className="operator__name">{coverage.operator}</span>
        <span className="grow" />
        <Chip tone={tone} dot>
          {coverage.voice.indoor === 'unknown' ? 'unknown' : `${coverage.voice.indoor} indoors`}
        </Chip>
      </div>

      <div className="operator__body">
        <div className="grade-row">
          <Label>Service</Label>
          <Label>Indoors</Label>
          <Label>Outdoors</Label>
        </div>

        <div className="grade-row">
          <span style={{ fontSize: 12.5, color: 'var(--sw-ink)' }}>Voice</span>
          <Grade grade={coverage.voice.indoor} />
          <Grade grade={coverage.voice.outdoor} />
        </div>

        <div className="grade-row">
          <span style={{ fontSize: 12.5, color: 'var(--sw-ink)' }}>4G data</span>
          <Grade grade={coverage.data4g.indoor} />
          <Grade grade={coverage.data4g.outdoor} />
        </div>

        {coverage.data5g && (
          <div className="grade-row">
            <span style={{ fontSize: 12.5, color: 'var(--sw-ink)' }}>5G data</span>
            <Grade grade={coverage.data5g.indoor} />
            <Grade grade={coverage.data5g.outdoor} />
          </div>
        )}

        <div className="row" style={{ gap: 6, marginTop: 2 }}>
          {coverage.volte && <Chip tone="idle">VoLTE</Chip>}
          {coverage.wifiCalling && <Chip tone="idle">Wi-Fi calling</Chip>}
          {!coverage.data5g && <Chip tone="idle">No 5G</Chip>}
        </div>

        {coverage.nearestSite?.distanceMetres != null && (
          <div style={{ fontSize: 12 }}>
            <Label>Nearest mast</Label>{' '}
            <span className="sw-mono">{coverage.nearestSite.distanceMetres.toLocaleString('en-GB')} m</span>
            {coverage.nearestSite.technologies?.length ? (
              <span className="muted"> · {coverage.nearestSite.technologies.join(', ')}</span>
            ) : null}
          </div>
        )}

        {coverage.bands?.length ? (
          <div style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            <Label>Bands</Label>
            <div className="muted sw-mono">{coverage.bands.join(' · ')}</div>
          </div>
        ) : null}

        {coverage.mvnos?.length ? (
          <div style={{ fontSize: 11.5 }}>
            <Label>Also carries</Label>
            <div className="muted">{coverage.mvnos.join(', ')}</div>
          </div>
        ) : null}

        {coverage.plannedUpgrade && (
          <div className="flag flag--info" style={{ marginTop: 2 }}>
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>Upgrade planned</strong>
              <span className="flag__detail">
                {coverage.plannedUpgrade.technology}
                {coverage.plannedUpgrade.date ? ` from ${formatDate(coverage.plannedUpgrade.date)}` : ''}
              </span>
            </span>
          </div>
        )}

        {coverage.notes.map((note, i) => (
          <p key={i} className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
            {note}
          </p>
        ))}
      </div>
    </div>
  );
}

export function SignalPanel({ data }: { data: SignalReport }): ReactElement {
  const ranked = [...data.operators].sort((a, b) => gradeScore(b.voice.indoor) - gradeScore(a.voice.indoor));

  return (
    <div className="stack">
      <Card
        title="Mobile coverage by network"
        eyebrow={`Checked ${formatDate(data.checkedAt) ?? 'just now'}`}
        accent={4}
        meta={
          data.headline?.bestIndoorVoice ? (
            <Chip tone="ok" dot>
              Best indoors: {data.headline.bestIndoorVoice}
            </Chip>
          ) : undefined
        }
      >
        <div className="signal-grid">
          {ranked.map((coverage) => (
            <OperatorCard key={coverage.operator} coverage={coverage} />
          ))}
        </div>
        <p className="muted" style={{ marginTop: 14, marginBottom: 0, fontSize: 12, lineHeight: 1.55 }}>
          Indoor grades are modelled from outdoor coverage with a building penetration allowance, so they are a guide
          rather than a measurement. A site that reads strong outdoors but weak indoors is usually solved with Wi-Fi
          calling before a repeater.
        </p>
      </Card>
    </div>
  );
}
