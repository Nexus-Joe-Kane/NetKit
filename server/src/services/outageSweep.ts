import {
  CHECK_INTERVAL_MS,
  attribute,
  clientKey,
  eventSubject,
  eventTicketNote,
  operatorForSim,
  reconcileWans,
  wanLinesFrom,
  wanRow,
  type CheckResult,
  type EventEnvironment,
  type EventFinding,
  type EventInventory,
  type EventMobile,
  type EventWan,
  type NetworkDevice,
  type NetworkSite,
  type SimRecord,
  type WanHealth,
} from '@sw/shared';
import { devicesForHost, networkSites, unifiConfigured, wanHealth } from '../providers/network/unifi';
import { ALERT_TAG, createInternalTicket, zendeskConfigured } from '../providers/tickets/zendesk';
import { attachDiagnosis, attachTicket, raiseEvent, recordCheck, watchState } from './events';
import { findClients } from './clientIndex';
import { audit } from '../auth/store';
import { config } from '../config';
import * as ops from './operations';

/**
 * The five-minute check: is anything off, and whose fault is it?
 *
 * The shape of the thing is dictated by cost. Two hundred sites checked every
 * five minutes is fifty-eight thousand requests a day, so the sweep is built
 * around one cheap question asked of the whole estate and expensive questions
 * asked only of the handful that look wrong.
 *
 * The cheap question is `GET /v1/sites`: one paged call for every site on the
 * account, each carrying how many devices the console can see and how many it
 * cannot. A site where the console can see none of its own kit is a site that
 * is off — or a console that is off, which for the customer is the same
 * morning.
 *
 * The expensive questions — WAN metrics per site, a line test per circuit —
 * are only spent once a site has failed twice, and are capped per sweep. A
 * genuine national outage would otherwise have the portal fire two hundred
 * line tests inside a minute, which is how an account gets rate-limited on
 * the one morning it is needed.
 */

export const SWEEP_INTERVAL_MS = CHECK_INTERVAL_MS;

/**
 * Sites diagnosed in one sweep.
 *
 * Diagnosis is the expensive half. Six is enough for a normal bad morning and
 * bounded enough that a national outage cannot turn into a self-inflicted
 * denial of service. Anything beyond it is checked, counted, and diagnosed on
 * the next pass — five minutes later, which is not a long wait when a
 * supplier is down nationally anyway.
 */
export const DIAGNOSE_BUDGET = 6;

/**
 * Is the site reachable, judged from what the console can see?
 *
 * `unknown` for a site with nothing to judge by, which is a real case: a
 * site whose console is newly adopted, or one that is all cloud keys and no
 * devices. Calling that `down` would raise a ticket for every empty site on
 * the account.
 */
export function reachabilityFromCounts(site: NetworkSite): CheckResult['reachable'] {
  const total = site.counts?.totalDevices;
  const offline = site.counts?.offlineDevices;

  if (total === undefined || total === 0) return 'unknown';
  if (offline === undefined) return 'unknown';
  // Everything the console owns here is unreachable. Either the site is off
  // or the console is, and both are worth somebody's morning.
  if (offline >= total) return 'down';
  return 'up';
}

/** What the WAN feed says, where it says anything. */
export function reachabilityFromWan(wan: WanHealth | null): CheckResult['reachable'] {
  const uptime = wan?.latest?.uptimePercent;
  if (uptime === undefined) return 'unknown';
  return uptime > 0 ? 'up' : 'down';
}

/** The client this console site belongs to, from our own index. */
function clientForSite(site: NetworkSite): {
  key: string;
  clientKey?: string;
  name: string;
  refs: string[];
  address?: string;
} {
  /*
   * The watch key is the site's identity, never its name and never the
   * client's.
   *
   * Both alternatives were wrong and one of them shipped. Keying on the name
   * meant every console's "Default" site — which is what an unrenamed
   * console calls its site, so most of them — shared a single counter, and
   * their drops pooled: an event opened saying "5 drops" while the stored
   * state had 6, because the sixth belonged to somebody else's building.
   * Keying on the client would pool Market Halls Victoria with Market Halls
   * Oxford Street, which is the same bug wearing a tie.
   *
   * The site id is unique, stable across renames, and per-site by
   * construction. The client is metadata hung off the event, not identity.
   */
  const key = `unifi:${site.siteId}`;
  const [best] = findClients(site.name, 1);
  if (best) {
    return {
      key,
      clientKey: best.key,
      name: best.name,
      refs: best.serviceRefs,
      ...(best.sites[0]?.address ? { address: best.sites[0].address } : {}),
    };
  }
  // No match in the index. Still watch it — an unmatched site going off is
  // worth knowing about, and the Clients tab is where somebody joins it up.
  return { key, name: site.name, refs: [] };
}

/* ------------------------------------------------------------------ *
 * Diagnosis
 * ------------------------------------------------------------------ */

const bad = (label: string, value?: string, detail?: string): EventFinding => ({
  source: 'unifi',
  label,
  ...(value ? { value } : {}),
  ...(detail ? { detail } : {}),
  verdict: 'bad',
});

/** A SIM, as the event wants it — with the network it is actually on. */
function asMobile(sim: SimRecord): EventMobile {
  const operator = operatorForSim({
    ...(sim.network ? { network: sim.network } : {}),
    ...(sim.tariff ? { tariff: sim.tariff } : {}),
  });
  return {
    ...(sim.msisdn ? { msisdn: sim.msisdn } : {}),
    ...(sim.iccid ? { iccid: sim.iccid } : {}),
    ...(operator ? { operator: operator.name } : {}),
    ...(sim.tariff ? { tariff: sim.tariff } : {}),
    ...(sim.state ? { state: sim.state } : {}),
    ...(sim.usedPercentReported !== undefined ? { usedPercent: sim.usedPercentReported } : {}),
  };
}

/**
 * Everything worth gathering about a site that is off.
 *
 * Each half is caught on its own. A Zen outage must not stop the UniFi half
 * being reported, and neither must stop the event existing — a bare event
 * saying "the site is off and we could not find out why" is worth far more
 * than no event at all.
 */
async function diagnose(
  site: NetworkSite,
  client: { key: string; name: string; refs: string[] },
): Promise<{
  attribution: ReturnType<typeof attribute>['attribution'];
  attributionBecause: string;
  findings: EventFinding[];
  inventory: EventInventory;
  environment: EventEnvironment;
  wans: EventWan[];
  wanVerdict: CheckResult['reachable'];
}> {
  const findings: EventFinding[] = [];
  const inventory: EventInventory = {};

  /* ---- The environment, which every technical ticket carries -------- */
  const environment: EventEnvironment = {
    siteId: site.siteId,
    ...(site.name ? { consoleName: site.name } : {}),
    ...(site.gateway?.model ? { gatewayModel: site.gateway.model } : {}),
    ...(site.counts?.totalDevices !== undefined ? { totalDevices: site.counts.totalDevices } : {}),
    ...(site.counts?.offlineDevices !== undefined ? { offlineDevices: site.counts.offlineDevices } : {}),
    ...(site.counts?.wiredClients !== undefined ? { wiredClients: site.counts.wiredClients } : {}),
    ...(site.counts?.wifiClients !== undefined ? { wifiClients: site.counts.wifiClients } : {}),
    ...(site.counts?.wanConfigurations !== undefined ? { wanCount: site.counts.wanConfigurations } : {}),
    ...(site.isp?.name ?? site.isp?.organisation ? { ispName: (site.isp?.name ?? site.isp?.organisation)! } : {}),
    ...(site.timezone ? { timezone: site.timezone } : {}),
  };

  // Named devices are worth more than a count. The gateway is the one
  // anybody asks about first.
  try {
    const devices = await devicesForHost(site.hostId);
    if (devices.length) {
      inventory.devices = devices.slice(0, 40).map((d: NetworkDevice) => ({
        ...(d.name ? { name: d.name } : {}),
        ...(d.model ? { model: d.model } : {}),
        ...(d.ip ? { ip: d.ip } : {}),
        ...(d.status ? { state: d.status } : {}),
      }));
      // `isConsole` where the controller says so; the model pattern only as
      // a fallback, because a device named "Gateway Cupboard AP" would
      // otherwise be reported as the gateway.
      const gateway =
        devices.find((d: NetworkDevice) => d.isConsole) ??
        devices.find((d: NetworkDevice) =>
          /\b(udm|uxg|usg|ucg)\b/i.test(`${d.shortModel ?? ''} ${d.model ?? ''}`),
        );
      if (gateway?.name) environment.gatewayName = gateway.name;
      if (gateway?.model && !environment.gatewayModel) environment.gatewayModel = gateway.model;
      if (environment.totalDevices === undefined) environment.totalDevices = devices.length;
    }
  } catch {
    // The device list is context, not a symptom. Its absence is not either.
  }

  /* ---- The console's own view of the uplinks ------------------------ */
  let wanVerdict: CheckResult['reachable'] = 'unknown';
  let health: WanHealth | null = null;
  try {
    health = await wanHealth(site.hostId, site.siteId);
    wanVerdict = reachabilityFromWan(health);
    if (health?.latest) {
      const uptime = health.latest.uptimePercent;
      findings.push({
        source: 'unifi',
        label: 'WAN uptime, last sample',
        ...(uptime !== undefined ? { value: `${uptime}%` } : {}),
        ...(health.latest.ispName ? { detail: `via ${health.latest.ispName}` } : {}),
        verdict: uptime === 0 ? 'bad' : uptime !== undefined && uptime < 100 ? 'warn' : 'good',
        ...(health.latest.at ? { at: health.latest.at } : {}),
      });
      if (health.downtimeSeconds) {
        findings.push({
          source: 'unifi',
          label: 'Downtime in the last 24 hours',
          value: `${Math.round(health.downtimeSeconds / 60)} minutes`,
          verdict: 'warn',
        });
      }
    }
  } catch (err) {
    findings.push({
      source: 'unifi',
      label: 'WAN metrics',
      detail: err instanceof Error ? err.message : String(err),
      verdict: 'info',
    });
  }

  if (site.counts?.totalDevices) {
    findings.push(
      bad(
        'Devices the console can reach',
        `${site.counts.totalDevices - (site.counts.offlineDevices ?? 0)} of ${site.counts.totalDevices}`,
      ),
    );
  }

  /* ---- The WAN rows, tested where they are ours --------------------- */
  //
  // The rule the rows follow: a managed line gets a test and a result, and
  // an unmanaged one says which provider it is and that we cannot test it.
  // A blank column is a question; "no test: G.Network on WAN 2 is not a
  // line we manage" is an answer.
  const uplinks = wanLinesFrom({ site, health, ...(health?.uplinks ? { uplinks: health.uplinks } : {}) });
  const wans: EventWan[] = [];
  let lineTest: 'network-fault' | 'clean' | 'not-run' = 'not-run';
  let circuit: CheckResult['reachable'] = 'unknown';

  // Our own references, matched to a slot where we can tell which.
  const ours = client.refs.slice(0, 4).map((reference, i) => ({ id: `line-${i}`, reference, provider: 'Zen' }));
  const { matched } = reconcileWans(ours, uplinks);
  const slotFor = new Map<string, string>();
  for (const [lineId, result] of matched) slotFor.set(result.wan.id, lineId);

  for (const wan of uplinks) {
    const lineId = slotFor.get(wan.id);
    const line = ours.find((o) => o.id === lineId);

    if (!line) {
      wans.push(
        wanRow({
          id: wan.id,
          label: wan.label,
          providerName: wan.providerName,
          ...(wan.stats.uptimePercent === undefined ? {} : { online: wan.stats.uptimePercent > 0 }),
        }),
      );
      continue;
    }

    // A managed line: test it, and record what came back verbatim.
    try {
      const result = await ops.runTest(line.reference, 'linetest');
      const faulty = result.data.outcome === 'fail' || Boolean(result.data.faultLocation);
      if (faulty) {
        lineTest = 'network-fault';
        circuit = 'down';
      } else if (lineTest === 'not-run') {
        lineTest = 'clean';
      }

      wans.push(
        wanRow({
          id: wan.id,
          label: wan.label,
          providerName: wan.providerName,
          serviceReference: line.reference,
          ...(wan.stats.uptimePercent === undefined ? {} : { online: wan.stats.uptimePercent > 0 }),
          test: {
            ran: true,
            passed: !faulty,
            output: plainTestOutput(result.data),
          },
        }),
      );

      findings.push({
        source: 'line-test',
        label: `Line test on ${line.reference}`,
        value: result.data.summary ?? result.data.outcome,
        ...(result.data.faultLocation ? { detail: `Fault located: ${result.data.faultLocation}` } : {}),
        verdict: faulty ? 'bad' : 'good',
      });
      inventory.services = [
        ...(inventory.services ?? []),
        { reference: line.reference, supplier: 'Zen', ...(result.data.summary ? { status: result.data.summary } : {}) },
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      wans.push(
        wanRow({
          id: wan.id,
          label: wan.label,
          providerName: wan.providerName,
          serviceReference: line.reference,
          ...(wan.stats.uptimePercent === undefined ? {} : { online: wan.stats.uptimePercent > 0 }),
          test: { ran: false, error: message },
        }),
      );
      findings.push({ source: 'line-test', label: `Line test on ${line.reference}`, detail: message, verdict: 'info' });
    }
  }

  // References we hold that no WAN could be matched to. Still tested — a
  // circuit is a circuit whether or not the console admits to it.
  for (const line of ours.filter((o) => ![...matched.keys()].includes(o.id))) {
    try {
      const result = await ops.runTest(line.reference, 'linetest');
      const faulty = result.data.outcome === 'fail' || Boolean(result.data.faultLocation);
      if (faulty) {
        lineTest = 'network-fault';
        circuit = 'down';
      } else if (lineTest === 'not-run') {
        lineTest = 'clean';
      }
      wans.push(
        wanRow({
          id: `unmatched-${line.reference}`,
          label: 'Circuit',
          providerName: 'Zen Internet',
          serviceReference: line.reference,
          test: { ran: true, passed: !faulty, output: plainTestOutput(result.data) },
        }),
      );
    } catch (err) {
      wans.push(
        wanRow({
          id: `unmatched-${line.reference}`,
          label: 'Circuit',
          providerName: 'Zen Internet',
          serviceReference: line.reference,
          test: { ran: false, error: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  /* ---- The 5G unit and its SIM -------------------------------------- */
  try {
    const estate = await ops.simEstate();
    const theirs = estate.data.sims.filter(
      (sim) => sim.clientName && clientKey(sim.clientName) === clientKey(client.name),
    );
    if (theirs.length) {
      inventory.mobiles = theirs.slice(0, 6).map(asMobile);
      const carrying = theirs.some((sim) => (sim.usedBytes ?? 0) > 0 && sim.state === 'active');
      findings.push({
        source: 'mobile',
        label: 'Mobile backup',
        value: `${theirs.length} SIM${theirs.length === 1 ? '' : 's'} on this customer`,
        ...(carrying ? { detail: 'At least one is passing traffic.' } : {}),
        verdict: carrying ? 'warn' : 'info',
      });
    }
  } catch {
    // No mobile estate is not a symptom. Most sites have none.
  }

  const backupCarrying = (inventory.mobiles ?? []).some((m) => m.online === true);
  const verdict = attribute({
    unifi: 'down',
    circuit: circuit === 'unknown' ? (wanVerdict === 'down' ? 'down' : wanVerdict) : circuit,
    lineTest,
    ...(backupCarrying ? { backupCarrying } : {}),
  });

  return {
    ...verdict,
    attributionBecause: verdict.because,
    findings,
    inventory,
    environment,
    wans,
    wanVerdict,
  };
}

/**
 * A line test as plain text, for the code block on the ticket.
 *
 * The provider's own figures, verbatim. Summarising a test into "fault
 * found" loses the attenuation reading the supplier will ask for, and an
 * engineer who has to re-run the test to get it back has been handed a worse
 * ticket than no ticket at all.
 */
function plainTestOutput(result: {
  outcome?: string;
  summary?: string;
  faultLocation?: string;
  metrics?: Array<{ label: string; value: string; unit?: string; verdict?: string }>;
  recommendations?: string[];
  source?: string;
}): string {
  const lines: string[] = [];
  if (result.outcome) lines.push(`Outcome: ${result.outcome}`);
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  if (result.faultLocation) lines.push(`Fault located: ${result.faultLocation}`);
  for (const metric of result.metrics ?? []) {
    const flag = metric.verdict && metric.verdict !== 'info' ? `  [${metric.verdict}]` : '';
    lines.push(`${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ''}${flag}`);
  }
  for (const recommendation of result.recommendations ?? []) lines.push(`Recommendation: ${recommendation}`);
  if (result.source) lines.push(`Source: ${result.source}`);
  return lines.length ? lines.join('\n') : 'The provider returned no detail.';
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

export interface SweepOutcome {
  checked: number;
  down: number;
  raised: number;
  unstable: number;
  recovered: number;
  diagnosed: number;
  /** Sites that needed diagnosing but were over the per-sweep budget. */
  deferred: number;
  skipped?: string;
}

const EMPTY: SweepOutcome = { checked: 0, down: 0, raised: 0, unstable: 0, recovered: 0, diagnosed: 0, deferred: 0 };

/**
 * When the last sweep ran, so the interval is honoured whatever drives it.
 *
 * The outage check rides the supervisor's timer rather than owning one, on
 * the same reasoning as the watch sweep: one scheduler is one thing to
 * reason about. But that interval is configurable and this one is not — five
 * minutes is the promise — so elapsed time is checked here rather than
 * assumed from whoever called.
 */
let lastSweepAt = 0;

/** True where enough time has passed to be worth checking again. */
export function sweepDue(nowMs = Date.now()): boolean {
  return nowMs - lastSweepAt >= SWEEP_INTERVAL_MS;
}

/**
 * Runs the sweep if it is due, and says so if not.
 *
 * The entry point for anything on a timer. `sweepOutages` itself always
 * runs, which is what a manual "check now" button wants.
 */
export async function sweepOutagesIfDue(now = new Date().toISOString()): Promise<SweepOutcome> {
  if (!sweepDue(Date.parse(now) || Date.now())) {
    return { ...EMPTY, skipped: 'Checked less than five minutes ago.' };
  }
  return sweepOutages(now);
}

/** Test hook. */
export function resetSweepClock(): void {
  lastSweepAt = 0;
}

export async function sweepOutages(now = new Date().toISOString()): Promise<SweepOutcome> {
  lastSweepAt = Date.parse(now) || Date.now();

  if (!unifiConfigured()) {
    return { ...EMPTY, skipped: 'UniFi Site Manager is not connected, so there is nothing to check sites against.' };
  }

  let sites: NetworkSite[];
  try {
    sites = await networkSites();
  } catch (err) {
    return { ...EMPTY, skipped: err instanceof Error ? err.message : String(err) };
  }

  const outcome: SweepOutcome = { ...EMPTY };
  const toDiagnose: Array<{ site: NetworkSite; kind: 'outage' | 'unstable'; because: string }> = [];

  for (const site of sites) {
    const reachable = reachabilityFromCounts(site);
    const client = clientForSite(site);
    const check: CheckResult = {
      source: 'unifi',
      at: now,
      reachable,
      ...(site.counts?.totalDevices
        ? { detail: `${site.counts.offlineDevices ?? 0} of ${site.counts.totalDevices} devices offline` }
        : {}),
    };

    const result = recordCheck(client.key, site.name, [check], now);
    outcome.checked += 1;
    if (reachable === 'down') outcome.down += 1;

    if (result.action === 'raise') toDiagnose.push({ site, kind: 'outage', because: result.because });
    if (result.action === 'unstable') toDiagnose.push({ site, kind: 'unstable', because: result.because });
    if (result.action === 'recovered') {
      outcome.recovered += 1;
      audit({ action: 'event.check_passed', automatic: true, detail: { clientKey: client.key, site: site.name } });
    }
  }

  // Worst first, so a budget that runs out runs out on the least bad.
  toDiagnose.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'outage' ? -1 : 1));
  outcome.deferred = Math.max(0, toDiagnose.length - DIAGNOSE_BUDGET);

  for (const item of toDiagnose.slice(0, DIAGNOSE_BUDGET)) {
    const client = clientForSite(item.site);
    const { event, created } = raiseEvent({
      kind: item.kind,
      clientKey: client.key,
      clientName: client.name,
      siteName: item.site.name,
      ...(client.address ? { address: client.address } : {}),
      because: item.because,
      automatic: true,
      at: now,
    });
    if (!created) continue;

    if (item.kind === 'outage') outcome.raised += 1;
    else outcome.unstable += 1;

    audit({
      action: 'event.opened',
      automatic: true,
      detail: { eventId: event.id, clientKey: client.key, site: item.site.name, kind: item.kind, because: item.because },
    });

    let diagnosed = event;
    try {
      const diagnosis = await diagnose(item.site, client);
      outcome.diagnosed += 1;
      diagnosed =
        attachDiagnosis(
          event.id,
          {
            attribution: diagnosis.attribution,
            attributionBecause: diagnosis.attributionBecause,
            findings: diagnosis.findings,
            inventory: diagnosis.inventory,
            // `downSince` comes off the watch state rather than the clock:
            // the ticket should say when the site went, not when we got
            // round to raising it.
            environment: {
              ...diagnosis.environment,
              ...(watchState(client.key, item.site.name).downSince
                ? { downSince: watchState(client.key, item.site.name).downSince! }
                : {}),
            },
            wans: diagnosis.wans,
          },
          now,
        ) ?? event;
      audit({
        action: 'event.check_failed',
        automatic: true,
        detail: {
          eventId: event.id,
          clientKey: client.key,
          attribution: diagnosis.attribution,
          because: diagnosis.attributionBecause,
        },
      });
    } catch (err) {
      // A diagnosis that failed still leaves an event saying the site is
      // off, which is the part somebody needs.
      audit({
        action: 'event.check_failed',
        automatic: true,
        detail: { eventId: event.id, error: err instanceof Error ? err.message : String(err) },
      });
    }

    await raiseTicketFor(diagnosed.id, diagnosed);
  }

  return outcome;
}

/**
 * Puts the event on the helpdesk, unassigned.
 *
 * Unassigned deliberately: `createInternalTicket` with no assignee lands in
 * the queue rather than on somebody's list, which is what "logged as
 * unassigned on the helpdesk on its own" means. Whoever picks it up owns it,
 * and nobody wakes up already owning six.
 */
async function raiseTicketFor(id: string, event: Parameters<typeof eventTicketNote>[0]): Promise<void> {
  if (!zendeskConfigured()) return;

  const publicUrl = config().publicUrl;
  const url = publicUrl ? `${publicUrl}/#/events/${id}` : undefined;

  try {
    const ticket = await createInternalTicket({
      subject: eventSubject(event),
      body: eventTicketNote(event, url),
      tags: [ALERT_TAG, 'netkit-event', event.kind === 'unstable' ? 'netkit-unstable' : 'netkit-outage'],
      priority: event.kind === 'outage' ? 'high' : 'normal',
    });
    attachTicket(id, ticket.ticketId, ticket.url);
    audit({
      action: 'event.ticket_raised',
      automatic: true,
      detail: { eventId: id, ticketId: ticket.ticketId, unassigned: true },
    });
  } catch (err) {
    audit({
      action: 'event.check_failed',
      automatic: true,
      detail: { eventId: id, ticketFailed: err instanceof Error ? err.message : String(err) },
    });
  }
}

export const __sweepTesting = { clientForSite, diagnose };
