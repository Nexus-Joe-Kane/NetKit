import { useEffect, useState, type ReactElement } from 'react';
import type { CompanyDetail, CompanyRecord } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, Empty, Label, Spinner, formatDate } from './ui';
import { Modal } from './overlay';
import { Tabs, type TabDef } from './Tabs';

/**
 * One company, in full.
 *
 * The list panel answers "who is here and are they trading". This answers
 * everything that follows, and it exists so nobody has to open the Companies
 * House website in the middle of a call: who can authorise a cease, who
 * actually owns the business, whether the accounts are late, whether a bank
 * holds a charge over the assets, and who the liquidator is.
 *
 * Fetched when the modal opens rather than with the list. The register is six
 * separate resources per company and the list can hold forty of them.
 */

type Tab = 'overview' | 'officers' | 'ownership' | 'filings' | 'charges' | 'insolvency';

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  dissolved: 'Dissolved',
  liquidation: 'In liquidation',
  receivership: 'In receivership',
  administration: 'In administration',
  'voluntary-arrangement': 'Voluntary arrangement',
  'insolvency-proceedings': 'Insolvency proceedings',
  'converted-closed': 'Converted or closed',
  closed: 'Closed',
  open: 'Open',
  removed: 'Removed',
};

export const statusLabelOf = (status: string): string =>
  STATUS_LABEL[status] ?? status.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A date that has already passed, for an "overdue" style reading. */
const isPast = (iso?: string): boolean => Boolean(iso) && new Date(iso!).getTime() < Date.now();

export function CompanyDetailModal({
  company,
  onClose,
}: {
  company: CompanyRecord | null;
  onClose: () => void;
}): ReactElement {
  const [detail, setDetail] = useState<(CompanyDetail & { mode: 'live' | 'mock' }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    if (!company) return;
    let live = true;
    setTab('overview');
    setDetail(null);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const result = await api.companyDetail(company.companyNumber);
        if (live) setDetail(result);
      } catch (err) {
        if (live) setError(err instanceof ApiClientError ? err.message : 'Could not load the full record.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [company]);

  const outstanding = detail?.outstandingCharges ?? 0;
  const activeOfficers = detail?.officers.filter((o) => o.active).length ?? 0;

  const tabs: Array<TabDef<Tab>> = [
    { id: 'overview', label: 'Overview' },
    { id: 'officers', label: 'Officers', count: detail?.officerCount ?? detail?.officers.length },
    { id: 'ownership', label: 'Ownership', count: detail?.pscCount ?? detail?.psc.length },
    { id: 'filings', label: 'Filings', count: detail?.filings.length },
    {
      id: 'charges',
      label: 'Charges',
      count: detail?.charges.length,
      ...(outstanding > 0 ? { tone: 'crit' as const } : {}),
    },
    // Only offered when there is a case: an empty Insolvency tab on a healthy
    // company invites a worried second look for no reason.
    ...(detail && detail.insolvency.length > 0
      ? [{ id: 'insolvency' as const, label: 'Insolvency', count: detail.insolvency.length, tone: 'crit' as const }]
      : []),
  ];

  return (
    <Modal
      open={company !== null}
      onClose={onClose}
      eyebrow="Companies House"
      title={detail?.name ?? company?.name ?? ''}
      subtitle={
        company
          ? `${company.companyNumber} · ${statusLabelOf(detail?.status ?? company.status)}`
          : undefined
      }
      width="wide"
      footer={
        <>
          {(detail?.url ?? company?.url) && (
            <a className="btn btn--ghost" href={detail?.url ?? company?.url} target="_blank" rel="noreferrer noopener">
              Open on Companies House
            </a>
          )}
          {detail?.mode === 'mock' && <Chip tone="warn" dot>Demo data</Chip>}
          <span className="grow" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {loading ? (
        <div style={{ padding: 24 }}>
          <Spinner label="Reading the register…" />
        </div>
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : !detail ? (
        <Empty title="Nothing to show">The register returned no record for this company.</Empty>
      ) : (
        <div className="stack stack--tight">
          {detail.concerning && (
            <div className="flag flag--critical">
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>{statusLabelOf(detail.status)}</strong>
                <span className="flag__detail">
                  {detail.dissolvedOn
                    ? `Dissolved on ${formatDate(detail.dissolvedOn)}. Anything billed to this company after that date needs looking at.`
                    : 'This company is not trading normally. Do not commit new spend without checking.'}
                </span>
              </span>
            </div>
          )}

          {detail.unavailable.length > 0 && (
            <Alert tone="warn">
              {detail.unavailable.join(' and ')}{' '}
              {detail.unavailable.length === 1 ? 'could not be read' : 'could not be read'} — the rest of this
              record is complete, but treat those sections as unknown rather than empty.
            </Alert>
          )}

          <Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Company sections" />

          {tab === 'overview' && <Overview detail={detail} activeOfficers={activeOfficers} />}
          {tab === 'officers' && <Officers detail={detail} />}
          {tab === 'ownership' && <Ownership detail={detail} />}
          {tab === 'filings' && <Filings detail={detail} />}
          {tab === 'charges' && <Charges detail={detail} />}
          {tab === 'insolvency' && <Insolvency detail={detail} />}
        </div>
      )}
    </Modal>
  );
}

function Overview({ detail, activeOfficers }: { detail: CompanyDetail; activeOfficers: number }): ReactElement {
  const dates = detail.filingDates;
  // Companies House set the overdue flag, but a due date already in the past
  // says the same thing and is sometimes the only one of the two present.
  const late = [
    ...(dates?.accountsOverdue || isPast(dates?.accountsNextDue) ? ['Accounts'] : []),
    ...(dates?.confirmationStatementOverdue || isPast(dates?.confirmationStatementNextDue)
      ? ['Confirmation statement']
      : []),
  ];
  return (
    <div className="stack stack--tight">
      <div className="kv">
        <Cell label="Company number" value={detail.companyNumber} mono copy />
        <Cell label="Status" value={statusLabelOf(detail.status)} />
        <Cell label="Type" value={detail.type} />
        <Cell label="Incorporated" value={formatDate(detail.incorporatedOn)} />
        <Cell label="Dissolved" value={formatDate(detail.dissolvedOn)} />
        <Cell label="Jurisdiction" value={detail.jurisdiction} />
        <Cell label="Serving officers" value={activeOfficers} mono />
        <Cell label="Owners on record" value={detail.psc.filter((p) => p.active).length} mono />
        <Cell label="Outstanding charges" value={detail.outstandingCharges ?? 0} mono />
        <Cell label="Registered office" value={detail.registeredOffice} />
      </div>

      {detail.registeredOfficeInDispute && (
        <Alert tone="warn">
          Companies House record the registered office as disputed — post sent there may not reach anyone.
        </Alert>
      )}

      {dates && (
        <div>
          <Label>Filing deadlines</Label>
          <div className="kv" style={{ marginTop: 5 }}>
            <Cell label="Accounts due" value={formatDate(dates.accountsNextDue)} />
            <Cell label="Accounts made up to" value={formatDate(dates.accountsLastMadeUpTo)} />
            <Cell label="Confirmation statement due" value={formatDate(dates.confirmationStatementNextDue)} />
            <Cell label="Statement made up to" value={formatDate(dates.confirmationStatementLastMadeUpTo)} />
          </div>
          {late.length > 0 && (
            <div className="flag flag--warn" style={{ marginTop: 10 }}>
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>{late.join(' and ')} overdue</strong>
                <span className="flag__detail">
                  Late filing is the earliest public sign of a business in trouble, and it precedes a
                  strike-off notice by months.
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {detail.previousNames && detail.previousNames.length > 0 && (
        <div>
          <Label>Previously known as</Label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
            {detail.previousNames.map((name) => (
              <Chip key={name} tone="idle">{name}</Chip>
            ))}
          </div>
        </div>
      )}

      {detail.sicCodes && detail.sicCodes.length > 0 && (
        <div>
          <Label>Nature of business (SIC)</Label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
            {detail.sicCodes.map((code) => (
              <Chip key={code} tone="idle">{code}</Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Serving officers first, then most recently appointed.
 *
 * Ordered here rather than trusting the provider, because the live path and
 * the fixture path were sorting differently and demo mode showed a resigned
 * director above a serving one. The person to ring belongs at the top in
 * both.
 */
const byStanding = <T extends { active: boolean }>(rank: (v: T) => string) =>
  (a: T, b: T): number => Number(b.active) - Number(a.active) || rank(b).localeCompare(rank(a));

function Officers({ detail }: { detail: CompanyDetail }): ReactElement {
  const officers = [...detail.officers].sort(byStanding((o) => o.appointedOn ?? ''));

  if (detail.officers.length === 0) {
    return <Empty title="No officers on record">Companies House list nobody against this company.</Empty>;
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Appointed</th>
            <th>Status</th>
            <th>Born</th>
            <th>Other roles</th>
          </tr>
        </thead>
        <tbody>
          {officers.map((officer) => (
            <tr key={`${officer.name}:${officer.appointedOn ?? ''}:${officer.role}`}>
              <td>
                <strong style={{ color: 'var(--sw-ink)' }}>{officer.name}</strong>
                {officer.occupation && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{officer.occupation}</div>
                )}
              </td>
              <td style={{ fontSize: 12.5 }}>
                {officer.role}
                {officer.corporate && (
                  <Chip tone="idle" title="An officer that is itself a company">Corporate</Chip>
                )}
              </td>
              <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDate(officer.appointedOn) ?? '—'}</td>
              <td>
                {officer.active ? (
                  <Chip tone="ok" dot>Serving</Chip>
                ) : (
                  <Chip tone="idle">Resigned {formatDate(officer.resignedOn) ?? ''}</Chip>
                )}
              </td>
              <td className="sw-mono" style={{ fontSize: 12 }}>{officer.bornOn ?? '—'}</td>
              <td className="sw-mono" style={{ fontSize: 12 }}>
                {officer.url ? (
                  <a href={officer.url} target="_blank" rel="noreferrer noopener">
                    {officer.otherAppointments ?? 'view'}
                  </a>
                ) : (
                  (officer.otherAppointments ?? '—')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ownership({ detail }: { detail: CompanyDetail }): ReactElement {
  if (detail.psc.length === 0) {
    return (
      <Empty title="No owners on record">
        Companies House hold no persons with significant control for this company. That is normal for some
        structures — a subsidiary, or a company that has claimed an exemption.
      </Empty>
    );
  }
  const psc = [...detail.psc].sort(byStanding((p) => p.notifiedOn ?? ''));

  return (
    <div className="stack stack--tight">
      {psc.map((psc) => (
        <Card key={`${psc.name}:${psc.notifiedOn ?? ''}`} title={psc.name} eyebrow={psc.kind} accent={2}>
          <div className="kv">
            <Cell label="Notified" value={formatDate(psc.notifiedOn)} />
            <Cell label="Status" value={psc.active ? 'Current' : `Ceased ${formatDate(psc.ceasedOn) ?? ''}`} />
            <Cell label="Nationality" value={psc.nationality} />
            <Cell label="Country of residence" value={psc.countryOfResidence} />
          </div>
          {psc.natureOfControl.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Label>Control held</Label>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                {psc.natureOfControl.map((n) => (
                  <Chip key={n} tone="info">{n}</Chip>
                ))}
              </div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Filings({ detail }: { detail: CompanyDetail }): ReactElement {
  if (detail.filings.length === 0) {
    return <Empty title="No filings">Companies House hold no filing history for this company.</Empty>;
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Date</th>
            <th>Category</th>
            <th>What was filed</th>
            <th>Pages</th>
          </tr>
        </thead>
        <tbody>
          {detail.filings.map((filing, index) => (
            <tr key={`${filing.date}:${index}`}>
              <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDate(filing.date) ?? filing.date}</td>
              <td><Chip tone="idle">{filing.category}</Chip></td>
              <td style={{ fontSize: 12.5 }}>{filing.description}</td>
              <td className="sw-mono" style={{ fontSize: 12 }}>{filing.pages ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Charges({ detail }: { detail: CompanyDetail }): ReactElement {
  if (detail.charges.length === 0) {
    return (
      <Empty title="No charges registered">
        Nothing is secured against this company's assets, which is the answer a credit check wants.
      </Empty>
    );
  }
  return (
    <div className="stack stack--tight">
      {(detail.outstandingCharges ?? 0) > 0 && (
        <div className="flag flag--warn">
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>
              {detail.outstandingCharges === 1
                ? '1 charge is still outstanding'
                : `${detail.outstandingCharges} charges are still outstanding`}
            </strong>
            <span className="flag__detail">
              A lender holds security over this company's assets. Relevant to a credit decision, not to a
              fault.
            </span>
          </span>
        </div>
      )}
      {detail.charges.map((charge, index) => (
        <Card
          key={`${charge.chargeNumber ?? index}`}
          title={charge.personsEntitled.join(', ') || 'Charge holder not recorded'}
          eyebrow={charge.chargeNumber != null ? `Charge ${charge.chargeNumber}` : 'Charge'}
          accent={charge.outstanding ? 4 : 2}
          meta={
            charge.outstanding ? <Chip tone="warn" dot>Outstanding</Chip> : <Chip tone="ok" dot>{charge.status}</Chip>
          }
        >
          <div className="kv">
            <Cell label="Created" value={formatDate(charge.createdOn)} />
            <Cell label="Delivered" value={formatDate(charge.deliveredOn)} />
            <Cell label="Satisfied" value={formatDate(charge.satisfiedOn)} />
            <Cell label="Classification" value={charge.classification} />
          </div>
          {charge.particulars && (
            <div style={{ marginTop: 10 }}>
              <Label>Particulars</Label>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{charge.particulars}</div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Insolvency({ detail }: { detail: CompanyDetail }): ReactElement {
  return (
    <div className="stack stack--tight">
      {detail.insolvency.map((kase, index) => (
        <Card key={`${kase.type}:${index}`} title={kase.type} eyebrow="Insolvency case" accent={4}>
          {kase.dates.length > 0 && (
            <div className="kv">
              {kase.dates.map((d) => (
                <Cell key={`${d.label}:${d.date}`} label={d.label} value={formatDate(d.date) ?? d.date} />
              ))}
            </div>
          )}
          {kase.practitioners.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Label>Practitioner — this is who to contact, not the company</Label>
              {kase.practitioners.map((p) => (
                <div key={p.name} className="kv" style={{ marginTop: 5 }}>
                  <Cell label="Name" value={p.name} />
                  <Cell label="Role" value={p.role} />
                  <Cell label="Appointed" value={formatDate(p.appointedOn)} />
                  <Cell label="Address" value={p.address} />
                </div>
              ))}
            </div>
          )}
          {kase.notes.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Label>Notes</Label>
              {kase.notes.map((n) => (
                <div key={n} className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{n}</div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
