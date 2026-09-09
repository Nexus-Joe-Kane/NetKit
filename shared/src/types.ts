import type { MatchConfidence } from './siteMatch';
import type { UnitQuestion } from './unitChoice';
import type { AreaCoverage } from './areaCoverage';
/**
 * SupportWizard NetKit — shared domain model.
 *
 * Every provider adapter normalises into these shapes, so the UI never has to
 * know whether a fact came from Zen, Openreach, Ofcom or OS Places.
 */

/* ------------------------------------------------------------------ *
 * Identifiers
 * ------------------------------------------------------------------ */

/** The things a user is allowed to type into the one search box. */
export type IdentifierKind =
  | 'postcode'
  | 'uprn'
  | 'address'
  | 'cli'
  | 'lineAccessId'
  | 'serviceId'
  | 'ontSerial'
  | 'unknown';

export interface ResolvedIdentifier {
  /** Exactly what the user typed. */
  raw: string;
  /** Canonical form: `SW1A 1AA`, `01617501234`, `100023336956`. */
  normalised: string;
  kind: IdentifierKind;
  /** 0..1 — how sure the classifier is. */
  confidence: number;
  /** Other readings of the same string, best first. */
  alternatives: Array<{ kind: IdentifierKind; normalised: string; confidence: number }>;
  /** Human explanation, shown in the UI as a chip tooltip. */
  reason: string;
}

/* ------------------------------------------------------------------ *
 * Address / UPRN
 * ------------------------------------------------------------------ */

export type AddressSource = 'os-places' | 'zen' | 'openreach' | 'postcodes.io' | 'mock' | 'cache';

/**
 * A single addressable premises. `uprn` is the Unique Property Reference
 * Number — the join key for the whole portal.
 */
export interface AddressRecord {
  uprn?: string;
  /** Royal Mail Unique Delivery Point Reference Number. */
  udprn?: string;
  /** Openreach/PAF address key, where a provider gives us one. */
  addressKey?: string;

  /** Fully formatted single-line address, always populated. */
  singleLine: string;
  /** Formatted address split into display lines (no postcode line). */
  lines: string[];

  organisation?: string;
  subBuilding?: string;
  buildingName?: string;
  buildingNumber?: string;
  dependentThoroughfare?: string;
  thoroughfare?: string;
  doubleDependentLocality?: string;
  dependentLocality?: string;
  postTown: string;
  postcode: string;
  county?: string;
  country?: string;

  latitude?: number;
  longitude?: number;
  easting?: number;
  northing?: number;

  /** OS AddressBase classification, e.g. `RD04` (terraced) / `CO01` (retail). */
  classificationCode?: string;
  classificationLabel?: string;
  /** Residential vs business drives which products are quotable. */
  premisesType?: 'residential' | 'business' | 'mixed' | 'other' | 'unknown';

  localAuthority?: string;
  ward?: string;
  constituency?: string;

  source: AddressSource;
  /** True when the record came from a postcode search and may need refining. */
  approximate?: boolean;
}

/** One row in the "pick the exact address" dropdown. */
export interface AddressSuggestion {
  id: string;
  uprn?: string;
  label: string;
  /** Bolded prefix + rest, for typeahead rendering. */
  matched?: string;
  postcode: string;
  postTown: string;
  source: AddressSource;
}

/* ------------------------------------------------------------------ *
 * Broadband availability
 * ------------------------------------------------------------------ */

export type AccessTechnology =
  | 'FTTP'
  | 'FTTC'
  | 'SOGEA'
  | 'SOGFAST'
  | 'GFAST'
  | 'ADSL2+'
  | 'ADSL'
  | 'WLR+ADSL'
  | 'DOCSIS3.1'
  | 'XGS-PON'
  | 'EoFTTC'
  | 'EAD'
  | 'Leased Line'
  | 'FWA'
  | '4G/5G Fixed Wireless'
  | 'Satellite'
  | 'Unknown';

export type AvailabilityStatus =
  | 'available'
  | 'available_soon'
  | 'waiting_list'
  | 'build_planned'
  | 'on_demand'
  | 'not_available'
  | 'unknown';

export type NetworkOperator =
  | 'openreach'
  | 'virgin-media'
  | 'cityfibre'
  | 'netomnia'
  | 'hyperoptic'
  | 'community-fibre'
  | 'gigaclear'
  | 'trooli'
  | 'zzoomm'
  | 'lit-fibre'
  | 'grain'
  | 'other';

export interface SpeedEstimate {
  downMbpsLow?: number;
  downMbpsHigh?: number;
  upMbpsLow?: number;
  upMbpsHigh?: number;
  /** Ofcom-style "average peak-time" figure where a provider supplies one. */
  downMbpsAvgPeak?: number;
  /** Confidence the provider attaches to the estimate. */
  basis?: 'measured' | 'modelled' | 'headline' | 'unknown';
}

/**
 * One purchasable/renderable outcome at a premises: an operator + technology
 * combination, its status and its speeds.
 */
export interface BroadbandOffer {
  id: string;
  operator: NetworkOperator;
  operatorLabel: string;
  /** The retail ISP this was quoted through, when relevant (e.g. `zen`). */
  retailer?: string;
  technology: AccessTechnology;
  status: AvailabilityStatus;
  speeds: SpeedEstimate;

  productCode?: string;
  productName?: string;
  /** Ready-for-service date for planned/soon builds. */
  rfsDate?: string;
  /** Openreach install category: `Category A` / `B` / `C`. */
  installCategory?: string;
  appointmentRequired?: boolean;
  /**
   * How sure we are the premises can actually be served.
   *
   * - `confirmed` — a provider API answered for *this address*.
   * - `footprint` — the network builds in this area, but this address has
   *   not been checked. Useful to know, dangerous to quote.
   * - `unknown`   — no serviceability signal at all.
   *
   * The distinction earns its place because alt-net footprint data and
   * alt-net serviceability are different facts, and only one of them is safe
   * to read out to a customer.
   */
  serviceability?: 'confirmed' | 'footprint' | 'unknown';
  /** False when the provider says this product cannot be ordered today. */
  orderable?: boolean;
  /** The provider's own words for why not. */
  orderableReason?: string;
  /** FTTP-on-Demand style excess construction charge, in pounds. */
  excessConstructionCharge?: number;
  contentionRatio?: string;
  notes: string[];
  source: string;
}

/**
 * Openreach-specific engineering detail. This is the section that gets the
 * most screen real estate — it is what support actually needs.
 */
export interface OpenreachDetail {
  addressKey?: string;
  districtCode?: string;
  cssDistrictCode?: string;
  /** ALK / Openreach premises identifier. */
  alk?: string;

  exchange?: {
    name: string;
    /** Three letter code, e.g. `MRDG`. */
    code?: string;
    tlc?: string;
    mdfSiteId?: string;
    /** Exchange-level programme state. */
    status?: 'standard' | 'fibre-enabled' | 'exchange-only' | 'stop-sell' | 'ceased' | 'unknown';
    /** All-IP / WLR withdrawal milestones. */
    wlrWithdrawalDate?: string;
    stopSellDate?: string;
    /** Distance from premises to exchange, straight-line metres. */
    distanceMetres?: number;
  };

  cabinet?: {
    /** PCP number. */
    id?: string;
    fibreCabinetId?: string;
    technology?: 'FTTC' | 'G.fast' | 'none';
    /** Cabinet build/availability state. */
    status?: string;
    fttcAvailable?: boolean;
    gfastAvailable?: boolean;
    /** Cabinet congestion — Openreach reports this as a flag. */
    congested?: boolean;
    distanceMetres?: number;
  };

  fttp?: {
    available: boolean;
    /** Openreach FTTP build state, e.g. `RFS`, `In Build`, `Planned`. */
    buildStatus?: string;
    rfsDate?: string;
    /** Connectorised Block Terminal serving the premises. */
    cbtId?: string;
    cbtSpareCapacity?: number;
    sn1?: string;
    spineId?: string;
    /** ONT already fitted at the premises? */
    ontPresent?: boolean;
    ontType?: string;
    ontSerial?: string;
    ontPortsUsed?: number;
    ontPortsTotal?: number;
    /** FTTP-on-Demand fallback when standard FTTP is absent. */
    fodAvailable?: boolean;
    fodExcessConstruction?: number;
  };

  copper?: {
    wlrAvailable?: boolean;
    sogeaAvailable?: boolean;
    mpfAvailable?: boolean;
    /** Spare copper pairs at the DP. */
    sparePairs?: number;
    /** Estimated copper line length, metres. */
    lineLengthMetres?: number;
    /** Estimated loop attenuation, dB. */
    attenuationDb?: number;
    /** Distribution point identifier. */
    dpId?: string;
  };

  /** All-IP stop-sell posture at this address. */
  stopSell?: {
    wlr?: boolean;
    mpf?: boolean;
    sogea?: boolean;
    fttc?: boolean;
    effectiveDate?: string;
    reason?: string;
  };

  /** Free-form provider warnings worth surfacing loudly. */
  flags: Array<{ level: 'info' | 'warn' | 'critical'; label: string; detail?: string }>;
}

/**
 * Ofcom's predicted speeds for one premises.
 *
 * An independent regulator figure, deliberately kept apart from the offers
 * table for two reasons. It names **no operator** — Ofcom withhold the
 * per-provider split as commercially confidential — so it can never be a
 * row you might order. And it is a *prediction* from their model, not a
 * provider's quote, so it is most useful as a sanity check: when the
 * wholesale estimate and the regulator disagree sharply, that is worth
 * knowing before promising anything.
 */
export interface PredictedSpeeds {
  /** Best predicted speeds from any technology at the premises. */
  maxDownMbps?: number;
  maxUpMbps?: number;
  /** Superfast (30 Mb+) and ultrafast (300 Mb+) tiers, where predicted. */
  superfastDownMbps?: number;
  ultrafastDownMbps?: number;
  /** True when the figures are for this exact UPRN, not a postcode average. */
  premisesMatched: boolean;
  /** How many premises the postcode returned, for context on an average. */
  premisesInPostcode?: number;
  /** Share of premises in the postcode that can get gigabit, where published. */
  gigabitPercent?: number;
  superfastPercent?: number;
  ultrafastPercent?: number;
  fttpPercent?: number;
  /** Share that cannot reach the 10 Mb universal service obligation. */
  belowUsoPercent?: number;
  /**
   * Where this came from and how fresh it is.
   *
   * `api` is Ofcom's live coverage endpoint. `dataset` is a Connected Nations
   * CSV on disk, which is a snapshot months old — the UI is required to say
   * so rather than presenting a dated file as a current prediction.
   */
  basis?: 'api' | 'dataset';
  /** The Ofcom release the dataset figures came from, e.g. `2025-07`. */
  release?: string;
  source: string;
}

export interface BroadbandAvailability {
  uprn?: string;
  address: AddressRecord;
  offers: BroadbandOffer[];
  openreach?: OpenreachDetail;
  /**
   * The provider's handle on this check. Required to book an appointment or
   * place an order — an order cannot be built without one, which is why
   * ordering always starts from a check rather than from typed detail.
   */
  availabilityReference?: string;
  /** Fair-use checks left on the account, where the provider reports it. */
  remainingChecks?: number;
  /** The regulator's own prediction for this premises, where available. */
  predicted?: PredictedSpeeds;
  /** Best available technology, precomputed for the summary strip. */
  headline?: {
    technology: AccessTechnology;
    downMbps?: number;
    upMbps?: number;
    operatorLabel: string;
  };
  checkedAt: string;
  sources: string[];
}

/* ------------------------------------------------------------------ *
 * Mobile signal
 * ------------------------------------------------------------------ */

export type MobileOperator = 'EE' | 'Vodafone' | 'O2' | 'Three';

/** Ofcom-style four-point coverage grade. */
export type SignalGrade = 'none' | 'poor' | 'variable' | 'good' | 'excellent' | 'unknown';

export interface SignalBand {
  indoor: SignalGrade;
  outdoor: SignalGrade;
  /** Outdoor grade when in a vehicle, where the source distinguishes it. */
  inVehicle?: SignalGrade;
}

export interface MobileCoverage {
  operator: MobileOperator;
  /** Retail brands riding this network, e.g. Vodafone → VOXI, Lebara. */
  mvnos?: string[];
  voice: SignalBand;
  data4g: SignalBand;
  data5g?: SignalBand;
  data3g?: SignalBand;
  volte?: boolean;
  wifiCalling?: boolean;
  /** Frequency bands reported as present, e.g. `B20`, `n78`. */
  bands?: string[];
  nearestSite?: {
    distanceMetres?: number;
    bearingDegrees?: number;
    technologies?: string[];
  };
  /** Planned upgrade the operator has published for this area. */
  plannedUpgrade?: { technology: string; date?: string };
  source: 'ofcom' | 'operator' | 'modelled' | 'mock';
  notes: string[];
}

/**
 * A cell site near the premises.
 *
 * Crowdsourced from OpenCelliD, and that provenance matters: these are
 * positions inferred from handset reports rather than an operator's own
 * asset register, so a site is roughly where this says and occasionally is
 * not there at all. Useful for the question a coverage percentage cannot
 * answer -- why does this customer have no signal when the area is fine --
 * and not something to quote as fact.
 */
export interface MastSite {
  /** The network, where the MCC/MNC pair is one we recognise. */
  operator?: MobileOperator;
  /** Raw mobile network code, kept so an unmapped operator is still visible. */
  networkCode?: string;
  /** `GSM`, `UMTS`, `LTE`, `NR`, as OpenCelliD label them. */
  radio?: string;
  latitude: number;
  longitude: number;
  distanceMetres: number;
  /** How many handset reports position this site. Low counts are shakier. */
  samples?: number;
  /** OpenCelliD's own estimate of positional error, metres. */
  rangeMetres?: number;
  /** Cell identifiers, for anyone cross-checking with an operator. */
  cellId?: string;
  areaCode?: string;
}

export interface SignalReport {
  uprn?: string;
  address: AddressRecord;
  operators: MobileCoverage[];
  /**
   * Nearest cell sites, closest first. Absent when no coordinates were
   * available for the premises or the provider is not configured.
   */
  masts?: MastSite[];
  /** Best indoor voice + data across all four networks, for the summary. */
  headline?: { bestIndoorVoice?: MobileOperator; bestIndoorData?: MobileOperator };
  /**
   * Area-level coverage, when that is all there is.
   *
   * Present only when no per-address or per-operator source answered and the
   * Ofcom Connected Nations file was used instead. It is a weaker answer --
   * an area of tens of thousands of premises, counting networks rather than
   * naming them -- so it never merges into `operators` and the UI is
   * required to say what it is.
   */
  areaCoverage?: AreaCoverage;
  checkedAt: string;
  sources: string[];
}

/* ------------------------------------------------------------------ *
 * Lines / services
 * ------------------------------------------------------------------ */

export type LineStatus =
  | 'active'
  | 'ceased'
  | 'pending_provide'
  | 'pending_cease'
  | 'pending_modify'
  | 'suspended'
  | 'unknown';

export interface LineSyncStats {
  downstreamSyncKbps?: number;
  upstreamSyncKbps?: number;
  maxStableDownKbps?: number;
  maxStableUpKbps?: number;
  snrMarginDb?: number;
  attenuationDb?: number;
  /** DLM profile, e.g. `Fastpath`, `Interleaved`. */
  profileName?: string;
  interleaving?: string;
  /** Errored seconds / retrains in the last 24h, where reported. */
  retrains24h?: number;
  /** When the line last resynced. */
  lastResync?: string;
  uptimeSeconds?: number;
}

export interface LineRecord {
  /** Internal id for links. */
  id: string;
  /** Calling Line Identity — the phone number on the line. */
  cli?: string;
  /** Openreach Line/Access ID (a.k.a. Access Line ID). */
  lineAccessId?: string;
  /** Provider service reference, e.g. Zen service id. */
  serviceId?: string;
  orderRef?: string;

  status: LineStatus;
  technology: AccessTechnology;
  provider: string;
  productName?: string;
  bearerSpeed?: string;

  /**
   * The provider's own reference for the customer.
   *
   * Zen key their portal on a customer reference and Giacom on an account
   * name; either is what a supplier asks for on the phone, so whichever the
   * source gives is carried through.
   */
  customerReference?: string;
  customerName?: string;

  /**
   * When the line went down, where the provider states it outright.
   *
   * Distinct from the RADIUS session fields on purpose. "The last session
   * ended at" and "the line went down at" are usually the same moment and
   * occasionally are not — a re-auth loop ends sessions without the line ever
   * going down — so a provider's own answer is kept separate from ours.
   */
  downSince?: string;

  address: AddressRecord;

  contract?: {
    startDate?: string;
    endDate?: string;
    minimumTermMonths?: number;
    inContract?: boolean;
    earlyTerminationCharge?: number;
  };

  cpe?: { vendor?: string; model?: string; serial?: string; macAddress?: string; firmware?: string };
  ont?: { serial?: string; model?: string; portsUsed?: number; portsTotal?: number };

  ipAddresses?: Array<{
    family: 'IPv4' | 'IPv6';
    value: string;
    prefixLength?: number;
    assignment: 'static' | 'dynamic';
    routed?: boolean;
  }>;

  radius?: {
    username?: string;
    realm?: string;
    lastAuthAt?: string;
    sessionId?: string;
    nasIpAddress?: string;
    onlineSince?: string;
    /** Bytes this session. */
    bytesIn?: number;
    bytesOut?: number;
    online?: boolean;
  };

  sync?: LineSyncStats;

  faults?: Array<{
    reference: string;
    raisedAt: string;
    status: string;
    summary: string;
    slaTarget?: string;
    lastUpdate?: string;
  }>;

  appointments?: Array<{
    reference: string;
    date: string;
    slot?: string;
    type: string;
    status: string;
  }>;

  /**
   * Where we found this line — matters when Zen doesn't own it.
   *
   * `giacom` is named rather than folded into `cross-provider` because it is
   * the second wholesale account: knowing which supplier a line sits on is
   * knowing who to ring about it.
   */
  discoveredVia: 'zen' | 'giacom' | 'openreach' | 'cross-provider';
  notes: string[];
}

export interface LineLookupResult {
  query: ResolvedIdentifier;
  lines: LineRecord[];
  /** Set when the identifier resolved to a premises but no line was found. */
  addressOnly?: AddressRecord;
  checkedAt: string;
  sources: string[];
}

/* ------------------------------------------------------------------ *
 * The composite site report — what the portal actually renders
 * ------------------------------------------------------------------ */

/** Per-section fetch outcome, so one failing provider never blanks the page. */
export interface SectionStatus {
  ok: boolean;
  /** `live` = a provider answered, `skipped` = none could be asked. */
  mode: 'live' | 'skipped';
  error?: string;
  durationMs?: number;
}

/**
 * What was actually asked, per provider, when looking for lines at a premises.
 *
 * "No lines found" is a claim about the world, and it was being made without
 * showing any working. This is the working: which provider was asked, how it
 * was asked, how many circuits came back and how many of those could be tied
 * to this doorstep. An engineer who knows we supply the site can then see
 * whether the supplier returned nothing at all or returned something we
 * excluded, which are entirely different problems.
 */
export interface LineSearchDiagnostic {
  provider: string;
  /** How the provider was asked, in the order it was tried. */
  tried: string[];
  /** Circuits the provider returned across all those attempts. */
  candidates: number;
  /** Of those, how many are at this premises. */
  matched: number;
  /** Of those, how many were at the postcode but not this premises. */
  excluded: number;
  error?: string;
}

export interface SiteReport {
  query: ResolvedIdentifier;
  /** The identity box: always the full address + UPRN. */
  address: AddressRecord;
  uprn?: string;
  broadband?: BroadbandAvailability;
  signal?: SignalReport;
  lines: LineRecord[];
  /**
   * Lines found at this postcode that could not be tied to this premises.
   *
   * Usually a neighbour, occasionally this customer under an address the
   * supplier records differently. Kept separate from `lines` so it is never
   * read as a line at this address, and kept at all because discarding them
   * silently is what made a real Openreach circuit look like none.
   */
  nearbyLines?: LineRecord[];
  /** Other addresses at the same postcode, for quick hopping. */
  siblings?: AddressSuggestion[];
  status: {
    address: SectionStatus;
    broadband: SectionStatus;
    signal: SectionStatus;
    lines: SectionStatus;
  };
  /** Per-provider working for the line search. Present even when it found nothing. */
  lineSearch?: LineSearchDiagnostic[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * API envelopes
 * ------------------------------------------------------------------ */

export interface ApiError {
  code:
    | 'bad_request'
    | 'not_found'
    | 'ambiguous'
    | 'upstream_error'
    | 'not_configured'
    | 'rate_limited'
    | 'internal';
  message: string;
  /** Present for `ambiguous`: the user must pick an address. */
  suggestions?: AddressSuggestion[];
  detail?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface SearchResponse {
  query: ResolvedIdentifier;
  /** Populated when the query narrows to many premises (postcode search). */
  suggestions: AddressSuggestion[];
  /**
   * Which unit, where the candidates differ by nothing else.
   *
   * Decided on the server because it needs the sub-building and the
   * organisation, and a suggestion carries neither — only a label. Present
   * only when there is genuinely a question to ask.
   */
  unitChoice?: UnitQuestion;
  /** Populated when the query resolves to exactly one thing. */
  report?: SiteReport;
  /** Populated when the query was a CLI / line id. */
  lines?: LineRecord[];
  /**
   * Words in a free-text search that nothing returned accounts for.
   *
   * Present so the list can say what it is. `megans richmond` came back with
   * nine Megan's in nine other towns under the heading "12 premises -- pick
   * the exact address", which is the search claiming to have answered a
   * question it did not. Naming the word that came back empty turns a wrong
   * answer into a useful one.
   */
  unmatched?: string[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  providers: Record<string, { configured: boolean; mode: 'live' | 'mock'; label: string }>;
  uptimeSeconds: number;
}

/* ------------------------------------------------------------------ *
 * What the documentation says is at a site
 * ------------------------------------------------------------------ */

/**
 * A documented piece of equipment at a site.
 *
 * Deliberately thin. This is what somebody wrote down, not what is on the
 * network — the two disagree often enough that conflating them would be
 * worse than showing neither. Live state comes from the controller and is
 * shown alongside, labelled as live.
 */
export interface DocumentedConfiguration {
  id: string;
  name: string;
  /** What kind of thing it is, as the documentation classifies it. */
  kind?: string;
  hostname?: string;
  primaryIp?: string;
  macAddress?: string;
  serialNumber?: string;
  assetTag?: string;
  manufacturer?: string;
  model?: string;
  operatingSystem?: string;
  /** Which of the company's sites it is recorded at. */
  locationId?: string;
  locationName?: string;
  notes?: string;
  warrantyExpires?: string;
  /** Straight into the documentation, so nobody re-derives what is written. */
  url?: string;
  updatedAt?: string;
  archived?: boolean;
}

/**
 * A documented credential, without the credential.
 *
 * Names, usernames and where it is used — never the value. IT Glue can
 * return password values when a key is set up to allow it, and NetKit does
 * not ask: an engineer who needs the password opens IT Glue, which logs that
 * they did. Pulling secrets through a second system doubles the places they
 * can leak from and halves the audit trail.
 */
export interface DocumentedCredential {
  id: string;
  name: string;
  username?: string;
  /** Where it signs in, when recorded. */
  url?: string;
  category?: string;
  /** Link into IT Glue, where the value can be read with an audit record. */
  documentationUrl?: string;
  updatedAt?: string;
}

/** One of a company's documented sites. */
export interface DocumentedLocation {
  id: string;
  name: string;
  primary?: boolean;
  addressLines: string[];
  city?: string;
  postcode?: string;
  region?: string;
  country?: string;
  phone?: string;
}

/** Everything one documentation system holds about a company. */
export interface DocumentedClient {
  /** The organisation as the documentation names it. */
  id: string;
  name: string;
  status?: string;
  shortName?: string;
  /** How confidently this was matched to the name that was searched. */
  confidence: MatchConfidence;
  matchReason: string;
  url?: string;
  locations: DocumentedLocation[];
  configurations: DocumentedConfiguration[];
  credentials: DocumentedCredential[];
}

/* ------------------------------------------------------------------ *
 * What the network actually says is at a site
 * ------------------------------------------------------------------ */

/** A device the controller can see, as the controller sees it. */
export interface NetworkDevice {
  id: string;
  name: string;
  model?: string;
  /** Short model code, e.g. UDMPROSE. */
  shortModel?: string;
  mac?: string;
  ip?: string;
  /** `network`, `protect`, and so on. */
  productLine?: string;
  status?: string;
  firmware?: string;
  firmwareStatus?: string;
  updateAvailable?: string;
  isConsole?: boolean;
  isManaged?: boolean;
  /** When it last booted. There is no uptime field to read. */
  startedAt?: string;
  adoptedAt?: string;
  note?: string;
}

/**
 * A site as the controller knows it.
 *
 * No address and no postcode: Site Manager does not hold either, which is
 * why matching a site to a premises falls back to the name.
 */
export interface NetworkSite {
  siteId: string;
  hostId: string;
  name: string;
  /** The friendlier of the two names the controller keeps. */
  description?: string;
  gatewayMac?: string;
  timezone?: string;
  /** What the operator can do here — admin, readonly. */
  permission?: string;
  counts?: {
    totalDevices?: number;
    offlineDevices?: number;
    wiredClients?: number;
    wifiClients?: number;
    guestClients?: number;
    criticalNotifications?: number;
    pendingUpdates?: number;
    wanConfigurations?: number;
  };
  /** Who the controller thinks provides the internet here. */
  isp?: { name?: string; organisation?: string };
  gateway?: { model?: string };
  /** Percentage, as the controller reports it. */
  wanUptimePercent?: number;
  /** True when the controller is reporting current internet trouble. */
  internetIssues?: boolean;
}

/**
 * WAN health over a window, from the ISP metrics feed.
 *
 * The nearest thing to "is the internet up here" that Site Manager
 * publishes: there is no per-site WAN status endpoint, so uptime and
 * downtime over an interval is what there is.
 */
export interface WanHealth {
  siteId: string;
  /** `5m` or `1h`, matching the interval requested. */
  interval: string;
  /** The most recent sample. */
  latest?: {
    at?: string;
    uptimePercent?: number;
    downtimeSeconds?: number;
    averageLatencyMs?: number;
    maxLatencyMs?: number;
    packetLossPercent?: number;
    downloadKbps?: number;
    uploadKbps?: number;
    ispName?: string;
  };
  /** Samples in the window, oldest first, for a sparkline. */
  samples: Array<{ at?: string; uptimePercent?: number; averageLatencyMs?: number }>;
  /** Downtime across the whole window, in seconds. */
  downtimeSeconds: number;
  /**
   * Per-uplink figures, where the feed gives them.
   *
   * Absent is the normal case: the metrics feed reports one aggregate for
   * the site. When it is absent the WAN list shows a single row labelled
   * `WAN` rather than `WAN 1`, because attributing one set of numbers to the
   * first of two uplinks would be a fabricated split.
   */
  uplinks?: Array<{
    id?: string;
    ispName?: string;
    publicIp?: string;
    uptimePercent?: number;
    downtimeSeconds?: number;
    averageLatencyMs?: number;
    maxLatencyMs?: number;
    packetLossPercent?: number;
    downloadKbps?: number;
    uploadKbps?: number;
    at?: string;
  }>;
}

/**
 * Everything we hold about a customer's site, from every system.
 *
 * Assembled per premises rather than per company, because that is the
 * question an engineer asks: not "what does this client have" but "what is
 * at this address". Each half says where it came from and how confidently it
 * was matched, because the join is on a name and a name is not an id.
 */
export interface SiteContext {
  /** The name that was searched for. */
  query: string;
  /** What the documentation holds, where a single organisation matched. */
  documented?: DocumentedClient;
  /** Organisations that could have been meant, when it was ambiguous. */
  documentedOptions?: Array<{ id: string; name: string; confidence: string; reason: string }>;
  /** The documented location judged to be this premises. */
  documentedLocation?: { location: DocumentedLocation; confidence: MatchConfidence; reason: string };
  /** Every site the controller holds for this company. */
  networkSites?: NetworkSite[];
  /** The controller site judged to be this premises. */
  networkSite?: { site: NetworkSite; confidence: MatchConfidence; reason: string };
  /** The equipment on that site's console. */
  devices?: NetworkDevice[];
  /** WAN health for that site over the last day. */
  wan?: WanHealth;
  status: {
    documentation: SectionStatus;
    network: SectionStatus;
  };
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * What the lookup box can find
 * ------------------------------------------------------------------ */

/**
 * The three kinds of thing a lookup can land on.
 *
 * A premises, a broadband service, or a mobile. They need different icons
 * and different destinations, and conflating them is why searching a client
 * name used to find their building and not their circuits.
 */
export type LookupKind = 'client' | 'address' | 'broadband' | 'mobile';

/**
 * One row in the lookup list.
 *
 * A superset of the address suggestion rather than a separate type, so the
 * typeahead has one list to render and one keyboard path through it. An
 * address row is exactly what it always was; the other two carry what is
 * needed to open the right thing.
 */
export interface LookupSuggestion {
  kind: LookupKind;
  id: string;
  label: string;
  /** The second line: postcode for a premises, client and site otherwise. */
  detail?: string;
  /** What to put in the search box to open it. */
  query: string;
  postcode?: string;
  postTown?: string;
  uprn?: string;
  /** Which system it came from, so a row can say whose record it is. */
  source: string;
  /** Broadband: the service reference to look up. */
  serviceReference?: string;
  /** Mobile: the SIM's ICCID, which is what its detail view is keyed on. */
  iccid?: string;
  /** Mobile: the number, for the label. */
  cli?: string;
  /** The customer, where the record names one. */
  client?: string;
  /**
   * Client rows only: the sites behind them, and what to send upstream for
   * each. One site opens directly; more than one is a choice, because a
   * company with twenty shops has twenty answers and guessing is worse than
   * asking.
   */
  sites?: Array<{ name: string; postcode?: string; uprn?: string; address?: string }>;
  /** Which systems know about this client. */
  knownFrom?: string[];
}
