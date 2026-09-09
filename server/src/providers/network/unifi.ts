import type { NetworkDevice, NetworkSite, WanHealth } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * UniFi Site Manager — what the network says, as opposed to what the
 * documentation says.
 *
 * Site Manager rather than a local controller. One key reaches every site on
 * the account, where a controller is one site and a hole in somebody's
 * firewall. The key is read-only, which suits a tool that has no business
 * changing a customer's network.
 *
 * Three things about this API shape the code below, and all three are from
 * Ubiquiti's own spec rather than inference.
 *
 * Everything is wrapped: `{ data, httpStatusCode, traceId, nextToken }`.
 * Pagination is a cursor — pass the previous `nextToken` back, and an absent
 * or empty one means the end.
 *
 * `meta` and `statistics` on a site, and `userData` on a host, have no
 * per-field schema and are documented as varying by UniFi OS version. So
 * they are read defensively: every field optional, nothing assumed, and the
 * absence of one is not an error.
 *
 * And devices are keyed to a *host*, not a site — there is no site id on a
 * device record. A site carries its host id, so a site's equipment is that
 * host's equipment. Where one console serves several sites that is an
 * over-count rather than a wrong answer, and the UI says which host the
 * list came from so it can be told apart.
 */

interface Envelope<T> {
  data?: T;
  httpStatusCode?: number;
  traceId?: string;
  nextToken?: string;
}

interface RawSite {
  siteId?: string;
  hostId?: string;
  permission?: string;
  isOwner?: boolean;
  meta?: { name?: string; desc?: string; gatewayMac?: string; timezone?: string };
  statistics?: {
    counts?: Record<string, number | undefined>;
    gateway?: { shortname?: string };
    ispInfo?: { name?: string; organization?: string };
    percentages?: { wanUptime?: number };
    internetIssues?: unknown[];
  };
}

interface RawDevice {
  id?: string;
  mac?: string;
  name?: string;
  model?: string;
  shortname?: string;
  ip?: string;
  productLine?: string;
  status?: string;
  version?: string;
  firmwareStatus?: string;
  updateAvailable?: string | null;
  isConsole?: boolean;
  isManaged?: boolean;
  startupTime?: string | null;
  adoptionTime?: string | null;
  note?: string | null;
}

interface RawDeviceGroup {
  hostId?: string;
  hostName?: string;
  devices?: RawDevice[];
  updatedAt?: string;
}

interface RawWanMetrics {
  uptime?: number;
  downtime?: number;
  avgLatency?: number;
  maxLatency?: number;
  packetLoss?: number;
  download_kbps?: number;
  upload_kbps?: number;
  ispName?: string;
  /** Only where the feed identifies which uplink this is. */
  id?: string;
  wanId?: string;
  interface?: string;
  ipAddress?: string;
  publicIp?: string;
}

interface RawMetricPeriod {
  metricTime?: string;
  data?: {
    /** One aggregate for the site, which is what the feed gives today. */
    wan?: RawWanMetrics;
    /**
     * Per-uplink metrics, read tolerantly.
     *
     * Ubiquiti document neither of these, and today's payload carries only
     * the aggregate above. But a site with two uplinks and one set of
     * numbers must be shown as one row rather than as WAN 1 -- so the moment
     * the feed does break them out, this reads it, and until then nothing
     * invents a split. Costs nothing to have here and saves fabricating.
     */
    wans?: RawWanMetrics[];
    uplinks?: RawWanMetrics[];
    wan2?: RawWanMetrics;
  };
}

interface RawMetricSite {
  metricType?: string;
  hostId?: string;
  siteId?: string;
  periods?: RawMetricPeriod[];
}

/** Site Manager caps a page at 500 and allows 10,000 requests a minute. */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

const siteCache = new TtlCache<NetworkSite[]>(5 * 60 * 1000, 20);
const deviceCache = new TtlCache<NetworkDevice[]>(2 * 60 * 1000, 200);
const wanCache = new TtlCache<WanHealth | null>(5 * 60 * 1000, 200);

export const unifiConfigured = (): boolean => config().unifi.configured;

export function clearUnifiCache(): void {
  siteCache.clear();
  deviceCache.clear();
  wanCache.clear();
}

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

async function call<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<Envelope<T> | null> {
  const cfg = config();
  return fetchJson<Envelope<T>>(`${cfg.unifi.baseUrl}${path}`, {
    label: 'UniFi Site Manager',
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
    headers: { 'X-API-Key': cfg.unifi.apiKey, Accept: 'application/json' },
    timeoutMs: Math.min(cfg.requestTimeoutMs, 10_000),
    retries: 1,
    notFoundAsNull: true,
  });
}

/** Follows `nextToken` until it comes back empty. */
async function pages<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const joiner = path.includes('?') ? '&' : '?';
    const query = `${path}${joiner}pageSize=${PAGE_SIZE}${token ? `&nextToken=${encodeURIComponent(token)}` : ''}`;
    const body = await call<T[]>(query);
    const batch = Array.isArray(body?.data) ? body!.data! : [];
    out.push(...batch);
    // Documented end condition: absent or empty.
    token = text(body?.nextToken);
    if (!token) break;
  }
  return out;
}

function toSite(raw: RawSite): NetworkSite | null {
  const siteId = text(raw.siteId);
  const hostId = text(raw.hostId);
  if (!siteId || !hostId) return null;

  const counts = raw.statistics?.counts ?? {};
  const issues = raw.statistics?.internetIssues;

  return {
    siteId,
    hostId,
    // `meta.desc` is the friendlier of the two ("Default" against
    // "default"), so it leads where it exists.
    name: text(raw.meta?.desc) ?? text(raw.meta?.name) ?? siteId,
    ...(text(raw.meta?.name) ? { description: text(raw.meta?.name)! } : {}),
    ...(text(raw.meta?.gatewayMac) ? { gatewayMac: text(raw.meta?.gatewayMac)! } : {}),
    ...(text(raw.meta?.timezone) ? { timezone: text(raw.meta?.timezone)! } : {}),
    ...(text(raw.permission) ? { permission: text(raw.permission)! } : {}),
    counts: {
      ...(num(counts.totalDevice) !== undefined ? { totalDevices: num(counts.totalDevice)! } : {}),
      ...(num(counts.offlineDevice) !== undefined ? { offlineDevices: num(counts.offlineDevice)! } : {}),
      ...(num(counts.wiredClient) !== undefined ? { wiredClients: num(counts.wiredClient)! } : {}),
      ...(num(counts.wifiClient) !== undefined ? { wifiClients: num(counts.wifiClient)! } : {}),
      ...(num(counts.guestClient) !== undefined ? { guestClients: num(counts.guestClient)! } : {}),
      ...(num(counts.criticalNotification) !== undefined
        ? { criticalNotifications: num(counts.criticalNotification)! }
        : {}),
      ...(num(counts.pendingUpdateDevice) !== undefined ? { pendingUpdates: num(counts.pendingUpdateDevice)! } : {}),
      ...(num(counts.wanConfiguration) !== undefined ? { wanConfigurations: num(counts.wanConfiguration)! } : {}),
    },
    ...(raw.statistics?.ispInfo
      ? {
          isp: {
            ...(text(raw.statistics.ispInfo.name) ? { name: text(raw.statistics.ispInfo.name)! } : {}),
            ...(text(raw.statistics.ispInfo.organization)
              ? { organisation: text(raw.statistics.ispInfo.organization)! }
              : {}),
          },
        }
      : {}),
    ...(text(raw.statistics?.gateway?.shortname) ? { gateway: { model: text(raw.statistics?.gateway?.shortname)! } } : {}),
    ...(num(raw.statistics?.percentages?.wanUptime) !== undefined
      ? { wanUptimePercent: num(raw.statistics?.percentages?.wanUptime)! }
      : {}),
    // The element shape of internetIssues is undocumented and empty in every
    // published example, so only its emptiness is read.
    ...(Array.isArray(issues) ? { internetIssues: issues.length > 0 } : {}),
  };
}

function toDevice(raw: RawDevice): NetworkDevice | null {
  const id = text(raw.id) ?? text(raw.mac);
  if (!id) return null;
  return {
    id,
    name: text(raw.name) ?? text(raw.model) ?? id,
    ...(text(raw.model) ? { model: text(raw.model)! } : {}),
    ...(text(raw.shortname) ? { shortModel: text(raw.shortname)! } : {}),
    ...(text(raw.mac) ? { mac: text(raw.mac)! } : {}),
    ...(text(raw.ip) ? { ip: text(raw.ip)! } : {}),
    ...(text(raw.productLine) ? { productLine: text(raw.productLine)! } : {}),
    ...(text(raw.status) ? { status: text(raw.status)! } : {}),
    ...(text(raw.version) ? { firmware: text(raw.version)! } : {}),
    ...(text(raw.firmwareStatus) ? { firmwareStatus: text(raw.firmwareStatus)! } : {}),
    ...(text(raw.updateAvailable) ? { updateAvailable: text(raw.updateAvailable)! } : {}),
    ...(raw.isConsole === true ? { isConsole: true } : {}),
    ...(raw.isManaged === true ? { isManaged: true } : {}),
    ...(text(raw.startupTime) ? { startedAt: text(raw.startupTime)! } : {}),
    ...(text(raw.adoptionTime) ? { adoptedAt: text(raw.adoptionTime)! } : {}),
    ...(text(raw.note) ? { note: text(raw.note)! } : {}),
  };
}

/** Every site on the account. Cached: the list changes rarely. */
export async function networkSites(): Promise<NetworkSite[]> {
  if (!unifiConfigured()) return [];
  return siteCache.wrap('sites', async () => {
    const raw = await pages<RawSite>('/v1/sites');
    return raw.map(toSite).filter((s): s is NetworkSite => s !== null);
  });
}

/**
 * The devices on one console.
 *
 * Filtered server-side with `hostIds[]`, so a customer with one console does
 * not pay for the whole estate.
 */
export async function devicesForHost(hostId: string): Promise<NetworkDevice[]> {
  if (!unifiConfigured() || !hostId) return [];
  return deviceCache.wrap(`host:${hostId}`, async () => {
    const groups = await pages<RawDeviceGroup>(`/v1/devices?hostIds[]=${encodeURIComponent(hostId)}`);
    const devices: NetworkDevice[] = [];
    for (const group of groups) {
      if (text(group.hostId) && text(group.hostId) !== hostId) continue;
      for (const raw of group.devices ?? []) {
        const device = toDevice(raw);
        if (device) devices.push(device);
      }
    }
    return devices;
  });
}

/**
 * WAN health for one site over the last day.
 *
 * There is no per-site WAN status endpoint — Ubiquiti publish none — so this
 * is the honest substitute: the ISP metrics feed, five-minute samples over
 * twenty-four hours, which answers "has the internet here been up" rather
 * than "is the interface up right now".
 *
 * Queried per site rather than pulling the whole account, because the
 * account-wide variant returns every site and this is called about one.
 */
export async function wanHealth(hostId: string, siteId: string): Promise<WanHealth | null> {
  if (!unifiConfigured() || !hostId || !siteId) return null;

  return wanCache.wrap(`wan:${siteId}`, async () => {
    const body = await call<{ metrics?: RawMetricSite[]; status?: string; message?: string }>(
      '/v1/isp-metrics/5m/query',
      { method: 'POST', body: { sites: [{ hostId, siteId }] } },
    );

    // This endpoint wraps its array in an object, unlike its GET sibling.
    const metrics = body?.data?.metrics ?? [];
    const mine = metrics.find((m) => text(m.siteId) === siteId) ?? metrics[0];
    if (!mine) return null;

    const periods = [...(mine.periods ?? [])].sort((a, b) =>
      (text(a.metricTime) ?? '').localeCompare(text(b.metricTime) ?? ''),
    );
    if (!periods.length) return null;

    const last = periods[periods.length - 1]!;
    const wan = last.data?.wan ?? {};
    const downtimeSeconds = periods.reduce((total, p) => total + (num(p.data?.wan?.downtime) ?? 0), 0);

    // Per-uplink figures if the feed gives any, under whichever of the three
    // plausible keys. Nothing is synthesised when it does not.
    const rawUplinks: RawWanMetrics[] =
      last.data?.wans ?? last.data?.uplinks ?? (last.data?.wan2 ? [wan, last.data.wan2] : []);

    const uplinks = rawUplinks
      .map((raw, i) => ({
        id: text(raw.id) ?? text(raw.wanId) ?? text(raw.interface) ?? `wan${i + 1}`,
        ...(text(raw.ispName) ? { ispName: text(raw.ispName)! } : {}),
        ...(text(raw.publicIp) ?? text(raw.ipAddress)
          ? { publicIp: (text(raw.publicIp) ?? text(raw.ipAddress))! }
          : {}),
        ...(num(raw.uptime) !== undefined ? { uptimePercent: num(raw.uptime)! } : {}),
        ...(num(raw.downtime) !== undefined ? { downtimeSeconds: num(raw.downtime)! } : {}),
        ...(num(raw.avgLatency) !== undefined ? { averageLatencyMs: num(raw.avgLatency)! } : {}),
        ...(num(raw.maxLatency) !== undefined ? { maxLatencyMs: num(raw.maxLatency)! } : {}),
        ...(num(raw.packetLoss) !== undefined ? { packetLossPercent: num(raw.packetLoss)! } : {}),
        ...(num(raw.download_kbps) !== undefined ? { downloadKbps: num(raw.download_kbps)! } : {}),
        ...(num(raw.upload_kbps) !== undefined ? { uploadKbps: num(raw.upload_kbps)! } : {}),
        ...(text(last.metricTime) ? { at: text(last.metricTime)! } : {}),
      }))
      // A row with a name and no numbers is worse than no row.
      .filter((u) => u.ispName || u.uptimePercent !== undefined || u.averageLatencyMs !== undefined);

    return {
      siteId,
      interval: text(mine.metricType) ?? '5m',
      latest: {
        ...(text(last.metricTime) ? { at: text(last.metricTime)! } : {}),
        ...(num(wan.uptime) !== undefined ? { uptimePercent: num(wan.uptime)! } : {}),
        ...(num(wan.downtime) !== undefined ? { downtimeSeconds: num(wan.downtime)! } : {}),
        ...(num(wan.avgLatency) !== undefined ? { averageLatencyMs: num(wan.avgLatency)! } : {}),
        ...(num(wan.maxLatency) !== undefined ? { maxLatencyMs: num(wan.maxLatency)! } : {}),
        ...(num(wan.packetLoss) !== undefined ? { packetLossPercent: num(wan.packetLoss)! } : {}),
        ...(num(wan.download_kbps) !== undefined ? { downloadKbps: num(wan.download_kbps)! } : {}),
        ...(num(wan.upload_kbps) !== undefined ? { uploadKbps: num(wan.upload_kbps)! } : {}),
        ...(text(wan.ispName) ? { ispName: text(wan.ispName)! } : {}),
      },
      samples: periods.map((p) => ({
        ...(text(p.metricTime) ? { at: text(p.metricTime)! } : {}),
        ...(num(p.data?.wan?.uptime) !== undefined ? { uptimePercent: num(p.data?.wan?.uptime)! } : {}),
        ...(num(p.data?.wan?.avgLatency) !== undefined ? { averageLatencyMs: num(p.data?.wan?.avgLatency)! } : {}),
      })),
      downtimeSeconds,
      ...(uplinks.length > 1 ? { uplinks } : {}),
    };
  });
}

export async function unifiPing(): Promise<{ ok: boolean; detail: string }> {
  if (!unifiConfigured()) return { ok: false, detail: 'UNIFI_API_KEY is not set.' };
  try {
    const body = await call<RawSite[]>('/v1/sites?pageSize=1');
    const rows = Array.isArray(body?.data) ? body!.data! : [];
    if (!rows.length) {
      return {
        ok: true,
        detail:
          'Connected, but the key can see no sites. A Site Manager key only sees sites on its own UI account — ' +
          'check it was made on the account the customers are under.',
      };
    }
    return { ok: true, detail: `Connected. First site: ${text(rows[0]?.meta?.desc) ?? text(rows[0]?.siteId) ?? 'unnamed'}.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Test hook: the tolerant mappers, without the network. */
export const __unifiTesting = { toSite, toDevice };
