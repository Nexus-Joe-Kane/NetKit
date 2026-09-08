import type {
  AddressMatch,
  AddressRecord,
  AddressRegistration,
  AppointmentSlot,
  AvailableTests,
  CallRecord,
  CompanyContext,
  EstateUsageReport,
  EthernetQuoteSet,
  FaultRecord,
  FootfallInsight,
  ImeiLookup,
  Incident,
  LineTestResult,
  LineTestType,
  NetworkConfiguration,
  NetworkConnectivityCheck,
  NumberPortCheck,
  OrderQuote,
  OrderRecord,
  OrderingGate,
  PlaceOrderRequest,
  PlaceOrderResult,
  ProfileOptions,
  ProviderNotification,
  RaiseFaultRequest,
  RdnsRecord,
  ServiceHistory,
  SimEstate,
  StabilityReport,
  UsageReport,
  CompanyDetail,
} from '@sw/shared';
import { config } from '../config';
import { isProviderEnabled, settings } from '../auth/store';
import { quotaLimit, quotaUsed } from './quota';
import { circuitReason, reportLiveFailure, reportLiveSuccess, shouldAttempt } from '../admin/supervisor';
import * as assurance from '../providers/zen/assurance';
import * as selfService from '../providers/zen/selfservice';
import * as bt from '../providers/bt/adapters';
import * as jola from '../providers/jola/adapters';
import { notConfigured } from '../lib/errors';
import {
  companiesHouseConfigured,
  withPremisesDetail,
  fetchCompaniesAtPostcode,
  fetchCompanyDetail,
} from '../providers/companies/companiesHouse';

/**
 * Operational orchestration.
 *
 * One pattern throughout: attempt the live provider when it is configured and
 * enabled, and otherwise say so plainly. There is no fixture fallback -- the
 * demo engine has been removed, because invented data on a live deployment is
 * worse than an empty panel that explains itself.
 */

export interface Sourced<T> {
  data: T;
  /** Always `live` now: nothing else can produce data. */
  mode: 'live';
  /**
   * Set only where a live call produced a shaped answer that is not a clean
   * success -- an order whose outcome could not be confirmed, for instance.
   * Not a fallback marker: there is nothing to fall back to.
   */
  error?: string;
}

interface Attempt<T> {
  /** Provider toggle key, matched against the admin switches. */
  key: string;
  configured: boolean;
  live: () => Promise<T>;
}

/**
 * Runs the live provider, or explains why it could not.
 *
 * There is no fallback. The demo engine used to stand in here, and invented
 * data on a live deployment is worse than a panel that says what is missing:
 * a plausible-looking fault list nobody raised, a SIM estate nobody owns.
 *
 * `not_configured` is a first-class error code with its own status, so a
 * missing key, a provider switched off in the admin portal and a provider
 * paused by the circuit breaker all reach the UI as one recognisable state
 * carrying an actionable message -- rather than as an empty panel that looks
 * like an answer.
 */
async function resolve<T>({ key, configured, live }: Attempt<T>): Promise<Sourced<T>> {
  if (!isProviderEnabled(key)) {
    throw notConfigured(`${key} is switched off in Admin portal → Integrations.`);
  }
  if (!configured) {
    throw notConfigured(`${key} has no credentials configured. Admin portal → Service status says which.`);
  }

  // The circuit breaker: while it is open, skip the live call entirely rather
  // than making every request wait for the same timeout. The supervisor lets
  // one probe through once the backoff expires.
  if (!shouldAttempt(key)) {
    throw notConfigured(circuitReason(key) ?? `${key} is temporarily paused after repeated failures.`);
  }

  try {
    const data = await live();
    reportLiveSuccess(key);
    return { data, mode: 'live' };
  } catch (err) {
    reportLiveFailure(key, err instanceof Error ? err.message : String(err));
    // The failure is the answer. Substituting data would hide an outage.
    throw err;
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
  });
}

export function outagesForService(zenReference: string): Promise<Sourced<Incident[]>> {
  return resolve({
    key: 'zen-faults',
    configured: zenReady('indirect-faults'),
    live: () => assurance.fetchOutagesForService(zenReference),
    // Most services are not caught in an outage, so the honest fixture is
    // usually an empty list.
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
  });
}

export function raiseFault(request: RaiseFaultRequest): Promise<Sourced<FaultRecord>> {
  return resolve({
    key: 'zen-faults',
    configured: zenReady('indirect-faults'),
    live: () => assurance.raiseFault(request),
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
  });
}

export function runTest(zenReference: string, type: LineTestType, technology?: string): Promise<Sourced<LineTestResult>> {
  const family = assurance.testFamilyFor(technology);
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.runTest(zenReference, type, family),
  });
}

export function profileOptions(zenReference: string): Promise<Sourced<ProfileOptions>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.fetchProfileOptions(zenReference),
  });
}

export function requestProfileChange(zenReference: string, profileCode: string): Promise<Sourced<LineTestResult>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.requestProfileChange(zenReference, profileCode),
  });
}

export function stability(zenReference: string, days = 30): Promise<Sourced<StabilityReport>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.fetchStability(zenReference, days),
  });
}

export function usage(zenReference: string, period: UsageReport['period'] = 'current_month'): Promise<Sourced<UsageReport>> {
  return resolve({
    key: 'zen-diagnostics',
    configured: zenReady('indirect-diagnostics'),
    live: () => assurance.fetchUsage(zenReference, period),
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
  });
}

export function cancelOrder(zenReference: string, reason: string): Promise<Sourced<{ ok: boolean; message?: string }>> {
  return resolve({
    key: 'zen-order',
    configured: zenReady('indirect-order'),
    live: () => selfService.cancelOrder(zenReference, reason),
  });
}

/**
 * Whether this user may place an order right now, and if not, why not.
 *
 * Four independent conditions, reported separately rather than as one
 * boolean, because "the button is greyed out" is a support call unless the
 * reason is on screen. The order of the checks is the order a person would
 * fix them in.
 */
export function orderingGate(userId: string): OrderingGate {
  const environmentAllows = config().allowOrdering;
  const adminAllows = settings().ordering?.enabled === true;
  const credentialsPresent = zenReady('indirect-placeorder') && isProviderEnabled('zen-placeorder');
  const dailyCap = quotaLimit('order');
  const usedToday = quotaUsed('order', userId);
  const withinCap = dailyCap === 0 || usedToday < dailyCap;

  // The two locks guard real spend; the cap guards a loop. Credentials do not
  // gate the flow — without them there is nothing to spend, and walking the
  // flow is how somebody learns it before the keys land. `demo` says which
  // it is, and the outcome screen never claims an order was placed.
  const reason = !environmentAllows
    ? 'Ordering is switched off in the server environment (ZEN_ALLOW_ORDERING). Changing it needs a deploy.'
    : !adminAllows
      ? 'Ordering is switched off in the admin portal. An administrator can enable it under Ordering & limits.'
      : !withinCap
        ? `You have placed ${usedToday} of your ${dailyCap} orders for today. The cap resets at midnight UTC.`
        : undefined;

  return {
    allowed: environmentAllows && adminAllows && withinCap,
    environmentAllows,
    adminAllows,
    credentialsPresent,
    demo: !credentialsPresent,
    usedToday,
    dailyCap,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Sends the order.
 *
 * The gate is checked by the route before this is called; this is the last
 * line and re-checks nothing, because a second read of a toggle between the
 * check and the call would be a false comfort.
 */
export async function placeOrder(request: PlaceOrderRequest): Promise<Sourced<PlaceOrderResult>> {
  const key = 'zen-placeorder';
  if (!isProviderEnabled(key) || !zenReady('indirect-placeorder')) {
    throw notConfigured('Ordering through Zen is not available: the placeorder scope is not configured.');
  }

  // Deliberately *not* routed through `resolve`. A failure here cannot be
  // reported as a plain error: a request that timed out may well have reached
  // Zen and placed the order. So it is reported as an unconfirmed order, with
  // the wording an operator needs to hear, and the next step is to search the
  // order book rather than to press the button again.
  try {
    const data = await selfService.placeOrder(request);
    reportLiveSuccess(key);
    return { data, mode: 'live' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportLiveFailure(key, message);
    return {
      data: {
        accepted: false,
        message: `The order could not be confirmed: ${message}`,
        messages: [
          'This does not prove the order was rejected — the request may have reached Zen. Search the order book for this address before trying again.',
        ],
        source: 'zen:self-service',
      },
      mode: 'live',
      error: message,
    };
  }
}

export function pricing(productCode: string, productName?: string): Promise<Sourced<OrderQuote>> {
  return resolve({
    key: 'zen-placeorder',
    configured: zenReady('indirect-placeorder'),
    live: () => selfService.fetchPricing(productCode, productName),
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
  });
}

export function ethernetQuotes(address: AddressRecord): Promise<Sourced<EthernetQuoteSet>> {
  return resolve({
    key: 'zen-quote',
    configured: zenReady('indirect-quote'),
    live: () => selfService.fetchEthernetQuotes(address),
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
  });
}

export function networkConnectivity(phoneNumber: string): Promise<Sourced<NetworkConnectivityCheck>> {
  return resolve({
    key: 'bt-home-network',
    configured: btReady('bt-home-network'),
    live: () => bt.checkNetworkConnectivity(phoneNumber),
  });
}

export function imeiLookup(phoneNumber: string): Promise<Sourced<ImeiLookup>> {
  return resolve({
    key: 'bt-imei-lookup',
    configured: btReady('bt-imei-lookup'),
    live: () => bt.lookupImei(phoneNumber),
  });
}

export function footfall(postcode: string): Promise<Sourced<FootfallInsight>> {
  return resolve({
    key: 'bt-location-insights',
    configured: btReady('bt-location-insights'),
    live: () => bt.fetchFootfall({ postcode }),
  });
}

export function callRecords(from: Date, to: Date): Promise<Sourced<CallRecord[]>> {
  return resolve({
    key: 'zen-cdr',
    configured: zenReady('indirect-cdr'),
    live: () => selfService.fetchCallRecords(from, to),
  });
}

export function rdns(zenReference?: string): Promise<Sourced<RdnsRecord[]>> {
  return resolve({
    key: 'zen-broadbandconnection',
    configured: zenReady('indirect-broadbandconnection'),
    live: () => selfService.fetchRdns(zenReference),
  });
}

/* ------------------------------------------------------------------ *
 * Address references, history, notifications, network, estate usage
 * ------------------------------------------------------------------ */

export function addressMatch(query: {
  postcode: string;
  postTown?: string;
  premiseName?: string;
  thoroughfareNumber?: string;
}): Promise<Sourced<AddressMatch>> {
  return resolve({
    key: 'zen-availability',
    configured: zenReady('indirect-availability'),
    live: () => selfService.matchAddress(query),
  });
}

/**
 * Registers a premises with Openreach.
 *
 * A write, so it is not routed through the fixture fallback on failure —
 * "nothing was created" has to be true when it is said. Demo mode still
 * refuses politely.
 */
export async function registerAddress(request: {
  postcode: string;
  buildingName?: string;
  buildingNumber?: string;
  thoroughfare: string;
  postTown: string;
  county?: string;
  uprn?: string;
}): Promise<Sourced<AddressRegistration>> {
  const key = 'zen-availability';
  if (!isProviderEnabled(key) || !zenReady('indirect-availability')) {
    throw notConfigured(
      'Registering an address with Openreach needs the Zen availability scope, which is not configured.',
    );
  }
  try {
    const data = await selfService.registerAddress(request);
    reportLiveSuccess(key);
    return { data, mode: 'live' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportLiveFailure(key, message);
    return {
      data: {
        created: false,
        technologyRestrictions: [],
        messages: [`The registration could not be confirmed: ${message}`, 'Re-run the address match before trying again — the premises may now be registered.'],
        source: 'zen:self-service',
      },
      mode: 'live',
      error: message,
    };
  }
}

export function serviceHistory(zenReference: string): Promise<Sourced<ServiceHistory>> {
  return resolve({
    key: 'zen-service',
    configured: zenReady('indirect-service'),
    live: () => selfService.fetchServiceHistory(zenReference),
  });
}

export function notifications(options: { since?: string; searchTerm?: string } = {}): Promise<Sourced<ProviderNotification[]>> {
  return resolve({
    key: 'zen-customerengagement',
    configured: zenReady('indirect-customerengagement'),
    live: () => selfService.fetchNotifications(options),
  });
}

export function networkConfiguration(zenReference?: string): Promise<Sourced<NetworkConfiguration>> {
  return resolve({
    key: 'zen-broadbandconnection',
    configured: zenReady('indirect-broadbandconnection'),
    live: () => selfService.fetchNetworkConfiguration(zenReference),
  });
}

export function estateUsage(period?: string): Promise<Sourced<EstateUsageReport>> {
  return resolve({
    key: 'zen-service',
    configured: zenReady('indirect-service'),
    live: () => selfService.fetchEstateUsage(period),
  });
}

/* ------------------------------------------------------------------ *
 * Company context
 * ------------------------------------------------------------------ */

/**
 * Companies at a postcode, narrowed to a premises when one is given.
 *
 * The register indexes by postcode and nothing else, so the search is always
 * postcode-wide. When the caller knows which premises is on screen, the
 * result is narrowed to it and those companies are enriched with their
 * accounts dates and status qualifier — the facts that decide whether to warn
 * somebody. Without a premises the old postcode-wide answer comes back
 * unchanged.
 */
export function companies(postcode: string, premises?: AddressRecord): Promise<Sourced<CompanyContext>> {
  return resolve({
    key: 'companies-house',
    configured: companiesHouseConfigured(),
    live: async () => {
      const context = await fetchCompaniesAtPostcode(postcode);
      return premises ? withPremisesDetail(context, premises) : context;
    },
  });
}

/**
 * The full record for one company.
 *
 * Separate from `companies()` on purpose. The list is one search call for a
 * whole postcode; this is six calls for one company, so it runs only when
 * someone actually opens one.
 */
export function companyDetail(companyNumber: string): Promise<Sourced<CompanyDetail>> {
  return resolve({
    key: 'companies-house',
    configured: companiesHouseConfigured(),
    live: () => fetchCompanyDetail(companyNumber),
  });
}

/** Whether the BT location product is likely to have data for a postcode. */
export const isLikelyLondon = bt.isLikelyLondon;
