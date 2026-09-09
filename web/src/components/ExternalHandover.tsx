import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  BASIS_LABEL,
  addressParts,
  handoverFields,
  productLabel,
  handoverState,
  handoverText,
  msUntilNextStep,
  type LineRecord,
  type LineTestResult,
  type SiteContact,
  type TestFinding,
} from '@sw/shared';
import { SiteVisitBooking } from './SiteVisitBooking';
import { Alert, Chip, CopyButton, Label } from './ui';
import { Modal } from './overlay';

/**
 * What an engineer needs the moment they leave this tool.
 *
 * Click through to a supplier's portal and you are on a page that knows
 * nothing about the line you came from — so you alt-tab back for the access
 * line ID, then the CLI, then the postcode, then the last test. This is the
 * box that stops that.
 *
 * Everything has its own copy button, the address is split the way supplier
 * forms want it, and one button copies the lot as a paste-ready summary.
 *
 * Easy to dismiss: Escape, the close button, or clicking outside. It is a
 * convenience, and a convenience that traps somebody is not one.
 */

const SIDE_TONE = { customer: 'warn', network: 'crit', unclear: 'idle' } as const;
const SIDE_WORD = {
  customer: 'Points inside the building',
  network: 'Points at the provider’s network',
  unclear: 'Which side is unclear',
} as const;

export function ExternalHandover({
  line,
  latestTest,
  siteContact,
  password,
  open,
  onClose,
  destination,
}: {
  line: LineRecord;
  latestTest?: LineTestResult;
  siteContact?: SiteContact;
  /** The broadband password, where an operator is entitled to see it. */
  password?: string;
  open: boolean;
  onClose: () => void;
  /** Where they are going, so the box says why it appeared. */
  destination: string;
}): ReactElement {
  /*
   * The clock.
   *
   * Ticks on the five-minute boundary rather than every second, so the
   * elapsed figure is a round number somebody can read out on a call and does
   * not change halfway through the sentence. The timer is set to the exact
   * moment the number becomes wrong, not to a fixed interval.
   */
  const [now, setNow] = useState(() => new Date());
  const state = useMemo(
    () => handoverState({ line, ...(latestTest ? { latestTest } : {}), now }),
    [line, latestTest, now],
  );

  useEffect(() => {
    if (!open || !state.downtime) return;
    const timer = window.setTimeout(
      () => setNow(new Date()),
      msUntilNextStep(state.downtime.since, now),
    );
    return () => window.clearTimeout(timer);
  }, [open, state.downtime, now]);

  const fields = useMemo(
    () => handoverFields({ line, ...(siteContact ? { siteContact } : {}), ...(password ? { password } : {}) }),
    [line, siteContact, password],
  );
  const address = addressParts(line);

  /*
   * The credentials as one string.
   *
   * Offered only when both halves are in hand — a "username and password"
   * button that copies half of it is worse than no button. Still never part
   * of "copy the lot", which goes into tickets.
   */
  const credentials = useMemo(() => {
    const username = line.radius?.username?.trim();
    if (!username || !password?.trim()) return null;
    return `${username}\n${password.trim()}`;
  }, [line.radius?.username, password]);
  const everything = useMemo(
    () =>
      handoverText({
        line,
        ...(latestTest ? { latestTest } : {}),
        ...(siteContact ? { siteContact } : {}),
        now,
      }),
    [line, latestTest, siteContact, now],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={`Off to ${destination}`}
      title="Everything about this line"
      subtitle="Copy what you need. Escape closes this."
      width="wide"
      footer={
        <>
          <CopyButton value={everything} label="Copy the lot" />
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            The password is never in “copy the lot” — copy it on its own if you need it.
          </span>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Got it
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        {/* State first: whether it is up, and if not, for how long. */}
        <div className={`handover__state${state.online === false ? ' handover__state--down' : ''}`}>
          {state.online === true ? (
            <>
              <Chip tone="ok" dot>
                Online
              </Chip>
              {line.radius?.onlineSince && (
                <span className="handover__since">since {handoverSince(line.radius.onlineSince)}</span>
              )}
            </>
          ) : state.downtime ? (
            <>
              <Chip tone="crit" dot>
                Offline
              </Chip>
              <span className="handover__since">
                since <strong>{state.downtime.exact}</strong> — that is{' '}
                <strong>{state.downtime.elapsed}</strong> ago
              </span>
              <span className="muted" style={{ fontSize: 11 }}>
                ({BASIS_LABEL[state.downtime.basis]})
              </span>
            </>
          ) : (
            <Chip tone="idle">State not reported</Chip>
          )}
        </div>

        {state.radiusLine && <div className="handover__radius">{state.radiusLine}</div>}

        {state.radiusMissing && (
          <Alert tone="warn">
            No authentication has ever been recorded on this line. That is usually a provisioning problem rather
            than a router one — worth raising as a fault if one is not open already.
          </Alert>
        )}

        {/* The identifiers, each with its own button. */}
        <div>
          <Label>Identifiers</Label>
          <div className="handover__fields">
            {fields.map((field) => (
              <HandoverRow key={field.label} label={field.label} value={field.value} secret={field.secret} mono={field.mono} />
            ))}
          </div>

          <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <CopyButton value={address.street} label="Copy address lines" />
            <CopyButton value={address.postcode} label="Copy postcode" />
            <CopyButton value={address.whole} label="Copy the whole address" />
            {/* Both halves together. Copying the username and then having to
                come back for the password is a small thing that reliably
                annoys somebody mid-config, so the pair is one button. */}
            {credentials && <CopyButton value={credentials} label="Copy username and password" />}
          </div>
        </div>

        {/* The last test, and what to do about it. */}
        <div>
          <Label>Latest line test</Label>
          {latestTest ? (
            <div className="handover__test">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip tone={latestTest.outcome === 'pass' ? 'ok' : 'crit'} dot>
                  {latestTest.outcome}
                </Chip>
                <span className="muted" style={{ fontSize: 12 }}>
                  {latestTest.ranAt ? handoverSince(latestTest.ranAt) : 'time not recorded'}
                  {latestTest.ranBy ? ` · ${latestTest.ranBy}` : ''}
                </span>
                {latestTest.faultLocation && <Chip tone="warn">{latestTest.faultLocation}</Chip>}
              </div>

              {latestTest.summary && <p className="handover__summary">{latestTest.summary}</p>}

              {latestTest.metrics.length > 0 && (
                <ul className="handover__metrics">
                  {latestTest.metrics.map((metric) => (
                    <li key={metric.label} className={metric.verdict === 'fail' ? 'is-fail' : metric.verdict === 'warn' ? 'is-warn' : ''}>
                      <span>{metric.label}</span>
                      <span>
                        {metric.value}
                        {metric.unit ? ` ${metric.unit}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {state.findings.map((finding) => (
                <Finding key={finding.kind} finding={finding} />
              ))}
            </div>
          ) : (
            <Alert tone="warn">
              No line test has been run. Run one before raising a fault — a supplier will reject a fault without
              one, and a visit on an untested line is billed as no fault found.
            </Alert>
          )}
        </div>

        {/* The site contact, for booking a visit. */}
        <div>
          <Label>On site contact</Label>
          {siteContact ? (
            <div className="handover__fields">
              <HandoverRow label="Name" value={siteContact.name} />
              {siteContact.email && <HandoverRow label="Email" value={siteContact.email} mono />}
              {siteContact.phone && <HandoverRow label="Phone" value={siteContact.phone} mono />}
              {siteContact.organisation && <HandoverRow label="Organisation" value={siteContact.organisation} />}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
              None loaded. Site contacts come from the customer's ticket — open the fault with a ticket number and
              the picker offers them.
            </p>
          )}
        </div>

        {/*
          * Booking the engineer, here rather than on its own page.
          *
          * This box already holds everything the decision needs: the line,
          * its technology, the latest test and what it means, and the site
          * contact. Sending somebody elsewhere to book means re-establishing
          * all of it, which is how a visit gets booked on a test nobody
          * re-read.
          */}
        <div>
          <Label>Engineer visit</Label>
          <SiteVisitBooking
            supplier={line.provider}
            technology={line.technology}
            findings={state.findings}
            {...(line.orderRef || line.serviceId ? { serviceReference: line.orderRef ?? line.serviceId! } : {})}
            {...(siteContact?.name ? { contactName: siteContact.name } : {})}
          />
        </div>
      </div>
    </Modal>
  );
}

/** One fact with its own copy button, and a reveal where it is a secret. */
function HandoverRow({
  label,
  value,
  secret = false,
  mono = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
  mono?: boolean;
}): ReactElement {
  const [shown, setShown] = useState(false);

  return (
    <div className="handover__row">
      <span className="handover__label">{label}</span>
      <span className={`handover__value${mono ? ' sw-mono' : ''}`}>
        {secret && !shown ? '••••••••••' : value}
      </span>
      <span className="row" style={{ gap: 4 }}>
        {secret && (
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setShown((v) => !v)}>
            {shown ? 'Hide' : 'Show'}
          </button>
        )}
        <CopyButton value={value} label="Copy" />
      </span>
    </div>
  );
}

/** What the test means and what to do, in order, cheapest check first. */
function Finding({ finding }: { finding: TestFinding }): ReactElement {
  return (
    <div className={`handover__finding handover__finding--${finding.severity}`}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip tone={SIDE_TONE[finding.side]} dot>
          {SIDE_WORD[finding.side]}
        </Chip>
      </div>
      <p className="handover__meaning">{finding.meaning}</p>
      <ol className="handover__steps">
        {finding.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {finding.beforeBooking && (
        <p className="handover__before">
          <strong>Before booking a visit:</strong> {finding.beforeBooking}
        </p>
      )}
    </div>
  );
}

/** `08/09/2026 at 14:32:07`, reused so the box reads consistently. */
function handoverSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} at ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}
