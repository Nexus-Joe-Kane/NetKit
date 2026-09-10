import type {
  AvailableTests,
  FaultCategory,
  FaultRecord,
  Incident,
  IncidentImpact,
  IncidentState,
  LineTestResult,
  LineTestType,
  ProfileOptions,
  RaiseFaultRequest,
  StabilityReport,
  TestMetric,
  TestOutcome,
  UsageReport,
} from '@sw/shared';
import { zenCall } from './client';
import { pickArray, pickBool, pickDate, pickNumber, pickString } from './map';

/**
 * Zen Assurance API.
 *
 * Covers outages, planned engineering work, faults, line testing and the
 * diagnostic history behind a service. Response field names come from the
 * published documentation; where the docs describe a field as an opaque
 * integer with no value table, it is read tolerantly (integer *or* string)
 * and mapped to `unknown` rather than guessed at.
 */

const ASSURANCE = { gateway: 'assurance' as const };

/**
 * The scopes an outage or planned-work endpoint might be gated on.
 *
 * `read-outages` first, because that is the one Zen's systems team named
 * when they confirmed the client already had access and we were still
 * getting a 401. `indirect-faults` stays behind it: it is what the rest of
 * the assurance gateway uses, and an account without `read-outages` would
 * otherwise lose outage data entirely rather than fall back.
 */
const OUTAGE_SCOPES = ['read-outages', 'indirect-faults'] as const;

const text = (v?: string): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' || s === 'string' ? undefined : s;
};

/* ------------------------------------------------------------------ *
 * Network status
 * ------------------------------------------------------------------ */

function incidentState(raw: unknown, kind: 'outage' | 'planned'): IncidentState {
  const v = (pickString(raw, 'status', 'state', 'incidentStatus') ?? '').toUpperCase();
  if (v.includes('RESOLV') || v.includes('CLEAR') || v.includes('CLOSED') || v.includes('COMPLETE')) return 'resolved';
  if (v.includes('MONITOR')) return 'monitoring';
  if (v.includes('PROGRESS') || v.includes('ACTIVE')) return 'in_progress';
  if (v.includes('SCHEDUL') || v.includes('PLANNED')) return 'scheduled';
  if (v.includes('OPEN') || v.includes('RAISED')) return 'open';
  // Fall back to the dates: a cleared time means it is done.
  if (pickDate(raw, 'clearedDate', 'resolvedDate', 'endDate', 'actualEndDate')) return 'resolved';
  return kind === 'planned' ? 'scheduled' : 'open';
}

function incidentImpact(raw: unknown): IncidentImpact {
  const v = (
    pickString(raw, 'impact', 'severity', 'serviceImpact', 'impactDescription') ?? ''
  ).toUpperCase();
  if (v.includes('TOTAL') || v.includes('LOSS OF SERVICE') || v.includes('NO SERVICE')) return 'total_loss';
  if (v.includes('PARTIAL')) return 'partial_loss';
  if (v.includes('DEGRAD') || v.includes('SLOW') || v.includes('INTERMITTENT')) return 'degraded';
  if (v.includes('AT RISK') || v.includes('RISK')) return 'at_risk';
  if (v.includes('NO IMPACT') || v.includes('NONE')) return 'no_impact';
  return 'unknown';
}

function mapIncident(raw: unknown, kind: 'outage' | 'planned', index: number): Incident {
  const reference =
    pickString(raw, 'reference', 'incidentReference', 'id', 'workReference') ?? `${kind}-${index + 1}`;

  const updates = pickArray(raw, 'updates', 'notes', 'history')
    .map((u) => {
      const at = pickDate(u, 'date', 'at', 'updatedDate', 'timestamp') ?? pickString(u, 'date', 'at');
      const body = pickString(u, 'text', 'note', 'description', 'update', 'message');
      return at && body ? { at, text: body } : null;
    })
    .filter((u): u is { at: string; text: string } => u !== null);

  const areas = pickArray(raw, 'areasAffected', 'affectedAreas', 'exchanges', 'regions')
    .map((a) => (typeof a === 'string' ? a : pickString(a, 'name', 'exchange', 'area', 'code')))
    .filter((a): a is string => Boolean(a));

  const services = pickArray(raw, 'affectedServices', 'services', 'impactedServices')
    .map((s) => ({
      ...(pickString(s, 'zenReference') ? { zenReference: pickString(s, 'zenReference') } : {}),
      ...(pickString(s, 'serviceId') ? { serviceId: pickString(s, 'serviceId') } : {}),
      ...(pickString(s, 'phoneNumber', 'cli') ? { cli: pickString(s, 'phoneNumber', 'cli') } : {}),
      ...(pickString(s, 'postCode', 'postcode') ? { postcode: pickString(s, 'postCode', 'postcode') } : {}),
    }))
    .filter((s) => Object.keys(s).length > 0);

  return {
    reference,
    kind,
    title:
      pickString(raw, 'title', 'summary', 'headline', 'description', 'workDescription') ??
      (kind === 'planned' ? 'Planned engineering work' : 'Service outage'),
    ...(pickString(raw, 'detail', 'details', 'longDescription', 'customerImpact')
      ? { detail: pickString(raw, 'detail', 'details', 'longDescription', 'customerImpact') }
      : {}),
    state: incidentState(raw, kind),
    impact: incidentImpact(raw),
    ...(pickDate(raw, 'startDate', 'startedDate', 'raisedDate', 'plannedStartDate', 'reportedDate')
      ? { startedAt: pickDate(raw, 'startDate', 'startedDate', 'raisedDate', 'plannedStartDate', 'reportedDate') }
      : {}),
    ...(pickDate(raw, 'estimatedClearDate', 'endDate', 'plannedEndDate', 'estimatedResolutionDate')
      ? { endsAt: pickDate(raw, 'estimatedClearDate', 'endDate', 'plannedEndDate', 'estimatedResolutionDate') }
      : {}),
    ...(pickDate(raw, 'clearedDate', 'resolvedDate', 'actualEndDate')
      ? { clearedAt: pickDate(raw, 'clearedDate', 'resolvedDate', 'actualEndDate') }
      : {}),
    ...(pickDate(raw, 'lastUpdatedDate', 'updatedDate', 'lastUpdate')
      ? { lastUpdatedAt: pickDate(raw, 'lastUpdatedDate', 'updatedDate', 'lastUpdate') }
      : {}),
    ...(areas.length ? { areasAffected: areas } : {}),
    ...(services.length ? { affectedServices: services } : {}),
    ...(updates.length ? { updates } : {}),
    provider: 'Zen Internet',
    source: 'zen:assurance',
  };
}

export async function fetchOutages(options: { past?: boolean } = {}): Promise<Incident[]> {
  const path = options.past ? '/api/major-service-outages/past' : '/api/major-service-outages';
  const json = await zenCall<unknown>(path, { ...ASSURANCE, scope: OUTAGE_SCOPES, emptyAsNull: true });
  const rows = pickArray(json, 'outages', 'majorServiceOutages', 'results', 'data', 'items');
  return rows.map((r, i) => mapIncident(r, 'outage', i));
}

export async function fetchPlannedWork(options: { past?: boolean } = {}): Promise<Incident[]> {
  const path = options.past ? '/api/planned-engineering-work/past' : '/api/planned-engineering-work';
  const json = await zenCall<unknown>(path, { ...ASSURANCE, scope: OUTAGE_SCOPES, emptyAsNull: true });
  const rows = pickArray(json, 'plannedEngineeringWork', 'plannedWork', 'results', 'data', 'items');
  return rows.map((r, i) => mapIncident(r, 'planned', i));
}

/** Outages affecting one specific service — the question support actually asks. */
export async function fetchOutagesForService(zenReference: string): Promise<Incident[]> {
  const json = await zenCall<unknown>(
    `/api/major-service-outages/zenreference/${encodeURIComponent(zenReference)}`,
    { ...ASSURANCE, scope: OUTAGE_SCOPES, emptyAsNull: true },
  );
  if (!json) return [];
  const rows = pickArray(json, 'outages', 'majorServiceOutages', 'results', 'data', 'items');
  return (rows.length ? rows : [json]).map((r, i) => mapIncident(r, 'outage', i));
}

/* ------------------------------------------------------------------ *
 * Faults
 * ------------------------------------------------------------------ */

function faultCategory(raw: unknown): FaultCategory {
  const v = (pickString(raw, 'category', 'faultType', 'type', 'faultCategory') ?? '').toUpperCase();
  if (v.includes('SYNC')) return 'synchronisation';
  if (v.includes('PERFORM') || v.includes('SPEED') || v.includes('THROUGHPUT')) return 'performance';
  if (v.includes('AUTH')) return 'authentication';
  if (v.includes('VOICE') || v.includes('DIAL') || v.includes('CALL')) return 'voice';
  return 'other';
}

function faultState(raw: unknown): FaultRecord['state'] {
  const v = (pickString(raw, 'status', 'faultStatus', 'state') ?? '').toUpperCase();
  if (v.includes('CLOSE') || v.includes('COMPLET')) return 'closed';
  if (v.includes('CLEAR')) return 'cleared';
  if (v.includes('CUSTOMER')) return 'awaiting_customer';
  if (v.includes('ENGINEER') || v.includes('APPOINT')) return 'engineer_assigned';
  if (v.includes('OPEN') || v.includes('PROGRESS') || v.includes('INVESTIG')) return 'open';
  if (pickDate(raw, 'clearedDate', 'closedDate')) return 'closed';
  return 'unknown';
}

/**
 * Does this object actually describe a fault?
 *
 * `mapFault` fills in a reference, a status and a summary when the payload
 * has none, which is right for the raise path -- Zen answer a successful
 * raise with a thin body and the request itself supplies the rest. It is
 * wrong for a list: an object that is not a fault came through it and
 * emerged as a fault referenced `fault-1`, category Other, state Unknown,
 * and the portal reported one open fault that does not exist.
 *
 * So a row has to carry at least one piece of fault identity before it is
 * accepted. Nothing recognisable means nothing is shown.
 */
export function looksLikeFault(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  return Boolean(
    pickString(raw, 'faultReference', 'reference', 'id') ??
      pickString(raw, 'summary', 'description', 'faultDescription', 'title') ??
      pickString(raw, 'status', 'faultStatus', 'state') ??
      pickString(raw, 'category', 'faultType', 'type', 'faultCategory') ??
      pickString(raw, 'zenReference', 'serviceReference', 'service') ??
      pickDate(raw, 'raisedDate', 'createdDate', 'reportedDate'),
  );
}

/** Maps a list row, discarding anything that is not a fault. */
function mapFaultRows(json: unknown, ...keys: string[]): FaultRecord[] {
  const rows = pickArray(json, 'faults', 'results', 'data', 'items', ...keys);
  return rows.filter(looksLikeFault).map(mapFault);
}

export function mapFault(raw: unknown, index: number): FaultRecord {
  const updates = pickArray(raw, 'updates', 'notes', 'history')
    .map((u) => {
      const at = pickDate(u, 'date', 'at', 'updatedDate') ?? pickString(u, 'date', 'at');
      const body = pickString(u, 'text', 'note', 'description', 'update');
      return at && body
        ? { at, text: body, ...(pickString(u, 'author', 'by') ? { author: pickString(u, 'author', 'by') } : {}) }
        : null;
    })
    .filter((u): u is { at: string; text: string; author?: string } => u !== null);

  const appointmentDate = pickDate(raw, 'appointmentDate', 'appointment.date');

  return {
    reference: pickString(raw, 'faultReference', 'reference', 'id') ?? `fault-${index + 1}`,
    ...(pickString(raw, 'zenReference') ? { zenReference: pickString(raw, 'zenReference') } : {}),
    ...(pickString(raw, 'serviceId') ? { serviceId: pickString(raw, 'serviceId') } : {}),
    ...(pickString(raw, 'phoneNumber', 'cli') ? { cli: pickString(raw, 'phoneNumber', 'cli') } : {}),
    category: faultCategory(raw),
    ...(pickString(raw, 'frequency')?.toUpperCase().includes('INTERMIT')
      ? { frequency: 'intermittent' as const }
      : pickString(raw, 'frequency')
        ? { frequency: 'permanent' as const }
        : {}),
    status: pickString(raw, 'status', 'faultStatus', 'state') ?? 'Unknown',
    state: faultState(raw),
    summary: pickString(raw, 'summary', 'description', 'faultDescription', 'title') ?? 'Fault',
    ...(pickString(raw, 'detail', 'details', 'additionalInformation')
      ? { detail: pickString(raw, 'detail', 'details', 'additionalInformation') }
      : {}),
    raisedAt: pickDate(raw, 'raisedDate', 'createdDate', 'reportedDate') ?? new Date().toISOString().slice(0, 10),
    ...(pickString(raw, 'raisedBy', 'reportedBy') ? { raisedBy: pickString(raw, 'raisedBy', 'reportedBy') } : {}),
    ...(pickDate(raw, 'clearedDate', 'closedDate') ? { clearedAt: pickDate(raw, 'clearedDate', 'closedDate') } : {}),
    ...(pickString(raw, 'careLevel') ? { careLevel: pickString(raw, 'careLevel') } : {}),
    ...(pickString(raw, 'slaTarget', 'sla', 'targetDate') ? { slaTarget: pickString(raw, 'slaTarget', 'sla', 'targetDate') } : {}),
    ...(pickDate(raw, 'committedDate', 'estimatedClearDate')
      ? { committedAt: pickDate(raw, 'committedDate', 'estimatedClearDate') }
      : {}),
    ...(appointmentDate
      ? {
          appointment: {
            date: appointmentDate,
            ...(pickString(raw, 'appointmentSlot', 'appointment.slot', 'timeslot')
              ? { slot: pickString(raw, 'appointmentSlot', 'appointment.slot', 'timeslot') }
              : {}),
            ...(pickString(raw, 'appointmentType', 'appointment.type')
              ? { type: pickString(raw, 'appointmentType', 'appointment.type') }
              : {}),
            ...(pickString(raw, 'appointmentStatus', 'appointment.status')
              ? { status: pickString(raw, 'appointmentStatus', 'appointment.status') }
              : {}),
          },
        }
      : {}),
    ...(updates.length ? { updates } : {}),
    ...(pickBool(raw, 'chargeable', 'chargeableRisk', 'potentiallyChargeable') != null
      ? { chargeableRisk: pickBool(raw, 'chargeable', 'chargeableRisk', 'potentiallyChargeable') }
      : {}),
    provider: 'Zen Internet',
    source: 'zen:assurance',
  };
}

export async function fetchOpenFaults(): Promise<FaultRecord[]> {
  const json = await zenCall<unknown>('/api/faults/open', { ...ASSURANCE, scope: 'indirect-faults', emptyAsNull: true });
  return mapFaultRows(json);
}

export async function fetchRecentlyClosedFaults(): Promise<FaultRecord[]> {
  const json = await zenCall<unknown>('/api/faults/recentlyclosed', {
    ...ASSURANCE,
    scope: 'indirect-faults',
    emptyAsNull: true,
  });
  return mapFaultRows(json);
}

export async function fetchFaultsForService(zenReference: string): Promise<FaultRecord[]> {
  const json = await zenCall<unknown>(`/api/fault/${encodeURIComponent(zenReference)}`, {
    ...ASSURANCE,
    scope: 'indirect-faults',
    emptyAsNull: true,
  });
  if (!json) return [];
  const rows = mapFaultRows(json);
  if (rows.length) return rows;
  // Zen answer this endpoint with the fault itself rather than a list when
  // there is exactly one -- but only if it really is a fault.
  return looksLikeFault(json) ? [mapFault(json, 0)] : [];
}

/**
 * Raises a fault. Zen exposes one endpoint per category and frequency
 * combination, so the path is composed rather than the body carrying a type.
 */
export async function raiseFault(request: RaiseFaultRequest): Promise<FaultRecord> {
  const category =
    request.category === 'synchronisation'
      ? 'synchronisation'
      : request.category === 'performance'
        ? 'performance'
        : 'authentication';

  const json = await zenCall<unknown>(`/api/fault/${category}/${request.frequency}`, {
    ...ASSURANCE,
    scope: 'indirect-faults',
    method: 'POST',
    body: {
      zenReference: request.zenReference,
      description: request.summary,
      ...(request.testsCarriedOut ? { testsCarriedOut: request.testsCarriedOut } : {}),
      ...(request.contactName ? { contactName: request.contactName } : {}),
      ...(request.contactNumber ? { contactNumber: request.contactNumber } : {}),
      ...(request.contactEmail ? { contactEmail: request.contactEmail } : {}),
      ...(request.siteNotes ? { siteNotes: request.siteNotes } : {}),
      ...(request.hazardNotes ? { hazardNotes: request.hazardNotes } : {}),
    },
  });
  return mapFault(json ?? { zenReference: request.zenReference, summary: request.summary }, 0);
}

/* ------------------------------------------------------------------ *
 * Line testing
 * ------------------------------------------------------------------ */

/**
 * Which Zen test family serves a technology. Copper products get the full
 * suite; fibre and alt-net products get a single service test.
 */
export function testFamilyFor(technology?: string): 'copper' | 'fttp' | 'sogea' | 'fibre' | 'altnet' {
  const v = (technology ?? '').toUpperCase();
  if (v.includes('FTTP') || v.includes('PON')) return 'fttp';
  if (v.includes('SOGEA')) return 'sogea';
  if (v.includes('CITYFIBRE') || v.includes('ALTNET')) return 'altnet';
  if (v.includes('FIBRE')) return 'fibre';
  return 'copper';
}

function testOutcome(raw: unknown): TestOutcome {
  const v = (pickString(raw, 'testOutcome', 'outcome', 'result') ?? '').toUpperCase();
  if (v.includes('PASS') || v.includes('OK') || v.includes('NO FAULT')) return 'pass';
  if (v.includes('FAIL') || v.includes('FAULT')) return 'fail';
  if (v.includes('INCONCLUSIVE') || v.includes('UNABLE')) return 'inconclusive';
  if (v.includes('PROGRESS') || v.includes('RUNNING') || v.includes('PENDING')) return 'in_progress';
  if (pickString(raw, 'errorMessage')) return 'error';
  // The state field is documented as an opaque integer, so it cannot be
  // mapped to an outcome without the value table.
  return 'unknown';
}

/** Builds metric rows from whichever fields a given test family returns. */
function metricsFrom(raw: unknown, type: LineTestType): TestMetric[] {
  const metrics: TestMetric[] = [];
  const add = (label: string, value?: string | number, unit?: string, verdict?: TestMetric['verdict']) => {
    if (value === undefined || value === null || value === '' || value === 'string') return;
    metrics.push({
      label,
      value: unit ? `${value} ${unit}` : String(value),
      ...(typeof value === 'number' ? { numeric: value } : {}),
      ...(unit ? { unit } : {}),
      ...(verdict ? { verdict } : {}),
    });
  };

  if (type === 'tamtest') {
    // The TAM test walks the stack: modem, DSL, ATM, PPP.
    for (const [label, key] of [
      ['Modem', 'modem'],
      ['DSL', 'dsl'],
      ['ATM', 'atm'],
      ['PPP', 'ppp'],
    ] as const) {
      const value = pickString(raw, key);
      if (!value) continue;
      const bad = /FAIL|DOWN|NO|ERROR/i.test(value);
      add(label, value, undefined, bad ? 'fail' : 'ok');
    }
    add('Additional information', pickString(raw, 'additionalText'));
  }

  // Generic electrical and rate readings, present across several tests.
  add('Downstream rate', pickNumber(raw, 'downstreamRate', 'downstreamSpeed', 'downSpeed'), 'kbps');
  add('Upstream rate', pickNumber(raw, 'upstreamRate', 'upstreamSpeed', 'upSpeed'), 'kbps');
  add('SNR margin', pickNumber(raw, 'snrMargin', 'snr'), 'dB');
  add('Line attenuation', pickNumber(raw, 'attenuation', 'lineAttenuation'), 'dB');
  add('Loop length', pickNumber(raw, 'loopLength', 'lineLength'), 'm');
  add('Line resistance', pickNumber(raw, 'resistance', 'loopResistance'), 'Ω');
  add('Line capacitance', pickNumber(raw, 'capacitance'), 'nF');
  add('Line voltage', pickNumber(raw, 'voltage'), 'V');
  add('Errored seconds', pickNumber(raw, 'erroredSeconds', 'es'));
  add('Retrains', pickNumber(raw, 'retrains', 'resyncs'));
  add('Profile', pickString(raw, 'profile', 'profileName', 'dlmProfile'));
  add('Interleaving', pickString(raw, 'interleaving'));

  return metrics;
}

function mapTestResult(raw: unknown, zenReference: string, type: LineTestType): LineTestResult {
  const outcome = testOutcome(raw);
  const faultLocation = pickString(raw, 'mainFaultLocation', 'faultLocation');
  const error = pickString(raw, 'errorMessage');

  return {
    ...(pickString(raw, 'testId', 'id', 'assuranceReference')
      ? { id: pickString(raw, 'testId', 'id', 'assuranceReference') }
      : {}),
    zenReference,
    type,
    outcome,
    ...(faultLocation ? { faultLocation } : {}),
    ...(pickString(raw, 'summary', 'testOutcomeDescription', 'description')
      ? { summary: pickString(raw, 'summary', 'testOutcomeDescription', 'description') }
      : {}),
    ...(pickString(raw, 'additionalText', 'detail', 'details')
      ? { detail: pickString(raw, 'additionalText', 'detail', 'details') }
      : {}),
    ...(pickDate(raw, 'dataFrom', 'ranAt', 'testDate') ? { ranAt: pickDate(raw, 'dataFrom', 'ranAt', 'testDate') } : {}),
    ...(pickString(raw, 'userName', 'ranBy') ? { ranBy: pickString(raw, 'userName', 'ranBy') } : {}),
    pending: outcome === 'in_progress',
    metrics: metricsFrom(raw, type),
    ...(error ? { errorMessage: error } : {}),
    provider: 'Zen Internet',
    source: `zen:assurance:${type}`,
  };
}

/** The most recent run of a test, without triggering a new one. */
export async function fetchLatestTest(
  zenReference: string,
  type: LineTestType,
  family = 'copper',
): Promise<LineTestResult | null> {
  // Fibre families expose a single service test rather than the copper suite.
  const segment = family === 'copper' ? type : 'latest';
  const path =
    family === 'copper'
      ? `/api/copper/services/${encodeURIComponent(zenReference)}/${type}/latest`
      : `/api/${family}/services/${encodeURIComponent(zenReference)}/${segment}`;

  const json = await zenCall<unknown>(path, { ...ASSURANCE, scope: 'indirect-diagnostics', emptyAsNull: true });
  if (!json) return null;
  return mapTestResult(json, zenReference, type);
}

/**
 * Triggers a test. These are asynchronous: the response carries a test id
 * which the caller polls with `fetchLatestTest`.
 */
export async function runTest(
  zenReference: string,
  type: LineTestType,
  family = 'copper',
): Promise<LineTestResult> {
  const path =
    family === 'copper'
      ? `/api/copper/services/${encodeURIComponent(zenReference)}/${type}`
      : `/api/${family}/services/${encodeURIComponent(zenReference)}/${type}`;

  const json = await zenCall<unknown>(path, {
    ...ASSURANCE,
    scope: 'indirect-diagnostics',
    method: 'POST',
    emptyAsNull: true,
  });
  const result = mapTestResult(json ?? {}, zenReference, type);
  // A trigger that returns nothing useful is still in progress.
  return result.metrics.length || result.outcome !== 'unknown' ? result : { ...result, outcome: 'in_progress', pending: true };
}

const TEST_LABELS: Record<LineTestType, { label: string; description: string; disruptive?: boolean }> = {
  linetest: {
    label: 'Copper line test',
    description: 'Electrical test of the copper pair — resistance, capacitance and battery. Finds physical faults.',
    disruptive: true,
  },
  xdsltest: {
    label: 'xDSL test',
    description: 'Reads the DSLAM: sync rates, SNR margin, attenuation and error counts.',
  },
  tamtest: {
    label: 'TAM test',
    description: 'Walks the stack — modem, DSL, ATM, PPP — to show where the session stops.',
  },
  kbdtest: {
    label: 'Known network test',
    description: 'Checks the service against known network problems before an engineer is considered.',
  },
  servicetest: {
    label: 'Service test',
    description: 'Fibre service test: ONT state, optical levels and session status.',
  },
  profilechange: {
    label: 'Profile change',
    description: 'Requests a DLM profile reset where a banded profile is capping the line.',
  },
};

export async function fetchAvailableTests(zenReference: string, technology?: string): Promise<AvailableTests> {
  const family = testFamilyFor(technology);

  // Copper services advertise which tests they support; fibre families
  // expose a single service test.
  if (family !== 'copper') {
    return {
      zenReference,
      ...(technology ? { technology: technology as AvailableTests['technology'] } : {}),
      types: [{ type: 'servicetest', ...TEST_LABELS.servicetest }],
      source: 'zen:assurance',
    };
  }

  const json = await zenCall<unknown>(
    `/api/copper/services/check-available-test-types/${encodeURIComponent(zenReference)}`,
    { ...ASSURANCE, scope: 'indirect-diagnostics', emptyAsNull: true },
  );

  const advertised = pickArray(json, 'testTypes', 'availableTestTypes', 'results', 'data')
    .map((t) => (typeof t === 'string' ? t : pickString(t, 'testType', 'type', 'name')))
    .filter((t): t is string => Boolean(t))
    .map((t) => t.toLowerCase().replace(/[^a-z]/g, ''))
    .filter((t): t is LineTestType => t in TEST_LABELS);

  const types = (advertised.length ? advertised : (['linetest', 'xdsltest', 'tamtest', 'kbdtest'] as LineTestType[])).map(
    (type) => ({ type, ...TEST_LABELS[type] }),
  );

  return {
    zenReference,
    ...(technology ? { technology: technology as AvailableTests['technology'] } : {}),
    types,
    source: 'zen:assurance',
  };
}

export async function fetchProfileOptions(zenReference: string): Promise<ProfileOptions> {
  const json = await zenCall<unknown>('/api/copper/services/profileoptions', {
    ...ASSURANCE,
    scope: 'indirect-diagnostics',
    query: { zenReference },
    emptyAsNull: true,
  });
  const options = pickArray(json, 'options', 'profileOptions', 'results', 'data')
    .map((o) => {
      const code = typeof o === 'string' ? o : pickString(o, 'code', 'value', 'id', 'profile');
      if (!code) return null;
      return {
        code,
        label: (typeof o === 'string' ? o : pickString(o, 'name', 'label', 'description')) ?? code,
        ...(typeof o !== 'string' && pickString(o, 'description') ? { description: pickString(o, 'description') } : {}),
      };
    })
    .filter((o): o is { code: string; label: string; description?: string } => o !== null);

  return {
    zenReference,
    ...(pickString(json, 'current', 'currentProfile') ? { current: pickString(json, 'current', 'currentProfile') } : {}),
    options,
    source: 'zen:assurance',
  };
}

export async function requestProfileChange(zenReference: string, profileCode: string): Promise<LineTestResult> {
  const json = await zenCall<unknown>('/api/copper/services/requestprofilechange', {
    ...ASSURANCE,
    scope: 'indirect-diagnostics',
    method: 'POST',
    body: { zenReference, profile: profileCode, profileCode },
    emptyAsNull: true,
  });
  return mapTestResult(json ?? {}, zenReference, 'profilechange');
}

/* ------------------------------------------------------------------ *
 * Stability — drops and authentication history
 * ------------------------------------------------------------------ */

export async function fetchStability(zenReference: string, days = 30): Promise<StabilityReport> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const [dropsJson, authJson] = await Promise.all([
    zenCall<unknown>(`/api/drops-over-time/${encodeURIComponent(zenReference)}`, {
      ...ASSURANCE,
      scope: 'indirect-diagnostics',
      query: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      emptyAsNull: true,
    }).catch(() => null),
    zenCall<unknown>(`/api/authentication-attempts/${encodeURIComponent(zenReference)}`, {
      ...ASSURANCE,
      scope: 'indirect-diagnostics',
      emptyAsNull: true,
    }).catch(() => null),
  ]);

  const buckets = pickArray(dropsJson, 'drops', 'results', 'data', 'items')
    .map((d) => {
      const date = pickDate(d, 'date', 'day', 'timestamp');
      const drops = pickNumber(d, 'drops', 'count', 'value') ?? 0;
      return date ? { date, drops } : null;
    })
    .filter((b): b is { date: string; drops: number } => b !== null);

  const attempts = pickArray(authJson, 'attempts', 'authenticationAttempts', 'results', 'data')
    .map((a) => {
      const at = pickString(a, 'date', 'at', 'timestamp');
      if (!at) return null;
      const raw = (pickString(a, 'result', 'status', 'outcome') ?? '').toUpperCase();
      return {
        at,
        result: raw.includes('ACCEPT') || raw.includes('SUCCESS') ? ('accept' as const) : raw.includes('REJECT') || raw.includes('FAIL') ? ('reject' as const) : ('unknown' as const),
        ...(pickString(a, 'reason', 'rejectReason', 'message') ? { reason: pickString(a, 'reason', 'rejectReason', 'message') } : {}),
        ...(pickString(a, 'nasIpAddress', 'nas') ? { nasIpAddress: pickString(a, 'nasIpAddress', 'nas') } : {}),
      };
    })
    .filter((a): a is NonNullable<StabilityReport['authenticationAttempts']>[number] => a !== null);

  return {
    zenReference,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    totalDrops: buckets.reduce((sum, b) => sum + b.drops, 0),
    buckets,
    ...(attempts.length ? { authenticationAttempts: attempts } : {}),
    source: 'zen:assurance',
  };
}

/* ------------------------------------------------------------------ *
 * Usage
 * ------------------------------------------------------------------ */

export async function fetchUsage(zenReference: string, period: UsageReport['period'] = 'current_month'): Promise<UsageReport> {
  const path =
    period === 'day'
      ? `/api/dailyusage/${encodeURIComponent(zenReference)}`
      : period === 'month'
        ? `/api/monthlyusage/historic/${encodeURIComponent(zenReference)}`
        : `/api/monthlyusage/current/${encodeURIComponent(zenReference)}`;

  const json = await zenCall<unknown>(path, { ...ASSURANCE, scope: 'indirect-diagnostics', emptyAsNull: true });

  const buckets = pickArray(json, 'usage', 'days', 'results', 'data', 'items')
    .map((u) => {
      const date = pickDate(u, 'date', 'day');
      return date
        ? {
            date,
            bytesIn: pickNumber(u, 'bytesIn', 'download', 'downloadBytes', 'in') ?? 0,
            bytesOut: pickNumber(u, 'bytesOut', 'upload', 'uploadBytes', 'out') ?? 0,
          }
        : null;
    })
    .filter((b): b is { date: string; bytesIn: number; bytesOut: number } => b !== null);

  const bytesIn = pickNumber(json, 'totalBytesIn', 'bytesIn', 'download') ?? buckets.reduce((s, b) => s + b.bytesIn, 0);
  const bytesOut = pickNumber(json, 'totalBytesOut', 'bytesOut', 'upload') ?? buckets.reduce((s, b) => s + b.bytesOut, 0);

  return {
    zenReference,
    period,
    ...(pickDate(json, 'from', 'periodStart') ? { from: pickDate(json, 'from', 'periodStart') } : {}),
    ...(pickDate(json, 'to', 'periodEnd') ? { to: pickDate(json, 'to', 'periodEnd') } : {}),
    ...(bytesIn ? { bytesIn } : {}),
    ...(bytesOut ? { bytesOut } : {}),
    ...(bytesIn + bytesOut ? { totalBytes: bytesIn + bytesOut } : {}),
    ...(pickNumber(json, 'cap', 'capBytes', 'downloadUsageCap') != null
      ? { capBytes: pickNumber(json, 'cap', 'capBytes', 'downloadUsageCap') }
      : {}),
    ...(buckets.length ? { buckets } : {}),
    source: 'zen:assurance',
  };
}

export const __assuranceTesting = { incidentState, incidentImpact, faultCategory, faultState, testOutcome, metricsFrom };
