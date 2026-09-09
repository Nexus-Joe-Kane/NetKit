import { downtimeFrom, formatExact, type Downtime } from './downtime';
import { translateTest, type TestFinding } from './lineTestAdvice';
import type { LineTestResult } from './operations';
import type { LineRecord, SiteContact } from './index';

/**
 * Everything an engineer needs when they leave this tool.
 *
 * The moment somebody clicks through to a supplier's portal, they are on a
 * page that knows nothing about the line they came from — and they start
 * alt-tabbing back for the access line ID, then the CLI, then the postcode.
 * This is the block that stops that: every identifier, the state of the line,
 * the last test and what it means, and the site contact, all with a copy
 * button on each and one that copies the lot as a paste-ready summary.
 */

/**
 * The provider's no-show charge, passed on to the customer.
 *
 * Here as a constant, in one place, because it goes in every customer email
 * about a visit and getting it wrong in one template is the kind of mistake
 * that costs an argument. Update it here when the supplier does.
 */
export const NO_SHOW_CHARGE = '£165 + VAT';

/** One copyable fact. */
export interface HandoverField {
  label: string;
  value: string;
  /** Grouped fields share a copy button as well as having their own. */
  group?: 'address' | 'credentials';
  /** True where the value should not be shown until asked for. */
  secret?: boolean;
  mono?: boolean;
}

export interface HandoverInput {
  line: LineRecord;
  latestTest?: LineTestResult;
  /** Who ran it, where the record does not say. */
  testRunBy?: string;
  siteContact?: SiteContact;
  /** The broadband password, only when an operator has asked to see it. */
  password?: string;
  now?: Date;
}

/**
 * The address as three copyable pieces.
 *
 * A supplier form wants the street lines in one box and the postcode in
 * another, so copying the whole single line means deleting half of it in
 * their field. Hence a button for the street part, one for the postcode, and
 * one for everything.
 */
export function addressParts(line: LineRecord): { street: string; postcode: string; whole: string } {
  const a = line.address;
  const lines = a.lines?.length
    ? a.lines
    : [a.subBuilding, a.buildingName, [a.buildingNumber, a.thoroughfare].filter(Boolean).join(' ')].filter(
        (v): v is string => Boolean(v && v.trim()),
      );
  const street = [...lines, a.postTown].filter((v) => v && v.trim()).join(', ');
  return { street, postcode: a.postcode, whole: [street, a.postcode].filter(Boolean).join(', ') };
}

/** Every identifier and fact, in the order an engineer reads them. */
export function handoverFields(input: HandoverInput): HandoverField[] {
  const { line } = input;
  const address = addressParts(line);
  const fields: HandoverField[] = [];

  const add = (label: string, value?: string, extra: Partial<HandoverField> = {}): void => {
    if (value && value.trim()) fields.push({ label, value: value.trim(), ...extra });
  };

  add('Service reference', line.serviceId, { mono: true });
  add('Access line ID', line.lineAccessId, { mono: true });
  add('CLI', line.cli, { mono: true });
  add('Customer reference', line.customerReference, { mono: true });
  add('Customer', line.customerName);
  add('Address', address.street, { group: 'address' });
  add('Postcode', address.postcode, { group: 'address', mono: true });
  add('UPRN', line.address.uprn, { mono: true });
  add('Product', productLabel(line));
  add('Technology', line.technology);
  add('Provider', line.provider);
  add('ONT serial', line.ont?.serial, { mono: true });
  add('Router MAC', line.cpe?.macAddress, { mono: true });
  add('Broadband username', line.radius?.username, { group: 'credentials', mono: true });
  // The password is a separate field and never in the copy-all block: a
  // password pasted into a customer-visible ticket is an incident, not a
  // convenience.
  if (input.password) {
    fields.push({ label: 'Broadband password', value: input.password, group: 'credentials', secret: true, mono: true });
  }

  return fields;
}

export interface HandoverState {
  online: boolean | undefined;
  downtime: Downtime | null;
  /** The last RADIUS event, as a sentence, or null where none is reported. */
  radiusLine: string | null;
  /** True when the product authenticates but nothing has ever been recorded. */
  radiusMissing: boolean;
  findings: TestFinding[];
}

/**
 * Whether this product authenticates at all.
 *
 * Broadband does; a leased line or an Ethernet tail does not, so "no RADIUS
 * session recorded" is a finding on the first and meaningless on the second.
 * Listing the exceptions rather than the rule, because a new broadband
 * technology should default to being expected to authenticate.
 */
const NO_AUTH: readonly string[] = ['EAD', 'Leased Line', 'EoFTTC'];
export const authenticates = (line: LineRecord): boolean => !NO_AUTH.includes(line.technology);

export function handoverState(input: HandoverInput): HandoverState {
  const { line } = input;
  const now = input.now ?? new Date();

  const downtime = downtimeFrom(
    {
      ...(line.downSince ? { downSince: line.downSince } : {}),
      ...(line.radius ? { radius: line.radius } : {}),
      ...(line.sync ? { sync: line.sync } : {}),
    },
    now,
  );

  const radius = line.radius;
  const session = radius?.online === true ? 'Online' : 'Last attempt';
  const auth = radius?.lastAuthAt ?? radius?.onlineSince;
  const protocol = line.technology === 'FTTP' ? 'IPoE or PPPoE' : 'PPPoE';

  const radiusLine =
    radius && (radius.username || auth)
      ? [
          `${session}:`,
          radius.username ? `user ${radius.username}` : null,
          auth ? `at ${formatExact(auth)}` : null,
          radius.nasIpAddress ? `via ${radius.nasIpAddress}` : null,
          `(${protocol})`,
        ]
          .filter(Boolean)
          .join(' ')
      : null;

  return {
    online: radius?.online,
    downtime,
    radiusLine,
    // A line that should authenticate and has never been seen doing so is
    // itself a finding — it usually means the service was never fully
    // provisioned, and that is worth raising rather than retrying a router.
    radiusMissing: authenticates(line) && !radiusLine,
    findings: input.latestTest ? translateTest(input.latestTest) : [],
  };
}

/**
 * One labelled line: bold capitals, then the value in italics.
 *
 * The two weights are doing a job rather than decorating. A label in bold
 * caps scans as a field name, and the value in italics reads as something a
 * machine printed rather than a person writing prose — which is exactly what
 * it is, and what stops a pasted block looking like it is trying too hard.
 *
 * Asterisks for both, which markdown handles unambiguously when the bold run
 * closes before the italic one opens.
 */
const field = (label: string, value: string): string => `**${label.toUpperCase()}:** *${value}*`;

/**
 * The paste-ready summary.
 *
 * Written for a supplier's chat window or a ticket note: a sentence saying
 * what and where, then the identifiers as labelled lines, then the state of
 * the line and the last test with what it means. Deliberately plain text —
 * it gets pasted into boxes that eat formatting.
 *
 * The password is never in here. See `handoverFields`.
 */
export function handoverText(input: HandoverInput): string {
  const { line } = input;
  const state = handoverState(input);
  const address = addressParts(line);

  // The product name usually already carries the speed ("80/20 SOGEA"), so
  // appending the bearer would read "80/20 SOGEA 80/20".
  const product = productLabel(line);
  const who = line.customerReference ?? line.customerName;

  const out: string[] = [
    `Details for ${line.provider}; ${line.technology} line at ${address.whole} provided by ` +
      `${accessProvider(line)}${who ? ` (${who})` : ''}`,
    '',
    field('PRODUCT', product),
  ];

  const maybe = (label: string, value?: string): void => {
    if (value && value.trim()) out.push(field(label, value.trim()));
  };

  maybe('ACCESS LINE ID', line.lineAccessId);
  maybe('CLI', line.cli);
  maybe('SERVICE REFERENCE', line.serviceId);
  maybe('CUSTOMER REFERENCE', line.customerReference);
  maybe('CUSTOMER', line.customerName);
  maybe('ADDRESS', address.whole);
  maybe('UPRN', line.address.uprn);
  maybe('ONT SERIAL', line.ont?.serial);
  maybe('BROADBAND USERNAME', line.radius?.username);

  /* ---- State -------------------------------------------------------- */
  out.push('');
  if (state.online === true) {
    const since = line.radius?.onlineSince;
    out.push(
      field('CURRENT STATUS', since ? `Online since ${formatExact(since)}` : 'Online'),
    );
  } else if (state.downtime) {
    out.push(
      field('CURRENT STATUS', `Offline since ${state.downtime.exact} (${state.downtime.elapsed} ago)`),
    );
  } else {
    out.push(field('CURRENT STATUS', 'Not reported by the provider'));
  }

  if (state.radiusLine) out.push(field('LAST SESSION', state.radiusLine));
  if (state.radiusMissing) {
    out.push(
      field(
        'LAST SESSION',
        'Nothing recorded. A line that should authenticate and never has is usually a provisioning ' +
          'problem rather than a router one — worth raising as a fault if one is not open already.',
      ),
    );
  }

  /* ---- The test ----------------------------------------------------- */
  const test = input.latestTest;
  if (test) {
    const runAt = test.ranAt ? formatExact(test.ranAt) : 'unknown time';
    const runBy = test.ranBy ?? input.testRunBy;
    out.push('', field('RESULTS OF LATEST LINE TEST', `run on ${runAt}${runBy ? ` by ${runBy}` : ''}`));
    out.push(`Outcome: ${test.outcome}${test.faultLocation ? ` — ${test.faultLocation}` : ''}`);
    if (test.summary) out.push(test.summary);

    for (const metric of test.metrics) {
      const flag = metric.verdict === 'fail' ? '  ← FAIL' : metric.verdict === 'warn' ? '  ← warning' : '';
      out.push(`· ${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ''}${flag}`);
    }

    for (const finding of state.findings) {
      out.push('', `What this means: ${finding.meaning}`);
      out.push(...finding.steps.map((step, i) => `  ${i + 1}. ${step}`));
      if (finding.beforeBooking) out.push(`  Before booking a visit: ${finding.beforeBooking}`);
    }
  } else {
    out.push('', field('RESULTS OF LATEST LINE TEST', 'None run. Run one before raising a fault.'));
  }

  if (input.siteContact) {
    out.push(
      '',
      field(
        'ON SITE CONTACT',
        [input.siteContact.name, input.siteContact.email, input.siteContact.phone].filter(Boolean).join(' · '),
      ),
    );
  }

  return out.join('\n');
}

/**
 * Product and speed, without saying the speed twice.
 *
 * Providers put the bearer in the product name more often than not, so this
 * appends it only when it is genuinely missing.
 */
export function productLabel(line: LineRecord): string {
  const name = line.productName?.trim();
  const bearer = line.bearerSpeed?.trim();
  if (!name) return bearer ? `${line.technology} ${bearer}` : line.technology;
  if (!bearer || name.includes(bearer)) return name;
  return `${name} ${bearer}`;
}

/**
 * Who owns the access network under this service.
 *
 * A supplier asks "whose line is it" and means Openreach or the alt-net, not
 * the retailer we buy from. Derived rather than guessed where the record does
 * not say, and left vague rather than wrong.
 */
export function accessProvider(line: LineRecord): string {
  if (line.discoveredVia === 'openreach') return 'Openreach';
  if (line.discoveredVia === 'giacom') return 'BT Wholesale / Openreach';
  const tech = line.technology.toUpperCase();
  if (['FTTC', 'SOGEA', 'ADSL2+', 'GFAST', 'FTTP'].includes(tech)) return 'Openreach';
  return 'the access provider';
}
