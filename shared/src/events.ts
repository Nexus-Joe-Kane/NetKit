import type { ActivityEntry } from './activity';
import { activityNote } from './activity';
import type { Attribution, CheckResult, Clearance, SiteWatchState } from './watchdog';
import { countingDisconnections } from './watchdog';

/**
 * An event: one piece of trouble, with everything about it in one place.
 *
 * The problem it solves is the twelve-tab problem. A site goes off and
 * answering "what is actually wrong" means the UniFi console, the Zen
 * portal, Cloud Market, Jola, IT Glue and Zendesk, in six tabs, at seven in
 * the morning, by somebody who has not had a coffee. The event is that work
 * already done: the checks that failed, the tests the portal ran itself,
 * whose fault it looks like, the products and the SIMs and the kit, the
 * supplier's own status page, and the trail of what anybody has done since.
 *
 * The ticket is deliberately thin by comparison. It goes on the helpdesk
 * unassigned, says what is wrong in a paragraph somebody can triage in ten
 * seconds, and links here for the rest. A ticket carrying all of this would
 * be unreadable and would still be a snapshot, where the event stays live.
 */

export type EventKind = 'outage' | 'unstable' | 'fault' | 'manual';

export type EventStatus = 'open' | 'cleared';

/**
 * What the site looked like, for the technical breakdown.
 *
 * Every technical ticket carries this. The question it answers is the one
 * asked on every handover — "what am I even looking at" — and it is the
 * cheapest section to fill in because the sweep already had all of it in
 * hand when it decided something was wrong.
 */
export interface EventEnvironment {
  /** When the site was first seen down, not when the ticket was raised. */
  downSince?: string;
  /** The gateway, because it is the thing somebody will ask about first. */
  gatewayModel?: string;
  gatewayName?: string;
  consoleName?: string;
  siteId?: string;
  totalDevices?: number;
  offlineDevices?: number;
  wiredClients?: number;
  wifiClients?: number;
  /** How many WANs the console is configured with. */
  wanCount?: number;
  /** What the console thinks provides the internet. */
  ispName?: string;
  timezone?: string;
}

/**
 * One WAN, as the event reports it.
 *
 * The `lineTest` pair is the point. A managed line gets a test and a result;
 * an unmanaged one gets neither, and says so with the provider named —
 * "no test: G.Network on WAN 2 is not a line we manage" is an answer, where
 * a blank column is a question.
 */
export interface EventWan {
  id: string;
  label: string;
  providerName: string;
  managed: boolean;
  online?: boolean;
  /** Our reference, where this WAN is a line we supply. */
  serviceReference?: string;
  /** `yes`, `no`, or `n/a` — rendered as tick, cross, question mark. */
  lineTestRun: 'yes' | 'no' | 'n/a';
  lineTestResult: 'pass' | 'fail' | 'unknown';
  /** Why no test ran, where none did. */
  lineTestNote?: string;
  /** The provider's own words, verbatim, for the code block. */
  lineTestOutput?: string;
}

/** Something the portal went and found out, unprompted. */
export interface EventFinding {
  /** Where it came from, for the event page's grouping. */
  source: 'line-test' | 'radius' | 'unifi' | 'circuit' | 'mobile' | 'provider-status';
  label: string;
  value?: string;
  /**
   * `bad` and `warn` sort to the top of the event page. A finding with no
   * verdict is context, not a symptom.
   */
  verdict?: 'good' | 'warn' | 'bad' | 'info';
  detail?: string;
  at?: string;
}

/** A 5G unit and the SIM in it, which is the pair nobody can ever find. */
export interface EventMobile {
  msisdn?: string;
  iccid?: string;
  /** The network the SIM is actually on, which is what the status check needs. */
  operator?: string;
  tariff?: string;
  state?: string;
  online?: boolean;
  usedPercent?: number;
  /** The unit the SIM lives in, where the documentation says. */
  deviceName?: string;
}

/** Everything the platforms hold, gathered once and kept with the event. */
export interface EventInventory {
  /** Broadband and connectivity products, from Zen and Cloud Market. */
  services?: Array<{
    reference: string;
    product?: string;
    supplier?: string;
    technology?: string;
    status?: string;
  }>;
  mobiles?: EventMobile[];
  /** Kit on the console. */
  devices?: Array<{ name?: string; model?: string; ip?: string; state?: string; uptimeSeconds?: number }>;
  /** Documented configurations, without any password values. */
  configurations?: Array<{ name: string; type?: string; hostname?: string; ip?: string }>;
  /** Where to go and read the rest. */
  links?: Array<{ label: string; url: string }>;
}

/** A supplier's own view of whether they are having a bad morning. */
export interface ProviderStatus {
  provider: string;
  state: 'ok' | 'degraded' | 'outage' | 'unknown';
  /** Reports in the last hour, where the source counts them. */
  reports?: number;
  detail?: string;
  checkedAt: string;
  source: string;
}

export interface NetEvent {
  id: string;
  kind: EventKind;
  status: EventStatus;
  /** The client-index key, so one site is one thing across every platform. */
  clientKey: string;
  clientName: string;
  siteName?: string;
  address?: string;
  uprn?: string;
  openedAt: string;
  /**
   * Absent where the portal opened it on its own.
   *
   * Read with `automatic`, not instead of it. A sweep can be running on
   * somebody's behalf and still be nobody's decision.
   */
  openedBy?: { name?: string; email?: string };
  automatic: boolean;
  /** Why it opened, in one line. */
  because: string;
  attribution?: Attribution;
  attributionBecause?: string;
  /** The unassigned ticket raised for it. */
  ticketId?: string;
  ticketUrl?: string;
  /** What the checks saw, newest last. */
  checks?: CheckResult[];
  findings?: EventFinding[];
  inventory?: EventInventory;
  providers?: ProviderStatus[];
  environment?: EventEnvironment;
  wans?: EventWan[];
  /** Drops in the counting window at the moment it opened. */
  dropsInWindow?: number;
  clearance?: Clearance;
  clearedAt?: string;
  /** What anybody, human or not, has done since. */
  activity?: ActivityEntry[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * How it reads
 * ------------------------------------------------------------------ */

const KIND_LABEL: Record<EventKind, string> = {
  outage: 'Site off',
  unstable: 'Site unstable',
  fault: 'Fault',
  manual: 'Raised by hand',
};

export const eventKindLabel = (kind: EventKind): string => KIND_LABEL[kind];

const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  ours: 'Looks like ours',
  supplier: 'Looks like the supplier',
  'power-or-site': 'Looks like power or kit on site',
  unclear: 'Not yet clear',
};

export const attributionLabel = (attribution: Attribution): string => ATTRIBUTION_LABEL[attribution];

/**
 * What the ticket is called.
 *
 * The client first, because that is what somebody scans a queue for, then
 * what is wrong, then where it points. Long enough to triage without
 * opening, short enough to read in a list.
 */
export function eventSubject(event: NetEvent): string {
  const where = event.siteName && event.siteName !== event.clientName ? ` — ${event.siteName}` : '';
  const blame = event.attribution && event.attribution !== 'unclear' ? ` (${attributionLabel(event.attribution).toLowerCase()})` : '';
  return `${event.clientName}${where}: ${KIND_LABEL[event.kind].toLowerCase()}${blame}`;
}

const bullet = (finding: EventFinding): string => {
  const parts = [finding.label];
  if (finding.value) parts.push(finding.value);
  if (finding.detail) parts.push(finding.detail);
  return `· ${parts.join(' — ')}`;
};

/** `bad` and `warn` first: an event page opens on its symptoms. */
const FINDING_ORDER: Record<NonNullable<EventFinding['verdict']> | 'none', number> = {
  bad: 0,
  warn: 1,
  info: 2,
  good: 3,
  none: 4,
};

export function sortFindings(findings: readonly EventFinding[]): EventFinding[] {
  return [...findings].sort((a, b) => FINDING_ORDER[a.verdict ?? 'none'] - FINDING_ORDER[b.verdict ?? 'none']);
}

/**
 * The unassigned ticket's opening note.
 *
 * Written to be triaged, not read end to end. What is off, whose it looks
 * like, the two or three findings that say so, and a link. Everything else
 * is on the event, and repeating it here would produce a wall nobody reads
 * and a snapshot that is wrong within the hour.
 *
 * Private, always. It is raised on the customer's behalf and quotes internal
 * diagnostics, and no part of it is written to be read by them.
 */
export function eventTicketNote(event: NetEvent, eventUrl?: string): string {
  const lines: string[] = [];
  const where = event.siteName && event.siteName !== event.clientName ? ` — ${event.siteName}` : '';

  lines.push(`${KIND_LABEL[event.kind]}: ${event.clientName}${where}`);
  if (event.address) lines.push(event.address);
  lines.push('');
  lines.push(event.because);

  if (event.attribution) {
    lines.push('');
    lines.push(`${attributionLabel(event.attribution)}. ${event.attributionBecause ?? ''}`.trim());
  }

  /* ---- When it went, which is the first thing anybody asks ---------- */
  const env = event.environment ?? {};
  if (env.downSince) {
    lines.push('');
    lines.push(`Offline since ${stamp(env.downSince)}${env.downSince !== event.openedAt ? ` (detected, not reported by the customer)` : ''}.`);
  }

  /* ---- The WANs, with the test columns ------------------------------ */
  if (event.wans?.length) {
    lines.push('');
    lines.push('Connectivity');
    for (const wan of event.wans) {
      const status = wan.online === true ? 'up' : wan.online === false ? 'DOWN' : 'state unknown';
      const managed = wan.managed ? wan.serviceReference ?? 'managed by us' : 'not managed by us';
      lines.push(`· ${wan.label} — ${wan.providerName} — ${status} — ${managed}`);
      if (wan.managed) {
        lines.push(`    line test: ${TEST_RUN_WORD[wan.lineTestRun]} · result: ${TEST_RESULT_WORD[wan.lineTestResult]}`);
      }
      if (wan.lineTestNote) lines.push(`    ${wan.lineTestNote}`);
    }
  }

  /* ---- What the tests actually said, verbatim ----------------------- */
  //
  // A code block, because the provider's own words are evidence. Summarising
  // a line test into "fault found" loses the attenuation figure that the
  // supplier will ask for, and an engineer who has to re-run the test to get
  // it back has been given a worse ticket than no ticket.
  const outputs = (event.wans ?? []).filter((w) => w.lineTestOutput);
  if (outputs.length) {
    lines.push('');
    lines.push('Line test output');
    lines.push('```');
    for (const wan of outputs) {
      lines.push(`${wan.label} — ${wan.providerName}${wan.serviceReference ? ` (${wan.serviceReference})` : ''}`);
      lines.push(wan.lineTestOutput!.trimEnd());
      lines.push('');
    }
    lines.push('```');
  }

  const symptoms = sortFindings(event.findings ?? []).filter((f) => f.verdict === 'bad' || f.verdict === 'warn');
  if (symptoms.length) {
    lines.push('');
    lines.push('What the portal found');
    lines.push(...symptoms.slice(0, 8).map(bullet));
  }

  /* ---- The environment, on every technical ticket ------------------- */
  const envRows: string[] = [];
  if (env.gatewayModel || env.gatewayName) {
    envRows.push(`· Gateway — ${[env.gatewayName, env.gatewayModel].filter(Boolean).join(' / ')}`);
  }
  if (env.consoleName) envRows.push(`· Console — ${env.consoleName}`);
  if (env.totalDevices !== undefined) {
    envRows.push(
      `· Devices — ${env.totalDevices} total, ${env.offlineDevices ?? 0} offline`,
    );
  }
  if (env.wiredClients !== undefined || env.wifiClients !== undefined) {
    envRows.push(`· Clients — ${env.wiredClients ?? 0} wired, ${env.wifiClients ?? 0} wireless`);
  }
  if (env.wanCount !== undefined) envRows.push(`· WANs configured — ${env.wanCount}`);
  if (env.ispName) envRows.push(`· Console reports the ISP as — ${env.ispName}`);
  if (env.siteId) envRows.push(`· UniFi site — ${env.siteId}`);
  if (env.timezone) envRows.push(`· Site timezone — ${env.timezone}`);
  if (envRows.length) {
    lines.push('');
    lines.push('Environment');
    lines.push(...envRows);
  }

  const struggling = (event.providers ?? []).filter((p) => p.state === 'outage' || p.state === 'degraded');
  if (struggling.length) {
    lines.push('');
    lines.push('Supplier status');
    lines.push(
      ...struggling.map((p) => `· ${p.provider} — ${p.state}${p.reports ? ` (${p.reports} reports)` : ''}${p.detail ? `. ${p.detail}` : ''}`),
    );
  }

  const mobiles = event.inventory?.mobiles ?? [];
  if (mobiles.length) {
    lines.push('');
    lines.push('Mobile backup');
    lines.push(
      ...mobiles.map((m) => {
        const bits = [m.deviceName, m.msisdn, m.operator, m.tariff].filter(Boolean);
        const state = m.online === true ? 'online' : m.online === false ? 'not online' : m.state;
        return `· ${bits.join(' — ') || 'SIM'}${state ? ` — ${state}` : ''}${
          m.usedPercent !== undefined ? ` — ${Math.round(m.usedPercent)}% of allowance used` : ''
        }`;
      }),
    );
  }

  // Only where `because` has not already said it, or the ticket reads
  // "5 drops in the last 24 hours" twice with two different numbers.
  if (event.dropsInWindow && !/\bdrops?\b/i.test(event.because)) {
    lines.push('');
    lines.push(`${event.dropsInWindow} drop${event.dropsInWindow === 1 ? '' : 's'} in the last 24 hours.`);
  }

  lines.push('');
  if (eventUrl) {
    lines.push(`Everything gathered — products, SIMs, kit, configurations, the tests and the trail — is on the event:`);
    lines.push(eventUrl);
  } else {
    // Say why there is no link rather than omitting it silently. A ticket
    // that mentions an event nobody can find is worse than one that says
    // where the link went.
    lines.push(
      'Everything gathered is on the event in NetKit. No link here because PUBLIC_URL is not set on the ' +
        'server — set it in Admin portal → Credentials and future tickets will carry one.',
    );
  }

  if (event.automatic) {
    lines.push('');
    lines.push('Opened automatically by NetKit. Nobody has looked at it yet.');
  }

  const trail = activityNote(event.activity ?? [], 'What has been done');
  return trail ? `${lines.join('\n')}\n\n${trail}` : lines.join('\n');
}

const TEST_RUN_WORD: Record<EventWan['lineTestRun'], string> = {
  yes: 'run',
  no: 'not run',
  'n/a': 'not applicable',
};

const TEST_RESULT_WORD: Record<EventWan['lineTestResult'], string> = {
  pass: 'clean',
  fail: 'fault found',
  unknown: 'unknown',
};

/** Day, month, and a 24-hour clock in London. Times on tickets are local. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });
}

/**
 * The WAN row, from what we know and what we could not find out.
 *
 * Built here rather than at the call site because the honest-blank rules are
 * the fiddly part: a line we do not manage has no test to report and must
 * say why, and a managed line whose test failed to run is different again
 * from one that ran and passed.
 */
export function wanRow(input: {
  id: string;
  label: string;
  providerName: string;
  online?: boolean;
  serviceReference?: string;
  test?: { ran: boolean; passed?: boolean; output?: string; error?: string };
}): EventWan {
  const managed = Boolean(input.serviceReference);

  if (!managed) {
    return {
      id: input.id,
      label: input.label,
      providerName: input.providerName,
      managed: false,
      ...(input.online === undefined ? {} : { online: input.online }),
      lineTestRun: 'n/a',
      lineTestResult: 'unknown',
      lineTestNote: `No line test: ${input.providerName} on ${input.label} is not a line we manage.`,
    };
  }

  const test = input.test;
  if (!test || !test.ran) {
    return {
      id: input.id,
      label: input.label,
      providerName: input.providerName,
      managed: true,
      ...(input.online === undefined ? {} : { online: input.online }),
      serviceReference: input.serviceReference!,
      lineTestRun: 'no',
      lineTestResult: 'unknown',
      lineTestNote: test?.error
        ? `Line test could not be run: ${test.error}`
        : 'Line test could not be run — the supplier did not answer.',
    };
  }

  return {
    id: input.id,
    label: input.label,
    providerName: input.providerName,
    managed: true,
    ...(input.online === undefined ? {} : { online: input.online }),
    serviceReference: input.serviceReference!,
    lineTestRun: 'yes',
    lineTestResult: test.passed === undefined ? 'unknown' : test.passed ? 'pass' : 'fail',
    ...(test.output ? { lineTestOutput: test.output } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Opening one
 * ------------------------------------------------------------------ */

export interface OpenEventInput {
  id: string;
  kind: EventKind;
  clientKey: string;
  clientName: string;
  siteName?: string;
  address?: string;
  uprn?: string;
  because: string;
  at: string;
  by?: { name?: string; email?: string };
  automatic?: boolean;
  watch?: SiteWatchState;
  checks?: CheckResult[];
}

export function openEvent(input: OpenEventInput): NetEvent {
  const automatic = input.automatic ?? !input.by;
  const drops = input.watch ? countingDisconnections(input.watch, input.at).length : undefined;
  return {
    id: input.id,
    kind: input.kind,
    status: 'open',
    clientKey: input.clientKey,
    clientName: input.clientName,
    ...(input.siteName ? { siteName: input.siteName } : {}),
    ...(input.address ? { address: input.address } : {}),
    ...(input.uprn ? { uprn: input.uprn } : {}),
    openedAt: input.at,
    // A human name is only recorded where a human did it, so an automatic
    // event cannot end up reading as somebody's decision.
    ...(input.by && !automatic ? { openedBy: input.by } : {}),
    automatic,
    because: input.because,
    ...(input.checks?.length ? { checks: input.checks } : {}),
    ...(drops ? { dropsInWindow: drops } : {}),
    updatedAt: input.at,
  };
}

/** Merges what a diagnosis found into an open event. */
export function withDiagnosis(
  event: NetEvent,
  diagnosis: {
    attribution?: Attribution;
    attributionBecause?: string;
    findings?: EventFinding[];
    inventory?: EventInventory;
    providers?: ProviderStatus[];
    environment?: EventEnvironment;
    wans?: EventWan[];
  },
  at: string,
): NetEvent {
  return {
    ...event,
    ...(diagnosis.attribution ? { attribution: diagnosis.attribution } : {}),
    ...(diagnosis.attributionBecause ? { attributionBecause: diagnosis.attributionBecause } : {}),
    ...(diagnosis.findings?.length ? { findings: [...(event.findings ?? []), ...diagnosis.findings] } : {}),
    ...(diagnosis.inventory ? { inventory: { ...event.inventory, ...diagnosis.inventory } } : {}),
    ...(diagnosis.providers?.length ? { providers: diagnosis.providers } : {}),
    ...(diagnosis.environment ? { environment: { ...event.environment, ...diagnosis.environment } } : {}),
    // Replaced rather than merged: a re-diagnosis re-reads every uplink, and
    // appending would leave the old rows next to the new ones.
    ...(diagnosis.wans?.length ? { wans: diagnosis.wans } : {}),
    updatedAt: at,
  };
}

export function clearEvent(event: NetEvent, clearance: Clearance): NetEvent {
  return { ...event, status: 'cleared', clearance, clearedAt: clearance.at, updatedAt: clearance.at };
}

/* ------------------------------------------------------------------ *
 * The glance
 * ------------------------------------------------------------------ */

/**
 * What the home page says before anybody clicks anything.
 *
 * Counts, not lists. The question at half past eight is "is anything on
 * fire", and four numbers answer it; the lists are one click away and are
 * not what somebody wants to read while taking their coat off.
 */
export interface Glance {
  appointments: number;
  /** Faults open with a supplier. */
  faults: number;
  sitesOff: number;
  sitesUnstable: number;
  /** Events nobody has picked up, which is the number that should be zero. */
  untouched: number;
}

export function glance(input: {
  events: readonly NetEvent[];
  appointments: number;
  faults: number;
}): Glance {
  const open = input.events.filter((e) => e.status === 'open');
  return {
    appointments: input.appointments,
    faults: input.faults,
    sitesOff: open.filter((e) => e.kind === 'outage').length,
    sitesUnstable: open.filter((e) => e.kind === 'unstable').length,
    untouched: open.filter((e) => e.automatic && !(e.activity ?? []).some((a) => !a.automatic)).length,
  };
}

/**
 * Open events, worst first.
 *
 * Off before unstable, unattributed before attributed — an event nobody has
 * worked out the cause of needs somebody more than one already pointed at a
 * supplier — then oldest first, because the one that has been sitting
 * longest is the one somebody is about to ring about.
 */
export function sortEvents(events: readonly NetEvent[]): NetEvent[] {
  const kindRank: Record<EventKind, number> = { outage: 0, fault: 1, unstable: 2, manual: 3 };
  return [...events].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    const kind = kindRank[a.kind] - kindRank[b.kind];
    if (kind !== 0) return kind;
    const blame = Number(Boolean(a.attribution && a.attribution !== 'unclear')) - Number(Boolean(b.attribution && b.attribution !== 'unclear'));
    if (blame !== 0) return blame;
    return a.openedAt.localeCompare(b.openedAt);
  });
}
