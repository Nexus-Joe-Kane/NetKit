import type { NetworkDevice } from './types';

/**
 * What a piece of UniFi kit actually is, and what can be done to it.
 *
 * The console reports a model code and a name and leaves the rest to the
 * reader. That is fine on their dashboard, where the icons do the work, and
 * not fine on a list where somebody has to decide whether restarting this
 * particular box takes the whole office off.
 *
 * Which is the point of the classification: a gateway restart is an outage
 * and an access point restart is thirty seconds of one room reconnecting.
 * They should not look the same or be one click apart.
 */

export type DeviceKind =
  | 'gateway'
  | 'switch'
  | 'access-point'
  | 'camera'
  | 'nvr'
  | 'phone'
  | 'door-access'
  | 'other';

/**
 * Model prefixes, matched at the start of a token.
 *
 * Two naming conventions have to be handled, which is what makes this
 * fiddlier than it looks. The console's `shortModel` is concatenated with no
 * separators — `UDMPROSE`, `UXGPRO` — while `model` is hyphenated:
 * `USW-Pro-Max-24-PoE`, `U6-Enterprise-IW`. So the family code is anchored
 * at the start of a token and *not* closed with a boundary, or `UDMPROSE`
 * never matches `udm`.
 *
 * The order matters and is not alphabetical. Cameras are tested before
 * switches because `UVC-G3-Flex` is a camera and `USW-Flex-Mini` is a
 * switch, and a pattern loose enough to catch one catches the other. Longer,
 * more specific families come first throughout for the same reason.
 */
const PATTERNS: ReadonlyArray<{ kind: DeviceKind; test: RegExp }> = [
  // Recorders first: `UNVR` starts with `un`, and nothing else does.
  { kind: 'nvr', test: /(^|[^a-z0-9])(unvr|ucknvr|uck|cloudkey|unas)/i },
  // Cameras before switches, for the Flex collision above.
  { kind: 'camera', test: /(^|[^a-z0-9])(uvc|g[0-9]|ai-?(pro|theta|360|dsm|bullet|turret|port))/i },
  { kind: 'door-access', test: /(^|[^a-z0-9])(ua-?(hub|pro|lite|g2|ultra|sk)|uad)/i },
  { kind: 'phone', test: /(^|[^a-z0-9])(uvp|ufp)/i },
  { kind: 'gateway', test: /(^|[^a-z0-9])(udm|uxg|usg|ucg|uxr|udw)/i },
  { kind: 'switch', test: /(^|[^a-z0-9])(usw|usl|us-?[0-9])/i },
  { kind: 'access-point', test: /(^|[^a-z0-9])(uap|u[67]|uwb|udb|e7)/i },
];

/*
 * `name` is absent from the signature on purpose, not by omission. The
 * function must not read it — a box somebody called "Reception Switch" may
 * be an access point on a shelf behind reception — and a type that cannot
 * see the name cannot be quietly changed to use it.
 */
export function deviceKind(
  device: Partial<Pick<NetworkDevice, 'model' | 'shortModel' | 'productLine' | 'isConsole'>>,
): DeviceKind {
  // The console says so outright for a gateway, which beats any pattern.
  if (device.isConsole) return 'gateway';

  const haystack = `${device.shortModel ?? ''} ${device.model ?? ''}`;
  for (const { kind, test } of PATTERNS) {
    if (test.test(haystack)) return kind;
  }

  // The product line is a weaker signal but a real one: `protect` is cameras
  // whatever the model code looks like.
  if (device.productLine === 'protect') return 'camera';
  if (device.productLine === 'access') return 'door-access';

  // Deliberately not guessed from the *name*. A device somebody called
  // "Reception Switch" might be an access point on a shelf behind reception,
  // and a wrong classification here changes which buttons appear.
  return 'other';
}

const KIND_LABEL: Record<DeviceKind, string> = {
  gateway: 'Gateway',
  switch: 'Switch',
  'access-point': 'Access point',
  camera: 'Camera',
  nvr: 'Recorder',
  phone: 'Phone',
  'door-access': 'Door access',
  other: 'Device',
};

export const deviceKindLabel = (kind: DeviceKind): string => KIND_LABEL[kind];

/**
 * A two-letter mark for the kind, so a list reads at a glance.
 *
 * Letters rather than an icon font: no extra request, no missing glyph, and
 * it survives a copy-paste into a ticket.
 */
const KIND_MARK: Record<DeviceKind, string> = {
  gateway: 'GW',
  switch: 'SW',
  'access-point': 'AP',
  camera: 'CAM',
  nvr: 'NVR',
  phone: 'TEL',
  'door-access': 'DR',
  other: '··',
};

export const deviceKindMark = (kind: DeviceKind): string => KIND_MARK[kind];

/**
 * How bad restarting this is.
 *
 * The whole reason the kinds exist. A gateway takes the site off; a switch
 * takes everything plugged into it off, including the access points; an
 * access point drops the clients on it and nothing else.
 */
export type RestartImpact = 'site' | 'segment' | 'local' | 'unknown';

export function restartImpact(kind: DeviceKind): { impact: RestartImpact; warning: string } {
  switch (kind) {
    case 'gateway':
      return {
        impact: 'site',
        warning:
          'Restarting the gateway takes the whole site off for a minute or two — every device, every phone, ' +
          'every till. Do not do this while the site is trading unless the alternative is worse.',
      };
    case 'switch':
      return {
        impact: 'segment',
        warning:
          'Everything plugged into this switch goes with it, access points included, so the Wi-Fi in that part ' +
          'of the building drops too.',
      };
    case 'nvr':
      return {
        impact: 'segment',
        warning: 'Recording stops while it comes back. Anything being watched live goes with it.',
      };
    case 'access-point':
      return {
        impact: 'local',
        warning: 'Clients on this access point reconnect, usually within thirty seconds. Wired kit is unaffected.',
      };
    case 'camera':
    case 'phone':
    case 'door-access':
      return { impact: 'local', warning: 'Only this device goes. It comes back on its own.' };
    default:
      return {
        impact: 'unknown',
        warning:
          'We could not work out what this device is, so we cannot say what restarting it affects. Check the ' +
          'console before you press it.',
      };
  }
}

/** Restarts that need somebody to think first. */
export const needsExtraCare = (kind: DeviceKind): boolean =>
  restartImpact(kind).impact === 'site' || restartImpact(kind).impact === 'unknown';

/* ------------------------------------------------------------------ *
 * Connected clients
 * ------------------------------------------------------------------ */

/**
 * One thing connected to the network.
 *
 * `via` is the useful field and the one the console makes you click three
 * times for: which access point or which switch port. An engineer on the
 * phone to somebody whose till has dropped wants to know it is on port 14 of
 * the back-office switch, not that it exists.
 */
export interface NetworkClient {
  id: string;
  name?: string;
  hostname?: string;
  mac?: string;
  ip?: string;
  /** Resolved from the MAC prefix where we recognise it. */
  vendor?: string;
  connection: 'wired' | 'wireless' | 'unknown';
  /** The access point or switch it is attached to. */
  via?: { deviceId?: string; deviceName?: string; port?: number; ssid?: string; band?: string };
  /** Seconds since it connected, where the console reports it. */
  uptimeSeconds?: number;
  signalDbm?: number;
  txRateMbps?: number;
  rxRateMbps?: number;
  guest?: boolean;
  blocked?: boolean;
  lastSeenAt?: string;
}

/**
 * Who made a device, from the first three bytes of its MAC.
 *
 * A short table, not the full IEEE registry — that is 34,000 rows and 3MB,
 * and shipping it to a browser to label a list of twelve devices is not a
 * trade worth making. These are the prefixes that actually turn up on a
 * customer site: the kit we install, the tills, the phones, the printers.
 *
 * An unrecognised prefix returns nothing rather than a guess, and the UI
 * shows the MAC, which is what somebody would look up anyway.
 */
const OUI: Record<string, string> = {
  // Ubiquiti
  '245a4c': 'Ubiquiti', '802aa8': 'Ubiquiti', '68d79a': 'Ubiquiti', 'fcecda': 'Ubiquiti',
  '74acb9': 'Ubiquiti', '9c05d6': 'Ubiquiti', 'e063da': 'Ubiquiti', '788a20': 'Ubiquiti',
  '18e829': 'Ubiquiti', '44d9e7': 'Ubiquiti', '687251': 'Ubiquiti', 'd021f9': 'Ubiquiti',
  // Apple
  'ac87a3': 'Apple', 'f0dbf8': 'Apple', '3c0754': 'Apple', 'a4d18c': 'Apple',
  '9c8dd3': 'Apple', 'dca904': 'Apple', '040cce': 'Apple', '8866a5': 'Apple',
  // Samsung
  '0021d1': 'Samsung', '3423ba': 'Samsung', '8425db': 'Samsung', 'e8508b': 'Samsung',
  // Microsoft / Surface
  '0017fa': 'Microsoft', '2816a8': 'Microsoft', '7c1e52': 'Microsoft',
  // Dell / HP / Lenovo
  'b8ac6f': 'Dell', '00188b': 'Dell', 'd4be d9': 'Dell',
  '3822d6': 'HP', '9457a5': 'HP', '3ca82a': 'HP',
  '00059a': 'Lenovo', '54ee75': 'Lenovo',
  // Printers
  '002481': 'Brother', '3c2af4': 'Brother', '0080a3': 'Lantronix',
  '00000e': 'Fujitsu', '0000aa': 'Xerox', '9c934e': 'Xerox',
  // Tills and payment
  '000b2f': 'Verifone', '001b32': 'Ingenico', 'd8b190': 'Zebra',
  // Phones
  '0004f2': 'Poly', '00907a': 'Polycom', '000e08': 'Cisco', '001f9d': 'Cisco',
  '805ec0': 'Yealink', '249ad8': 'Yealink',
  // Streaming and telly, which is usually what the guest network is doing
  'd0035c': 'Roku', 'b827eb': 'Raspberry Pi', 'dca632': 'Raspberry Pi',
  '2c3ae8': 'Espressif', '3c71bf': 'Espressif',
  // Sonos, Hikvision, Axis — the ones that turn up and confuse people
  '5cae7c': 'Sonos', '347e5c': 'Sonos',
  'bcad28': 'Hikvision', 'c05b28': 'Hikvision',
  'accc8e': 'Axis', '00408c': 'Axis',
};

/** The vendor for a MAC, or nothing. Never a guess. */
export function vendorForMac(mac: string | undefined): string | undefined {
  if (!mac) return undefined;
  const prefix = mac.replace(/[^0-9a-f]/gi, '').slice(0, 6).toLowerCase();
  if (prefix.length < 6) return undefined;
  return OUI[prefix];
}

/**
 * A mark for a client, from what we can tell about it.
 *
 * The vendor's initials where we know them, otherwise the connection type,
 * so every row has something rather than a ragged column of blanks.
 */
export function clientMark(client: Pick<NetworkClient, 'vendor' | 'connection'>): string {
  if (client.vendor) {
    const words = client.vendor.split(/\s+/);
    if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
    return client.vendor.slice(0, 2).toUpperCase();
  }
  return client.connection === 'wired' ? 'LAN' : client.connection === 'wireless' ? 'WiFi' : '··';
}

/**
 * Where a client is plugged in, as one line.
 *
 * The answer to "where is this thing" in the words somebody would use on the
 * phone. Port numbers matter: "port 14 of the back-office switch" ends a
 * conversation that "it is on the network" does not.
 */
export function clientLocation(client: NetworkClient): string {
  const via = client.via;
  if (!via) return client.connection === 'wired' ? 'Wired, device not reported' : 'Wireless, access point not reported';

  if (client.connection === 'wired') {
    const where = via.deviceName ?? 'a switch';
    return via.port !== undefined ? `Port ${via.port} of ${where}` : `Wired to ${where}`;
  }

  const parts = [via.deviceName ?? 'an access point'];
  if (via.ssid) parts.push(`on ${via.ssid}`);
  if (via.band) parts.push(`(${via.band})`);
  return parts.join(' ');
}

/** Wired first, then by where they are, so the list groups itself. */
export function sortClients(clients: readonly NetworkClient[]): NetworkClient[] {
  const rank = (c: NetworkClient): number => (c.connection === 'wired' ? 0 : c.connection === 'wireless' ? 1 : 2);
  return [...clients].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.via?.deviceName ?? '').localeCompare(b.via?.deviceName ?? '') ||
      (a.via?.port ?? 0) - (b.via?.port ?? 0) ||
      (a.name ?? a.hostname ?? a.mac ?? '').localeCompare(b.name ?? b.hostname ?? b.mac ?? ''),
  );
}
