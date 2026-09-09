import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { confirmMatches } from '@sw/shared';
import type {
  AppointmentSlot,
  BroadbandAvailability,
  BroadbandOffer,
  OrderQuote,
  OrderingGate,
  PlaceOrderResult,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Cell, Chip, Label, Spinner, formatDate } from './ui';
import { Modal } from './overlay';

/**
 * Placing an order.
 *
 * This is the only screen in NetKit that spends money, and it is built to
 * feel like it. Three deliberate steps — review, confirm, outcome — with the
 * money shown before anything is committed and the address retyped by hand
 * at the end. Nothing submits from a table row.
 *
 * The guards are enforced on the server; everything here exists so the
 * operator can see what they are about to do, and so a refusal explains
 * itself rather than greying a button out.
 */

type Step = 'review' | 'confirm' | 'result';

export interface OrderFlowProps {
  availability: BroadbandAvailability;
  offer: BroadbandOffer;
  onClose: () => void;
  /** Called after an order is accepted, so the caller can refresh its view. */
  onPlaced?: (result: PlaceOrderResult) => void;
}

const money = (amount: number): string =>
  `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function OrderFlow({ availability, offer, onClose, onPlaced }: OrderFlowProps): ReactElement {
  const [step, setStep] = useState<Step>('review');
  const [gate, setGate] = useState<OrderingGate | null>(null);
  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [slots, setSlots] = useState<AppointmentSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PlaceOrderResult | null>(null);

  // What the operator fills in.
  const [appointmentToken, setAppointmentToken] = useState('');
  const [customerReference, setCustomerReference] = useState('');
  const [contractTermMonths, setContractTermMonths] = useState('12');
  const [contactName, setContactName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [workingLineTakeover, setWorkingLineTakeover] = useState(false);
  const [typed, setTyped] = useState('');

  const address = availability.address;
  const addressLine = address.singleLine;
  const goldAddressKey = availability.openreach?.addressKey ?? address.addressKey ?? '';
  const districtCode = availability.openreach?.districtCode ?? '';
  const availabilityReference = availability.availabilityReference ?? '';

  // The premises already has a provider on it, which is the fact that decides
  // whether this is a provide or a takeover. Worth having on screen.
  const existingProvider = availability.openreach?.flags?.find((f) => /in service|provider/i.test(f.label));

  const missing: string[] = [
    ...(availabilityReference ? [] : ['an availability reference — re-run the availability check']),
    ...(goldAddressKey ? [] : ['a Gold Address Key for this premises']),
    ...(offer.productCode ? [] : ['a product code on this option']),
  ];

  useEffect(() => {
    let live = true;
    void (async () => {
      setLoading(true);
      try {
        const [gateResult, quoteResult] = await Promise.all([
          api.orderingGate(),
          offer.productCode
            ? api.orderPricing(offer.productCode, offer.productName).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!live) return;
        setGate(gateResult);
        setQuote(quoteResult);

        // Only fetch slots when the product actually needs an engineer —
        // asking for appointments on a managed install returns nothing and
        // makes the screen look broken.
        if (offer.appointmentRequired && availabilityReference && offer.productCode) {
          const appts = await api
            .appointments({
              availabilityReference,
              productCode: offer.productCode,
              goldAddressKey,
              districtCode,
            })
            .catch(() => null);
          if (live && appts) setSlots(appts.slots);
        }
        if (live) setError(null);
      } catch (err) {
        if (live) setError(err instanceof ApiClientError ? err.message : 'Could not prepare the order.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [availabilityReference, districtCode, goldAddressKey, offer.appointmentRequired, offer.productCode, offer.productName]);

  const submit = useCallback(async () => {
    if (!offer.productCode) return;
    setSubmitting(true);
    try {
      const placed = await api.placeOrder({
        availabilityReference,
        productCode: offer.productCode,
        ...(offer.productName ? { productName: offer.productName } : {}),
        goldAddressKey,
        districtCode,
        ...(address.uprn ? { uprn: address.uprn } : {}),
        addressLine,
        postcode: address.postcode,
        ...(appointmentToken ? { appointmentToken } : {}),
        ...(customerReference.trim() ? { customerReference: customerReference.trim() } : {}),
        ...(Number.parseInt(contractTermMonths, 10) > 0
          ? { contractTermMonths: Number.parseInt(contractTermMonths, 10) }
          : {}),
        ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
        ...(contactNumber.trim() ? { contactNumber: contactNumber.trim() } : {}),
        ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        workingLineTakeover,
        confirmAddressLine: typed.trim(),
      });
      setResult(placed);
      setGate(placed.gate);
      setStep('result');
      if (placed.accepted) onPlaced?.(placed);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The order could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  }, [
    address.postcode,
    address.uprn,
    addressLine,
    appointmentToken,
    availabilityReference,
    contactEmail,
    contactName,
    contactNumber,
    contractTermMonths,
    customerReference,
    districtCode,
    goldAddressKey,
    notes,
    offer.productCode,
    offer.productName,
    onPlaced,
    typed,
    workingLineTakeover,
  ]);

  // The same comparison the server uses, so the button enables exactly when
  // the request would be accepted.
  const typedMatches = confirmMatches(typed, addressLine);

  const blocked = Boolean(gate && !gate.allowed) || missing.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={step === 'result' ? 'Order outcome' : `Step ${step === 'review' ? '1' : '2'} of 2`}
      title={step === 'result' ? (result?.accepted ? 'Order placed' : 'Order not placed') : `Order ${offer.productName ?? offer.technology}`}
      subtitle={step === 'result' ? undefined : addressLine}
      width="wide"
      tone={step === 'confirm' && !gate?.demo ? 'danger' : 'default'}
      footer={
        step === 'result' ? (
          <>
            <span className="grow" />
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Close
            </button>
          </>
        ) : step === 'review' ? (
          <>
            <span className="grow muted" style={{ fontSize: 11.5 }}>
              {gate && gate.dailyCap > 0
                ? `${gate.usedToday} of ${gate.dailyCap} orders placed today`
                : 'No daily cap set'}
            </span>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={loading || blocked}
              onClick={() => setStep('confirm')}
            >
              Continue to confirmation
            </button>
          </>
        ) : (
          <>
            <span className="grow" />
            <button type="button" className="btn btn--ghost" onClick={() => setStep('review')} disabled={submitting}>
              Back
            </button>
            <button
              type="button"
              className={gate?.demo ? 'btn btn--primary' : 'btn btn--danger'}
              disabled={!typedMatches || submitting}
              onClick={() => void submit()}
            >
              {submitting ? 'Placing the order…' : gate?.demo ? 'Place this order (rehearsal)' : 'Place this order'}
            </button>
          </>
        )
      }
    >
      {error && <Alert tone="error">{error}</Alert>}

      {loading ? (
        <Spinner label="Fetching pricing and appointments…" />
      ) : step === 'review' ? (
        <div className="stack stack--tight">
          {gate && !gate.allowed && (
            <div className="flag flag--critical">
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>Ordering is locked</strong>
                <span className="flag__detail">{gate.reason}</span>
              </span>
            </div>
          )}

          {gate?.allowed && gate.demo && (
            <div className="flag flag--info">
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>Rehearsal — nothing will be sent</strong>
                <span className="flag__detail">
                  No provider ordering credentials are configured, so this walks the whole flow and then refuses.
                  Nothing is sent to a supplier and your daily cap is not charged.
                </span>
              </span>
            </div>
          )}

          {missing.length > 0 && (
            <div className="flag flag--critical">
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>This premises cannot be ordered from yet</strong>
                <span className="flag__detail">Missing {missing.join('; ')}.</span>
              </span>
            </div>
          )}

          {offer.orderable === false && (
            <div className="flag flag--warn">
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>The provider flagged this product as not orderable</strong>
                <span className="flag__detail">{offer.orderableReason ?? 'No reason given.'}</span>
              </span>
            </div>
          )}

          {existingProvider && (
            <div className="flag flag--warn">
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>{existingProvider.label}</strong>
                <span className="flag__detail">
                  {existingProvider.detail ?? 'This is a migration or takeover, not a fresh provide.'}
                </span>
              </span>
            </div>
          )}

          {/* ---- The money, before anything else ------------------------ */}
          <section
            style={{
              border: '1px solid var(--sw-hairline)',
              borderRadius: 4,
              background: 'var(--sw-panel)',
              padding: 16,
            }}
          >
            <Label>What this costs</Label>
            {quote ? (
              <>
                <div style={{ display: 'flex', gap: 28, marginTop: 8, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--sw-ink)', letterSpacing: '-0.02em' }}>
                      {money(quote.monthlyTotal)}
                    </div>
                    <div className="muted" style={{ fontSize: 11.5 }}>per month, recurring</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--sw-ink)', letterSpacing: '-0.02em' }}>
                      {money(quote.oneOffTotal)}
                    </div>
                    <div className="muted" style={{ fontSize: 11.5 }}>one-off charges</div>
                  </div>
                </div>
                {quote.lines.length > 0 && (
                  <div className="table-wrap" style={{ marginTop: 14 }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Charge</th>
                        <th>Basis</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quote.lines.map((line, i) => (
                        <tr key={`${line.name}-${i}`}>
                          <td>{line.name}</td>
                          <td className="muted">{line.recurring ? (line.frequency ?? 'Monthly') : 'One-off'}</td>
                          <td className="sw-mono" style={{ textAlign: 'right' }}>{money(line.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
                <p className="muted" style={{ fontSize: 11.5, margin: '10px 0 0' }}>
                  Prices as quoted by {quote.source}. Excess construction charges and non-standard installs are not
                  included.
                </p>
              </>
            ) : (
              <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
                No pricing was returned for this product. The order can still be placed, but nobody will have seen the
                cost first — check the price list before continuing.
              </p>
            )}
          </section>

          {/* ---- What is being ordered, and where ---------------------- */}
          <div className="kv">
            <Cell label="Product" value={offer.productName ?? offer.technology} />
            <Cell label="Product code" value={offer.productCode} mono copy />
            <Cell label="Technology" value={offer.technology} />
            <Cell label="Address" value={addressLine} />
            <Cell label="Postcode" value={address.postcode} mono />
            <Cell label="UPRN" value={address.uprn} mono copy />
            <Cell label="Gold Address Key" value={goldAddressKey} mono copy />
            <Cell label="District code" value={districtCode} mono />
            <Cell label="Availability reference" value={availabilityReference} mono copy />
            <Cell label="Engineer required" value={offer.appointmentRequired ?? false} />
          </div>

          {/* ---- Appointment ------------------------------------------- */}
          {offer.appointmentRequired && (
            <label className="field">
              <Label>Engineer appointment</Label>
              {slots.length === 0 ? (
                <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
                  No slots were offered. The order can go without one and the supplier will contact the site — say so
                  in the notes if the customer needs a specific day.
                </p>
              ) : (
                <select
                  className="field__input"
                  value={appointmentToken}
                  onChange={(e) => setAppointmentToken(e.target.value)}
                >
                  <option value="">No appointment — let the supplier arrange it</option>
                  {slots.map((slot) => (
                    <option key={slot.token ?? `${slot.date}-${slot.slot}`} value={slot.token ?? ''}>
                      {formatDate(slot.date)} · {slot.slot}
                      {slot.appointmentType ? ` · type ${slot.appointmentType}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}

          {/* ---- Everything else --------------------------------------- */}
          <div className="two-col">
            <label className="field">
              <Label>Customer reference</Label>
              <input
                className="field__input"
                value={customerReference}
                onChange={(e) => setCustomerReference(e.target.value)}
                placeholder="SW-01234"
              />
            </label>
            <label className="field">
              <Label>Contract term (months)</Label>
              <input
                className="field__input"
                type="number"
                min={1}
                max={60}
                value={contractTermMonths}
                onChange={(e) => setContractTermMonths(e.target.value)}
              />
            </label>
            <label className="field">
              <Label>Site contact name</Label>
              <input className="field__input" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </label>
            <label className="field">
              <Label>Site contact number</Label>
              <input
                className="field__input"
                value={contactNumber}
                onChange={(e) => setContactNumber(e.target.value)}
                placeholder="07700 900123"
              />
            </label>
            <label className="field">
              <Label>Site contact email</Label>
              <input
                className="field__input"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </label>
            <label className="field">
              <Label>Working line takeover</Label>
              <select
                className="field__input"
                value={workingLineTakeover ? 'yes' : 'no'}
                onChange={(e) => setWorkingLineTakeover(e.target.value === 'yes')}
              >
                <option value="no">No — this is a new provide</option>
                <option value="yes">Yes — take over the working line</option>
              </select>
            </label>
          </div>

          <label className="field">
            <Label>Notes for the supplier</Label>
            <textarea
              className="field__input"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Access arrangements, preferred install position, anything the engineer needs to know."
            />
          </label>
        </div>
      ) : step === 'confirm' ? (
        /* ---- Confirmation ------------------------------------------- */
        <div className="stack stack--tight">
          <div className={gate?.demo ? 'flag flag--info' : 'flag flag--critical'}>
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>{gate?.demo ? 'This is a rehearsal' : 'This places a real order'}</strong>
              <span className="flag__detail">
                {gate?.demo
                  ? 'No provider credentials are configured, so nothing will be sent. Every other guard behaves exactly as it will on the day.'
                  : 'It commits spend and, where one is booked, a real engineer visit. Cancelling later may attract a charge, and a provide to the wrong premises is slow to unwind.'}
              </span>
            </span>
          </div>

          <div className="kv">
            <Cell label="Product" value={offer.productName ?? offer.technology} />
            <Cell label="Monthly" value={quote ? money(quote.monthlyTotal) : 'Not quoted'} mono />
            <Cell label="One-off" value={quote ? money(quote.oneOffTotal) : 'Not quoted'} mono />
            <Cell label="Term" value={`${contractTermMonths} months`} />
            <Cell
              label="Appointment"
              value={
                appointmentToken
                  ? (slots.find((s) => s.token === appointmentToken)
                      ? `${formatDate(slots.find((s) => s.token === appointmentToken)!.date)} · ${
                          slots.find((s) => s.token === appointmentToken)!.slot
                        }`
                      : 'Selected')
                  : 'None booked'
              }
            />
            <Cell label="Takeover" value={workingLineTakeover} />
            <Cell label="UPRN" value={address.uprn} mono />
            <Cell label="Customer reference" value={customerReference || undefined} />
          </div>

          <label className="field">
            <Label>Retype the installation address to confirm</Label>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
              Type it exactly as shown: <strong style={{ color: 'var(--sw-ink)' }}>{addressLine}</strong>
            </p>
            <input
              className="field__input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={addressLine}
              autoComplete="off"
              autoFocus
            />
            {typed.trim().length > 0 && !typedMatches && (
              <span className="field__hint" style={{ color: 'var(--sw-crit-ink)' }}>
                That does not match yet.
              </span>
            )}
          </label>
        </div>
      ) : null}

      {step === 'result' && result && (
        <div className="stack stack--tight">
          <div className={result.accepted ? 'flag flag--ok' : 'flag flag--critical'}>
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>{result.accepted ? 'The provider accepted the order' : 'Nothing was placed'}</strong>
              <span className="flag__detail">{result.message ?? (result.accepted ? 'No message returned.' : '')}</span>
            </span>
          </div>

          {result.accepted && (
            <div className="kv">
              <Cell label="Provider reference" value={result.zenReference} mono copy />
              <Cell label="Order reference" value={result.orderReference} mono copy />
              <Cell label="State" value={result.state} />
              <Cell label="Committed date" value={formatDate(result.committedDate)} />
            </div>
          )}

          {result.messages && result.messages.length > 0 && (
            <div>
              <Label>Provider messages</Label>
              <ul style={{ margin: '6px 0 0', paddingLeft: 17, fontSize: 13, lineHeight: 1.65 }}>
                {result.messages.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
            Either way this is in the audit log, under{' '}
            <Chip tone="idle">{result.accepted ? 'order.placed' : 'order.rejected'}</Chip>.
          </p>
        </div>
      )}
    </Modal>
  );
}
