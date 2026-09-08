import type { ReactElement } from 'react';
import { useState } from 'react';
import { gradeScore, type MobileCoverage, type MobileOperator, type SignalGrade, type SignalReport } from '@sw/shared';
import { Card, Cell, Chip, Label, formatDate } from './ui';
import { Tabs, TabPanel, type TabDef } from './Tabs';

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

type SignalTab = 'all' | MobileOperator;

export function SignalPanel({ data }: { data: SignalReport }): ReactElement {
  const [tab, setTab] = useState<SignalTab>('all');
  const ranked = [...data.operators].sort((a, b) => gradeScore(b.voice.indoor) - gradeScore(a.voice.indoor));

  const tabs: Array<TabDef<SignalTab>> = [
    { id: 'all', label: 'All networks', count: ranked.length },
    ...ranked.map((c) => ({
      id: c.operator as SignalTab,
      label: c.operator,
      // A network with no usable indoor voice is worth flagging on the tab.
      ...(gradeScore(c.voice.indoor) <= gradeScore('poor') ? { tone: 'crit' as const } : {}),
    })),
  ];

  const selected = tab === 'all' ? null : ranked.find((c) => c.operator === tab);

  return (
    <Card
      title="Mobile coverage"
      eyebrow="At this premises"
      index="03"
      accent={4}
      meta={
        data.headline?.bestIndoorVoice ? (
          <Chip tone="ok" dot>
            Best indoors: {data.headline.bestIndoorVoice}
          </Chip>
        ) : undefined
      }
      tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Mobile networks" />}
    >
      <TabPanel>
        {selected ? (
          <OperatorDetail coverage={selected} />
        ) : (
          <>
            <div className="signal-grid">
              {ranked.map((coverage) => (
                <OperatorCard key={coverage.operator} coverage={coverage} />
              ))}
            </div>
            <p className="muted" style={{ marginTop: 14, marginBottom: 0, fontSize: 12, lineHeight: 1.55 }}>
              Indoor grades are modelled from outdoor coverage with a building penetration allowance, so they are a
              guide rather than a measurement. A site that reads strong outdoors but weak indoors is usually solved
              with Wi-Fi calling before a repeater.
            </p>
          </>
        )}
      </TabPanel>
    </Card>
  );
}

/** The single-network view: everything the provider told us, laid out flat. */
function OperatorDetail({ coverage }: { coverage: MobileCoverage }): ReactElement {
  const grade = (g: SignalGrade) => (g === 'unknown' ? undefined : g);

  return (
    <div className="stack stack--tight">
      <div className="kv">
        <Cell label="Voice indoors" value={grade(coverage.voice.indoor)} />
        <Cell label="Voice outdoors" value={grade(coverage.voice.outdoor)} />
        <Cell label="Voice in vehicle" value={grade(coverage.voice.inVehicle ?? 'unknown')} />
        <Cell label="4G indoors" value={grade(coverage.data4g.indoor)} />
        <Cell label="4G outdoors" value={grade(coverage.data4g.outdoor)} />
        <Cell label="5G indoors" value={grade(coverage.data5g?.indoor ?? 'unknown')} />
        <Cell label="5G outdoors" value={grade(coverage.data5g?.outdoor ?? 'unknown')} />
        <Cell label="VoLTE" value={coverage.volte} />
        <Cell label="Wi-Fi calling" value={coverage.wifiCalling} />
        <Cell
          label="Nearest mast"
          value={
            coverage.nearestSite?.distanceMetres != null
              ? `${coverage.nearestSite.distanceMetres.toLocaleString('en-GB')} m`
              : undefined
          }
          mono
        />
        <Cell label="Mast bearing" value={coverage.nearestSite?.bearingDegrees != null ? `${coverage.nearestSite.bearingDegrees}°` : undefined} mono />
        <Cell label="Mast technologies" value={coverage.nearestSite?.technologies?.join(', ')} />
      </div>

      {coverage.bands?.length ? (
        <div>
          <Label>Frequency bands present</Label>
          <div className="row" style={{ gap: 5, marginTop: 6 }}>
            {coverage.bands.map((band) => (
              <Chip key={band} tone="idle">
                {band}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      {coverage.mvnos?.length ? (
        <div>
          <Label>Retail brands on this network</Label>
          <div className="row" style={{ gap: 5, marginTop: 6 }}>
            {coverage.mvnos.map((mvno) => (
              <Chip key={mvno} tone="info">
                {mvno}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      {coverage.plannedUpgrade && (
        <div className="flag flag--info">
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
        <div key={i} className="flag flag--warn">
          <span className="flag__marker" aria-hidden="true" />
          <span className="flag__detail">{note}</span>
        </div>
      ))}
    </div>
  );
}
