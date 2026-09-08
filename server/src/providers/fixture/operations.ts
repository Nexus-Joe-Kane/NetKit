import { formatPostcode, normaliseCli, type AddressRecord } from '@sw/shared';
import type {
  AddressMatch,
  CompanyContext,
  CompanyRecord,
  AddressRegistration,
  AppointmentSlot,
  AvailableTests,
  CallRecord,
  EthernetQuote,
  EthernetQuoteSet,
  FaultRecord,
  FootfallInsight,
  ImeiLookup,
  Incident,
  LineTestResult,
  LineTestType,
  NetworkConnectivityCheck,
  NumberPortCheck,
  EstateUsageReport,
  EstateUsageRow,
  NetworkConfiguration,
  NetworkOption,
  OrderQuote,
  PlaceOrderRequest,
  PlaceOrderResult,
  ProviderNotification,
  ServiceHistory,
  ServiceHistoryEvent,
  OrderRecord,
  ProfileOptions,
  RdnsRecord,
  SimEstate,
  SimRecord,
  StabilityReport,
  TestMetric,
  UsageReport,
} from '@sw/shared';
import { Seeded } from '../../lib/seeded';
import { EXCHANGES, regionFor } from '../../fixtures/uk';

/**
 * Fixtures for the operational surface.
 *
 * Same principle as the site fixtures: everything is seeded from a stable
 * identifier, so the same reference always produces the same fault, the same
 * test result and the same order history. That makes the portal fully
 * demonstrable before any credential exists, and keeps a demo coherent
 * between refreshes.
 */

const isoAt = (daysAgo: number, rng: Seeded): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(rng.int(7, 19), rng.int(0, 59), 0, 0);
  return d.toISOString();
};

/* ------------------------------------------------------------------ *
 * Network status
 * ------------------------------------------------------------------ */

interface IncidentTemplate {
  title: string;
  detail: string;
  impact: Incident['impact'];
}

const OUTAGE_TEMPLATES: IncidentTemplate[] = [
  {
    title: 'Fibre break affecting multiple exchanges',
    detail:
      'A third-party contractor severed a fibre bundle during roadworks. Openreach have a splicing team on site. Services are hard down rather than degraded.',
    impact: 'total_loss',
  },
  {
    title: 'Power failure at exchange',
    detail:
      'Mains failure with generator running. Broadband is up but at risk until mains is restored — avoid raising individual faults for sites in this area.',
    impact: 'at_risk',
  },
  {
    title: 'Congestion on a backhaul link',
    detail:
      'Peak-time throughput is reduced on affected lines. Speed complaints in this area are expected to clear once the additional capacity lands.',
    impact: 'degraded',
  },
  {
    title: 'DSLAM card failure',
    detail: 'A line card has failed at the cabinet. Affected lines will not sync until it is replaced.',
    impact: 'partial_loss',
  },
];

const PLANNED_TEMPLATES: IncidentTemplate[] = [
  {
    title: 'Exchange software upgrade',
    detail: 'Brief loss of service expected during the window. No customer action required.',
    impact: 'partial_loss',
  },
  {
    title: 'Fibre network reinforcement',
    detail: 'Planned reroute onto new fibre. Sessions will drop once and re-establish automatically.',
    impact: 'at_risk',
  },
  {
    title: 'Cabinet battery replacement',
    detail: 'Scheduled maintenance with no expected loss of service.',
    impact: 'no_impact',
  },
];

export function buildFixtureIncidents(kind: 'outage' | 'planned', past = false): Incident[] {
  // Seeded by the day, so the list is stable within a day but moves on.
  const day = new Date().toISOString().slice(0, 10);
  const rng = new Seeded(`incidents:${kind}:${past}:${day}`);
  const templates = kind === 'outage' ? OUTAGE_TEMPLATES : PLANNED_TEMPLATES;
  const count = past ? rng.int(3, 6) : rng.int(1, 3);

  return Array.from({ length: count }, (_, i): Incident => {
    const seed = new Seeded(`incident:${kind}:${past}:${day}:${i}`);
    const template = seed.pick(templates);
    const exchanges = seed.sample(EXCHANGES, seed.int(1, 3));
    const startedDaysAgo = past ? seed.int(10, 90) : kind === 'planned' ? -seed.int(1, 21) : seed.int(0, 4);

    const resolved = past || (kind === 'outage' && seed.bool(0.25));
    const state: Incident['state'] = past
      ? 'resolved'
      : kind === 'planned'
        ? startedDaysAgo < 0
          ? 'scheduled'
          : 'in_progress'
        : resolved
          ? 'monitoring'
          : 'in_progress';

    const updates = Array.from({ length: seed.int(1, 3) }, (_, u) => ({
      at: isoAt(Math.max(0, startedDaysAgo - u), seed),
      text: seed.pick([
        'Engineer despatched, attending site.',
        'Splicing under way, restoration expected within the window.',
        'Root cause identified. Monitoring for stability before closing.',
        'Awaiting third-party access to the duct.',
        'Additional capacity ordered; interim throughput unchanged.',
      ]),
    }));

    return {
      reference: `${kind === 'outage' ? 'MSO' : 'PEW'}${seed.digits(6)}`,
      kind,
      title: template.title,
      detail: template.detail,
      state,
      impact: template.impact,
      startedAt: isoAt(startedDaysAgo, seed),
      ...(kind === 'planned' || !resolved
        ? { endsAt: isoAt(startedDaysAgo - seed.int(1, 3), seed) }
        : {}),
      ...(state === 'resolved' ? { clearedAt: isoAt(Math.max(0, startedDaysAgo - seed.int(1, 4)), seed) } : {}),
      lastUpdatedAt: updates[0]?.at ?? isoAt(startedDaysAgo, seed),
      areasAffected: exchanges.map((e) => `${e.name} (${e.tlc})`),
      updates,
      provider: 'Zen Internet',
      source: 'fixture:assurance',
    };
  });
}

/* ------------------------------------------------------------------ *
 * Faults
 * ------------------------------------------------------------------ */

const FAULT_TEMPLATES: Array<{ category: FaultRecord['category']; summary: string; detail: string }> = [
  {
    category: 'synchronisation',
    summary: 'Line dropping repeatedly — DLM has banded the profile',
    detail:
      'Twelve resyncs in the last 24 hours. SNR margin has been raised to 12 dB by DLM, which has capped the rate well below the estimate.',
  },
  {
    category: 'performance',
    summary: 'Throughput well below the Range A estimate',
    detail: 'Sync rate is healthy but throughput tops out around a third of sync. Suspected congestion or a CPE limitation.',
  },
  {
    category: 'authentication',
    summary: 'PPP authentication rejecting intermittently',
    detail: 'RADIUS shows repeated rejects with the correct username. Suspected RADIUS proxy issue rather than credentials.',
  },
  {
    category: 'synchronisation',
    summary: 'No sync at all following a power cut',
    detail: 'Line has not resynced since the local power failure. Modem shows no DSL light.',
  },
  {
    category: 'voice',
    summary: 'No dial tone, crackling reported before failure',
    detail: 'Classic water ingress signature. Copper test shows low insulation resistance to earth.',
  },
];

export function buildFixtureFaults(options: { state: 'open' | 'closed'; zenReference?: string }): FaultRecord[] {
  const day = new Date().toISOString().slice(0, 10);
  const rng = new Seeded(`faults:${options.state}:${options.zenReference ?? 'all'}:${day}`);
  const count = options.zenReference ? rng.weighted([[0, 6], [1, 3], [2, 1]]) : rng.int(2, 6);

  return Array.from({ length: count }, (_, i): FaultRecord => {
    const seed = new Seeded(`fault:${options.state}:${options.zenReference ?? 'all'}:${day}:${i}`);
    const template = seed.pick(FAULT_TEMPLATES);
    const raisedDaysAgo = options.state === 'open' ? seed.int(0, 9) : seed.int(10, 60);
    const engineer = seed.bool(0.45);

    return {
      reference: `FLT${seed.digits(8)}`,
      zenReference: options.zenReference ?? `ZEN${seed.digits(7)}`,
      serviceId: `BBEU${seed.digits(8)}`,
      cli: `${regionFor('M1 1AE').dialCode}${seed.digits(4)}`.slice(0, 11),
      category: template.category,
      frequency: seed.bool(0.6) ? 'intermittent' : 'permanent',
      status:
        options.state === 'closed'
          ? seed.pick(['Closed — fault cleared', 'Closed — no fault found', 'Closed — customer equipment'])
          : engineer
            ? 'Open — engineer assigned'
            : seed.pick(['Open — under investigation', 'Open — awaiting customer', 'Open — with supplier']),
      state:
        options.state === 'closed'
          ? 'closed'
          : engineer
            ? 'engineer_assigned'
            : seed.bool(0.3)
              ? 'awaiting_customer'
              : 'open',
      summary: template.summary,
      detail: template.detail,
      raisedAt: isoAt(raisedDaysAgo, seed),
      raisedBy: seed.pick(['joe@supportwizard.net', 'helpdesk@supportwizard.net', 'Zen automated monitoring']),
      ...(options.state === 'closed' ? { clearedAt: isoAt(Math.max(0, raisedDaysAgo - seed.int(1, 6)), seed) } : {}),
      careLevel: seed.pick(['Care Level 2 — next working day + 1', 'Care Level 3 — next working day', 'Care Level 4 — 6 clock hours']),
      slaTarget: isoAt(-seed.int(1, 3), seed),
      ...(engineer
        ? {
            appointment: {
              date: isoAt(-seed.int(1, 8), seed).slice(0, 10),
              slot: seed.pick(['AM (08:00–13:00)', 'PM (13:00–18:00)', 'All day']),
              type: 'Fault — engineer visit',
              status: seed.pick(['Booked', 'Confirmed']),
            },
          }
        : {}),
      updates: Array.from({ length: seed.int(1, 3) }, (_, u) => ({
        at: isoAt(Math.max(0, raisedDaysAgo - u * 2), seed),
        text: seed.pick([
          'Line test run — fault indicated toward the D-side.',
          'Customer confirmed the router has been swapped, fault persists.',
          'Openreach engineer attended, no access. Rebooked.',
          'DLM profile reset requested; monitoring for 48 hours.',
          'Fault passed to the supplier for network investigation.',
        ]),
        author: seed.pick(['J. Kane', 'Zen assurance', 'Openreach']),
      })),
      chargeableRisk: seed.bool(0.2),
      provider: 'Zen Internet',
      source: 'fixture:assurance',
    };
  });
}

/* ------------------------------------------------------------------ *
 * Line testing
 * ------------------------------------------------------------------ */

const TEST_LABELS: Record<LineTestType, { label: string; description: string; disruptive?: boolean }> = {
  linetest: {
    label: 'Copper line test',
    description: 'Electrical test of the copper pair — resistance, capacitance and battery. Finds physical faults.',
    disruptive: true,
  },
  xdsltest: { label: 'xDSL test', description: 'Reads the DSLAM: sync rates, SNR margin, attenuation and error counts.' },
  tamtest: { label: 'TAM test', description: 'Walks the stack — modem, DSL, ATM, PPP — to show where the session stops.' },
  kbdtest: { label: 'Known network test', description: 'Checks the service against known network problems.' },
  servicetest: { label: 'Service test', description: 'Fibre service test: ONT state, optical levels and session status.' },
  profilechange: { label: 'Profile change', description: 'Requests a DLM profile reset where a banded profile is capping the line.' },
};

export function buildFixtureAvailableTests(zenReference: string, technology?: string): AvailableTests {
  const fibre = /FTTP|PON|FIBRE/i.test(technology ?? '');
  const types: LineTestType[] = fibre ? ['servicetest'] : ['linetest', 'xdsltest', 'tamtest', 'kbdtest', 'profilechange'];
  return {
    zenReference,
    ...(technology ? { technology: technology as AvailableTests['technology'] } : {}),
    types: types.map((type) => ({ type, ...TEST_LABELS[type] })),
    source: 'fixture:assurance',
  };
}

export function buildFixtureTestResult(zenReference: string, type: LineTestType): LineTestResult {
  const rng = new Seeded(`test:${zenReference}:${type}`);
  // Most lines test clean; the interesting cases are the minority.
  const outcome = rng.weighted<LineTestResult['outcome']>([
    ['pass', 6],
    ['fail', 3],
    ['inconclusive', 1],
  ]);
  const failing = outcome === 'fail';

  const metrics: TestMetric[] = [];
  const add = (label: string, value: string | number, unit?: string, verdict?: TestMetric['verdict']) =>
    metrics.push({
      label,
      value: unit ? `${value} ${unit}` : String(value),
      ...(typeof value === 'number' ? { numeric: value } : {}),
      ...(unit ? { unit } : {}),
      ...(verdict ? { verdict } : {}),
    });

  if (type === 'linetest') {
    const insulation = failing ? rng.int(2, 60) : rng.int(800, 9999);
    add('Insulation resistance A–E', insulation, 'kΩ', insulation < 100 ? 'fail' : 'ok');
    add('Insulation resistance B–E', failing ? rng.int(5, 90) : rng.int(800, 9999), 'kΩ', failing ? 'fail' : 'ok');
    add('Loop resistance', rng.int(120, 900), 'Ω', 'info');
    add('Line capacitance', rng.float(30, 140, 1), 'nF', 'info');
    add('Battery voltage', rng.float(48, 52, 1), 'V', 'ok');
  } else if (type === 'xdsltest') {
    const sync = failing ? rng.int(1500, 8000) : rng.int(18000, 76000);
    add('Downstream sync', sync, 'kbps', failing ? 'warn' : 'ok');
    add('Upstream sync', Math.round(sync * rng.float(0.2, 0.28, 2)), 'kbps');
    add('SNR margin', rng.float(failing ? 12 : 4, failing ? 18 : 9, 1), 'dB', failing ? 'warn' : 'ok');
    add('Line attenuation', rng.float(12, 48, 1), 'dB', 'info');
    add('Errored seconds (24h)', failing ? rng.int(400, 9000) : rng.int(0, 30), undefined, failing ? 'fail' : 'ok');
    add('Retrains (24h)', failing ? rng.int(8, 40) : rng.int(0, 2), undefined, failing ? 'fail' : 'ok');
    add('DLM profile', failing ? 'Interleaved (Banded)' : rng.pick(['Fastpath', 'Interleaved (Standard)']));
  } else if (type === 'tamtest') {
    const stopsAt = failing ? rng.int(1, 4) : 5;
    add('Modem', stopsAt >= 1 ? 'Responding' : 'No response', undefined, stopsAt >= 1 ? 'ok' : 'fail');
    add('DSL', stopsAt >= 2 ? 'In sync' : 'No sync', undefined, stopsAt >= 2 ? 'ok' : 'fail');
    add('ATM', stopsAt >= 3 ? 'Cells passing' : 'No cells', undefined, stopsAt >= 3 ? 'ok' : 'fail');
    add('PPP', stopsAt >= 4 ? 'Session up' : 'Not authenticating', undefined, stopsAt >= 4 ? 'ok' : 'fail');
  } else if (type === 'servicetest') {
    add('ONT status', failing ? 'Loss of signal (LOS)' : 'Operational', undefined, failing ? 'fail' : 'ok');
    add('Optical receive power', rng.float(failing ? -30 : -22, failing ? -27 : -15, 2), 'dBm', failing ? 'fail' : 'ok');
    add('Optical transmit power', rng.float(1.5, 4.5, 2), 'dBm', 'ok');
    add('PON port', `${rng.int(1, 8)}/${rng.int(1, 16)}`);
    add('Session', failing ? 'Down' : 'Up', undefined, failing ? 'fail' : 'ok');
  } else if (type === 'kbdtest') {
    add('Known network fault', failing ? 'Matched an open incident' : 'None matched', undefined, failing ? 'warn' : 'ok');
    add('Planned work in area', rng.bool(0.2) ? 'Yes' : 'No', undefined, 'info');
  }

  const faultLocation = failing
    ? rng.pick([
        'Customer side of the NTE',
        'D-side — between the cabinet and the premises',
        'E-side — between the exchange and the cabinet',
        'Exchange equipment',
        'Network — beyond the access line',
      ])
    : undefined;

  const recommendations = failing
    ? [
        faultLocation?.startsWith('Customer')
          ? 'Ask the customer to test at the master socket with a known-good router before raising a fault — a visit would be chargeable otherwise.'
          : 'Raise a fault in the matching category. Include this test result to avoid a repeat test.',
        type === 'xdsltest' ? 'A DLM profile reset is worth requesting once the underlying fault is cleared.' : null,
      ].filter((r): r is string => Boolean(r))
    : ['No action needed. Keep this result — it evidences a clean line if the customer escalates.'];

  return {
    id: `TST${rng.digits(8)}`,
    zenReference,
    type,
    outcome,
    ...(faultLocation ? { faultLocation } : {}),
    summary: failing
      ? `Test failed — fault indicated ${faultLocation?.toLowerCase()}`
      : outcome === 'inconclusive'
        ? 'Test could not reach a verdict; the line was in use during the test'
        : 'Test passed — no fault found on the access line',
    ranAt: isoAt(rng.int(0, 3), rng),
    ranBy: 'joe@supportwizard.net',
    pending: false,
    metrics,
    recommendations,
    provider: 'Zen Internet',
    source: `fixture:assurance:${type}`,
  };
}

export function buildFixtureProfileOptions(zenReference: string): ProfileOptions {
  const rng = new Seeded(`profile:${zenReference}`);
  return {
    zenReference,
    current: rng.pick(['Interleaved (Standard)', 'Interleaved (Banded)', 'Fastpath']),
    options: [
      { code: 'FASTPATH', label: 'Fastpath', description: 'Lowest latency. Best for voice and gaming on a stable line.' },
      { code: 'INTERLEAVED_STANDARD', label: 'Interleaved (Standard)', description: 'Default. Adds error correction at a small latency cost.' },
      { code: 'INTERLEAVED_DEEP', label: 'Interleaved (Deep)', description: 'Maximum error correction for a noisy line.' },
      { code: 'RESET', label: 'Reset DLM banding', description: 'Clears an applied band so the line can retrain to its natural rate.' },
    ],
    source: 'fixture:assurance',
  };
}

export function buildFixtureStability(zenReference: string, days = 30): StabilityReport {
  const rng = new Seeded(`stability:${zenReference}`);
  // An unstable line is the minority case but the one worth seeing.
  const unstable = rng.bool(0.3);

  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const seed = new Seeded(`drops:${zenReference}:${i}`);
    return {
      date: d.toISOString().slice(0, 10),
      drops: unstable ? seed.weighted([[0, 3], [seed.int(1, 4), 4], [seed.int(5, 22), 2]]) : seed.weighted([[0, 9], [1, 1]]),
    };
  });

  const attempts = Array.from({ length: rng.int(6, 18) }, (_, i) => {
    const seed = new Seeded(`auth:${zenReference}:${i}`);
    const reject = unstable && seed.bool(0.35);
    return {
      at: isoAt(seed.int(0, days), seed),
      result: reject ? ('reject' as const) : ('accept' as const),
      ...(reject
        ? { reason: seed.pick(['Invalid credentials', 'No response from RADIUS proxy', 'Session limit exceeded', 'Line suspended']) }
        : {}),
      nasIpAddress: `10.${seed.int(0, 255)}.${seed.int(0, 255)}.${seed.int(1, 254)}`,
    };
  }).sort((a, b) => b.at.localeCompare(a.at));

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  return {
    zenReference,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    totalDrops: buckets.reduce((s, b) => s + b.drops, 0),
    buckets,
    authenticationAttempts: attempts,
    source: 'fixture:assurance',
  };
}

export function buildFixtureUsage(zenReference: string, period: UsageReport['period'] = 'current_month'): UsageReport {
  const rng = new Seeded(`usage:${zenReference}:${period}`);
  const days = period === 'day' ? 1 : 30;

  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const seed = new Seeded(`usageday:${zenReference}:${i}`);
    // Weekends run heavier than weekdays on a residential line.
    const weekend = [0, 6].includes(d.getUTCDay());
    const base = seed.int(2, weekend ? 45 : 22) * 1024 ** 3;
    return {
      date: d.toISOString().slice(0, 10),
      bytesIn: base,
      bytesOut: Math.round(base * seed.float(0.06, 0.22, 3)),
    };
  });

  const bytesIn = buckets.reduce((s, b) => s + b.bytesIn, 0);
  const bytesOut = buckets.reduce((s, b) => s + b.bytesOut, 0);
  const capped = rng.bool(0.2);

  return {
    zenReference,
    period,
    from: buckets[0]?.date,
    to: buckets[buckets.length - 1]?.date,
    bytesIn,
    bytesOut,
    totalBytes: bytesIn + bytesOut,
    ...(capped ? { capBytes: 1024 ** 4 } : {}),
    buckets,
    source: 'fixture:assurance',
  };
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

export function buildFixtureOrders(searchTerm?: string): OrderRecord[] {
  const day = new Date().toISOString().slice(0, 10);
  const rng = new Seeded(`orders:${searchTerm ?? 'all'}:${day}`);
  const count = searchTerm ? rng.int(1, 3) : rng.int(4, 9);

  return Array.from({ length: count }, (_, i): OrderRecord => {
    const seed = new Seeded(`order:${searchTerm ?? 'all'}:${day}:${i}`);
    const state = seed.weighted<OrderRecord['state']>([
      ['in_progress', 5],
      ['awaiting_appointment', 3],
      ['completed', 3],
      ['delayed', 2],
      ['submitted', 2],
      ['cancelled', 1],
    ]);
    const type = seed.weighted<OrderRecord['type']>([
      ['provide', 6],
      ['modify', 2],
      ['cease', 2],
    ]);
    const placedDaysAgo = seed.int(1, 40);
    const needsEngineer = seed.bool(0.55);

    // An order with no installation address is not a realistic order — the
    // detail dialog and the CSV export both lead with it.
    const orderPostcode = seed.pick(['M1 1AE', 'LS1 4AP', 'EH1 1YZ', 'SL1 1XY', 'CF10 1EP', 'BS1 4DJ']);
    const orderRegion = regionFor(orderPostcode);
    const houseNumber = seed.int(1, 180);
    const street = seed.pick(['High Street', 'Mill Lane', 'Station Road', 'Church Street', 'Manor Road']);
    const singleLine = `${houseNumber} ${street}, ${orderRegion.town.toUpperCase()}, ${orderPostcode}`;

    return {
      zenReference: `ZEN${seed.digits(7)}`,
      customerReference: `SW-${seed.digits(5)}`,
      orderReference: `ORD${seed.digits(8)}`,
      type,
      state,
      ...(state === 'delayed'
        ? { stateReason: seed.pick(['Awaiting Openreach civils', 'No access at appointment', 'Awaiting customer confirmation']) }
        : {}),
      productName: seed.pick(['Full Fibre 900', 'Full Fibre 500', 'SOGEA 80/20', 'Unlimited Fibre 2', 'FTTP 330/50']),
      productCode: `PRD${seed.digits(5)}`,
      cli: `${regionFor('M1 1AE').dialCode}${seed.digits(4)}`.slice(0, 11),
      serviceId: `BBFB${seed.digits(8)}`,
      accessLineId: `AL${seed.digits(9)}`,
      placedAt: isoAt(placedDaysAgo, seed),
      committedDate: isoAt(placedDaysAgo - seed.int(5, 20), seed).slice(0, 10),
      ...(state === 'completed' ? { completedAt: isoAt(seed.int(1, 10), seed).slice(0, 10) } : {}),
      ...(needsEngineer && state !== 'completed'
        ? {
            appointment: {
              reference: `APP${seed.digits(7)}`,
              date: isoAt(-seed.int(1, 14), seed).slice(0, 10),
              slot: seed.pick(['AM (08:00–13:00)', 'PM (13:00–18:00)', 'All day']),
              type: 'Provide — engineer install',
              status: seed.pick(['Booked', 'Confirmed']),
            },
          }
        : {}),
      ...(state === 'delayed' ? { delayReason: 'Openreach have raised a civils requirement — new date to follow.' } : {}),
      address: {
        uprn: seed.digits(12),
        singleLine,
        lines: [`${houseNumber} ${street}`],
        postTown: orderRegion.town.toUpperCase(),
        postcode: orderPostcode,
        source: 'mock',
      },
      supplier: seed.pick(['Openreach', 'Openreach', 'CityFibre', 'BT Wholesale']),
      requiresEngineer: needsEngineer,
      workingLineTakeover: seed.bool(0.3),
      contactName: seed.pick(['A. Patel', 'S. Okafor', 'R. Davies', 'L. Nowak']),
      contactEmail: 'customer@example.com',
      provider: 'Zen Internet',
      source: 'fixture:self-service',
    };
  });
}

export function buildFixtureAppointments(): AppointmentSlot[] {
  const rng = new Seeded(`appointments:${new Date().toISOString().slice(0, 10)}`);
  const slots: AppointmentSlot[] = [];
  for (let day = 3; day < 21; day += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + day);
    // Openreach do not do provide appointments at weekends.
    if ([0, 6].includes(d.getUTCDay())) continue;
    const seed = new Seeded(`appt:${day}`);
    for (const slot of ['AM', 'PM'] as const) {
      if (seed.bool(0.65)) {
        slots.push({
          date: d.toISOString().slice(0, 10),
          slot: slot === 'AM' ? 'AM (08:00–13:00)' : 'PM (13:00–18:00)',
          appointmentType: 'Standard',
          token: JSON.stringify({ date: d.toISOString().slice(0, 10), timeSlot: slot === 'AM' ? 0 : 1, appointmentType: 0 }),
        });
      }
    }
  }
  return slots.slice(0, rng.int(10, 18));
}

export function buildFixturePricing(productCode: string, productName?: string): OrderQuote {
  const rng = new Seeded(`pricing:${productCode}`);
  const lines = [
    { name: productName ?? 'Broadband rental', amount: rng.int(24, 68), recurring: true, frequency: 'Monthly', category: 'Broadband' },
    { name: 'Care level 2', amount: rng.int(3, 9), recurring: true, frequency: 'Monthly', category: 'Care' },
    { name: 'Static IPv4 address', amount: rng.int(2, 6), recurring: true, frequency: 'Monthly', category: 'IP' },
    { name: 'Activation charge', amount: rng.int(0, 60), recurring: false, category: 'One-off' },
    ...(rng.bool(0.4) ? [{ name: 'Engineer install', amount: rng.int(60, 180), recurring: false, category: 'One-off' }] : []),
  ];
  return {
    productCode,
    ...(productName ? { productName } : {}),
    lines,
    monthlyTotal: lines.filter((l) => l.recurring).reduce((s, l) => s + l.amount, 0),
    oneOffTotal: lines.filter((l) => !l.recurring).reduce((s, l) => s + l.amount, 0),
    currency: 'GBP',
    source: 'fixture:self-service',
  };
}

/**
 * Demo mode never places an order.
 *
 * Every other fixture in this file invents plausible data, because a
 * plausible read is useful. A plausible *order* is not: it would hand back a
 * reference that no provider has ever heard of, and someone would chase it.
 * So this refuses, and says why.
 */
export function buildFixturePlaceOrder(request: PlaceOrderRequest): PlaceOrderResult {
  return {
    accepted: false,
    message:
      'Demo mode — nothing was sent to Zen. Add Zen ordering credentials and set ZEN_ALLOW_ORDERING=true to place real orders.',
    messages: [
      // The address line usually ends with the postcode already, so only
      // append it when it does not — a duplicated postcode reads as a bug.
      `Would have ordered ${request.productName ?? request.productCode} at ${request.addressLine}${
        request.addressLine.toUpperCase().includes(request.postcode.toUpperCase()) ? '' : `, ${request.postcode}`
      }.`,
      `Availability reference ${request.availabilityReference}, Gold Address Key ${request.goldAddressKey}.`,
    ],
    source: 'fixture:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Number porting
 * ------------------------------------------------------------------ */

export function buildFixturePortCheck(phoneNumber: string): NumberPortCheck {
  const normalised = normaliseCli(phoneNumber) ?? phoneNumber;
  const rng = new Seeded(`port:${normalised}`);
  const canBePorted = rng.bool(0.78);

  return {
    reference: `NP${rng.digits(8)}`,
    phoneNumber: normalised,
    canBePorted,
    pending: false,
    currentProvider: rng.pick(['BT', 'Sky', 'TalkTalk', 'Virgin Media', 'Vodafone', 'Gamma']),
    exchangePrefix: normalised.slice(0, 5),
    cupid: rng.digits(4),
    messages: canBePorted
      ? ['Number is portable. The losing provider has 10 working days to object.']
      : [
          rng.pick([
            'Number is part of a multi-line group and cannot be ported individually.',
            'Number is not recognised on the losing provider’s range holder record.',
            'Number is already subject to an in-flight port.',
          ]),
        ],
    checkedAt: new Date().toISOString(),
    source: 'fixture:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Ethernet
 * ------------------------------------------------------------------ */

export function buildFixtureEthernetQuotes(address: AddressRecord): EthernetQuoteSet {
  const rng = new Seeded(`ethernet:${address.uprn ?? address.postcode}`);

  const quotes: EthernetQuote[] = (
    [
      { name: 'EAD 100/100 (Ethernet Access Direct)', bearer: 1000, committed: 100, tech: 'EAD' as const },
      { name: 'EAD 200/200', bearer: 1000, committed: 200, tech: 'EAD' as const },
      { name: 'EAD 1000/1000', bearer: 1000, committed: 1000, tech: 'EAD' as const },
      { name: 'EoFTTC 20/20', bearer: 80, committed: 20, tech: 'EoFTTC' as const },
    ] as const
  ).map((q, i) => {
    const ecc = rng.bool(0.35) ? rng.int(1200, 18000) : 0;
    return {
      id: `eth-${i + 1}`,
      productName: q.name,
      bearerMbps: q.bearer,
      committedMbps: q.committed,
      technology: q.tech,
      monthlyCharge: Math.round(q.committed * rng.float(0.9, 1.8, 2) + 120),
      installCharge: rng.int(500, 2600),
      ...(ecc ? { excessConstruction: ecc } : {}),
      termMonths: rng.pick([36, 60]),
      leadTimeDays: rng.int(45, 110),
      indicative: true,
      notes: [
        'Indicative only — not a quotation. A firm price needs a survey.',
        ...(ecc ? [`Survey flagged excess construction of about £${ecc.toLocaleString('en-GB')}.`] : []),
        `Lead time assumes no wayleave is required.`,
      ],
      source: 'fixture:self-service',
    };
  });

  return { address, quotes, checkedAt: new Date().toISOString(), sources: ['fixture:self-service'] };
}

/* ------------------------------------------------------------------ *
 * SIMs
 * ------------------------------------------------------------------ */

export function buildFixtureSimEstate(): SimEstate {
  const rng = new Seeded('sims:estate');
  const count = rng.int(8, 22);

  const sims: SimRecord[] = Array.from({ length: count }, (_, i) => {
    const seed = new Seeded(`sim:${i}`);
    const state = seed.weighted<SimRecord['state']>([
      ['active', 8],
      ['suspended', 2],
      ['pending', 2],
      ['ceased', 1],
    ]);
    const allowance = seed.pick([1, 2, 5, 10, 20, 50]) * 1024 ** 3;
    const used = state === 'active' ? Math.round(allowance * seed.float(0.05, 1.35, 3)) : 0;

    return {
      // ICCIDs are 19-20 digits and start 8944 for UK issuers.
      iccid: `8944${seed.digits(15)}`,
      zenReference: `ZEN${seed.digits(7)}`,
      msisdn: `07700${seed.digits(6)}`,
      imsi: `234${seed.digits(12)}`,
      state,
      network: seed.pick(['EE', 'Vodafone', 'O2', 'Three']),
      postcode: formatPostcode(seed.pick(['M1 1AE', 'LS1 4DY', 'W8 5TT', 'B1 1BB'])),
      allowanceBytes: allowance,
      ...(seed.bool(0.25) ? { boltOnBytes: seed.pick([1, 5, 10]) * 1024 ** 3 } : {}),
      usedBytes: used,
      ...(state === 'suspended' ? { bars: seed.sample(['Data', 'Voice', 'Roaming', 'Premium rate'], seed.int(1, 2)) } : {}),
      attached: state === 'active' && seed.bool(0.88),
      lastSeenAt: isoAt(state === 'active' ? seed.int(0, 2) : seed.int(10, 90), seed),
      apn: seed.pick(['internet', 'jolamobile', 'mobile.zen.co.uk']),
      ...(state === 'active' && seed.bool(0.4) ? { ipAddress: `10.${seed.int(0, 255)}.${seed.int(0, 255)}.${seed.int(1, 254)}` } : {}),
      provider: 'Zen Internet (Jola)',
      source: 'fixture:self-service',
    };
  });

  const active = sims.filter((s) => s.state === 'active');
  const poolSize = active.reduce((s, x) => s + (x.allowanceBytes ?? 0), 0);
  const poolUsed = active.reduce((s, x) => s + (x.usedBytes ?? 0), 0);

  return {
    sims,
    pool: {
      name: 'Shared data pool',
      sizeBytes: poolSize,
      usedBytes: poolUsed,
      simCount: active.length,
      overageBytes: Math.max(0, poolUsed - poolSize),
    },
    checkedAt: new Date().toISOString(),
    sources: ['fixture:self-service'],
  };
}

/* ------------------------------------------------------------------ *
 * Mobile device checks
 * ------------------------------------------------------------------ */

export function buildFixtureConnectivity(phoneNumber: string): NetworkConnectivityCheck {
  const normalised = normaliseCli(phoneNumber) ?? phoneNumber;
  const rng = new Seeded(`connectivity:${normalised}`);
  const connected = rng.bool(0.82);
  const roaming = connected && rng.bool(0.12);

  return {
    msisdn: normalised,
    connected,
    network: 'EE',
    roaming,
    ...(roaming ? { country: rng.pick(['Ireland', 'France', 'Spain', 'United States']) } : { country: 'United Kingdom' }),
    lastSeenAt: isoAt(connected ? 0 : rng.int(1, 30), rng),
    reachable: connected,
    messages: connected
      ? roaming
        ? ['Device is attached but roaming — check the bundle covers the country before troubleshooting data.']
        : ['Device is attached to the network and reachable.']
      : ['Device is not currently attached. Handset may be off, out of coverage, or the SIM may be barred.'],
    checkedAt: new Date().toISOString(),
    provider: 'BT — Home Network',
    source: 'fixture:bt',
  };
}

interface Handset {
  tac: string;
  manufacturer: string;
  model: string;
  caps: string[];
}

const HANDSETS: Handset[] = [
  { tac: '35328611', manufacturer: 'Apple', model: 'iPhone 15 Pro', caps: ['VoLTE', 'Wi-Fi calling', '5G SA', 'eSIM'] },
  { tac: '35692011', manufacturer: 'Apple', model: 'iPhone 13', caps: ['VoLTE', 'Wi-Fi calling', '5G NSA', 'eSIM'] },
  { tac: '35404511', manufacturer: 'Samsung', model: 'Galaxy S24', caps: ['VoLTE', 'Wi-Fi calling', '5G SA', 'eSIM'] },
  { tac: '35171410', manufacturer: 'Samsung', model: 'Galaxy A55', caps: ['VoLTE', 'Wi-Fi calling', '5G NSA'] },
  { tac: '35847010', manufacturer: 'Google', model: 'Pixel 8', caps: ['VoLTE', 'Wi-Fi calling', '5G SA', 'eSIM'] },
  { tac: '86891104', manufacturer: 'Teltonika', model: 'RUT240 (router)', caps: ['LTE Cat4'] },
];

export function buildFixtureImei(phoneNumber: string): ImeiLookup {
  const normalised = normaliseCli(phoneNumber) ?? phoneNumber;
  const rng = new Seeded(`imei:${normalised}`);
  const handset = rng.pick(HANDSETS);
  const imei = `${handset.tac}${rng.digits(6)}`;

  return {
    msisdn: normalised,
    imei,
    tac: handset.tac,
    manufacturer: handset.manufacturer,
    model: handset.model,
    capabilities: [...handset.caps],
    blacklisted: rng.bool(0.04),
    messages: [
      'The IMEI identifies the handset currently using this number.',
      ...(handset.caps.includes('Wi-Fi calling')
        ? ['Handset supports Wi-Fi calling — worth enabling where indoor signal is weak.']
        : ['Handset does not report Wi-Fi calling support, so a weak indoor signal cannot be worked around in software.']),
    ],
    checkedAt: new Date().toISOString(),
    provider: 'BT — IMEI Lookup',
    source: 'fixture:bt',
  };
}

export function buildFixtureFootfall(postcode: string): FootfallInsight {
  const rng = new Seeded(`footfall:${postcode}`);
  const days = 28;

  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const seed = new Seeded(`ff:${postcode}:${i}`);
    const weekend = [0, 6].includes(d.getUTCDay());
    const base = rng.int(1800, 14000);
    return {
      date: d.toISOString().slice(0, 10),
      visitors: Math.round(base * (weekend ? seed.float(1.15, 1.6, 2) : seed.float(0.8, 1.1, 2))),
    };
  });

  return {
    areaName: formatPostcode(postcode),
    granularity: 'Postcode sector, daily',
    from: series[0]?.date,
    to: series[series.length - 1]?.date,
    series,
    catchment: [
      { area: 'Within 1 km', share: rng.float(0.28, 0.44, 2) },
      { area: '1–5 km', share: rng.float(0.2, 0.3, 2) },
      { area: '5–20 km', share: rng.float(0.12, 0.2, 2) },
      { area: 'Over 20 km', share: rng.float(0.05, 0.14, 2) },
      { area: 'Overseas', share: rng.float(0.01, 0.08, 2) },
    ],
    hourly: Array.from({ length: 24 }, (_, hour) => {
      const seed = new Seeded(`ffh:${postcode}:${hour}`);
      // A plausible retail curve: quiet overnight, peaking early afternoon.
      const shape = hour < 6 ? 0.05 : hour < 9 ? 0.35 : hour < 12 ? 0.8 : hour < 15 ? 1 : hour < 19 ? 0.85 : hour < 22 ? 0.45 : 0.15;
      return { hour, visitors: Math.round(900 * shape * seed.float(0.85, 1.15, 2)) };
    }),
    coverageNote: 'Demo data. The live BT product covers Greater London only.',
    provider: 'BT — Location Insights for London',
    source: 'fixture:bt',
  };
}

/* ------------------------------------------------------------------ *
 * Call records and rDNS
 * ------------------------------------------------------------------ */

export function buildFixtureCallRecords(from: Date, to: Date): CallRecord[] {
  const rng = new Seeded(`cdrs:${from.toISOString().slice(0, 10)}`);
  return Array.from({ length: rng.int(12, 40) }, (_, i): CallRecord => {
    const seed = new Seeded(`cdr:${from.toISOString().slice(0, 10)}:${i}`);
    const started = new Date(from.getTime() + seed.next() * (to.getTime() - from.getTime()));
    const classification = seed.weighted([
      ['UK Geographic', 6],
      ['UK Mobile', 4],
      ['Freephone', 2],
      ['International', 1],
      ['Premium rate', 1],
    ] as const);
    const duration = seed.weighted([
      [seed.int(5, 60), 4],
      [seed.int(60, 600), 4],
      [seed.int(600, 3600), 1],
    ]);
    const rate = classification === 'International' ? 0.12 : classification === 'Premium rate' ? 0.4 : classification === 'UK Mobile' ? 0.02 : 0.008;

    return {
      id: String(i + 1),
      startedAt: started.toISOString(),
      sourceNumber: `${regionFor('M1 1AE').dialCode}${seed.digits(4)}`.slice(0, 11),
      presentationNumber: `${regionFor('M1 1AE').dialCode}${seed.digits(4)}`.slice(0, 11),
      destinationNumber: classification === 'UK Mobile' ? `07700${seed.digits(6)}` : `0${seed.int(1, 2)}${seed.digits(9)}`.slice(0, 11),
      durationSeconds: duration,
      classification,
      destinationDescription: seed.pick(['Manchester', 'London', 'Leeds', 'Mobile', 'Dublin', 'Freephone']),
      dialCode: seed.digits(4),
      costPounds: Number(((duration / 60) * rate).toFixed(3)),
      source: 'fixture:self-service',
    };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function buildFixtureRdns(zenReference?: string): RdnsRecord[] {
  const rng = new Seeded(`rdns:${zenReference ?? 'all'}`);
  return Array.from({ length: rng.int(2, 6) }, (_, i) => {
    const seed = new Seeded(`rdnsrec:${zenReference ?? 'all'}:${i}`);
    const ip = `${seed.int(51, 88)}.${seed.int(0, 255)}.${seed.int(0, 255)}.${seed.int(1, 254)}`;
    return {
      ipAddress: ip,
      ...(seed.bool(0.6) ? { hostname: `host-${ip.replace(/\./g, '-')}.customer.example.net` } : {}),
      ...(zenReference ? { zenReference } : { zenReference: `ZEN${seed.digits(7)}` }),
      editable: true,
      source: 'fixture:self-service',
    };
  });
}

/* ------------------------------------------------------------------ *
 * Address references and Openreach registration
 * ------------------------------------------------------------------ */

/**
 * Demo address matching, with a deliberate disagreement.
 *
 * Roughly one premises in five has a BTW reference that differs from the
 * Openreach one, because that is the case the screen exists for — a fixture
 * where the two always agree would never show the operator what a mismatch
 * looks like.
 */
export function buildFixtureAddressMatch(query: {
  postcode: string;
  postTown?: string;
  premiseName?: string;
  thoroughfareNumber?: string;
}): AddressMatch {
  const key = `${query.postcode}|${query.premiseName ?? ''}|${query.thoroughfareNumber ?? ''}`;
  const rng = new Seeded(`addrmatch:${key}`);
  const found = rng.bool(0.9);
  if (!found) {
    return {
      query,
      agrees: false,
      messages: ['No wholesale address matched that search. The premises may need registering with Openreach.'],
      source: 'fixture:self-service',
    };
  }

  const bto = `A${rng.digits(11)}`;
  const disagrees = rng.bool(0.2);
  const btw = disagrees ? `W${rng.digits(11)}` : `W${bto.slice(1)}`;

  return {
    query,
    btoAddressReference: bto,
    btwAddressReference: btw,
    // Derived from the postcode's region, the same way the availability
    // fixture does it — a Manchester postcode returning an Edinburgh district
    // code is the kind of incoherence that makes demo data useless.
    districtCode: `${(regionFor(query.postcode).exchanges[0] ?? 'XX').slice(0, 2)}${rng.int(10, 99)}`,
    uprn: rng.digits(12),
    agrees: true,
    messages: disagrees
      ? [
          'Openreach and BT Wholesale hold different references for this premises. Order against the Openreach reference and expect BTW validation to query it.',
        ]
      : [],
    source: 'fixture:self-service',
  };
}

/** Demo registration. Never actually registers anything, and says so. */
export function buildFixtureAddressRegistration(request: {
  postcode: string;
  thoroughfare: string;
  postTown: string;
}): AddressRegistration {
  const rng = new Seeded(`addrreg:${request.postcode}:${request.thoroughfare}`);
  return {
    created: false,
    technologyRestrictions: rng.bool(0.4)
      ? [{ technology: 'FTTP', reason: 'No fibre spine serving this exchange area yet.' }]
      : [],
    messages: [
      'Demo mode — no address was registered with Openreach.',
      `Would have registered ${request.thoroughfare}, ${request.postTown}, ${request.postcode}.`,
    ],
    source: 'fixture:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Service history
 * ------------------------------------------------------------------ */

export function buildFixtureServiceHistory(zenReference: string): ServiceHistory {
  const rng = new Seeded(`history:${zenReference}`);
  const events: ServiceHistoryEvent[] = [];

  // A plausible life story for a line, oldest first, then reversed.
  const provided = rng.int(400, 1500);
  events.push({
    at: isoAt(provided, rng),
    type: 'Provide',
    description: 'Service activated',
    reference: `ZO${rng.digits(8)}`,
  });
  if (rng.bool(0.6)) {
    events.push({
      at: isoAt(rng.int(120, provided - 30), rng),
      type: 'Regrade',
      description: 'Speed profile changed',
      from: rng.pick(['FTTC 40/10', 'ADSL2+ 24/1', 'SOGEA 40/10']),
      to: rng.pick(['SOGEA 80/20', 'FTTP 330/50', 'FTTP 500/70']),
      reference: `ZO${rng.digits(8)}`,
    });
  }
  if (rng.bool(0.45)) {
    events.push({
      at: isoAt(rng.int(30, 120), rng),
      type: 'Care level',
      description: 'Care level changed',
      from: 'Care level 1',
      to: 'Care level 2',
      actor: 'SupportWizard',
    });
  }
  if (rng.bool(0.3)) {
    events.push({
      at: isoAt(rng.int(2, 30), rng),
      type: 'IP allocation',
      description: 'Static IPv4 block added',
      to: '/29',
      actor: 'SupportWizard',
    });
  }

  return {
    zenReference,
    events: events.sort((a, b) => b.at.localeCompare(a.at)),
    source: 'fixture:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

const NOTIFICATIONS: Array<[ProviderNotification['severity'], string, string, string]> = [
  [
    'critical',
    'Stop sell',
    'WLR stop-sell reached at a further 118 exchanges',
    'Analogue lines and FTTC can no longer be ordered at these exchanges. Any provide must be SOGEA or FTTP. Existing services are unaffected until the withdrawal date.',
  ],
  [
    'warn',
    'Price change',
    'Openreach annual price change effective 1 April',
    'GEA-FTTC and GEA-FTTP rental rates change. Affected services will show the new rate on the next invoice.',
  ],
  [
    'warn',
    'Product withdrawal',
    'ADSL2+ closed to new provides',
    'Existing services continue. Any regrade must move to SOGEA or FTTP.',
  ],
  [
    'info',
    'Platform',
    'Self-service API maintenance window',
    'A two-hour window is planned overnight. Availability checks and order placement will return 503 during the window.',
  ],
  [
    'info',
    'Product',
    'FTTP 1000/115 now available on the standard price list',
    'No action required. The product appears automatically in availability results where the premises supports it.',
  ],
  [
    'warn',
    'Migration',
    'Copper line migration programme — batch 14',
    'Services on the attached list will be migrated within 90 days. Router reconfiguration is not required.',
  ],
];

export function buildFixtureNotifications(options: { since?: string; searchTerm?: string } = {}): ProviderNotification[] {
  const day = new Date().toISOString().slice(0, 10);
  const rng = new Seeded(`notifications:${day}`);
  const all = NOTIFICATIONS.map(([severity, category, title, detail], i): ProviderNotification => {
    const seed = new Seeded(`notification:${day}:${i}`);
    return {
      id: `NOTE-${seed.digits(6)}`,
      publishedAt: isoAt(seed.int(0, 45), seed),
      category,
      severity,
      title,
      detail,
      ...(severity !== 'info' ? { actionRequiredBy: isoAt(-seed.int(14, 90), seed) } : {}),
      read: seed.bool(0.5),
      source: 'fixture:self-service',
    };
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const term = options.searchTerm?.trim().toLowerCase();
  const filtered = term
    ? all.filter((n) => `${n.title} ${n.detail ?? ''} ${n.category ?? ''}`.toLowerCase().includes(term))
    : all;
  return options.since ? filtered.filter((n) => n.publishedAt >= options.since!) : filtered.slice(0, rng.int(4, 6));
}

/* ------------------------------------------------------------------ *
 * Network management
 * ------------------------------------------------------------------ */

export function buildFixtureNetworkConfiguration(zenReference?: string): NetworkConfiguration {
  const rng = new Seeded(`network:${zenReference ?? 'catalogue'}`);
  const serviceSelectionNames: NetworkOption[] = [
    { name: 'zen', description: 'Standard dynamic IPv4', realm: '@zen', ipVersion: 'ipv4', default: true },
    { name: 'zen-static', description: 'Single static IPv4', realm: '@zen-static', ipVersion: 'ipv4', staticBlock: '/32' },
    { name: 'zen-block29', description: 'Static IPv4 block', realm: '@zen-block29', ipVersion: 'ipv4', staticBlock: '/29' },
    { name: 'zen-dual', description: 'Dual stack with delegated IPv6', realm: '@zen-dual', ipVersion: 'dual', staticBlock: '/56' },
  ];

  if (!zenReference) return { serviceSelectionNames, details: [], source: 'fixture:self-service' };

  const selected = rng.pick(serviceSelectionNames);
  return {
    zenReference,
    serviceSelectionNames,
    details: [
      { label: 'Service selection name', value: selected.name },
      { label: 'RADIUS realm', value: selected.realm ?? '@zen' },
      { label: 'Username', value: `${zenReference.toLowerCase()}${selected.realm ?? '@zen'}` },
      { label: 'IPv4 address', value: `${rng.int(51, 88)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}` },
      ...(selected.staticBlock && selected.staticBlock !== '/32'
        ? [{ label: 'Static block', value: `${rng.int(51, 88)}.${rng.int(0, 255)}.${rng.int(0, 255)}.0${selected.staticBlock}` }]
        : []),
      ...(selected.ipVersion === 'dual'
        ? [{ label: 'Delegated IPv6 prefix', value: `2a02:${rng.digits(4)}:${rng.digits(4)}::/56` }]
        : []),
      { label: 'MTU', value: '1492' },
      { label: 'Reverse DNS delegated', value: rng.bool(0.3) ? 'Yes' : 'No' },
    ],
    source: 'fixture:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Estate-wide usage
 * ------------------------------------------------------------------ */

export function buildFixtureEstateUsage(period?: string): EstateUsageReport {
  const month = period ?? new Date().toISOString().slice(0, 7);
  const rng = new Seeded(`estateusage:${month}`);
  const rows: EstateUsageRow[] = [];

  for (let i = 0; i < rng.int(12, 28); i += 1) {
    const seed = new Seeded(`estateusage:${month}:${i}`);
    const region = regionFor(seed.pick(['M1 1AE', 'LS1 4AP', 'EH1 1YZ', 'SL1 1XY', 'CF10 1EP', 'BS1 4DJ']));
    const down = seed.int(20, 1400) * 1024 * 1024 * 1024;
    const up = Math.round(down * seed.float(0.04, 0.18, 3));
    rows.push({
      zenReference: `ZEN${seed.digits(7)}`,
      serviceId: `BB${seed.pick(['ZN', 'ZS', 'ZF'])}${seed.digits(8)}`,
      // `dialCode` already carries the full 0-prefixed stem, so this is the
      // same shape the other order/line fixtures use: eleven digits.
      cli: `${region.dialCode}${seed.digits(4)}`.slice(0, 11),
      address: `${seed.int(1, 240)} ${seed.pick(['High Street', 'Mill Lane', 'Station Road', 'Church Street'])}, ${region.town}`,
      downloadBytes: down,
      uploadBytes: up,
      totalBytes: down + up,
      overAllowance: seed.bool(0.12),
    });
  }

  rows.sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));

  // Three months back, which is as far as the provider's picker usually goes.
  const availablePeriods: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i);
    availablePeriods.push(d.toISOString().slice(0, 7));
  }

  return {
    period: month,
    rows,
    totalBytes: rows.reduce((sum, r) => sum + (r.totalBytes ?? 0), 0),
    availablePeriods,
    source: 'fixture:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Company context
 * ------------------------------------------------------------------ */

const COMPANY_SUFFIXES = ['Limited', 'Ltd', 'LLP', 'PLC'] as const;
const COMPANY_WORDS = [
  'Northgate',
  'Ashcroft',
  'Pennine',
  'Riverbank',
  'Kestrel',
  'Blackthorn',
  'Meridian',
  'Halewood',
  'Copperfield',
  'Stanbury',
] as const;
const COMPANY_TRADES = ['Consulting', 'Logistics', 'Dental Care', 'Joinery', 'Media', 'Property', 'Catering', 'Systems'] as const;

/**
 * Demo companies at a postcode, including one in trouble roughly a third of
 * the time — the case the panel exists to surface.
 */
export function buildFixtureCompanies(postcode: string): CompanyContext {
  const rng = new Seeded(`companies:${postcode}`);
  const companies: CompanyRecord[] = [];

  for (let i = 0; i < rng.int(1, 4); i += 1) {
    const seed = new Seeded(`company:${postcode}:${i}`);
    const status = seed.weighted([
      ['active', 8],
      ['liquidation', 1],
      ['dissolved', 1],
    ] as const);
    const incorporated = new Date(Date.now() - seed.int(400, 9000) * 86_400_000).toISOString().slice(0, 10);
    const region = regionFor(postcode);

    companies.push({
      companyNumber: seed.digits(8),
      name: `${seed.pick(COMPANY_WORDS)} ${seed.pick(COMPANY_TRADES)} ${seed.pick(COMPANY_SUFFIXES)}`.toUpperCase(),
      status,
      concerning: status !== 'active',
      type: 'ltd',
      incorporatedOn: incorporated,
      ...(status === 'dissolved'
        ? { dissolvedOn: new Date(Date.now() - seed.int(10, 380) * 86_400_000).toISOString().slice(0, 10) }
        : {}),
      registeredOffice: `${seed.int(1, 180)} ${seed.pick(['High Street', 'Mill Lane', 'Station Road'])}, ${region.town}, ${formatPostcode(postcode)}`,
      registeredHere: true,
      sicCodes: [seed.pick(['62020', '43320', '86230', '70229', '56102', '68209'])],
      ...(seed.bool(0.25) ? { overdue: ['Confirmation statement overdue'] } : {}),
      officerCount: seed.int(1, 5),
      url: 'https://find-and-update.company-information.service.gov.uk/',
      source: 'fixture:companies-house',
    });
  }

  companies.sort((a, b) => Number(b.concerning) - Number(a.concerning) || a.name.localeCompare(b.name));
  return { postcode: formatPostcode(postcode), companies, source: 'fixture:companies-house' };
}
