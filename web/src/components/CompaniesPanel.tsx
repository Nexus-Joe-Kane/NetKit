import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  companyRiskFlags,
  summariseRisks,
  type CompanyContext,
  type CompanyRecord,
  type CompanyRiskFlag,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, Empty, Spinner, Switch, formatDate } from '../components/ui';
import { CompanyDetailModal, statusLabelOf } from './CompanyDetailModal';

/**
 * Who is registered at this premises.
 *
 * The panel earns its place on the days it changes the answer: a business
 * broadband fault, a cease request or a credit decision reads differently
 * when the company on the account is proposed for strike off, has not filed
 * accounts, or went into liquidation last month.
 *
 * Two defaults do most of the work here. The register indexes by postcode,
 * so a search returns everything in it — dozens of companies for a central
 * London address, most of them nothing to do with the premises on screen —
 * and the panel therefore shows the ones registered at *this* premises and
 * offers the rest behind a switch. Companies that have ceased to exist are
 * hidden the same way: a company dissolved in 2019 is history, and history
 * three rows deep is what stops somebody noticing the one in liquidation.
 *
 * Nothing is hidden irrecoverably. Both switches say how many they are
 * holding back, because a filter that does not admit what it removed is a
 * filter nobody trusts.
 */

/** Risk flags for a company, only where the register was actually read. */
function flagsFor(company: CompanyRecord): CompanyRiskFlag[] {
  // Undefined risk fields mean "not checked", not "clean" — the profile
  // fetch only runs for companies at the premises. Status-derived flags are
  // always safe, so the shared helper is given exactly what is known.
  return companyRiskFlags(company);
}

export function CompaniesPanel({ postcode, uprn }: { postcode: string; uprn?: string }): ReactElement {
  const [data, setData] = useState<(CompanyContext & { mode: 'live'; providerError?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompanyRecord | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [showPostcode, setShowPostcode] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      setLoading(true);
      try {
        const result = await api.companies(postcode, uprn);
        if (live) {
          setData(result);
          setError(null);
          // A premises with nothing registered at it should not open on an
          // empty table when the postcode has plenty — fall back to the
          // wider view rather than looking broken.
          setShowPostcode((result.atPremises ?? 0) === 0);
        }
      } catch (err) {
        if (live) setError(err instanceof ApiClientError ? err.message : 'Could not look up companies.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [postcode, uprn]);

  const all = data?.companies ?? [];
  const narrowed = data?.atPremises != null;

  const { rows, hiddenClosed, hiddenElsewhere, warned } = useMemo(() => {
    const inScope = narrowed && !showPostcode ? all.filter((c) => c.registeredHere) : all;
    const visible = showClosed ? inScope : inScope.filter((c) => !c.closed);

    // The banner speaks for what is actually on screen. Warning about a
    // company the filters have hidden is how a panel ends up contradicting
    // itself.
    const warnedRows = visible
      .map((company) => ({ company, flags: flagsFor(company) }))
      .filter((row) => row.flags.some((f) => f.severity === 'critical'));

    return {
      rows: visible,
      hiddenClosed: inScope.filter((c) => c.closed).length,
      hiddenElsewhere: narrowed ? all.filter((c) => !c.registeredHere).length : 0,
      warned: warnedRows,
    };
  }, [all, narrowed, showClosed, showPostcode]);

  const bannerFlags = warned.flatMap((row) => row.flags.filter((f) => f.severity === 'critical'));

  return (
    <>
      <Card
        title="Registered companies"
        eyebrow="Companies House"
        index="05"
        accent={3}
        flush
        meta={
          data ? (
            <>
              <Chip tone="ok" dot>Live</Chip>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {narrowed && !showPostcode ? 'at this address' : `at ${data.postcode}`}
              </span>
            </>
          ) : undefined
        }
      >
        {loading ? (
          <div style={{ padding: 18 }}>
            <Spinner label="Checking the register…" />
          </div>
        ) : error ? (
          <div style={{ padding: 18 }}>
            <Alert tone="error">{error}</Alert>
          </div>
        ) : !data || all.length === 0 ? (
          <Empty title="No registered companies">
            Nothing is registered at this postcode. That is normal for a residential premises.
          </Empty>
        ) : (
          <>
            {warned.length > 0 && (
              <div style={{ padding: '14px 18px 0' }}>
                <div className="warn-board">
                  <div className="warn-board__head">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3 2 20h20L12 3Z" />
                      <path d="M12 9v5M12 17.5v.5" />
                    </svg>
                    <span>
                      {warned.length === 1
                        ? 'One company here has '
                        : `${warned.length} companies here have `}
                      {summariseRisks(bannerFlags)}
                    </span>
                  </div>

                  <ul className="warn-board__list">
                    {warned.map(({ company, flags }) => (
                      <li key={company.companyNumber}>
                        <button type="button" className="warn-board__name" onClick={() => setDetail(company)}>
                          {company.name}
                        </button>
                        <span className="warn-board__flags">
                          {flags
                            .filter((f) => f.severity === 'critical')
                            .map((f) => (
                              <Chip key={f.kind} tone="crit">
                                {f.label}
                              </Chip>
                            ))}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <p className="warn-board__foot">
                    Do not take an order or agree credit against one of these without a person looking at it first.
                  </p>
                </div>
              </div>
            )}

            <div style={{ padding: '14px 18px 0' }}>
              <div className="kv">
                {narrowed && <Cell label="At this address" value={data.atPremises} mono />}
                <Cell label="In the postcode" value={all.length} mono />
                <Cell label="Needs a look" value={warned.length} mono />
                <Cell label="Shown below" value={rows.length} mono />
              </div>
            </div>

            <div className="company-filters">
              {(hiddenClosed > 0 || showClosed) && (
                <Filter
                  checked={showClosed}
                  onChange={setShowClosed}
                  text={
                    hiddenClosed > 0
                      ? `Show ${hiddenClosed} closed ${hiddenClosed === 1 ? 'company' : 'companies'}`
                      : 'Show closed companies'
                  }
                  hint="Dissolved, removed or struck off. Hidden by default so a live problem is not buried under history."
                />
              )}
              {narrowed && hiddenElsewhere > 0 && (
                <Filter
                  checked={showPostcode}
                  onChange={setShowPostcode}
                  text={`Show ${hiddenElsewhere} more in ${data.postcode}`}
                  hint="The register only indexes by postcode, so these are neighbours rather than this premises."
                />
              )}
            </div>

            {rows.length === 0 ? (
              <Empty title="Nothing to show with these filters">
                {hiddenClosed > 0
                  ? `Every company here has closed. Turn on "Show ${hiddenClosed} closed" to see them.`
                  : 'Nothing is registered at this exact address. Turn on the postcode view to see the rest.'}
              </Empty>
            ) : (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Number</th>
                      <th>Status</th>
                      <th>Incorporated</th>
                      <th>Registered office</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((company) => {
                      const flags = flagsFor(company);
                      const critical = flags.filter((f) => f.severity === 'critical');
                      return (
                        <tr
                          key={company.companyNumber}
                          className={`clickable${critical.length ? ' row--critical' : ''}`}
                          onClick={() => setDetail(company)}
                        >
                          <td style={{ maxWidth: 260 }}>
                            <strong style={{ color: 'var(--sw-ink)' }}>{company.name}</strong>
                            {flags.length > 0 && (
                              <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                                {flags.map((f) => (
                                  <Chip key={f.kind} tone={f.severity === 'critical' ? 'crit' : 'warn'}>
                                    {f.label}
                                  </Chip>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="sw-mono" style={{ fontSize: 12 }}>{company.companyNumber}</td>
                          <td>
                            <Chip tone={company.concerning ? 'crit' : 'ok'} dot>
                              {statusLabelOf(company.status)}
                            </Chip>
                          </td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                            {formatDate(company.incorporatedOn) ?? '—'}
                          </td>
                          <td style={{ fontSize: 12, maxWidth: 240 }}>
                            {company.registeredHere ? (
                              <Chip tone="idle" title="Registered at the premises being looked at">
                                This address
                              </Chip>
                            ) : (
                              (company.registeredOffice ?? '—')
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      <CompanyDetailModal company={detail} onClose={() => setDetail(null)} />
    </>
  );
}

/** A labelled switch. The bare `Switch` shows only On/Off. */
function Filter({
  checked,
  onChange,
  text,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  text: string;
  hint: string;
}): ReactElement {
  return (
    <div className="company-filter" title={hint}>
      <Switch checked={checked} onChange={onChange} label={text} />
      <span className="company-filter__text">{text}</span>
    </div>
  );
}
