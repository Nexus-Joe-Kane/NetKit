import {
  statusRank,
  technologyRank,
  type AccessTechnology,
  type AddressRecord,
  type AvailabilityStatus,
  type BroadbandAvailability,
  type BroadbandOffer,
  type NetworkOperator,
  type OpenreachDetail,
} from '@sw/shared';
import { Seeded } from '../../lib/seeded';
import { EXCHANGES, ONT_MODELS, regionFor } from '../../fixtures/uk';
import type { AvailabilityProvider } from '../types';

/**
 * Fixture availability engine.
 *
 * Rather than emitting random values, this models a premises the way the real
 * network is shaped: an exchange with a fibre programme state, a PCP cabinet
 * some distance away, a copper loop whose length drives the FTTC/ADSL speeds,
 * and an FTTP build that may or may not have reached this address yet. Every
 * derived number therefore agrees with every other one.
 */

/** Where this premises sits in the Openreach FTTP programme. */
type FibreMaturity = 'rfs' | 'in-build' | 'planned' | 'no-plan';

interface Model {
  maturity: FibreMaturity;
  /** Copper loop length in metres — drives every copper speed estimate. */
  loopMetres: number;
  cabinetMetres: number;
  exchangeMetres: number;
  fttcEnabled: boolean;
  gfastEnabled: boolean;
  exchangeOnlyLine: boolean;
  ontPresent: boolean;
}

function buildModel(rng: Seeded, address: AddressRecord): Model {
  // Urban premises (flats, businesses in town) get better infrastructure.
  const urban = address.premisesType === 'business' || Boolean(address.subBuilding);
  const maturity = rng.weighted<FibreMaturity>([
    ['rfs', urban ? 7 : 5],
    ['in-build', 2],
    ['planned', 2],
    ['no-plan', urban ? 1 : 2],
  ]);
  const exchangeOnlyLine = rng.bool(0.06);
  const cabinetMetres = exchangeOnlyLine ? 0 : rng.int(90, 1400);
  return {
    maturity,
    // Copper loop is longer than the straight-line cabinet distance.
    loopMetres: exchangeOnlyLine ? rng.int(900, 4200) : Math.round(cabinetMetres * rng.float(1.2, 1.9, 2)),
    cabinetMetres,
    exchangeMetres: rng.int(400, 6500),
    fttcEnabled: !exchangeOnlyLine && rng.bool(0.94),
    gfastEnabled: !exchangeOnlyLine && urban && rng.bool(0.18),
    exchangeOnlyLine,
    ontPresent: maturity === 'rfs' && rng.bool(0.45),
  };
}

/** Copper attenuation rises roughly linearly with loop length. */
const attenuationFor = (metres: number) => Number((metres * 0.0138 + 2.5).toFixed(1));

/**
 * VDSL2 (FTTC/SOGEA) rate vs loop length. Approximates the Openreach
 * downstream/upstream curves closely enough to be useful for triage.
 */
function vdslSpeeds(loopMetres: number): { down: number; up: number } {
  const km = loopMetres / 1000;
  const down = Math.max(4, Math.min(80, 80 * Math.exp(-0.62 * km)));
  const up = Math.max(0.5, Math.min(20, 20 * Math.exp(-0.75 * km)));
  return { down: Number(down.toFixed(1)), up: Number(up.toFixed(1)) };
}

/** ADSL2+ rate vs loop length. */
function adslSpeed(loopMetres: number): number {
  const km = loopMetres / 1000;
  return Number(Math.max(0.5, Math.min(20, 20 * Math.exp(-0.45 * km))).toFixed(1));
}

function buildOpenreach(rng: Seeded, address: AddressRecord, m: Model): OpenreachDetail {
  // The exchange has to belong to the same region as the postcode, or the
  // data reads as obviously synthetic.
  const region = regionFor(address.postcode);
  const candidates = EXCHANGES.filter((e) => region.exchanges.includes(e.tlc));
  const exchange = candidates.length ? rng.pick(candidates) : rng.pick(EXCHANGES);
  const flags: OpenreachDetail['flags'] = [];

  // All-IP: WLR is withdrawn nationally, so stop-sell is the normal state.
  const stopSellActive = rng.bool(0.85);
  const wlrWithdrawal = '2027-01-31';

  if (m.exchangeOnlyLine) {
    flags.push({
      level: 'warn',
      label: 'Exchange Only line',
      detail: 'No PCP cabinet serves this premises, so FTTC/SOGEA is unavailable. FTTP or a copper reroute is required.',
    });
  }
  if (stopSellActive) {
    flags.push({
      level: 'critical',
      label: 'All-IP stop sell in force',
      detail: 'New WLR and MPF orders are blocked at this exchange. Provide on SOGEA or FTTP only.',
    });
  }
  if (m.maturity === 'rfs' && m.ontPresent) {
    flags.push({
      level: 'info',
      label: 'ONT already fitted',
      detail: 'A fibre ONT is present at the premises — a provide may not need an engineer visit.',
    });
  }
  if (m.loopMetres > 2200) {
    flags.push({
      level: 'warn',
      label: 'Long copper loop',
      detail: `Estimated ${m.loopMetres} m loop. Copper speeds will be materially below headline.`,
    });
  }

  const ont = rng.pick(ONT_MODELS);
  const cabinetId = String(rng.int(1, 92));

  return {
    addressKey: `A${rng.digits(11)}`,
    districtCode: `${exchange.tlc.slice(0, 2)}${rng.int(10, 99)}`,
    cssDistrictCode: exchange.tlc.slice(0, 2),
    alk: `ALK${rng.digits(9)}`,

    exchange: {
      name: exchange.name,
      code: exchange.code,
      tlc: exchange.tlc,
      mdfSiteId: `MDF${rng.digits(6)}`,
      status: m.maturity === 'rfs' ? 'fibre-enabled' : stopSellActive ? 'stop-sell' : 'standard',
      wlrWithdrawalDate: wlrWithdrawal,
      ...(stopSellActive ? { stopSellDate: rng.dateOffset(-800, -30) } : {}),
      distanceMetres: m.exchangeMetres,
    },

    cabinet: m.exchangeOnlyLine
      ? { technology: 'none', status: 'Exchange Only — no PCP', fttcAvailable: false, gfastAvailable: false }
      : {
          id: `PCP ${cabinetId}`,
          fibreCabinetId: `FTTC ${rng.int(1, 40)}`,
          technology: m.gfastEnabled ? 'G.fast' : 'FTTC',
          status: m.fttcEnabled ? 'Available' : 'Not fibre enabled',
          fttcAvailable: m.fttcEnabled,
          gfastAvailable: m.gfastEnabled,
          congested: rng.bool(0.12),
          distanceMetres: m.cabinetMetres,
        },

    fttp: {
      available: m.maturity === 'rfs',
      buildStatus:
        m.maturity === 'rfs'
          ? 'RFS — Ready for Service'
          : m.maturity === 'in-build'
            ? 'In Build'
            : m.maturity === 'planned'
              ? 'Planned'
              : 'No current plan',
      ...(m.maturity === 'in-build' ? { rfsDate: rng.dateOffset(30, 210) } : {}),
      ...(m.maturity === 'planned' ? { rfsDate: rng.dateOffset(240, 720) } : {}),
      ...(m.maturity === 'rfs'
        ? {
            cbtId: `CBT${rng.digits(6)}`,
            cbtSpareCapacity: rng.int(0, 8),
            sn1: `SN1-${rng.digits(7)}`,
            spineId: `SP${rng.digits(5)}`,
            ontPresent: m.ontPresent,
            ...(m.ontPresent
              ? {
                  ontType: `${ont.vendor} ${ont.model}`,
                  ontSerial: `${ont.prefix}${rng.hex(8)}`,
                  ontPortsUsed: rng.int(1, 2),
                  ontPortsTotal: 4,
                }
              : {}),
          }
        : {}),
      // FTTP on Demand is the fallback where standard FTTP hasn't arrived.
      fodAvailable: m.maturity !== 'rfs' && rng.bool(0.55),
      ...(m.maturity !== 'rfs' ? { fodExcessConstruction: rng.int(1800, 14500) } : {}),
    },

    copper: {
      wlrAvailable: !stopSellActive,
      sogeaAvailable: m.fttcEnabled,
      mpfAvailable: !stopSellActive,
      sparePairs: rng.int(0, 6),
      lineLengthMetres: m.loopMetres,
      attenuationDb: attenuationFor(m.loopMetres),
      dpId: `DP ${rng.int(1, 40)}/${rng.int(1, 12)}`,
    },

    stopSell: {
      wlr: stopSellActive,
      mpf: stopSellActive,
      sogea: false,
      fttc: stopSellActive && m.maturity === 'rfs',
      ...(stopSellActive ? { effectiveDate: rng.dateOffset(-800, -30) } : {}),
      reason: stopSellActive
        ? m.maturity === 'rfs'
          ? 'FTTP available at this premises — copper products withdrawn'
          : 'Exchange has passed the All-IP stop-sell trigger'
        : 'No stop sell recorded',
    },

    flags,
  };
}

function buildOffers(rng: Seeded, address: AddressRecord, m: Model, or: OpenreachDetail): BroadbandOffer[] {
  const offers: BroadbandOffer[] = [];
  const vdsl = vdslSpeeds(m.loopMetres);
  const stopSell = or.stopSell?.wlr ?? false;
  let n = 0;
  const id = () => `offer-${(n += 1)}`;

  // A demo offer is orderable exactly when it is available, so the ordering
  // flow can be exercised end to end without credentials — it still refuses
  // to place anything, but the whole path up to that point is real.
  const push = (o: Omit<BroadbandOffer, 'id'>) =>
    offers.push({ id: id(), orderable: o.status === 'available', ...o });

  // ---- Openreach FTTP -------------------------------------------------
  if (m.maturity === 'rfs') {
    push({
      operator: 'openreach',
      operatorLabel: 'Openreach',
      retailer: 'zen',
      technology: 'FTTP',
      status: 'available',
      speeds: { downMbpsLow: 900, downMbpsHigh: 1000, upMbpsLow: 900, upMbpsHigh: 1000, basis: 'headline' },
      productCode: 'FTTP-1000-115',
      productName: 'FTTP 1000/115 (GEA-FTTP)',
      installCategory: m.ontPresent ? 'Category A (ONT present)' : 'Category B',
      appointmentRequired: !m.ontPresent,
      notes: m.ontPresent
        ? ['ONT already installed — likely a managed install with no engineer visit.']
        : ['Engineer appointment required to fit the ONT.'],
      source: 'fixture:openreach',
    });
    for (const [code, down, up] of [
      ['FTTP-500-70', 500, 70],
      ['FTTP-330-50', 330, 50],
      ['FTTP-160-30', 160, 30],
      ['FTTP-80-20', 80, 20],
    ] as const) {
      push({
        operator: 'openreach',
        operatorLabel: 'Openreach',
        retailer: 'zen',
        technology: 'FTTP',
        status: 'available',
        speeds: { downMbpsHigh: down, upMbpsHigh: up, basis: 'headline' },
        productCode: code,
        productName: `FTTP ${down}/${up} (GEA-FTTP)`,
        notes: [],
        source: 'fixture:openreach',
      });
    }
  } else {
    const status: AvailabilityStatus =
      m.maturity === 'in-build' ? 'available_soon' : m.maturity === 'planned' ? 'build_planned' : 'not_available';
    push({
      operator: 'openreach',
      operatorLabel: 'Openreach',
      technology: 'FTTP',
      status,
      speeds: { downMbpsHigh: 1000, upMbpsHigh: 1000, basis: 'headline' },
      ...(or.fttp?.rfsDate ? { rfsDate: or.fttp.rfsDate } : {}),
      productName: 'FTTP (GEA-FTTP)',
      notes: [or.fttp?.buildStatus ?? 'Build status unknown'],
      source: 'fixture:openreach',
    });
    if (or.fttp?.fodAvailable) {
      push({
        operator: 'openreach',
        operatorLabel: 'Openreach',
        technology: 'FTTP',
        status: 'on_demand',
        speeds: { downMbpsHigh: 1000, upMbpsHigh: 1000, basis: 'headline' },
        productName: 'FTTP on Demand (FoD)',
        ...(or.fttp.fodExcessConstruction ? { excessConstructionCharge: or.fttp.fodExcessConstruction } : {}),
        notes: [
          `Excess construction charge estimated at £${(or.fttp.fodExcessConstruction ?? 0).toLocaleString('en-GB')}.`,
          'Survey required before the charge is confirmed.',
        ],
        source: 'fixture:openreach',
      });
    }
  }

  // ---- Openreach copper ----------------------------------------------
  if (m.fttcEnabled) {
    push({
      operator: 'openreach',
      operatorLabel: 'Openreach',
      retailer: 'zen',
      technology: 'SOGEA',
      status: 'available',
      speeds: {
        downMbpsLow: Number((vdsl.down * 0.72).toFixed(1)),
        downMbpsHigh: vdsl.down,
        upMbpsLow: Number((vdsl.up * 0.72).toFixed(1)),
        upMbpsHigh: vdsl.up,
        downMbpsAvgPeak: Number((vdsl.down * 0.86).toFixed(1)),
        basis: 'modelled',
      },
      productCode: 'SOGEA-80-20',
      productName: 'SOGEA 80/20 (single order GEA)',
      notes: ['No analogue line required — the All-IP replacement for FTTC + WLR.'],
      source: 'fixture:openreach',
    });
    if (m.gfastEnabled) {
      push({
        operator: 'openreach',
        operatorLabel: 'Openreach',
        technology: 'SOGFAST',
        status: 'available',
        speeds: {
          downMbpsHigh: Math.min(330, Math.round(vdsl.down * 3.1)),
          upMbpsHigh: Math.min(50, Math.round(vdsl.up * 2.4)),
          basis: 'modelled',
        },
        productName: 'SOGfast 330/50 (G.fast)',
        notes: ['G.fast is highly loop-length sensitive; rate falls away sharply beyond ~350 m.'],
        source: 'fixture:openreach',
      });
    }
    push({
      operator: 'openreach',
      operatorLabel: 'Openreach',
      technology: 'FTTC',
      status: stopSell ? 'not_available' : 'available',
      speeds: { downMbpsHigh: vdsl.down, upMbpsHigh: vdsl.up, basis: 'modelled' },
      productName: 'FTTC 80/20 + WLR',
      notes: stopSell ? ['Blocked by All-IP stop sell — order SOGEA instead.'] : [],
      source: 'fixture:openreach',
    });
  }
  push({
    operator: 'openreach',
    operatorLabel: 'Openreach',
    technology: 'ADSL2+',
    status: stopSell ? 'not_available' : 'available',
    speeds: { downMbpsHigh: adslSpeed(m.loopMetres), upMbpsHigh: 1, basis: 'modelled' },
    productName: 'ADSL2+ (IPStream / WBC)',
    notes: stopSell ? ['Blocked by All-IP stop sell.'] : ['Legacy product — only where no fibre path exists.'],
    source: 'fixture:openreach',
  });

  // Alt-nets and cable used to be invented here. They now come from a
  // separate provider chain, because footprint coverage and wholesale
  // availability are different facts from different sources — and because a
  // fabricated "Community Fibre: available" row is the one thing in this
  // fixture nobody could ever replace with the truth.

  // ---- Fixed wireless fallback for poorly served premises -------------
  if (m.maturity === 'no-plan' && !m.fttcEnabled) {
    push({
      operator: 'other',
      operatorLabel: 'Fixed wireless (4G/5G)',
      technology: '4G/5G Fixed Wireless',
      status: 'available',
      speeds: { downMbpsLow: 20, downMbpsHigh: 150, upMbpsHigh: 30, basis: 'modelled' },
      productName: '4G/5G fixed wireless access',
      notes: ['Recommended where no fixed path exists — check the mobile signal panel first.'],
      source: 'fixture:fwa',
    });
  }

  return offers.sort(
    (a, b) => statusRank(b.status) - statusRank(a.status) || technologyRank(b.technology) - technologyRank(a.technology),
  );
}

/** Picks the offer that should headline the summary strip. */
export function headlineOf(offers: BroadbandOffer[]): BroadbandAvailability['headline'] {
  const best = offers
    .filter((o) => o.status === 'available')
    .sort((a, b) => {
      const t = technologyRank(b.technology) - technologyRank(a.technology);
      if (t !== 0) return t;
      return (b.speeds.downMbpsHigh ?? 0) - (a.speeds.downMbpsHigh ?? 0);
    })[0];
  if (!best) return undefined;
  return {
    technology: best.technology as AccessTechnology,
    ...(best.speeds.downMbpsHigh != null ? { downMbps: best.speeds.downMbpsHigh } : {}),
    ...(best.speeds.upMbpsHigh != null ? { upMbps: best.speeds.upMbpsHigh } : {}),
    operatorLabel: best.operatorLabel,
  };
}

export function buildFixtureAvailability(address: AddressRecord): BroadbandAvailability {
  const seed = address.uprn ?? address.singleLine;
  const rng = new Seeded(`avail:${seed}`);
  const model = buildModel(rng, address);
  const openreach = buildOpenreach(rng, address, model);
  const offers = buildOffers(rng, address, model, openreach);
  return {
    ...(address.uprn ? { uprn: address.uprn } : {}),
    address,
    offers,
    openreach,
    headline: headlineOf(offers),
    // Shaped like Zen's own reference so nothing downstream has to special-case
    // demo mode, and obviously a demo value to anyone reading it.
    availabilityReference: `DEMO-AV-${rng.digits(10)}`,
    checkedAt: new Date().toISOString(),
    sources: ['fixture:openreach'],
  };
}

export function createFixtureAvailabilityProvider(): AvailabilityProvider {
  return {
    name: 'fixture-availability',
    label: 'Demo availability data',
    configured: true,
    mode: 'mock',
    async forAddress(address) {
      return buildFixtureAvailability(address);
    },
  };
}

export const __testing = { vdslSpeeds, adslSpeed, attenuationFor };
