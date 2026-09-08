import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { OrderRecord, OrderState } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import {
  Alert,
  Card,
  Cell,
  Chip,
  ExportButtons,
  Label,
  Spinner,
  formatDate,
  formatDateTime,
  type ChipTone,
} from '../components/ui';
import type { CsvColumn } from '../lib/csv';
import { Tabs, TabPanel, type TabDef } from '../components/Tabs';
import { Modal, useConfirm } from '../components/overlay';

/**
 * Orders — the in-flight book, the WIP report and a search.
 *
 * Delayed orders and those with no appointment booked lead, because those
 * are the two states that need chasing.
 */

const STATE_TONE: Record<OrderState, ChipTone> = {
  draft: 'idle',
  submitted: 'info',
  accepted: 'info',
  in_progress: 'info',
  delayed: 'crit',
  awaiting_appointment: 'warn',
  completed: 'ok',
  cancelled: 'idle',
  rejected: 'crit',
  unknown: 'idle',
};

const STATE_LABEL: Record<OrderState, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  accepted: 'Accepted',
  in_progress: 'In progress',
  delayed: 'Delayed',
  awaiting_appointment: 'Awaiting appointment',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  unknown: 'Unknown',
};

type Tab = 'status' | 'wip' | 'search';

/** Everything a chased order needs, in the order someone would read it. */
const ORDER_COLUMNS: Array<CsvColumn<OrderRecord>> = [
  { header: 'Zen reference', value: (o) => o.zenReference },
  { header: 'Customer reference', value: (o) => o.customerReference },
  { header: 'Type', value: (o) => o.type },
  { header: 'State', value: (o) => STATE_LABEL[o.state] },
  { header: 'State reason', value: (o) => o.stateReason },
  { header: 'Delay reason', value: (o) => o.delayReason },
  { header: 'Product', value: (o) => o.productName },
  { header: 'Product code', value: (o) => o.productCode },
  { header: 'Address', value: (o) => o.address?.singleLine },
  { header: 'Postcode', value: (o) => o.address?.postcode },
  { header: 'UPRN', value: (o) => o.address?.uprn },
  { header: 'CLI', value: (o) => o.cli },
  { header: 'Service ID', value: (o) => o.serviceId },
  { header: 'Access line ID', value: (o) => o.accessLineId },
  { header: 'Supplier', value: (o) => o.supplier },
  { header: 'Placed', value: (o) => o.placedAt },
  { header: 'Committed', value: (o) => o.committedDate },
  { header: 'Promised', value: (o) => o.promisedDate },
  { header: 'Completed', value: (o) => o.completedAt },
  { header: 'Engineer required', value: (o) => o.requiresEngineer },
  { header: 'Appointment date', value: (o) => o.appointment?.date },
  { header: 'Appointment slot', value: (o) => o.appointment?.slot },
  { header: 'Site contact', value: (o) => o.contactName },
];

export function OrdersPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('status');
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'live'>('live');
  const [providerError, setProviderError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderRecord | null>(null);
  const { confirm, dialog } = useConfirm();

  const load = useCallback(async (view: Tab, searchTerm?: string) => {
    setLoading(true);
    try {
      const result = await api.orders(view, searchTerm);
      setOrders(result.orders);
      setMode(result.mode);
      setProviderError(result.providerError);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load orders.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'search') void load(tab);
  }, [load, tab]);

  const delayed = orders.filter((o) => o.state === 'delayed').length;
  const noAppointment = orders.filter((o) => o.requiresEngineer && !o.appointment?.date).length;
  const completing = orders.filter((o) => o.state === 'completed').length;

  const cancel = async (order: OrderRecord) => {
    const ok = await confirm({
      title: `Cancel order ${order.zenReference}?`,
      tone: 'danger',
      confirmLabel: 'Cancel the order',
      requireTyping: order.zenReference,
      message: (
        <>
          <p>
            This asks Zen to cancel an in-flight order. Depending on how far it has progressed the supplier may refuse,
            or may apply a cancellation charge.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>{order.productName ?? 'Order'}</strong>
            {order.address?.singleLine ? ` at ${order.address.singleLine}` : ''}.
          </p>
        </>
      ),
    });
    if (!ok) return;

    try {
      const result = await api.cancelOrder(order.zenReference, 'Cancelled by SupportWizard via NetKit');
      setDetail(null);
      await load(tab === 'search' ? 'search' : tab, tab === 'search' ? query : undefined);
      if (!result.ok) setError(result.message ?? 'The provider did not accept the cancellation.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not cancel that order.');
    }
  };

  const tabs: Array<TabDef<Tab>> = [
    { id: 'status', label: 'In flight', ...(tab === 'status' && orders.length ? { count: orders.length } : {}) },
    { id: 'wip', label: 'WIP report', ...(tab === 'wip' && orders.length ? { count: orders.length } : {}) },
    { id: 'search', label: 'Search' },
  ];

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {providerError && (
        <Alert tone="warn">
          <span>Showing demo data — the live call failed: {providerError}</span>
        </Alert>
      )}

      <section className="card card--accent-1">
        <div className="headline">
          <div className="headline__tile">
            <Label>Orders shown</Label>
            <div className="headline__big">{orders.length}</div>
            <div className="headline__sub">{tab === 'wip' ? 'work in progress' : 'in flight'}</div>
          </div>
          <div className="headline__tile">
            <Label>Delayed</Label>
            <div className="headline__big" style={{ color: delayed ? 'var(--sw-crit-ink)' : 'var(--sw-ink)' }}>
              {delayed}
            </div>
            <div className="headline__sub">chase the supplier</div>
          </div>
          <div className="headline__tile">
            <Label>No appointment</Label>
            <div className="headline__big" style={{ color: noAppointment ? 'var(--sw-amber-ink)' : 'var(--sw-ink)' }}>
              {noAppointment}
            </div>
            <div className="headline__sub">engineer needed, none booked</div>
          </div>
          <div className="headline__tile">
            <Label>Completed</Label>
            <div className="headline__big" style={{ color: 'var(--sw-ok)' }}>{completing}</div>
            <div className="headline__sub">in this view</div>
          </div>
        </div>
      </section>

      <Card
        title="Orders"
        eyebrow="Zen self-service"
        index="01"
        accent={2}
        flush
        meta={
          <>
            <Chip tone="ok" dot>Live</Chip>
            <ExportButtons rows={orders} columns={ORDER_COLUMNS} filenamePrefix={`orders-${tab}`} label="the order list" />
          </>
        }
        tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Order views" />}
      >
        <TabPanel>
          {tab === 'search' && (
            <form
              style={{ padding: 18, borderBottom: '1px solid var(--sw-hairline)', background: 'var(--sw-panel)' }}
              onSubmit={(event) => {
                event.preventDefault();
                void load('search', query.trim() || undefined);
              }}
            >
              <label className="field" style={{ marginBottom: 10 }}>
                <Label>Zen reference, customer reference or phone number</Label>
                <input
                  className="field__input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ZEN1234567, SW-01234 or 01614969790"
                  autoFocus
                />
              </label>
              <button className="btn btn--primary" type="submit" disabled={loading}>
                {loading ? 'Searching…' : 'Search orders'}
              </button>
            </form>
          )}

          {loading ? (
            <div style={{ padding: 18 }}>
              <Spinner label="Loading orders…" />
            </div>
          ) : orders.length === 0 ? (
            <div className="empty">
              <h3>No orders</h3>
              <p>{tab === 'search' ? 'Nothing matched that search.' : 'Nothing is currently in flight.'}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Zen reference</th>
                    <th>Type</th>
                    <th>Product</th>
                    <th>State</th>
                    <th>Committed</th>
                    <th>Appointment</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.zenReference} className="clickable" onClick={() => setDetail(order)}>
                      <td className="sw-mono">
                        {order.zenReference}
                        {order.customerReference && (
                          <div className="muted" style={{ fontSize: 11 }}>{order.customerReference}</div>
                        )}
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>{order.type}</td>
                      <td style={{ maxWidth: 220 }}>
                        {order.productName ?? '—'}
                        {order.cli && <div className="muted sw-mono" style={{ fontSize: 11 }}>{order.cli}</div>}
                      </td>
                      <td>
                        <Chip tone={STATE_TONE[order.state]} dot>
                          {STATE_LABEL[order.state]}
                        </Chip>
                        {order.delayReason && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 3, maxWidth: 200 }}>
                            {order.delayReason}
                          </div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDate(order.committedDate) ?? '—'}</td>
                      <td style={{ fontSize: 12.5 }}>
                        {order.appointment?.date ? (
                          <>
                            {formatDate(order.appointment.date)}
                            <div className="muted" style={{ fontSize: 11 }}>{order.appointment.slot}</div>
                          </>
                        ) : order.requiresEngineer ? (
                          <Chip tone="warn">Not booked</Chip>
                        ) : (
                          <span className="muted">Not needed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>
      </Card>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow={detail ? `${detail.type} order` : undefined}
        title={detail?.zenReference ?? ''}
        subtitle={detail?.productName}
        width="default"
        footer={
          <>
            <span className="grow" />
            {detail && !['completed', 'cancelled', 'rejected'].includes(detail.state) && (
              <button type="button" className="btn btn--danger" onClick={() => void cancel(detail)}>
                Cancel order
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={() => setDetail(null)}>
              Close
            </button>
          </>
        }
      >
        {detail && (
          <div className="stack stack--tight">
            {detail.delayReason && (
              <div className="flag flag--critical">
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>Delayed</strong>
                  <span className="flag__detail">{detail.delayReason}</span>
                </span>
              </div>
            )}

            {detail.address?.singleLine && (
              <div>
                <Label>Installation address</Label>
                <div style={{ marginTop: 3, fontSize: 14, color: 'var(--sw-ink)', fontWeight: 500 }}>
                  {detail.address.singleLine}
                </div>
              </div>
            )}

            <div className="kv">
              <Cell label="State" value={STATE_LABEL[detail.state]} />
              <Cell label="Reason" value={detail.stateReason} />
              <Cell label="Type" value={detail.type} />
              <Cell label="Supplier" value={detail.supplier} />
              <Cell label="Product code" value={detail.productCode} mono />
              <Cell label="Placed" value={formatDateTime(detail.placedAt)} />
              <Cell label="Committed" value={formatDate(detail.committedDate)} />
              <Cell label="Promised" value={formatDate(detail.promisedDate)} />
              <Cell label="Preferred activation" value={formatDate(detail.preferredActivationDate)} />
              <Cell label="Completed" value={formatDate(detail.completedAt)} />
              <Cell label="CLI" value={detail.cli} mono copy />
              <Cell label="Service ID" value={detail.serviceId} mono copy />
              <Cell label="Access line ID" value={detail.accessLineId} mono copy />
              <Cell label="Order reference" value={detail.orderReference} mono copy />
              <Cell label="Customer reference" value={detail.customerReference} mono />
              <Cell label="Engineer required" value={detail.requiresEngineer} />
              <Cell label="Working line takeover" value={detail.workingLineTakeover} />
              <Cell label="Site contact" value={detail.contactName} />
            </div>

            {detail.appointment?.date && (
              <div className="flag flag--info">
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>Engineer appointment</strong>
                  <span className="flag__detail">
                    {formatDate(detail.appointment.date)}
                    {detail.appointment.slot ? `, ${detail.appointment.slot}` : ''} ·{' '}
                    {detail.appointment.status ?? 'Booked'}
                    {detail.appointment.reference ? ` · ${detail.appointment.reference}` : ''}
                  </span>
                </span>
              </div>
            )}
          </div>
        )}
      </Modal>

      {dialog}
    </div>
  );
}
