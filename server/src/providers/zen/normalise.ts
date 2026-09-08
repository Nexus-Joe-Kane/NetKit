import {
  finaliseAddress,
  formatPostcode,
  normaliseCli,
  premisesTypeFor,
  statusRank,
  technologyRank,
  type AccessTechnology,
  type AddressRecord,
  type AvailabilityStatus,
  type BroadbandAvailability,
  type BroadbandOffer,
  type LineRecord,
  type LineStatus,
  type OpenreachDetail,
  type SpeedEstimate,
} from '@sw/shared';

/**
 * Zen response shapes → domain model.
 *
 * Field names here come straight from the Zen API docs. Enum fields are
 * documented as integers without published value tables, so every enum is
 * read tolerantly (integer *or* string) and falls back to `unknown` rather
 * than guessing wrong.
 */

/* ------------------------------------------------------------------ *
 * Raw shapes (only the fields the portal reads)
 * ------------------------------------------------------------------ */

export interface ZenAddress {
  organisationName?: string;
  poBox?: string;
  subPremises?: string;
  subPremiseName?: string;
  premisesName?: string;
  premiseName?: string;
  thoroughfareNumber?: string;
  dependentThoroughfareName?: string;
  dependentThoroughfare?: string;
  thoroughfareName?: string;
  thoroughfare?: string;
  doubleDependentLocality?: string;
  locality?: string;
  postTown?: string;
  county?: string;
  postCode?: string;
  country?: string;
}

export interface ZenAddressReference {
  qualifier?: string;
  /** The Gold Address Key — required when placing an order. */
  addressReferenceNumber?: string;
  districtCode?: string;
  uprn?: string;
  parentUPRN?: string;
  exchangeCode?: string;
}

export interface ZenAddressSearchRow {
  address?: ZenAddress;
  addressReference?: ZenAddressReference;
  message?: string;
  coordinates?: { easting?: string; northing?: string };
  addressClassification?: {
    classificationCode?: string;
    classificationDescription?: string;
    premiseType?: string;
    historicSite?: boolean;
  };
}

/** Common shape shared by the FTTC / SOGEA / G.fast blocks. */
interface ZenRangeBlock {
  rag?: string;
  ragDescription?: string;
  mdfSiteId?: string;
  mdfSiteName?: string;
  availabilityDescription?: string;
  readyDate?: string;
  rangeADownstreamTopSpeedValue?: number;
  rangeADownstreamBottomSpeedValue?: number;
  rangeAUpstreamTopSpeedValue?: number;
  rangeAUpstreamBottomSpeedValue?: number;
  rangeBDownstreamTopSpeedValue?: number;
  rangeBDownstreamBottomSpeedValue?: number;
  rangeBUpstreamTopSpeedValue?: number;
  rangeBUpstreamBottomSpeedValue?: number;
}

export interface ZenLineDetails {
  fttc?: ZenRangeBlock & { fttcExchangeName?: string; fttcExchangeCode?: string; fttcUnAvailableMessage?: string };
  sogea?: ZenRangeBlock & { exchangeName?: string; exchangeCode?: string; unAvailableMessage?: string };
  gFast?: ZenRangeBlock & { gfastExchangeName?: string; gfastExchangeCode?: string; gFastUnAvailableMessage?: string; reasonCodeDescription?: string };
  fttp?: {
    rag?: string;
    ragDescription?: string;
    fttpUnAvailableMessage?: string;
    reasonCodeDescription?: string;
    maxDownstreamSpeedValue?: number;
    maxUpstreamSpeedValue?: number;
    exchangeStatusDescription?: string;
    ontInstallLeadTime?: string;
    premiseType?: number;
    readyDate?: string;
    fttpExchangeName?: string;
    fttpExchangeCode?: string;
  };
  adsl2Plus?: {
    rag?: string;
    ragDescription?: string;
    reasonCodeDescription?: string;
    speedValue?: number;
    speedRangeMinValue?: number;
    speedRangeMaxValue?: number;
    exchangeStatusDescription?: string;
    mdfSiteName?: string;
    mdfSiteId?: string;
  };
  adsl2PlusAnnexM?: {
    rag?: string;
    ragDescription?: string;
    downloadSpeedValue?: number;
    uploadSpeedValue?: number;
    mdfSiteName?: string;
    mdfSiteId?: string;
  };
  ipStreamMax?: {
    rag?: string;
    ragDescription?: string;
    speedValue?: number;
    speedRangeMinValue?: number;
    speedRangeMaxValue?: number;
    mdfSiteName?: string;
    mdfSiteId?: string;
  };
  lineCharacteristics?: {
    btOpenreachPostCode?: string;
    btWholesalePostCode?: string;
    /** Primary Connection Point — the street cabinet. */
    pcpId?: string;
    /** Copper loop length, as a string with units. */
    lineLength?: string;
    /** Communications provider currently on the line. */
    cpName?: string;
    /** Service provider currently on the line. */
    spName?: string;
  };
}

export interface ZenOnt {
  location?: { floor?: string; room?: string; position?: string };
  serialNumber?: string;
  reference?: string;
  ports?: Array<{ number?: string; status?: string; type?: string; maxSpeed?: number }>;
}

export interface ZenAccessLine {
  accessLineId?: string;
  last2Digits?: string;
  serviceType?: string;
  lineNumber?: string;
  lineType?: number | string;
}

export interface ZenAvailabilityResponse {
  availabilityReference?: string;
  broadbandGroups?: Array<{
    broadbandType?: number | string;
    products?: Array<{
      productCode?: string;
      productName?: string;
      description?: string;
      marketLocation?: string;
      provisionType?: number | string;
      minimumActivationDate?: string;
      isOrderable?: boolean;
      isOrderableDescription?: string;
      installationLines?: Array<{
        exchangeWorkRequired?: boolean;
        installationType?: number | string;
        accessLine?: ZenAccessLine;
        ontDetail?: ZenOnt;
      }>;
      allowedAppointmentTypes?: string[];
      customerType?: string;
      serviceDeliveryMethod?: { method?: string };
    }>;
  }>;
  lineDetails?: ZenLineDetails;
  ontDetails?: ZenOnt[];
  accessLines?: ZenAccessLine[];
  addressReference?: ZenAddressReference;
  availabilityInformation?: {
    messages?: Array<{ severity?: number | string; category?: number | string; description?: string; errorCode?: string }>;
  };
  /** Fair-use quota remaining on this account. */
  remainingAvailabilityChecks?: unknown;
}

export interface ZenService {
  zenReference?: string;
  serviceStatus?: number | string;
  startDate?: string;
  serviceId?: string;
  phoneNumber?: string;
  postCode?: string;
  productCode?: string;
  productDescription?: string;
  connectionTechnology?: number | string;
  faultState?: number | string;
  careLevel?: number | string;
  trafficWeighting?: number | string;
  customerReference?: string;
  exchangeCode?: string;
  installationAddress?: ZenAddress & { addressReferenceNumber?: string; districtCode?: string; uprn?: string };
  contractEndDate?: string;
  upstreamSpeed?: string;
  ceasedDate?: string;
  isZenManagedConnection?: boolean;
  accessLineId?: string;
  ontReference?: string;
  port?: string;
  supplier?: number | string;
  cellularDetails?: { iccId?: string; phoneNumber?: string };
  events?: Array<{ startDate?: string; orderType?: number | string; eventDescription?: number | string }>;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const text = (v?: string | null): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' || s === 'string' ? undefined : s;
};

const numeric = (v?: number | string | null): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : typeof v === 'number' && v === 0 ? undefined : Number.isFinite(n) ? n : undefined;
};

const isoDate = (v?: string): string | undefined => {
  const s = text(v);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  // Zen returns placeholder dates in docs examples; treat year < 2000 as absent.
  if (d.getUTCFullYear() < 2000) return undefined;
  return d.toISOString().slice(0, 10);
};

/**
 * Zen reports per-technology availability as a RAG value. Green is orderable,
 * Amber is orderable with a caveat, Red is not.
 */
export function statusFromRag(rag?: string, description?: string): AvailabilityStatus {
  const v = (rag ?? '').trim().toUpperCase();
  if (v.startsWith('G')) return 'available';
  if (v.startsWith('A')) return 'available';
  if (v.startsWith('R')) return 'not_available';
  // Some blocks only populate the description.
  const d = (description ?? '').toUpperCase();
  if (d.includes('AVAILABLE') && !d.includes('NOT')) return 'available';
  if (d.includes('NOT AVAILABLE') || d.includes('UNAVAILABLE')) return 'not_available';
  return 'unknown';
}

/** True when the RAG value carries a caveat worth showing. */
const isAmber = (rag?: string) => (rag ?? '').trim().toUpperCase().startsWith('A');

/** Range A is the clean estimate; Range B is the impacted one. */
function speedsFrom(block: ZenRangeBlock): SpeedEstimate {
  return {
    ...(numeric(block.rangeADownstreamBottomSpeedValue) != null
      ? { downMbpsLow: numeric(block.rangeADownstreamBottomSpeedValue) }
      : {}),
    ...(numeric(block.rangeADownstreamTopSpeedValue) != null
      ? { downMbpsHigh: numeric(block.rangeADownstreamTopSpeedValue) }
      : {}),
    ...(numeric(block.rangeAUpstreamBottomSpeedValue) != null
      ? { upMbpsLow: numeric(block.rangeAUpstreamBottomSpeedValue) }
      : {}),
    ...(numeric(block.rangeAUpstreamTopSpeedValue) != null ? { upMbpsHigh: numeric(block.rangeAUpstreamTopSpeedValue) } : {}),
    basis: 'modelled',
  };
}

/** Range B, rendered as a note so the impacted estimate isn't lost. */
function rangeBNote(block: ZenRangeBlock): string | null {
  const down = numeric(block.rangeBDownstreamTopSpeedValue);
  const up = numeric(block.rangeBUpstreamTopSpeedValue);
  if (down == null && up == null) return null;
  const parts = [
    down != null ? `${numeric(block.rangeBDownstreamBottomSpeedValue) ?? '?'}–${down} Mbps down` : null,
    up != null ? `${numeric(block.rangeBUpstreamBottomSpeedValue) ?? '?'}–${up} Mbps up` : null,
  ].filter(Boolean);
  return `Range B (impacted line) estimate: ${parts.join(', ')}.`;
}

/* ------------------------------------------------------------------ *
 * Address
 * ------------------------------------------------------------------ */

export function mapZenAddress(row: ZenAddressSearchRow, fallbackPostcode = ''): AddressRecord {
  const a = row.address ?? {};
  const ref = row.addressReference ?? {};
  const cls = row.addressClassification ?? {};
  const classificationCode = text(cls.classificationCode);

  return finaliseAddress({
    ...(text(ref.uprn) ? { uprn: text(ref.uprn) } : {}),
    ...(text(ref.addressReferenceNumber) ? { addressKey: text(ref.addressReferenceNumber) } : {}),
    ...(text(a.organisationName) ? { organisation: text(a.organisationName) } : {}),
    ...(text(a.subPremises ?? a.subPremiseName) ? { subBuilding: text(a.subPremises ?? a.subPremiseName) } : {}),
    ...(text(a.premisesName ?? a.premiseName) ? { buildingName: text(a.premisesName ?? a.premiseName) } : {}),
    ...(text(a.thoroughfareNumber) ? { buildingNumber: text(a.thoroughfareNumber) } : {}),
    ...(text(a.dependentThoroughfareName ?? a.dependentThoroughfare)
      ? { dependentThoroughfare: text(a.dependentThoroughfareName ?? a.dependentThoroughfare) }
      : {}),
    ...(text(a.thoroughfareName ?? a.thoroughfare) ? { thoroughfare: text(a.thoroughfareName ?? a.thoroughfare) } : {}),
    ...(text(a.doubleDependentLocality) ? { doubleDependentLocality: text(a.doubleDependentLocality) } : {}),
    ...(text(a.locality) ? { dependentLocality: text(a.locality) } : {}),
    postTown: (text(a.postTown) ?? '').toUpperCase(),
    postcode: formatPostcode(text(a.postCode) ?? fallbackPostcode),
    ...(text(a.county) ? { county: text(a.county) } : {}),
    ...(text(a.country) ? { country: text(a.country) } : {}),
    ...(numeric(row.coordinates?.easting) != null ? { easting: numeric(row.coordinates?.easting) } : {}),
    ...(numeric(row.coordinates?.northing) != null ? { northing: numeric(row.coordinates?.northing) } : {}),
    ...(classificationCode ? { classificationCode } : {}),
    ...(text(cls.classificationDescription) ? { classificationLabel: text(cls.classificationDescription) } : {}),
    premisesType: classificationCode
      ? premisesTypeFor(classificationCode)
      : text(cls.premiseType)?.toLowerCase() === 'residential'
        ? 'residential'
        : text(cls.premiseType)
          ? 'business'
          : 'unknown',
    source: 'zen',
  });
}

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

interface OfferSpec {
  technology: AccessTechnology;
  label: string;
  rag?: string;
  ragDescription?: string;
  unavailableMessage?: string;
  reason?: string;
  speeds: SpeedEstimate;
  readyDate?: string;
  extraNotes: Array<string | null>;
}

function offerFrom(spec: OfferSpec, index: number): BroadbandOffer {
  const status = statusFromRag(spec.rag, spec.ragDescription);
  const notes = [
    ...(isAmber(spec.rag) && spec.ragDescription ? [`Amber: ${spec.ragDescription}`] : []),
    ...(status === 'not_available' && spec.unavailableMessage ? [spec.unavailableMessage] : []),
    ...(spec.reason ? [spec.reason] : []),
    ...spec.extraNotes,
  ].filter((n): n is string => Boolean(n));

  return {
    id: `zen-${spec.technology.toLowerCase()}-${index}`,
    operator: 'openreach',
    operatorLabel: 'Openreach',
    retailer: 'zen',
    technology: spec.technology,
    status,
    speeds: spec.speeds,
    productName: spec.label,
    ...(spec.readyDate ? { rfsDate: spec.readyDate } : {}),
    notes,
    source: 'zen:availability',
  };
}

/** Turns `lineDetails` into one offer per access technology. */
export function offersFromLineDetails(ld: ZenLineDetails): BroadbandOffer[] {
  const out: BroadbandOffer[] = [];
  let i = 0;

  if (ld.fttp) {
    const f = ld.fttp;
    out.push(
      offerFrom(
        {
          technology: 'FTTP',
          label: 'GEA-FTTP (Openreach full fibre)',
          rag: f.rag,
          ragDescription: f.ragDescription,
          unavailableMessage: text(f.fttpUnAvailableMessage),
          reason: text(f.reasonCodeDescription),
          speeds: {
            ...(numeric(f.maxDownstreamSpeedValue) != null ? { downMbpsHigh: numeric(f.maxDownstreamSpeedValue) } : {}),
            ...(numeric(f.maxUpstreamSpeedValue) != null ? { upMbpsHigh: numeric(f.maxUpstreamSpeedValue) } : {}),
            basis: 'headline',
          },
          ...(isoDate(f.readyDate) ? { readyDate: isoDate(f.readyDate) } : {}),
          extraNotes: [
            text(f.exchangeStatusDescription) ? `Exchange: ${text(f.exchangeStatusDescription)}` : null,
            text(f.ontInstallLeadTime) ? `ONT install lead time: ${text(f.ontInstallLeadTime)}` : null,
          ],
        },
        (i += 1),
      ),
    );
  }

  if (ld.sogea) {
    out.push(
      offerFrom(
        {
          technology: 'SOGEA',
          label: 'SOGEA (single order GEA)',
          rag: ld.sogea.rag,
          ragDescription: ld.sogea.ragDescription,
          unavailableMessage: text(ld.sogea.unAvailableMessage),
          speeds: speedsFrom(ld.sogea),
          ...(isoDate(ld.sogea.readyDate) ? { readyDate: isoDate(ld.sogea.readyDate) } : {}),
          extraNotes: [rangeBNote(ld.sogea), text(ld.sogea.availabilityDescription) ?? null],
        },
        (i += 1),
      ),
    );
  }

  if (ld.gFast) {
    out.push(
      offerFrom(
        {
          technology: 'GFAST',
          label: 'G.fast (SOGfast)',
          rag: ld.gFast.rag,
          ragDescription: ld.gFast.ragDescription,
          unavailableMessage: text(ld.gFast.gFastUnAvailableMessage),
          reason: text(ld.gFast.reasonCodeDescription),
          speeds: speedsFrom(ld.gFast),
          ...(isoDate(ld.gFast.readyDate) ? { readyDate: isoDate(ld.gFast.readyDate) } : {}),
          extraNotes: [rangeBNote(ld.gFast)],
        },
        (i += 1),
      ),
    );
  }

  if (ld.fttc) {
    out.push(
      offerFrom(
        {
          technology: 'FTTC',
          label: 'GEA-FTTC (fibre to the cabinet)',
          rag: ld.fttc.rag,
          ragDescription: ld.fttc.ragDescription,
          unavailableMessage: text(ld.fttc.fttcUnAvailableMessage),
          speeds: speedsFrom(ld.fttc),
          ...(isoDate(ld.fttc.readyDate) ? { readyDate: isoDate(ld.fttc.readyDate) } : {}),
          extraNotes: [rangeBNote(ld.fttc), text(ld.fttc.availabilityDescription) ?? null],
        },
        (i += 1),
      ),
    );
  }

  if (ld.adsl2Plus) {
    const a = ld.adsl2Plus;
    out.push(
      offerFrom(
        {
          technology: 'ADSL2+',
          label: 'ADSL2+ (WBC)',
          rag: a.rag,
          ragDescription: a.ragDescription,
          reason: text(a.reasonCodeDescription),
          speeds: {
            ...(numeric(a.speedRangeMinValue) != null ? { downMbpsLow: numeric(a.speedRangeMinValue) } : {}),
            ...(numeric(a.speedRangeMaxValue ?? a.speedValue) != null
              ? { downMbpsHigh: numeric(a.speedRangeMaxValue ?? a.speedValue) }
              : {}),
            basis: 'modelled',
          },
          extraNotes: [text(a.exchangeStatusDescription) ? `Exchange: ${text(a.exchangeStatusDescription)}` : null],
        },
        (i += 1),
      ),
    );
  }

  if (ld.adsl2PlusAnnexM) {
    const a = ld.adsl2PlusAnnexM;
    out.push(
      offerFrom(
        {
          technology: 'ADSL2+',
          label: 'ADSL2+ Annex M (uplift upstream)',
          rag: a.rag,
          ragDescription: a.ragDescription,
          speeds: {
            ...(numeric(a.downloadSpeedValue) != null ? { downMbpsHigh: numeric(a.downloadSpeedValue) } : {}),
            ...(numeric(a.uploadSpeedValue) != null ? { upMbpsHigh: numeric(a.uploadSpeedValue) } : {}),
            basis: 'modelled',
          },
          extraNotes: ['Annex M trades downstream for upstream — useful for hosted voice and CCTV.'],
        },
        (i += 1),
      ),
    );
  }

  if (ld.ipStreamMax) {
    const a = ld.ipStreamMax;
    out.push(
      offerFrom(
        {
          technology: 'ADSL',
          label: 'IPStream Max (legacy)',
          rag: a.rag,
          ragDescription: a.ragDescription,
          speeds: {
            ...(numeric(a.speedRangeMinValue) != null ? { downMbpsLow: numeric(a.speedRangeMinValue) } : {}),
            ...(numeric(a.speedRangeMaxValue ?? a.speedValue) != null
              ? { downMbpsHigh: numeric(a.speedRangeMaxValue ?? a.speedValue) }
              : {}),
            basis: 'modelled',
          },
          extraNotes: ['Legacy product — only where no fibre or WBC path exists.'],
        },
        (i += 1),
      ),
    );
  }

  return out.sort(
    (a, b) => statusRank(b.status) - statusRank(a.status) || technologyRank(b.technology) - technologyRank(a.technology),
  );
}

/** Adds the orderable Zen retail products alongside the wholesale offers. */
export function offersFromProducts(res: ZenAvailabilityResponse): BroadbandOffer[] {
  const out: BroadbandOffer[] = [];
  let i = 0;
  for (const group of res.broadbandGroups ?? []) {
    for (const p of group.products ?? []) {
      const code = text(p.productCode);
      if (!code) continue;
      const orderable = p.isOrderable !== false;
      const line = p.installationLines?.[0];
      out.push({
        id: `zen-product-${(i += 1)}`,
        operator: 'openreach',
        operatorLabel: 'Openreach',
        retailer: 'zen',
        technology: technologyFromProduct(text(p.productName) ?? text(p.description) ?? code),
        status: orderable ? 'available' : 'not_available',
        speeds: { basis: 'headline' },
        productCode: code,
        ...(text(p.productName) ? { productName: text(p.productName) } : {}),
        ...(isoDate(p.minimumActivationDate) ? { rfsDate: isoDate(p.minimumActivationDate) } : {}),
        ...(line?.exchangeWorkRequired ? { installCategory: 'Exchange work required' } : {}),
        ...(p.allowedAppointmentTypes?.length ? { appointmentRequired: true } : {}),
        orderable,
        ...(orderable ? {} : { orderableReason: text(p.isOrderableDescription) ?? 'Not currently orderable.' }),
        notes: [
          ...(orderable ? [] : [text(p.isOrderableDescription) ?? 'Not currently orderable.']),
          ...(text(p.marketLocation) ? [`Market location ${text(p.marketLocation)}`] : []),
          ...(text(p.customerType) ? [`Customer type: ${text(p.customerType)}`] : []),
          ...(line?.accessLine?.accessLineId ? [`Existing access line ${line.accessLine.accessLineId}`] : []),
          ...(p.allowedAppointmentTypes?.length ? [`Appointment types: ${p.allowedAppointmentTypes.join(', ')}`] : []),
        ],
        source: 'zen:product',
      });
    }
  }
  return out;
}

/** Best-effort technology inference from a Zen retail product name. */
export function technologyFromProduct(name: string): AccessTechnology {
  const v = name.toUpperCase().replace(/[\s_-]/g, '');
  if (v.includes('FTTP') || v.includes('FULLFIBRE')) return 'FTTP';
  if (v.includes('SOGFAST')) return 'SOGFAST';
  if (v.includes('GFAST')) return 'GFAST';
  if (v.includes('SOGEA')) return 'SOGEA';
  if (v.includes('FTTC') || v.includes('VDSL')) return 'FTTC';
  if (v.includes('ANNEXM') || v.includes('ADSL2')) return 'ADSL2+';
  if (v.includes('ADSL') || v.includes('IPSTREAM')) return 'ADSL';
  if (v.includes('ETHERNET') || v.includes('EAD')) return 'EAD';
  if (v.includes('CELLULAR') || v.includes('4G') || v.includes('5G')) return '4G/5G Fixed Wireless';
  return 'Unknown';
}

/** Builds the Openreach engineering panel from a Zen availability response. */
export function openreachFromAvailability(res: ZenAvailabilityResponse): OpenreachDetail {
  const ld = res.lineDetails ?? {};
  const lc = ld.lineCharacteristics ?? {};
  const ref = res.addressReference ?? {};
  const ont = res.ontDetails?.[0];

  const exchangeName =
    text(ld.fttp?.fttpExchangeName) ??
    text(ld.sogea?.exchangeName) ??
    text(ld.fttc?.fttcExchangeName) ??
    text(ld.gFast?.gfastExchangeName);
  const exchangeCode =
    text(ld.fttp?.fttpExchangeCode) ??
    text(ld.sogea?.exchangeCode) ??
    text(ld.fttc?.fttcExchangeCode) ??
    text(ld.gFast?.gfastExchangeCode);
  const mdfSiteId = text(ld.sogea?.mdfSiteId) ?? text(ld.fttc?.mdfSiteId) ?? text(ld.adsl2Plus?.mdfSiteId);
  const mdfSiteName = text(ld.sogea?.mdfSiteName) ?? text(ld.fttc?.mdfSiteName) ?? text(ld.adsl2Plus?.mdfSiteName);

  const flags: OpenreachDetail['flags'] = [];

  // Availability messages are the provider's own warnings — surface them.
  for (const m of res.availabilityInformation?.messages ?? []) {
    const description = text(m.description);
    if (!description) continue;
    const sev = String(m.severity ?? '').toUpperCase();
    const level: 'info' | 'warn' | 'critical' =
      sev.includes('ERROR') || sev === '3' || sev === '2' ? 'critical' : sev.includes('WARN') || sev === '1' ? 'warn' : 'info';
    flags.push({
      level,
      label: text(m.errorCode) ? `${text(m.errorCode)}` : 'Availability message',
      detail: description,
    });
  }

  // Knowing who is already on the line is the single most useful fact for a
  // migration conversation, so it gets promoted to a flag.
  const cp = text(lc.cpName);
  const sp = text(lc.spName);
  if (cp || sp) {
    flags.push({
      level: 'info',
      label: 'Line already in service',
      detail: `Currently provided by ${[sp, cp].filter(Boolean).join(' via ')}. A provide will be a migration or takeover.`,
    });
  }
  if (ont?.serialNumber && text(ont.serialNumber)) {
    const spare = (ont.ports ?? []).filter((p) => (p.status ?? '').toUpperCase().includes('SPARE')).length;
    flags.push({
      level: 'info',
      label: 'ONT already fitted',
      detail: `ONT ${text(ont.serialNumber)}${spare ? ` with ${spare} spare port(s)` : ''} — a provide may not need an engineer visit.`,
    });
  }

  const fttpAvailable = statusFromRag(ld.fttp?.rag, ld.fttp?.ragDescription) === 'available';
  const lineLength = text(lc.lineLength);

  return {
    ...(text(ref.addressReferenceNumber) ? { addressKey: text(ref.addressReferenceNumber) } : {}),
    ...(text(ref.districtCode) ? { districtCode: text(ref.districtCode) } : {}),
    ...(exchangeName || exchangeCode || mdfSiteId
      ? {
          exchange: {
            name: exchangeName ?? mdfSiteName ?? 'Unknown',
            ...(exchangeCode ? { code: exchangeCode, tlc: exchangeCode } : {}),
            ...(mdfSiteId ? { mdfSiteId } : {}),
            status: fttpAvailable ? 'fibre-enabled' : 'standard',
          },
        }
      : {}),
    ...(text(lc.pcpId)
      ? {
          cabinet: {
            id: text(lc.pcpId),
            technology: statusFromRag(ld.gFast?.rag) === 'available' ? 'G.fast' : 'FTTC',
            fttcAvailable: statusFromRag(ld.fttc?.rag, ld.fttc?.ragDescription) === 'available',
            gfastAvailable: statusFromRag(ld.gFast?.rag, ld.gFast?.ragDescription) === 'available',
          },
        }
      : {}),
    fttp: {
      available: fttpAvailable,
      ...(text(ld.fttp?.ragDescription) ? { buildStatus: text(ld.fttp?.ragDescription) } : {}),
      ...(isoDate(ld.fttp?.readyDate) ? { rfsDate: isoDate(ld.fttp?.readyDate) } : {}),
      ...(text(ont?.serialNumber)
        ? {
            ontPresent: true,
            ontSerial: text(ont?.serialNumber),
            ...(ont?.ports?.length ? { ontPortsTotal: ont.ports.length } : {}),
            ...(ont?.ports?.length
              ? { ontPortsUsed: ont.ports.filter((p) => !(p.status ?? '').toUpperCase().includes('SPARE')).length }
              : {}),
          }
        : {}),
    },
    copper: {
      sogeaAvailable: statusFromRag(ld.sogea?.rag, ld.sogea?.ragDescription) === 'available',
      ...(lineLength && numeric(lineLength) != null ? { lineLengthMetres: numeric(lineLength) } : {}),
    },
    flags,
  };
}

export function availabilityFromZen(address: AddressRecord, res: ZenAvailabilityResponse): BroadbandAvailability {
  const offers = [...offersFromLineDetails(res.lineDetails ?? {}), ...offersFromProducts(res)].sort(
    (a, b) => statusRank(b.status) - statusRank(a.status) || technologyRank(b.technology) - technologyRank(a.technology),
  );
  const best = offers.find((o) => o.status === 'available' && o.speeds.downMbpsHigh != null) ?? offers[0];

  return {
    ...(address.uprn ? { uprn: address.uprn } : {}),
    address,
    offers,
    openreach: openreachFromAvailability(res),
    ...(best
      ? {
          headline: {
            technology: best.technology,
            ...(best.speeds.downMbpsHigh != null ? { downMbps: best.speeds.downMbpsHigh } : {}),
            ...(best.speeds.upMbpsHigh != null ? { upMbps: best.speeds.upMbpsHigh } : {}),
            operatorLabel: best.operatorLabel,
          },
        }
      : {}),
    checkedAt: new Date().toISOString(),
    sources: ['zen:availability'],
  };
}

/* ------------------------------------------------------------------ *
 * Services → lines
 * ------------------------------------------------------------------ */

/**
 * Zen documents `serviceStatus` as an integer without a published value
 * table, so this reads a string form when present and otherwise infers from
 * `ceasedDate` — which is unambiguous.
 */
export function lineStatusFromZen(svc: ZenService): LineStatus {
  const raw = String(svc.serviceStatus ?? '').toUpperCase();
  if (raw.includes('CEASE')) return raw.includes('PEND') ? 'pending_cease' : 'ceased';
  if (raw.includes('SUSPEND')) return 'suspended';
  if (raw.includes('ACTIVE') || raw.includes('LIVE')) return 'active';
  if (raw.includes('PEND') || raw.includes('ORDER')) return 'pending_provide';
  if (isoDate(svc.ceasedDate)) return 'ceased';
  if (isoDate(svc.startDate)) return 'active';
  return 'unknown';
}

export function technologyFromZenService(svc: ZenService): AccessTechnology {
  const raw = String(svc.connectionTechnology ?? '');
  if (/[a-z]/i.test(raw)) {
    const t = technologyFromProduct(raw);
    if (t !== 'Unknown') return t;
  }
  if (svc.cellularDetails?.iccId) return '4G/5G Fixed Wireless';
  if (text(svc.ontReference)) return 'FTTP';
  return technologyFromProduct(text(svc.productDescription) ?? text(svc.productCode) ?? '');
}

const SUPPLIERS: Record<string, string> = {
  '0': 'All',
  '1': 'Openreach',
  '2': 'BT Wholesale',
  '3': 'CityFibre',
};

export function mapZenService(svc: ZenService): LineRecord {
  const ia = svc.installationAddress ?? {};
  const address = mapZenAddress(
    {
      address: ia,
      addressReference: {
        ...(text(ia.uprn) ? { uprn: text(ia.uprn) } : {}),
        ...(text(ia.addressReferenceNumber) ? { addressReferenceNumber: text(ia.addressReferenceNumber) } : {}),
        ...(text(ia.districtCode) ? { districtCode: text(ia.districtCode) } : {}),
      },
    },
    text(svc.postCode) ?? '',
  );

  const supplierLabel = SUPPLIERS[String(svc.supplier ?? '')] ?? text(String(svc.supplier ?? '')) ?? 'Zen Internet';
  const cli = normaliseCli(text(svc.phoneNumber) ?? text(svc.cellularDetails?.phoneNumber) ?? '');
  const contractEnd = isoDate(svc.contractEndDate);

  const notes: string[] = [];
  if (svc.isZenManagedConnection) notes.push('Zen managed connection.');
  if (text(svc.customerReference)) notes.push(`Customer reference ${text(svc.customerReference)}.`);
  if (supplierLabel && supplierLabel !== 'All') notes.push(`Access supplier: ${supplierLabel}.`);
  if (isoDate(svc.ceasedDate)) notes.push(`Ceased ${isoDate(svc.ceasedDate)}.`);

  return {
    id: text(svc.zenReference) ?? text(svc.serviceId) ?? 'zen-line',
    ...(cli ? { cli } : {}),
    ...(text(svc.accessLineId) ? { lineAccessId: text(svc.accessLineId) } : {}),
    ...(text(svc.serviceId) ? { serviceId: text(svc.serviceId) } : {}),
    ...(text(svc.zenReference) ? { orderRef: text(svc.zenReference) } : {}),
    status: lineStatusFromZen(svc),
    technology: technologyFromZenService(svc),
    provider: 'Zen Internet',
    ...(text(svc.productDescription) ? { productName: text(svc.productDescription) } : {}),
    ...(text(svc.upstreamSpeed) ? { bearerSpeed: `${text(svc.upstreamSpeed)} upstream` } : {}),
    address,
    ...(isoDate(svc.startDate) || contractEnd
      ? {
          contract: {
            ...(isoDate(svc.startDate) ? { startDate: isoDate(svc.startDate) } : {}),
            ...(contractEnd ? { endDate: contractEnd, inContract: new Date(contractEnd).getTime() > Date.now() } : {}),
          },
        }
      : {}),
    ...(text(svc.ontReference)
      ? {
          ont: {
            serial: text(svc.ontReference),
            ...(text(svc.port) ? { portsUsed: numeric(svc.port) ?? 1 } : {}),
          },
        }
      : {}),
    discoveredVia: 'zen',
    notes,
  };
}
