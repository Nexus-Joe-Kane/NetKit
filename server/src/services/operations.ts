import type {
  AddressRecord,
  AppointmentSlot,
  AvailableTests,
  CallRecord,
  EthernetQuoteSet,
  FaultRecord,
  FootfallInsight,
  ImeiLookup,
  Incident,
  LineTestResult,
  LineTestType,
  NetworkConnectivityCheck,
  NumberPortCheck,
  OrderQuote,
  OrderRecord,
  ProfileOptions,
  RaiseFaultRequest,
  RdnsRecord,
  SimEstate,
  StabilityReport,
  UsageReport,
} from '@sw/shared';
import { config, shouldRunLive } from '../config';
import { isProviderEnabled } from '../auth/store';
import * as assurance from '../providers/zen/assurance';
import * as selfService from '../providers/zen/selfservice';
import * as bt from '../providers/bt/adapters';
import * as jola from '../providers/jola/adapters';
import * as fx from '../providers/fixture/operations';

/**
 * Operational orchestration.
 *
 * One pattern throughout: attempt the live provider when it is configured and
 * enabled, fall back to fixtures otherwise, and always report which was used
 * so the UI can label it. `DATA_MODE=live` suppresses the fallback so a
 * misconfiguration surfaces instead of being papered over.
 */

export interface Sourced<T> {
  data: T;
  mode: 'live' | 'mock';
  /** Set when a live call failed and fixtures were used instead. */
  error?: string;
}

interface Attempt<T> {
  /** Provider toggle key, matched against the admin switches. */
  key: string;
  configured: boolean;
  live: () => Promise<T>;
  fixture: () => T;
}

async function resolve<T>({ key, configured, live, fixture }: Attempt<T>): Promise<Sourced<T>> {
  const mode = config().dataMode;
  const enabled = isProviderEnabled(key);
  const canGoLive = enabled && shouldRunLive(configured);

  if (!canGoLive) {
    if (mode === 'live') {
      throw new Error(
        !enabled
          ? `${key} is switched off in the admin portal.`
          : `${key} has no credentials configured, and DATA_MODE=live forbids demo data.`,
      );
    }
    return { data: fixture(), mode: 'mock' };
  }

  try {
    return { data: await live(), mode: 'live' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mode === 'live') throw err;
    // Degrade to fixtures but keep the reason, so the UI can say why.
    return { data: fixture(), mode: 'mock', error: message };
  }
}

/** True when Zen credentials exist and the given scope was granted. */
function zenReady(scope: string): boolean {
  const zen = config().zen;
  return zen.configured && zen.scopes.includes(scope as (typeof zen.scopes)[number]);
}

const btReady = (key: string): boolean => Boolean(config().bt.products[key]?.apiKey || config().bt.products[key]?.clientId);

const jolaReady = (): boolean => Boolean(config().jola.baseUrl && config().jola.apiKey);

/* ------------------------------------------------------------------ *
 * Network status
 * ------------------------------------------------------------------ */

export function networkStatus(options: { past?: boolean } = {}): Promise<Sourced<{ outages: Incident[]; plannedWork: Incident[] }>> {
  return resolve({
    key: 'zen-faults',
    configured: zenReady('indirect-faults'),
    live: async () => {
      const [outages, plannedWork] = await Promise.all([
        assurance.fetchOutages(options),
        assurance.fetchPlannedWork(options),
      ]);
      return { outages, plannedWork };
    },
    fixture: () => ({
      outages: fx.buildFixtureIncidents('outage', options.past),
      plannedWork: fx.buildFixtureIncidents('planned', options.past),
    }),
  });
}

export function outagesForService(zenReference: string): Promise<Sourced<Incident[]>> {
  return resolve({
    key: 'zen-faults',
    configured: zenReady('indirect-faults'),
    live: () => assurance.fetchOutagesForService(zenReference),
    // Most services are not caught in an outage, so the honest fixture is
    // usually an empty list.
    fixture: () => fx.buildFixtureIncidents('outage').slice(0, Number(zenReference.slice(-1)) % 3 === 0 ? 1 : 0),
  });
}

/* ------------------------------------------------------------------ *
 * Faults
 * ------------------------------------------------------------------ */

export function faults(options: { state: 'open' | 'closed'; zenReference?: string }): Promise<Sourced<FaultRecord[]>> {
  return resolve({
    key: 'zen-faults',
    configured: zenReady('indirect-faults'),
    live: () =>
      options.zenReference
        ? assurance.fetchFaultsForService(options.zenReference)
        : options.state === 'open'
          ? assurance.fetchOpenFaults()
          : assurance.fetchRecentlyClosedFaults(),
    fixture: () => fx.buildFixtureFaults(options),
  });
}

export function raiseFault(request: RaiseFaultRequest): Promise<Sourced<FaultRecord>> {
  return resolve({
    key: 'zen-faults',
    configured: zenReady('indirect-faults'),
    live: () => assurance.raiseFault(request),
    fixture: () => {
      // A fixture "raise" must be visibly a rehearsal, not a real reference.
      const record = fx.buildFixtureFaults({ state: 'open', zenReference: request.zenReference })[0];
      return {
        ...(record ?? ({} as FaultRecord)),
        reference: 'DEMO-NOT-RAISED',
        zenReference: request.zenReference,
        category: request.category,
        frequency: request.frequency,
        summary: request.summary,
        status: 'Not raised — demo mode',
        state: 'open' as const,
        detail:
          'Demo mode: no fault was raised with Zen. Connect Zen credentials with the indirect-faults scope to raise for real.',
        raisedAt: new Date().toISOString(),
        provider: 'Demo data',
        source: 'fixture:assurance',
      };
    },
  });
}

/* ------------------------------------------------------------------ *
 * Line testing
 * ------------------------------------------------------------------ */

export function availableTests(zenReference: string, technology?: string): Promise<Sourced<AvailableTests>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.fetchAvailableTests(zenReference, technology),
    fixture: () => fx.buildFixtureAvailableTests(zenReference, technology),
  });
}

export function latestTest(zenReference: string, type: LineTestType, technology?: string): Promise<Sourced<LineTestResult>> {
  const family = assurance.testFamilyFor(technology);
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: async () => {
      const result = await assurance.fetchLatestTest(zenReference, type, family);
      if (!result) throw new Error('No previous test result is recorded for this service.');
      return result;
    },
    fixture: () => fx.buildFixtureTestResult(zenReference, type),
  });
}

export function runTest(zenReference: string, type: LineTestType, technology?: string): Promise<Sourced<LineTestResult>> {
  const family = assurance.testFamilyFor(technology);
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.runTest(zenReference, type, family),
    fixture: () => ({
      ...fx.buildFixtureTestResult(zenReference, type),
      summary: `Demo mode — no test was run against the network. ${fx.buildFixtureTestResult(zenReference, type).summary ?? ''}`.trim(),
    }),
  });
}

export function profileOptions(zenReference: string): Promise<Sourced<ProfileOptions>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.fetchProfileOptions(zenReference),
    fixture: () => fx.buildFixtureProfileOptions(zenReference),
  });
}

export function requestProfileChange(zenReference: string, profileCode: string): Promise<Sourced<LineTestResult>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.requestProfileChange(zenReference, profileCode),
    fixture: () => ({
      ...fx.buildFixtureTestResult(zenReference, 'profilechange'),
      outcome: 'pass' as const,
      summary: `Demo mode — no profile change was requested. The live call would set ${profileCode}.`,
    }),
  });
}

export function stability(zenReference: string, days = 30): Promise<Sourced<StabilityReport>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.fetchStability(zenReference, days),
    fixture: () => fx.buildFixtureStability(zenReference, days),
  });
}

export function usage(zenReference: string, period: UsageReport['period'] = 'current_month'): Promise<Sourced<UsageReport>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.fetchUsage(zenReference, period),
    fixture: () => fx.buildFixtureUsage(zenReference, period),
  });
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

export function orders(options: { searchTerm?: string; view?: 'search' | 'status' | 'wip' } = {}): Promise<Sourced<OrderRecord[]>> {
  return resolve({
    key: 'zen-order',
    configured: zenReady('indirect-order'),
    live: () =>
      options.view === 'wip'
        ? selfService.fetchWipReport()
        : options.view === 'status'
          ? selfService.fetchOrderStatus(options.searchTerm)
          : selfService.searchOrders(options.searchTerm),
    fixture: () => fx.buildFixtureOrders(options.searchTerm),
  });
}

export function cancelOrder(zenReference: string, reason: string): Promise<Sourced<{ ok: boolean; message?: string }>> {
  return resolve({
    key: 'zen-order',
    configured: zenReady('indirect-order'),
    live: () => selfService.cancelOrder(zenReference, reason),
    fixture: () => ({ ok: false, message: 'Demo mode — no cancellation was sent to Zen.' }),
  });
}

export function pricing(productCode: string, productName?: string): Promise<Sourced<OrderQuote>> {
  return resolve({
    key: 'zen-placeorder',
    configured: zenReady('indirect-placeorder'),
    live: () => selfService.fetchPricing(productCode, productName),
    fixture: () => fx.buildFixturePricing(productCode, productName),
  });
}

export function appointments(params: {
  availabilityReference: string;
  productCode: string;
  goldAddressKey: string;
  districtCode: string;
}): Promise<Sourced<AppointmentSlot[]>> {
  return resolve({
    key: 'zen-availability',
    configured: zenReady('indirect-availability'),
    live: () => selfService.fetchAppointments(params),
    fixture: () => fx.buildFixtureAppointments(),
  });
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export function numberPortCheck(phoneNumber: string): Promise<Sourced<NumberPortCheck>> {
  return resolve({
    key: 'zen-availability',
    configured: zenReady('indirect-availability'),
    live: async () => {
      const started = await selfService.startNumberPortCheck(phoneNumber);
      // The check is asynchronous; poll briefly rather than making the
      // operator press a button again.
      if (!started.pending || !started.reference) return started;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((r) => setTimeout(r, 1200));
        const polled = await selfService.pollNumberPort(started.reference, phoneNumber);
        if (!polled.pending) return polled;
      }
      return started;
    },
    fixture: () => fx.buildFixturePortCheck(phoneNumber),
  });
}

export function ethernetQuotes(address: AddressRecord): Promise<Sourced<EthernetQuoteSet>> {
  return resolve({
    key: 'zen-quote',
    configured: zenReady('indirect-quote'),
    live: () => selfService.fetchEthernetQuotes(address),
    fixture: () => fx.buildFixtureEthernetQuotes(address),
  });
}

export function simEstate(): Promise<Sourced<SimEstate>> {
  // Zen's cellular endpoints are Jola-backed, so Zen is tried first and a
  // direct Jola integration is only needed for SIMs held outside Zen.
  return resolve({
    key: 'zen-broadbandconnection',
    configured: zenReady('indirect-broadbandconnection'),
    live: async () => {
      const zenEstate = await selfService.fetchSimEstate();
      if (zenEstate.sims.length > 0) return zenEstate;
      // Nothing at Zen — try Jola directly if it is configured.
      if (jolaReady() && isProviderEnabled('jola-mobile-manager')) {
        const jolaEstate = await jola.fetchJolaEstate();
        return { ...jolaEstate, sources: [...zenEstate.sources, ...jolaEstate.sources] };
      }
      return zenEstate;
    },
    fixture: () => fx.buildFixtureSimEstate(),
  });
}

export function networkConnectivity(phoneNumber: string): Promise<Sourced<NetworkConnectivityCheck>> {
  return resolve({
    key: 'bt-home-network',
    configured: btReady('bt-home-network'),
    live: () => bt.checkNetworkConnectivity(phoneNumber),
    fixture: () => fx.buildFixtureConnectivity(phoneNumber),
  });
}

export function imeiLookup(phoneNumber: string): Promise<Sourced<ImeiLookup>> {
  return resolve({
    key: 'bt-imei-lookup',
    configured: btReady('bt-imei-lookup'),
    live: () => bt.lookupImei(phoneNumber),
    fixture: () => fx.buildFixtureImei(phoneNumber),
  });
}

export function footfall(postcode: string): Promise<Sourced<FootfallInsight>> {
  return resolve({
    key: 'bt-location-insights',
    configured: btReady('bt-location-insights'),
    live: () => bt.fetchFootfall({ postcode }),
    fixture: () => fx.buildFixtureFootfall(postcode),
  });
}

export function callRecords(from: Date, to: Date): Promise<Sourced<CallRecord[]>> {
  return resolve({
    key: 'zen-cdr',
    configured: zenReady('indirect-cdr'),
    live: () => selfService.fetchCallRecords(from, to),
    fixture: () => fx.buildFixtureCallRecords(from, to),
  });
}

export function rdns(zenReference?: string): Promise<Sourced<RdnsRecord[]>> {
  return resolve({
    key: 'zen-broadbandconnection',
    configured: zenReady('indirect-broadbandconnection'),
    live: () => selfService.fetchRdns(zenReference),
    fixture: () => fx.buildFixtureRdns(zenReference),
  });
}

/** Whether the BT location product is likely to have data for a postcode. */
export const isLikelyLondon = bt.isLikelyLondon;
