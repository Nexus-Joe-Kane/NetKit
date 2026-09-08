import {
  normaliseCli,
  type AccessTechnology,
  type AddressRecord,
  type LineRecord,
  type LineStatus,
} from '@sw/shared';
import { Seeded } from '../../lib/seeded';
import { CPE_MODELS, FAULT_SUMMARIES, ONT_MODELS, ZEN_PRODUCTS, regionFor } from '../../fixtures/uk';
import { fixtureFindByUprn, fixturePremisesFor } from '../address/fixture';
import { buildFixtureAvailability } from '../availability/fixture';
import { DEMO_POSTCODES } from '../../fixtures/uk';
import type { LineProvider } from '../types';

/**
 * Fixture line records.
 *
 * A line is generated *from* the premises it sits at, so its technology
 * agrees with what the availability engine says is available there — an FTTP
 * line never appears at a copper-only address. This is what makes the
 * "look up a CLI and see the whole site" flow hold together.
 */

/** Deterministic CLI for a premises, so a UPRN always yields the same number. */
function cliFor(address: AddressRecord): string {
  const rng = new Seeded(`cli:${address.uprn ?? address.singleLine}`);
  // The dialling code follows the postcode's region, and the ranges used are
  // Ofcom's reserved drama/test ranges so fixture numbers can never collide
  // with a real subscriber's line.
  const area = regionFor(address.postcode).dialCode;
  return `${area}${rng.digits(4)}`.slice(0, 11);
}

function accessIdFor(address: AddressRecord): string {
  return `AL${new Seeded(`alid:${address.uprn ?? address.singleLine}`).digits(9)}`;
}

function serviceIdFor(address: AddressRecord, tech: AccessTechnology): string {
  const rng = new Seeded(`svc:${address.uprn}:${tech}`);
  const prefix = tech === 'FTTP' ? 'BBFB' : tech === 'SOGEA' ? 'BBEU' : 'BBIP';
  return `${prefix}${rng.digits(8)}`;
}

function buildLine(address: AddressRecord, index: number): LineRecord {
  const rng = new Seeded(`line:${address.uprn ?? address.singleLine}:${index}`);
  const availability = buildFixtureAvailability(address);
  const or = availability.openreach;

  // Pick a technology the premises can actually take.
  const fttpLive = or?.fttp?.available ?? false;
  const sogeaLive = or?.copper?.sogeaAvailable ?? false;
  const tech: AccessTechnology = fttpLive
    ? rng.weighted<AccessTechnology>([
        ['FTTP', 7],
        ['SOGEA', 2],
        ['FTTC', 1],
      ])
    : sogeaLive
      ? rng.weighted<AccessTechnology>([
          ['SOGEA', 6],
          ['FTTC', 3],
          ['ADSL2+', 1],
        ])
      : 'ADSL2+';

  const product =
    ZEN_PRODUCTS.filter((p) => p.tech === tech)[0] ??
    ZEN_PRODUCTS.find((p) => p.tech === 'SOGEA') ??
    ZEN_PRODUCTS[ZEN_PRODUCTS.length - 1]!;

  const status = rng.weighted<LineStatus>([
    ['active', 12],
    ['pending_provide', 2],
    ['suspended', 1],
    ['pending_cease', 1],
    ['ceased', 1],
  ]);
  const online = status === 'active' && rng.bool(0.93);

  const cli = cliFor(address);
  const isFibre = tech === 'FTTP';
  const cpe = rng.pick(CPE_MODELS);
  const ont = rng.pick(ONT_MODELS);

  // Sync figures follow the modelled loop for copper, or the product for FTTP.
  const loop = or?.copper?.lineLengthMetres ?? 800;
  const headlineDown = product.down * 1000;
  const syncDown = isFibre
    ? headlineDown
    : Math.round(
        Math.max(2000, Math.min(headlineDown, headlineDown * Math.exp(-0.55 * (loop / 1000)))) * rng.float(0.95, 1.02, 3),
      );
  const syncUp = isFibre ? product.up * 1000 : Math.round(product.up * 1000 * rng.float(0.8, 1.0, 3));

  const hasFault = rng.bool(0.18);
  const hasAppointment = status === 'pending_provide' || rng.bool(0.12);

  const contractStart = rng.dateOffset(-1400, -60);
  const termMonths = rng.pick([12, 18, 24]);
  const endDate = new Date(contractStart);
  endDate.setMonth(endDate.getMonth() + termMonths);
  const inContract = endDate.getTime() > Date.now();

  return {
    id: `line-${address.uprn ?? 'x'}-${index}`,
    cli,
    lineAccessId: accessIdFor(address),
    serviceId: serviceIdFor(address, tech),
    orderRef: `ORD${rng.digits(8)}`,
    status,
    technology: tech,
    provider: 'Zen Internet',
    productName: product.name,
    bearerSpeed: isFibre ? `${product.down} Mbps / ${product.up} Mbps` : `${product.down} Mbps down`,
    address,

    contract: {
      startDate: contractStart,
      endDate: endDate.toISOString().slice(0, 10),
      minimumTermMonths: termMonths,
      inContract,
      ...(inContract ? { earlyTerminationCharge: rng.int(45, 480) } : {}),
    },

    ...(isFibre
      ? {
          ont: {
            serial: or?.fttp?.ontSerial ?? `${ont.prefix}${rng.hex(8)}`,
            model: or?.fttp?.ontType ?? `${ont.vendor} ${ont.model}`,
            portsUsed: 1,
            portsTotal: 4,
          },
        }
      : {}),

    cpe: {
      vendor: cpe.vendor,
      model: cpe.model,
      serial: `S${rng.digits(10)}`,
      macAddress: Array.from({ length: 6 }, () => rng.hex(2)).join(':'),
      firmware: `${rng.int(1, 5)}.${rng.int(0, 20)}.${rng.int(0, 9)}`,
    },

    ipAddresses: [
      {
        family: 'IPv4',
        value: `${rng.int(51, 88)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
        assignment: rng.bool(0.55) ? 'static' : 'dynamic',
        routed: false,
      },
      ...(rng.bool(0.45)
        ? [
            {
              family: 'IPv4' as const,
              value: `${rng.int(51, 88)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(0, 248)}`,
              prefixLength: rng.pick([29, 28]),
              assignment: 'static' as const,
              routed: true,
            },
          ]
        : []),
      {
        family: 'IPv6',
        value: `2a02:${rng.hex(4)}:${rng.hex(4)}::`,
        prefixLength: 56,
        assignment: 'static',
        routed: true,
      },
    ],

    radius: {
      username: `${cli}@zen`,
      realm: 'zen',
      ...(online
        ? {
            lastAuthAt: new Date(Date.now() - rng.int(60, 86_400) * 1000).toISOString(),
            sessionId: rng.hex(16),
            nasIpAddress: `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
            onlineSince: new Date(Date.now() - rng.int(600, 30 * 86_400) * 1000).toISOString(),
            bytesIn: rng.int(1_000_000, 900_000_000_000),
            bytesOut: rng.int(500_000, 120_000_000_000),
          }
        : { lastAuthAt: new Date(Date.now() - rng.int(2, 40) * 86_400_000).toISOString() }),
      online,
    },

    sync: isFibre
      ? {
          downstreamSyncKbps: syncDown,
          upstreamSyncKbps: syncUp,
          profileName: 'GEA-FTTP fixed rate',
          ...(online ? { uptimeSeconds: rng.int(600, 90 * 86_400) } : {}),
        }
      : {
          downstreamSyncKbps: syncDown,
          upstreamSyncKbps: syncUp,
          maxStableDownKbps: Math.round(syncDown * rng.float(1.02, 1.22, 3)),
          maxStableUpKbps: Math.round(syncUp * rng.float(1.02, 1.18, 3)),
          snrMarginDb: rng.float(3, 12, 1),
          attenuationDb: or?.copper?.attenuationDb ?? rng.float(8, 45, 1),
          profileName: rng.pick(['Fastpath', 'Interleaved (Standard)', 'Interleaved (Banded)']),
          interleaving: rng.pick(['Off', 'Low', 'High']),
          retrains24h: rng.weighted([
            [0, 8],
            [rng.int(1, 4), 3],
            [rng.int(10, 60), 1],
          ]),
          lastResync: new Date(Date.now() - rng.int(300, 20 * 86_400) * 1000).toISOString(),
          ...(online ? { uptimeSeconds: rng.int(300, 30 * 86_400) } : {}),
        },

    ...(hasFault
      ? {
          faults: [
            {
              reference: `FLT${rng.digits(8)}`,
              raisedAt: new Date(Date.now() - rng.int(1, 12) * 86_400_000).toISOString(),
              status: rng.pick(['Open — engineer assigned', 'Open — awaiting customer', 'Under investigation', 'Cleared, monitoring']),
              summary: rng.pick(FAULT_SUMMARIES),
              slaTarget: rng.pick(['Care Level 2 — next working day + 1', 'Care Level 3 — next working day', 'Care Level 4 — 6 clock hours']),
              lastUpdate: new Date(Date.now() - rng.int(1, 40) * 3_600_000).toISOString(),
            },
          ],
        }
      : {}),

    ...(hasAppointment
      ? {
          appointments: [
            {
              reference: `APP${rng.digits(7)}`,
              date: rng.dateOffset(1, 21),
              slot: rng.pick(['AM (08:00–13:00)', 'PM (13:00–18:00)', 'All day']),
              type: status === 'pending_provide' ? 'Provide — engineer install' : 'Fault — engineer visit',
              status: rng.pick(['Booked', 'Confirmed', 'Awaiting confirmation']),
            },
          ],
        }
      : {}),

    discoveredVia: 'mock',
    notes:
      status === 'ceased'
        ? ['Line has been ceased — retained for history. Any reprovide will need a new order.']
        : [],
  };
}

/** Lines at a premises. Most premises have one; some have two or none. */
export function buildFixtureLines(address: AddressRecord): LineRecord[] {
  const rng = new Seeded(`lines:${address.uprn ?? address.singleLine}`);
  const count = rng.weighted([
    [1, 7],
    [0, 2],
    [2, 2],
  ]);
  return Array.from({ length: count }, (_, i) => buildLine(address, i));
}

/** Scans the demo estate for a line matching a predicate. */
async function scan(match: (line: LineRecord) => boolean): Promise<LineRecord[]> {
  for (const pc of DEMO_POSTCODES) {
    for (const address of await fixturePremisesFor(pc)) {
      const hits = buildFixtureLines(address).filter(match);
      if (hits.length) return hits;
    }
  }
  return [];
}

export function createFixtureLineProvider(): LineProvider {
  return {
    name: 'fixture-lines',
    label: 'Demo line data',
    configured: true,
    mode: 'mock',

    async byCli(cli) {
      const n = normaliseCli(cli) ?? cli;
      return scan((l) => l.cli === n);
    },

    byAccessId: (id) => scan((l) => l.lineAccessId?.toUpperCase() === id.toUpperCase()),

    byServiceId: (id) => scan((l) => l.serviceId?.toUpperCase() === id.toUpperCase()),

    byOntSerial: (serial) => scan((l) => l.ont?.serial?.toUpperCase() === serial.toUpperCase()),

    async byUprn(uprn) {
      const address = await fixtureFindByUprn(uprn);
      return address ? buildFixtureLines(address) : [];
    },

    async byPostcode(postcode) {
      const out: LineRecord[] = [];
      for (const address of await fixturePremisesFor(postcode)) {
        out.push(...buildFixtureLines(address));
      }
      return out;
    },
  };
}
