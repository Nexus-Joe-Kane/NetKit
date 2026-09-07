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
