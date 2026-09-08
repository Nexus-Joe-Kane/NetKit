import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { FaultCategory, FaultRecord } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, ExportButtons, Label, Spinner, formatDateTime, type ChipTone } from '../components/ui';
import type { CsvColumn } from '../lib/csv';
import { Tabs, TabPanel, type TabDef } from '../components/Tabs';
import { Modal } from '../components/overlay';

/**
 * Faults — the open book, closed history, and raising a new one.
 *
 * The raise form deliberately requires what has already been tested. Every
 * provider rejects faults without it, and a chargeable no-fault-found visit
 * is the expensive outcome of skipping it.
 */

const STATE_TONE: Record<FaultRecord['state'], ChipTone> = {
  open: 'crit',
  engineer_assigned: 'warn',
  awaiting_customer: 'warn',
  cleared: 'ok',
  closed: 'idle',
  unknown: 'idle',
};

const CATEGORY_LABEL: Record<FaultCategory, string> = {
  synchronisation: 'Sync',
  performance: 'Performance',
  authentication: 'Authentication',
  voice: 'Voice',
  other: 'Other',
};

const FAULT_COLUMNS: Array<CsvColumn<FaultRecord>> = [
  { header: 'Reference', value: (f) => f.reference },
  { header: 'Service reference', value: (f) => f.zenReference },
  { header: 'Service ID', value: (f) => f.serviceId },
  { header: 'CLI', value: (f) => f.cli },
  { header: 'Category', value: (f) => CATEGORY_LABEL[f.category] },
  { header: 'Frequency', value: (f) => f.frequency },
  { header: 'State', value: (f) => f.state },
  { header: 'Provider status', value: (f) => f.status },
  { header: 'Summary', value: (f) => f.summary },
  { header: 'Raised', value: (f) => f.raisedAt },
  { header: 'Raised by', value: (f) => f.raisedBy },
  { header: 'Cleared', value: (f) => f.clearedAt },
  { header: 'Care level', value: (f) => f.careLevel },
  { header: 'SLA target', value: (f) => f.slaTarget },
  { header: 'Committed fix', value: (f) => f.committedAt },
  { header: 'Appointment date', value: (f) => f.appointment?.date },
  { header: 'Appointment slot', value: (f) => f.appointment?.slot },
  { header: 'Chargeable risk', value: (f) => f.chargeableRisk },
  { header: 'Address', value: (f) => f.address?.singleLine },
  { header: 'Postcode', value: (f) => f.address?.postcode },
  { header: 'Updates', value: (f) => f.updates?.length ?? 0 },
];

type Tab = 'open' | 'closed';

export function FaultsPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('open');
  const [faults, setFaults] = useState<FaultRecord[]>([]);
  const [mode, setMode] = useState<'live' | 'mock'>('mock');
  const [providerError, setProviderError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<FaultRecord | null>(null);
  const [raising, setRaising] = useState(false);
  const [raised, setRaised] = useState<FaultRecord | null>(null);

  const load = useCallback(async (state: Tab) => {
    setLoading(true);
    try {
      const result = await api.faults(state);
      setFaults(result.faults);
      setMode(result.mode);
      setProviderError(result.providerError);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load faults.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  const tabs: Array<TabDef<Tab>> = [
    { id: 'open', label: 'Open', ...(tab === 'open' && faults.length ? { count: faults.length, tone: 'crit' as const } : {}) },
    { id: 'closed', label: 'Recently closed', ...(tab === 'closed' && faults.length ? { count: faults.length } : {}) },
  ];

  const withEngineer = faults.filter((f) => f.state === 'engineer_assigned').length;
  const awaitingCustomer = faults.filter((f) => f.state === 'awaiting_customer').length;
  const chargeable = faults.filter((f) => f.chargeableRisk).length;

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {providerError && (
        <Alert tone="warn">
          <span>Showing demo data — the live call failed: {providerError}</span>
        </Alert>
      )}

      {tab === 'open' && (
        <section className="card card--accent-1">
          <div className="headline">
            <div className="headline__tile">
              <Label>Open faults</Label>
              <div className="headline__big" style={{ color: faults.length ? 'var(--sw-crit-ink)' : 'var(--sw-ok)' }}>
                {faults.length}
              </div>
              <div className="headline__sub">across all services</div>
            </div>
            <div className="headline__tile">
              <Label>Engineer assigned</Label>
              <div className="headline__big">{withEngineer}</div>
              <div className="headline__sub">visit booked</div>
            </div>
            <div className="headline__tile">
              <Label>Awaiting customer</Label>
              <div className="headline__big" style={{ color: awaitingCustomer ? 'var(--sw-amber-ink)' : 'var(--sw-ink)' }}>
                {awaitingCustomer}
              </div>
              <div className="headline__sub">chase these first</div>
            </div>
            <div className="headline__tile">
              <Label>Chargeable risk</Label>
              <div className="headline__big" style={{ color: chargeable ? 'var(--sw-amber-ink)' : 'var(--sw-ink)' }}>
                {chargeable}
              </div>
              <div className="headline__sub">could bill on no fault found</div>
            </div>
          </div>
        </section>
      )}

      <Card
        title="Faults"
        eyebrow="Zen Assurance"
        index="01"
        accent={2}
        flush
        meta={
          <>
            {mode === 'mock' ? <Chip tone="warn" dot>Demo data</Chip> : <Chip tone="ok" dot>Live</Chip>}
            <ExportButtons rows={faults} columns={FAULT_COLUMNS} filenamePrefix={`faults-${tab}`} label="the fault book" />
            <button className="btn btn--primary btn--small" onClick={() => setRaising(true)}>
              Raise a fault
            </button>
          </>
        }
        tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Fault sections" />}
      >
        <TabPanel>
          {loading ? (
            <div style={{ padding: 18 }}>
              <Spinner label="Loading faults…" />
            </div>
          ) : faults.length === 0 ? (
            <div className="empty">
              <h3>{tab === 'open' ? 'No open faults' : 'Nothing recently closed'}</h3>
              <p>
                {tab === 'open'
                  ? 'Nothing is currently raised. Check Network status before raising one — an area outage should not become a per-site fault.'
                  : 'No faults have been closed recently.'}
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Service</th>
                    <th>Category</th>
                    <th>Summary</th>
                    <th>State</th>
                    <th>Raised</th>
                  </tr>
                </thead>
                <tbody>
                  {faults.map((fault) => (
                    <tr key={fault.reference} className="clickable" onClick={() => setDetail(fault)}>
                      <td className="sw-mono">{fault.reference}</td>
                      <td className="sw-mono" style={{ fontSize: 12 }}>
                        {fault.cli ?? fault.serviceId ?? fault.zenReference ?? '—'}
                      </td>
                      <td>
                        <Chip tone="idle">{CATEGORY_LABEL[fault.category]}</Chip>
                        {fault.frequency && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{fault.frequency}</div>
                        )}
                      </td>
                      <td style={{ maxWidth: 300 }}>{fault.summary}</td>
                      <td>
                        <Chip tone={STATE_TONE[fault.state]} dot>
                          {fault.status}
                        </Chip>
                        {fault.chargeableRisk && (
                          <div style={{ marginTop: 3 }}>
                            <Chip tone="warn">Chargeable risk</Chip>
                          </div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDateTime(fault.raisedAt) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>
      </Card>

      <FaultModal fault={detail} onClose={() => setDetail(null)} />

      <RaiseFaultModal
        open={raising}
        onClose={() => setRaising(false)}
        onRaised={(fault) => {
          setRaising(false);
          setRaised(fault);
          void load(tab);
        }}
      />

      <Modal
        open={raised !== null}
        onClose={() => setRaised(null)}
        title={raised?.reference === 'DEMO-NOT-RAISED' ? 'Nothing was raised' : 'Fault raised'}
        subtitle={raised?.reference === 'DEMO-NOT-RAISED' ? undefined : raised?.reference}
        width="narrow"
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setRaised(null)}>
            Done
          </button>
        }
      >
        {raised?.reference === 'DEMO-NOT-RAISED' ? (
          <p style={{ margin: 0 }}>
            This is demo mode — no fault was sent to Zen. Connect Zen credentials with the{' '}
            <code className="sw-mono">indirect-faults</code> scope and this will raise for real.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            The fault is with Zen as <strong className="sw-mono">{raised?.reference}</strong>. It will appear in the
            open list, and updates from the supplier land on its timeline.
          </p>
        )}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fault detail
 * ------------------------------------------------------------------ */

export function FaultModal({ fault, onClose }: { fault: FaultRecord | null; onClose: () => void }): ReactElement | null {
  if (!fault) return null;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${CATEGORY_LABEL[fault.category]} fault`}
      title={fault.summary}
      subtitle={fault.reference}
      {...(fault.state === 'open' ? { tone: 'danger' as const } : {})}
      footer={
        <>
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            {fault.provider}
          </span>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        {fault.detail && (
          <div className="flag flag--info">
            <span className="flag__marker" aria-hidden="true" />
            <span className="flag__detail">{fault.detail}</span>
          </div>
        )}

        {fault.chargeableRisk && (
          <div className="flag flag--warn">
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>Chargeable risk</strong>
              <span className="flag__detail">
                If the engineer finds no network fault, the visit is likely to be billed. Confirm the customer has
                tested at the master socket with known-good equipment.
              </span>
            </span>
          </div>
        )}

        <div className="kv">
          <Cell label="Status" value={fault.status} />
          <Cell label="Category" value={CATEGORY_LABEL[fault.category]} />
          <Cell label="Frequency" value={fault.frequency} />
          <Cell label="Raised" value={formatDateTime(fault.raisedAt)} />
          <Cell label="Raised by" value={fault.raisedBy} />
          <Cell label="Cleared" value={formatDateTime(fault.clearedAt)} />
          <Cell label="Care level" value={fault.careLevel} />
          <Cell label="SLA target" value={formatDateTime(fault.slaTarget)} />
          <Cell label="Committed" value={formatDateTime(fault.committedAt)} />
          <Cell label="Zen reference" value={fault.zenReference} mono copy />
          <Cell label="Service ID" value={fault.serviceId} mono copy />
          <Cell label="CLI" value={fault.cli} mono copy />
        </div>

        {fault.appointment && (
          <div className="flag flag--info">
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>Engineer visit booked</strong>
              <span className="flag__detail">
                {formatDateTime(fault.appointment.date)}
                {fault.appointment.slot ? `, ${fault.appointment.slot}` : ''} · {fault.appointment.status ?? 'Booked'}
                {fault.appointment.type ? ` · ${fault.appointment.type}` : ''}
              </span>
            </span>
          </div>
        )}

        {fault.updates?.length ? (
          <div>
            <Label>Updates — newest first</Label>
            <div className="timeline" style={{ marginTop: 8 }}>
              {fault.updates.map((update, i) => (
                <div key={i} className="timeline__item">
                  <span className="timeline__dot" aria-hidden="true" />
                  <div>
                    <div className="sw-label">
                      {formatDateTime(update.at)}
                      {update.author ? ` · ${update.author}` : ''}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.55 }}>{update.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Raising a fault
 * ------------------------------------------------------------------ */

export function RaiseFaultModal({
  open,
  onClose,
  onRaised,
  presetZenReference,
}: {
  open: boolean;
  onClose: () => void;
  onRaised: (fault: FaultRecord) => void;
  presetZenReference?: string;
}): ReactElement | null {
  const [form, setForm] = useState({
    zenReference: presetZenReference ?? '',
    category: 'synchronisation' as FaultCategory,
    frequency: 'intermittent' as 'intermittent' | 'permanent',
    summary: '',
    testsCarriedOut: '',
    contactName: '',
    contactNumber: '',
    siteNotes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && presetZenReference) setForm((f) => ({ ...f, zenReference: presetZenReference }));
  }, [open, presetZenReference]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.raiseFault({
        zenReference: form.zenReference.trim(),
        category: form.category,
        frequency: form.frequency,
        summary: form.summary.trim(),
        ...(form.testsCarriedOut.trim() ? { testsCarriedOut: form.testsCarriedOut.trim() } : {}),
        ...(form.contactName.trim() ? { contactName: form.contactName.trim() } : {}),
        ...(form.contactNumber.trim() ? { contactNumber: form.contactNumber.trim() } : {}),
        ...(form.siteNotes.trim() ? { siteNotes: form.siteNotes.trim() } : {}),
      });
      onRaised(result.fault);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not raise the fault.');
    } finally {
      setBusy(false);
    }
  };

  const ready = form.zenReference.trim().length > 0 && form.summary.trim().length >= 10;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Zen Assurance"
      title="Raise a fault"
      subtitle="Goes to Zen, who pass it to the access provider. Anything you put here reaches the engineer."
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || !ready}>
            {busy ? 'Raising…' : 'Raise fault'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}

        <div className="flag flag--warn" style={{ marginBottom: 14 }}>
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>Check Network status first</strong>
            <span className="flag__detail">
              If an area outage is already open, a per-site fault will be rejected or closed as a duplicate.
            </span>
          </span>
        </div>

        <label className="field">
          <Label>Zen service reference</Label>
          <input
            className="field__input sw-mono"
            value={form.zenReference}
            onChange={(e) => setForm({ ...form, zenReference: e.target.value })}
            placeholder="ZEN1234567"
            required
            {...(presetZenReference ? { readOnly: true } : { autoFocus: true })}
          />
        </label>

        <div className="two-col">
          <label className="field">
            <Label>Category</Label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as FaultCategory })}>
              <option value="synchronisation">Synchronisation — dropping or no sync</option>
              <option value="performance">Performance — slow throughput</option>
              <option value="authentication">Authentication — not connecting</option>
            </select>
          </label>

          <label className="field">
            <Label>Frequency</Label>
            <select
              value={form.frequency}
              onChange={(e) => setForm({ ...form, frequency: e.target.value as 'intermittent' | 'permanent' })}
            >
              <option value="intermittent">Intermittent — comes and goes</option>
              <option value="permanent">Permanent — constant</option>
            </select>
          </label>
        </div>

        <label className="field">
          <Label>What is happening</Label>
          <textarea
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
            rows={3}
            required
            placeholder="Line drops 6–8 times a day, mostly late afternoon. Router logs show DSL retrains, not PPP failures."
          />
          <span className="field__hint">
            At least a sentence. Specific symptoms and timings get a fault accepted; “internet not working” does not.
          </span>
        </label>

        <label className="field">
          <Label>Tests already carried out</Label>
          <textarea
            value={form.testsCarriedOut}
            onChange={(e) => setForm({ ...form, testsCarriedOut: e.target.value })}
            rows={3}
            placeholder="Tested at the master socket with a known-good router. Microfilter swapped. xDSL test run — SNR 12 dB, banded profile applied."
          />
          <span className="field__hint">
            Strongly recommended. Without it the provider may bill a no-fault-found visit.
          </span>
        </label>

        <div className="two-col">
          <label className="field">
            <Label>Site contact name</Label>
            <input className="field__input" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          </label>
          <label className="field">
            <Label>Site contact number</Label>
            <input className="field__input" value={form.contactNumber} onChange={(e) => setForm({ ...form, contactNumber: e.target.value })} />
          </label>
        </div>

        <label className="field" style={{ marginBottom: 0 }}>
          <Label>Access and hazard notes</Label>
          <textarea
            value={form.siteNotes}
            onChange={(e) => setForm({ ...form, siteNotes: e.target.value })}
            rows={2}
            placeholder="Report to reception. Dog on site. Ladder needed for the DP."
          />
        </label>
      </form>
    </Modal>
  );
}
