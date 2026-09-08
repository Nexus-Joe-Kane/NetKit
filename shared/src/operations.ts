/**
 * Operational domain model — everything beyond "what's available at a site".
 *
 * These cover the rest of the Zen Indirect surface (faults, diagnostics,
 * outages, orders, porting, SIMs, usage) plus the BT and Jola capabilities.
 * As with the site model, every provider normalises into these shapes so the
 * UI never has to know which upstream answered.
 */

import type { AccessTechnology, AddressRecord } from './types';

/* ------------------------------------------------------------------ *
 * Network status — outages and planned work
 * ------------------------------------------------------------------ */

export type IncidentState = 'open' | 'monitoring' | 'resolved' | 'scheduled' | 'in_progress' | 'unknown';

export type IncidentImpact = 'total_loss' | 'partial_loss' | 'degraded' | 'at_risk' | 'no_impact' | 'unknown';

export interface Incident {
  reference: string;
  kind: 'outage' | 'planned';
  title: string;
  detail?: string;
  state: IncidentState;
  impact: IncidentImpact;
  /** When it started, or is scheduled to start. */
  startedAt?: string;
  /** Estimated or actual clear time. */
  endsAt?: string;
  clearedAt?: string;
  lastUpdatedAt?: string;
  /** Exchanges, postcode areas or regions affected, as reported. */
  areasAffected?: string[];
  /** Services of ours caught up in it, where the provider correlates them. */
  affectedServices?: Array<{ zenReference?: string; serviceId?: string; cli?: string; postcode?: string }>;
  /** Free-text updates, newest first. */
  updates?: Array<{ at: string; text: string }>;
  provider: string;
  source: string;
}

export interface NetworkStatusReport {
  outages: Incident[];
  plannedWork: Incident[];
  checkedAt: string;
  sources: string[];
}

/* ------------------------------------------------------------------ *
 * Faults
 * ------------------------------------------------------------------ */

export type FaultCategory = 'synchronisation' | 'performance' | 'authentication' | 'voice' | 'other';

export type FaultFrequency = 'intermittent' | 'permanent';

export interface FaultRecord {
  reference: string;
  /** Our service reference, so a fault can be tied back to a line. */
  zenReference?: string;
  serviceId?: string;
  cli?: string;
  category: FaultCategory;
  frequency?: FaultFrequency;
  status: string;
  state: 'open' | 'closed' | 'awaiting_customer' | 'engineer_assigned' | 'cleared' | 'unknown';
  summary: string;
  detail?: string;
  raisedAt: string;
  raisedBy?: string;
  clearedAt?: string;
  /** SLA / care level the fault is being worked to. */
  careLevel?: string;
  slaTarget?: string;
  /** Committed fix time, where one has been given. */
  committedAt?: string;
  appointment?: { date: string; slot?: string; type?: string; status?: string };
  updates?: Array<{ at: string; text: string; author?: string }>;
  /** True when the provider says the customer is liable for a visit charge. */
  chargeableRisk?: boolean;
  address?: AddressRecord;
  provider: string;
  source: string;
}

/** Payload for raising a fault. Mirrors Zen's category/frequency endpoints. */
export interface RaiseFaultRequest {
  zenReference: string;
  category: FaultCategory;
  frequency: FaultFrequency;
  summary: string;
  /** What has already been checked — providers reject faults without this. */
  testsCarriedOut?: string;
  contactName?: string;
  contactNumber?: string;
  contactEmail?: string;
  /** Site access notes and hazards, passed to the engineer. */
  siteNotes?: string;
  hazardNotes?: string;
}

/* ------------------------------------------------------------------ *
 * Line testing / diagnostics
 * ------------------------------------------------------------------ */

export type LineTestType =
  | 'linetest'
  | 'xdsltest'
  | 'tamtest'
  | 'kbdtest'
  | 'servicetest'
  | 'profilechange';

export type TestOutcome = 'pass' | 'fail' | 'inconclusive' | 'in_progress' | 'error' | 'unknown';

/** One measured value from a test, kept generic so any test can report. */
export interface TestMetric {
  label: string;
  value: string;
  /** Present when the provider gives a numeric value with a unit. */
  numeric?: number;
  unit?: string;
  /** Whether this reading is itself a problem. */
  verdict?: 'ok' | 'warn' | 'fail' | 'info';
}

export interface LineTestResult {
  /** Provider's id for this run, used to poll an async test. */
  id?: string;
  zenReference: string;
  type: LineTestType;
  outcome: TestOutcome;
  /** Where the provider believes the fault lies. */
  faultLocation?: string;
  summary?: string;
  detail?: string;
  ranAt?: string;
  ranBy?: string;
  /** Still running — the caller should poll. */
  pending: boolean;
  metrics: TestMetric[];
  /** What to do about it, from the provider or derived. */
  recommendations?: string[];
  errorMessage?: string;
  provider: string;
  source: string;
}

/** Which tests a given service supports, so the UI only offers valid ones. */
export interface AvailableTests {
  zenReference: string;
  technology?: AccessTechnology;
  types: Array<{ type: LineTestType; label: string; description?: string; disruptive?: boolean }>;
  source: string;
}

/** DLM / broadband profile options and the current setting. */
export interface ProfileOptions {
  zenReference: string;
  current?: string;
  options: Array<{ code: string; label: string; description?: string }>;
  source: string;
}

/** Connection drops over a period — the fastest way to spot an unstable line. */
export interface StabilityReport {
  zenReference: string;
  from: string;
  to: string;
  totalDrops: number;
  /** One bucket per day, for a sparkline. */
  buckets: Array<{ date: string; drops: number }>;
  /** Individual authentication attempts, where the provider exposes them. */
  authenticationAttempts?: Array<{
    at: string;
    result: 'accept' | 'reject' | 'unknown';
    reason?: string;
    nasIpAddress?: string;
  }>;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Usage
 * ------------------------------------------------------------------ */

export interface UsageReport {
  zenReference: string;
  period: 'day' | 'month' | 'current_month';
  from?: string;
  to?: string;
  bytesIn?: number;
  bytesOut?: number;
  totalBytes?: number;
  /** Cap where the product has one, so an overage is visible. */
  capBytes?: number;
  buckets?: Array<{ date: string; bytesIn: number; bytesOut: number }>;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Number porting
 * ------------------------------------------------------------------ */

export interface NumberPortCheck {
  /** Provider reference, needed to poll and then to place the order. */
  reference?: string;
  phoneNumber: string;
  canBePorted?: boolean;
  /** True while the provider is still checking. */
  pending: boolean;
  /** Losing communications provider, where identified. */
  currentProvider?: string;
  exchangePrefix?: string;
  /** Communications provider identity code. */
  cupid?: string;
  messages: string[];
  checkedAt: string;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Ethernet / leased line quotes
 * ------------------------------------------------------------------ */

export interface EthernetQuote {
  id: string;
  productName: string;
  /** Bearer and committed rates, e.g. 1000/200. */
  bearerMbps?: number;
  committedMbps?: number;
  technology: AccessTechnology;
  /** Monthly recurring charge, pounds. */
  monthlyCharge?: number;
  installCharge?: number;
  /** Excess construction charge where a survey flags one. */
  excessConstruction?: number;
  termMonths?: number;
  leadTimeDays?: number;
  /** Presented as indicative unless the provider confirms it is firm. */
  indicative: boolean;
  notes: string[];
  source: string;
}

export interface EthernetQuoteSet {
  address: AddressRecord;
  quotes: EthernetQuote[];
  checkedAt: string;
  sources: string[];
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

export type OrderState =
  | 'draft'
  | 'submitted'
  | 'accepted'
  | 'in_progress'
  | 'delayed'
  | 'awaiting_appointment'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'unknown';

export interface OrderRecord {
  zenReference: string;
  customerReference?: string;
  orderReference?: string;
  type: 'provide' | 'modify' | 'cease' | 'unknown';
  state: OrderState;
  stateReason?: string;
  productName?: string;
  productCode?: string;
  cli?: string;
  serviceId?: string;
  accessLineId?: string;
  address?: AddressRecord;
  placedAt?: string;
  committedDate?: string;
  promisedDate?: string;
  completedAt?: string;
  preferredActivationDate?: string;
  appointment?: { reference?: string; date?: string; slot?: string; type?: string; status?: string };
  delayReason?: string;
  /** Openreach / BTW / CityFibre. */
  supplier?: string;
  requiresEngineer?: boolean;
  workingLineTakeover?: boolean;
  contactName?: string;
  contactEmail?: string;
  provider: string;
  source: string;
}

/** An appointment slot offered for a provide. */
export interface AppointmentSlot {
  date: string;
  /** Provider slot enum, rendered as a label. */
  slot: string;
  appointmentType?: string;
  /** Opaque value to send back when ordering. */
  token?: string;
}

/** Line-item pricing that will apply to an order. */
export interface PriceLine {
  name: string;
  amount: number;
  recurring: boolean;
  frequency?: string;
  category?: string;
}

export interface OrderQuote {
  productCode: string;
  productName?: string;
  lines: PriceLine[];
  monthlyTotal: number;
  oneOffTotal: number;
  currency: 'GBP';
  source: string;
}

/**
 * A request to place a real order.
 *
 * Everything here comes from an availability check the operator has already
 * run — the reference, the product code and the Gold Address Key are not
 * things a person can type. That is deliberate: an order can only be built
 * from a checked premises, never from free text.
 */
export interface PlaceOrderRequest {
  availabilityReference: string;
  productCode: string;
  productName?: string;
  /** Gold Address Key (Openreach `addressReferenceNumber`). */
  goldAddressKey: string;
  districtCode: string;
  uprn?: string;
  /** Single-line address, echoed back for the type-to-confirm guard. */
  addressLine: string;
  postcode: string;
  /** Existing line to take over or migrate, where there is one. */
  phoneNumber?: string;
  accessLineId?: string;
  ontSerialNumber?: string;
  workingLineTakeover?: boolean;
  /** Opaque appointment token from `AppointmentSlot.token`. */
  appointmentToken?: string;
  contractTermMonths?: number;
  preferredActivationDate?: string;
  customerReference?: string;
  contactName?: string;
  contactNumber?: string;
  contactEmail?: string;
  notes?: string;
}

/** What came back from the provider after an order was submitted. */
export interface PlaceOrderResult {
  accepted: boolean;
  zenReference?: string;
  orderReference?: string;
  state?: OrderState;
  message?: string;
  /** Provider validation messages, verbatim. */
  messages?: string[];
  committedDate?: string;
  source: string;
}

/**
 * Why ordering is or is not available right now.
 *
 * Both locks are reported separately so the reason a button is disabled is
 * never a mystery: one is an environment variable only a deploy can change,
 * the other is an admin switch.
 */
export interface OrderingGate {
  /** True when both locks are open and the user has budget left. */
  allowed: boolean;
  /** `ZEN_ALLOW_ORDERING` — needs a deploy to change. */
  environmentAllows: boolean;
  /** The admin portal switch. */
  adminAllows: boolean;
  /** Whether provider ordering credentials are actually present. */
  credentialsPresent: boolean;
  /**
   * True when the flow will run end to end but nothing can reach the
   * provider — no credentials, or the integration is switched off.
   *
   * This is a rehearsal, not a refusal. The two locks exist to stop real
   * spend; without credentials there is no spend to stop, and being able to
   * walk the flow is how someone learns it before the keys arrive. The
   * outcome screen says plainly that nothing was sent.
   */
  demo: boolean;
  /** Orders this user has placed today, and the ceiling. */
  usedToday: number;
  dailyCap: number;
  /** Present when `allowed` is false: the first blocker, in plain English. */
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * Address references and Openreach registration
 * ------------------------------------------------------------------ */

/**
 * The two wholesale references for one premises.
 *
 * Openreach and BT Wholesale each keep their own address database, and they
 * disagree more often than you would hope — usually over flats and
 * subdivided buildings. When an order is rejected for an address mismatch,
 * this is the screen that shows which of the two is the odd one out.
 */
export interface AddressMatch {
  /** What was searched for, echoed back. */
  query: { postcode: string; postTown?: string; premiseName?: string; thoroughfareNumber?: string };
  /** Openreach's reference (the NAD / Gold Address Key). */
  btoAddressReference?: string;
  /** BT Wholesale's reference. */
  btwAddressReference?: string;
  districtCode?: string;
  uprn?: string;
  /** The address as the provider holds it, which may differ from the search. */
  address?: AddressRecord;
  /** True when both databases answered and the references correspond. */
  agrees: boolean;
  messages: string[];
  source: string;
}

/**
 * The result of registering a premises with Openreach.
 *
 * This is the fix for "the address is not in Openreach's list", which
 * otherwise dead-ends a provide with nothing the operator can do.
 */
export interface AddressRegistration {
  created: boolean;
  /** The new Gold Address Key, when one was issued. */
  addressReference?: string;
  districtCode?: string;
  /** Technologies Openreach will not sell at this premises, and why. */
  technologyRestrictions: Array<{ technology: string; reason?: string }>;
  messages: string[];
  source: string;
}

/* ------------------------------------------------------------------ *
 * Service history and notifications
 * ------------------------------------------------------------------ */

/** One recorded change to a service. */
export interface ServiceHistoryEvent {
  at: string;
  /** Provide, modify, cease, regrade, care level change, and so on. */
  type: string;
  description?: string;
  /** Before and after, where the provider reports both. */
  from?: string;
  to?: string;
  reference?: string;
  actor?: string;
}

export interface ServiceHistory {
  zenReference: string;
  events: ServiceHistoryEvent[];
  source: string;
}

/**
 * A provider notification — price changes, product withdrawals, planned
 * migrations, stop-sell announcements.
 *
 * Worth having because these arrive by email to one mailbox and are read by
 * whoever happens to open it.
 */
export interface ProviderNotification {
  id: string;
  publishedAt: string;
  category?: string;
  severity: 'info' | 'warn' | 'critical' | 'unknown';
  title: string;
  detail?: string;
  /** Services this notification names, where it names any. */
  affectedReferences?: string[];
  actionRequiredBy?: string;
  read?: boolean;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Network management
 * ------------------------------------------------------------------ */

/**
 * The realms and IP configuration available when ordering, and in use on an
 * existing service. This is what decides what a router has to be configured
 * with, so it is the answer to "why will this line not authenticate".
 */
export interface NetworkOption {
  name: string;
  description?: string;
  /** RADIUS realm, e.g. `@zen`. */
  realm?: string;
  ipVersion?: 'ipv4' | 'ipv6' | 'dual';
  /** Static block size where the option carries one, e.g. `/29`. */
  staticBlock?: string;
  default?: boolean;
}

export interface NetworkConfiguration {
  zenReference?: string;
  serviceSelectionNames: NetworkOption[];
  /** IP allocations and routing detail for an existing service. */
  details: Array<{ label: string; value: string }>;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Estate-wide usage
 * ------------------------------------------------------------------ */

/** One service's month, in the estate-wide report. */
export interface EstateUsageRow {
  zenReference: string;
  serviceId?: string;
  cli?: string;
  address?: string;
  downloadBytes?: number;
  uploadBytes?: number;
  totalBytes?: number;
  /** True where the provider flags the service as over its allowance. */
  overAllowance?: boolean;
}

export interface EstateUsageReport {
  period: string;
  rows: EstateUsageRow[];
  totalBytes: number;
  /** Reports the provider has available, for the period picker. */
  availablePeriods: string[];
  source: string;
}

/* ------------------------------------------------------------------ *
 * Company context
 * ------------------------------------------------------------------ */

/**
 * A registered company at, or matching, a premises.
 *
 * Worth having on a support tool: when a business line goes into dispute,
 * knowing the company is in liquidation, dissolved, or trading under a name
 * nobody on the account recognises changes what you do next. It also catches
 * the case where the "customer" is a company that no longer exists.
 */
export interface CompanyRecord {
  companyNumber: string;
  name: string;
  /** Companies House status, e.g. `active`, `liquidation`, `dissolved`. */
  status: string;
  /**
   * The qualifier under the status, e.g. `active-proposal-to-strike-off`.
   *
   * This is where a Gazette strike-off notice shows up: the status stays
   * `active` and only this field says the company is on its way out.
   */
  statusDetail?: string;
  /** True for statuses that mean "do not take an order from this company". */
  concerning: boolean;
  /**
   * True when the company has ceased to exist — dissolved, removed, closed.
   *
   * Separate from `concerning` because the two need opposite treatment: a
   * company in liquidation is the most important row on the panel, and one
   * dissolved in 2019 is clutter. Only this kind is hidden by default.
   */
  closed?: boolean;
  type?: string;
  incorporatedOn?: string;
  dissolvedOn?: string;
  registeredOffice?: string;
  /**
   * The registered office broken into the parts a premises match needs.
   *
   * Kept because comparing the joined one-line office against an AddressBase
   * record never works: Companies House put "Flat 3" in one field, "45" in
   * another and sometimes both in the first. These are what
   * `samePremises` actually reads.
   */
  office?: {
    buildingNumber?: string;
    buildingName?: string;
    subBuilding?: string;
    thoroughfare?: string;
    postTown?: string;
    postcode?: string;
  };
  /**
   * True when the registered office is the premises being looked at — the
   * actual premises, matched building and sub-building, not merely the same
   * postcode.
   */
  registeredHere?: boolean;
  sicCodes?: string[];
  /** Set when Companies House flags overdue accounts or a confirmation statement. */
  overdue?: string[];
  /* ---- Risk, from the company profile ------------------------------ *
   * Present only on companies enriched with a profile fetch, which is the
   * ones at the premises being looked at. Undefined means "not checked",
   * never "fine".
   */
  accountsOverdue?: boolean;
  accountsNextDue?: string;
  confirmationStatementOverdue?: boolean;
  confirmationStatementNextDue?: string;
  insolvencyHistory?: boolean;
  registeredOfficeInDispute?: boolean;
  /** Set from a `GAZ1` filing when the status alone does not say it. */
  strikeOffProposed?: boolean;
  /** True once the risk fields above have actually been looked up. */
  riskChecked?: boolean;
  url?: string;
  source: string;
}

export interface CompanyContext {
  postcode: string;
  companies: CompanyRecord[];
  /**
   * How many of `companies` are registered at the selected premises rather
   * than merely in the postcode. The panel leads with those.
   */
  atPremises?: number;
  /** The premises the match was made against, for the panel to name. */
  premises?: string;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Call records
 * ------------------------------------------------------------------ */

export interface CallRecord {
  id: string;
  startedAt: string;
  sourceNumber?: string;
  presentationNumber?: string;
  destinationNumber?: string;
  durationSeconds?: number;
  classification?: string;
  destinationDescription?: string;
  dialCode?: string;
  costPounds?: number;
  source: string;
}

/* ------------------------------------------------------------------ *
 * SIMs / mobile estate
 * ------------------------------------------------------------------ */

export type SimState = 'active' | 'suspended' | 'ceased' | 'pending' | 'test' | 'unknown';

export interface SimRecord {
  iccid: string;
  /** Zen service reference where the SIM is sold through Zen. */
  zenReference?: string;
  msisdn?: string;
  imsi?: string;
  state: SimState;
  /** Network the SIM rides. */
  network?: string;
  postcode?: string;
  /** Data allowance and use, bytes. */
  allowanceBytes?: number;
  boltOnBytes?: number;
  usedBytes?: number;
  /**
   * Voice and SMS use for the current period.
   *
   * Only a per-SIM usage call carries these -- an estate listing gives data
   * alone -- so they are present on a single SIM that has been looked up and
   * absent on the rows of an estate view.
   */
  usedVoiceMinutes?: number;
  usedSms?: number;
  /** The period the usage figures cover, where the provider states it. */
  usagePeriodStart?: string;
  usagePeriodEnd?: string;
  /** Bars applied, e.g. data, voice, roaming. */
  bars?: string[];
  /** Current attach state, where the provider reports it. */
  attached?: boolean;
  lastSeenAt?: string;
  apn?: string;
  ipAddress?: string;
  provider: string;
  source: string;
}

export interface SimPool {
  name?: string;
  sizeBytes?: number;
  usedBytes?: number;
  simCount?: number;
  overageBytes?: number;
}

export interface SimEstate {
  sims: SimRecord[];
  pool?: SimPool;
  checkedAt: string;
  sources: string[];
}

/* ------------------------------------------------------------------ *
 * Mobile device and identity checks (BT)
 * ------------------------------------------------------------------ */

/** "Is this phone actually on the network right now?" */
export interface NetworkConnectivityCheck {
  msisdn: string;
  /** Whether the number is currently attached to the network. */
  connected?: boolean;
  network?: string;
  /** Roaming state, where reported. */
  roaming?: boolean;
  country?: string;
  lastSeenAt?: string;
  /** Whether the number is reachable for calls and texts. */
  reachable?: boolean;
  messages: string[];
  checkedAt: string;
  provider: string;
  source: string;
}

export interface ImeiLookup {
  msisdn?: string;
  imei?: string;
  /** Type Allocation Code — the first 8 digits, identifying the model. */
  tac?: string;
  manufacturer?: string;
  model?: string;
  /** Whether the handset supports VoLTE / Wi-Fi calling, where known. */
  capabilities?: string[];
  /** Blacklist status, where the provider exposes it. */
  blacklisted?: boolean;
  messages: string[];
  checkedAt: string;
  provider: string;
  source: string;
}

/** Footfall / catchment insight for a location. */
export interface FootfallInsight {
  areaName: string;
  /** The geography the figures cover. */
  granularity?: string;
  from?: string;
  to?: string;
  /** Visitor counts by day, for a chart. */
  series: Array<{ date: string; visitors: number }>;
  /** Where visitors travelled from, most common first. */
  catchment?: Array<{ area: string; share: number }>;
  /** Split by hour of day, 0-23. */
  hourly?: Array<{ hour: number; visitors: number }>;
  coverageNote?: string;
  provider: string;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Reverse DNS
 * ------------------------------------------------------------------ */

export interface RdnsRecord {
  ipAddress: string;
  hostname?: string;
  zenReference?: string;
  editable: boolean;
  source: string;
}

/* ------------------------------------------------------------------ *
 * Tool results, for the generic tool runner
 * ------------------------------------------------------------------ */

export interface ToolMeta {
  id: string;
  name: string;
  /** One line, shown under the tool name. */
  description: string;
  /** Which provider serves it, for the "awaiting credentials" state. */
  providerKey: string;
  /** What the operator types in. */
  input: {
    label: string;
    placeholder: string;
    kind: 'msisdn' | 'cli' | 'postcode' | 'uprn' | 'ip' | 'text' | 'zenReference';
    hint?: string;
  };
  /** True when the tool changes something rather than just reading. */
  mutating?: boolean;
  available: boolean;
  unavailableReason?: string;
}
