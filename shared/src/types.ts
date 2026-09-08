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

export interface SignalReport {
  uprn?: string;
  address: AddressRecord;
  operators: MobileCoverage[];
  /** Best indoor voice + data across all four networks, for the summary. */
  headline?: { bestIndoorVoice?: MobileOperator; bestIndoorData?: MobileOperator };
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
  /** Populated when the query resolves to exactly one thing. */
  report?: SiteReport;
  /** Populated when the query was a CLI / line id. */
  lines?: LineRecord[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  providers: Record<string, { configured: boolean; mode: 'live' | 'mock'; label: string }>;
  uptimeSeconds: number;
}
