import { sortClients, vendorForMac, type NetworkClient } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * What is connected to a customer's network.
 *
 * Read through Ubiquiti's Connector Proxy, which is the only way to reach a
 * console's own API from a server that is not on the customer's LAN. The
 * Site Manager API knows sites and devices; it does not know clients.
 *
 * The field worth the whole file is `via`: which access point, or which
 * switch port. It is three clicks deep in the console and it is the answer
 * to the only question anybody asks — an engineer on the phone to somebody
 * whose till has dropped wants "port 14 of the back-office switch", not a
 * confirmation that the till exists.
 *
 * Read tolerantly, because Ubiquiti document the client shape less than they
 * document anything else: names vary between firmware versions and between
 * the wired and wireless halves of the same payload.
 */

const clientCache = new TtlCache<NetworkClient[]>(60 * 1000, 200);

export const unifiClientsConfigured = (): boolean => Boolean(config().unifi.integrationKey);

export function clearUnifiClientCache(): void {
  clientCache.clear();
}

const PROXY = 'https://api.ui.com/v1/connector/consoles';

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Reads whichever of several names a firmware version happens to use. */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== '') return row[name];
  }
  return undefined;
}

/**
 * One client, from whatever the console sent.
 *
 * The connection type is decided from evidence rather than defaulted:
 * an SSID or a signal reading means wireless, a switch port means wired, and
 * neither means `unknown`. Defaulting to wired would file every phone in the
 * building under a switch nobody can find.
 */
export function toClient(raw: unknown, devices: Map<string, string>): NetworkClient | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const id = text(pick(row, 'id', '_id', 'mac')) ?? undefined;
  const mac = text(pick(row, 'macAddress', 'mac'));
  if (!id && !mac) return null;

  const ssid = text(pick(row, 'ssid', 'essid', 'wifiNetwork'));
  const signal = num(pick(row, 'signal', 'rssi', 'signalStrength'));
  const port = num(pick(row, 'switchPort', 'swPort', 'port', 'portIdx'));
  const uplinkId = text(pick(row, 'uplinkDeviceId', 'apMac', 'swMac', 'uplinkMac', 'accessPointId'));

  const connection: NetworkClient['connection'] =
    ssid !== undefined || signal !== undefined
      ? 'wireless'
      : port !== undefined
        ? 'wired'
        : (text(pick(row, 'type', 'connectionType')) ?? '').toLowerCase().startsWith('wired')
          ? 'wired'
          : (text(pick(row, 'type', 'connectionType')) ?? '').toLowerCase().startsWith('wireless')
            ? 'wireless'
            : 'unknown';

  const via: NonNullable<NetworkClient['via']> = {
    ...(uplinkId ? { deviceId: uplinkId } : {}),
    ...(uplinkId && devices.get(uplinkId.toLowerCase()) ? { deviceName: devices.get(uplinkId.toLowerCase())! } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(ssid ? { ssid } : {}),
    ...(text(pick(row, 'band', 'radioBand', 'radio')) ? { band: text(pick(row, 'band', 'radioBand', 'radio'))! } : {}),
  };

  const vendor = vendorForMac(mac);

  return {
    id: id ?? mac!,
    ...(text(pick(row, 'name', 'displayName', 'alias')) ? { name: text(pick(row, 'name', 'displayName', 'alias'))! } : {}),
    ...(text(pick(row, 'hostname', 'host')) ? { hostname: text(pick(row, 'hostname', 'host'))! } : {}),
    ...(mac ? { mac } : {}),
    ...(text(pick(row, 'ipAddress', 'ip', 'lastIp')) ? { ip: text(pick(row, 'ipAddress', 'ip', 'lastIp'))! } : {}),
    ...(vendor ? { vendor } : {}),
    connection,
    ...(Object.keys(via).length ? { via } : {}),
    ...(num(pick(row, 'uptime', 'uptimeSeconds', 'connectedFor')) !== undefined
      ? { uptimeSeconds: num(pick(row, 'uptime', 'uptimeSeconds', 'connectedFor'))! }
      : {}),
    ...(signal !== undefined ? { signalDbm: signal } : {}),
    ...(num(pick(row, 'txRate', 'txRateMbps')) !== undefined ? { txRateMbps: num(pick(row, 'txRate', 'txRateMbps'))! } : {}),
    ...(num(pick(row, 'rxRate', 'rxRateMbps')) !== undefined ? { rxRateMbps: num(pick(row, 'rxRate', 'rxRateMbps'))! } : {}),
    ...(pick(row, 'isGuest', 'guest') === true ? { guest: true } : {}),
    ...(pick(row, 'blocked', 'isBlocked') === true ? { blocked: true } : {}),
    ...(text(pick(row, 'lastSeen', 'lastSeenAt')) ? { lastSeenAt: text(pick(row, 'lastSeen', 'lastSeenAt'))! } : {}),
  };
}

/**
 * The clients on one site.
 *
 * `devices` maps a device id or MAC to its name, so `via` can say "Back
 * Office Switch" rather than a MAC address. Built by the caller, which
 * already has the device list.
 */
export async function clientsForSite(input: {
  consoleId: string;
  siteId: string;
  devices?: Map<string, string>;
}): Promise<{ clients: NetworkClient[]; error?: string }> {
  const cfg = config();
  if (!cfg.unifi.integrationKey) {
    return {
      clients: [],
      error:
        'No UniFi Network Integration key is set, so the client list cannot be read. It is a different key ' +
        'from the Site Manager one: UniFi Network → Settings → Control Plane → Integrations.',
    };
  }

  const key = `${input.consoleId}:${input.siteId}`;
  try {
    const clients = await clientCache.wrap(key, async () => {
      const url =
        `${PROXY}/${encodeURIComponent(input.consoleId)}/proxy/network/integration/v1` +
        `/sites/${encodeURIComponent(input.siteId)}/clients?limit=200`;

      const body = await fetchJson<{ data?: unknown[] } | unknown[]>(url, {
        label: 'UniFi Network',
        headers: { 'X-API-KEY': cfg.unifi.integrationKey, Accept: 'application/json' },
        timeoutMs: Math.min(cfg.requestTimeoutMs, 15_000),
        retries: 1,
        notFoundAsNull: true,
      });

      const rows = Array.isArray(body) ? body : (body?.data ?? []);
      const named = input.devices ?? new Map<string, string>();
      const out: NetworkClient[] = [];
      for (const row of rows) {
        const client = toClient(row, named);
        if (client) out.push(client);
      }
      return sortClients(out);
    });
    return { clients };
  } catch (err) {
    // A missing client list is not a reason to fail the page: the device
    // list and the WAN figures are worth having on their own.
    return { clients: [], error: err instanceof Error ? err.message : String(err) };
  }
}
