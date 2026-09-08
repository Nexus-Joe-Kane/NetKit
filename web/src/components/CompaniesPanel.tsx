import { useEffect, useState, type ReactElement } from 'react';
import type { CompanyContext, CompanyRecord } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, Empty, Spinner, formatDate } from '../components/ui';
import { CompanyDetailModal, statusLabelOf } from './CompanyDetailModal';

/**
 * Who is registered at this premises.
 *
 * The panel earns its place on the days it changes the answer: a business
 * broadband fault, a cease request or a credit decision reads differently
 * when the company on the account went into liquidation last month, or was
 * dissolved two years ago and nobody told anyone.
 *
 * Companies at the postcode rather than the exact premises, because that is
 * what the register indexes — the ones registered at this address are marked.
 */

export function CompaniesPanel({ postcode }: { postcode: string }): ReactElement {
  const [data, setData] = useState<(CompanyContext & { mode: 'live'; providerError?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompanyRecord | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      setLoading(true);
      try {
        const result = await api.companies(postcode);
        if (live) {
          setData(result);
          setError(null);
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
  }, [postcode]);

  const concerning = data?.companies.filter((c) => c.concerning) ?? [];
  const here = data?.companies.filter((c) => c.registeredHere).length ?? 0;

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
              <span className="muted" style={{ fontSize: 11.5 }}>at {data.postcode}</span>
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
        ) : !data || data.companies.length === 0 ? (
          <Empty title="No registered companies">
            Nothing is registered at this postcode. That is normal for a residential premises.
          </Empty>
        ) : (
          <>
            {concerning.length > 0 && (
              <div style={{ padding: '14px 18px 0' }}>
                <div className="flag flag--critical">
                  <span className="flag__marker" aria-hidden="true" />
                  <span>
                    <strong>
                      {concerning.length === 1
                        ? '1 company here is not trading normally'
                        : `${concerning.length} companies here are not trading normally`}
                    </strong>
                    <span className="flag__detail">
                      {concerning
                        .slice(0, 3)
                        .map((c) => `${c.name} — ${statusLabelOf(c.status)}`)
                        .join('; ')}
                      . Check before taking an order or agreeing a credit.
                    </span>
                  </span>
                </div>
              </div>
            )}

            <div style={{ padding: '14px 18px 0' }}>
              <div className="kv">
                <Cell label="Companies at this postcode" value={data.companies.length} mono />
                <Cell label="Registered at this address" value={here} mono />
                <Cell label="Not trading normally" value={concerning.length} mono />
              </div>
            </div>

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
                  {data.companies.map((company) => (
                    <tr key={company.companyNumber} className="clickable" onClick={() => setDetail(company)}>
                      <td style={{ maxWidth: 260 }}>
                        <strong style={{ color: 'var(--sw-ink)' }}>{company.name}</strong>
                        {company.overdue && company.overdue.length > 0 && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{company.overdue.join(', ')}</div>
                        )}
                      </td>
                      <td className="sw-mono" style={{ fontSize: 12 }}>{company.companyNumber}</td>
                      <td>
                        <Chip tone={company.concerning ? 'crit' : 'ok'} dot>
                          {statusLabelOf(company.status)}
                        </Chip>
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDate(company.incorporatedOn) ?? '—'}</td>
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
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <CompanyDetailModal company={detail} onClose={() => setDetail(null)} />
    </>
  );
}
