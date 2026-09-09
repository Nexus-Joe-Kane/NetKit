import { ispIdentity } from './ispDirectory';
import type { NetworkSite, WanHealth } from './types';

/**
 * Connectivity we can see but do not supply.
 *
 * The Lines section used to be empty for a site whose broadband is somebody
 * else's — which is the least useful moment for it to be empty, because that
 * is exactly when nobody on the desk knows anything about the line. But the
 * console knows: there is a WAN, it has a provider, and it has been up or
 * down in a way we can measure. That is a line, and it belongs in Lines.
 *
 * Labelled honestly. A row built from console telemetry is marked
 * `unmanaged` and never carries a service reference, a supplier order or a
 * fault path, because there is nothing behind those and offering an engineer
 * a "raise a fault" button for a line we cannot raise a fault on wastes the
 * ten minutes when it matters most.
 *
 * The other half is the join in the opposite direction: a line we *do*
 * supply, matched back to the WAN slot it occupies, so "the Zen circuit" and
 * "WAN 2" are known to be the same thing.
 */

/** How a WAN row came to be. */
export type WanManagement = 'managed' | 'unmanaged';

export interface WanLine {
  /** `wan1`, `wan2`, or `wan` where the console does not say which. */
  id: string;
  /** `WAN 1`, or `WAN` for a single uplink. */
  label: string;
  management: WanManagement;
  /** The provider, as the console reports it. */
  providerName: string;
  providerColour: string;
  providerMonogram: string;
  providerDomain?: string;
  /** True where the provider was recognised rather than passed through. */
  providerKnown: boolean;
  /** Our own service reference, where this WAN is a line we supply. */
  serviceReference?: string;
  /** Why we think the two are the same thing. */
  matchedBy?: 'provider' | 'address' | 'only-wan' | 'ip';
  publicIp?: string;
  stats: WanStats;
}

export interface WanStats {
  /** Percentage, from the most recent sample. */
  uptimePercent?: number;
  /** Seconds of downtime across the reporting window. */
  downtimeSeconds?: number;
  averageLatencyMs?: number;
  maxLatencyMs?: number;
  packetLossPercent?: number;
  downloadKbps?: number;
  uploadKbps?: number;
  /** How many samples in the window came back below 100% uptime. */
  unstableSamples?: number;
  sampleCount?: number;
  at?: string;
}

/**
 * Latency worth mentioning.
 *
 * Not a hard fault: a line at 90ms works, and voice on it does not. The
 * point of a threshold rather than a raw number is that an engineer scanning
 * a list should not have to remember what good looks like.
 */
export const LATENCY_WARN_MS = 40;
export const LATENCY_BAD_MS = 90;
export const LOSS_WARN_PERCENT = 1;
export const LOSS_BAD_PERCENT = 5;

export type StatVerdict = 'good' | 'warn' | 'bad' | 'unknown';

export function latencyVerdict(ms: number | undefined): StatVerdict {
  if (ms === undefined || !Number.isFinite(ms)) return 'unknown';
  if (ms >= LATENCY_BAD_MS) return 'bad';
  if (ms >= LATENCY_WARN_MS) return 'warn';
  return 'good';
}

export function lossVerdict(percent: number | undefined): StatVerdict {
  if (percent === undefined || !Number.isFinite(percent)) return 'unknown';
  if (percent >= LOSS_BAD_PERCENT) return 'bad';
  if (percent >= LOSS_WARN_PERCENT) return 'warn';
  return 'good';
}

export function uptimeVerdict(percent: number | undefined): StatVerdict {
  if (percent === undefined || !Number.isFinite(percent)) return 'unknown';
  if (percent <= 0) return 'bad';
  if (percent < 99.9) return 'warn';
  return 'good';
}

/** The worst of the three, which is what a row's colour should be. */
export function wanVerdict(stats: WanStats): StatVerdict {
  const parts = [
    uptimeVerdict(stats.uptimePercent),
    latencyVerdict(stats.averageLatencyMs),
    lossVerdict(stats.packetLossPercent),
  ];
  if (parts.includes('bad')) return 'bad';
  if (parts.includes('warn')) return 'warn';
  if (parts.includes('good')) return 'good';
  return 'unknown';
}

/** `WAN 1` from `wan1`; `WAN` from `wan`. */
export function wanLabel(id: string): string {
  const match = /^wan[_-]?(\d+)$/i.exec(id.trim());
  if (match) return `WAN ${match[1]}`;
  if (/^wan$/i.test(id.trim())) return 'WAN';
  return id.trim() || 'WAN';
}

/**
 * One uplink's telemetry, as reported.
 *
 * `uplinks` is present where the console breaks its WANs out; a single
 * aggregate is what the Site Manager feed gives today. Both are read,
 * because inventing a per-WAN split from aggregate numbers would put a
 * confident-looking "WAN 2: 100% uptime" on screen that nothing measured.
 */
export interface WanUplinkSample {
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
}

function statsFrom(sample: WanUplinkSample, health?: WanHealth | null): WanStats {
  const samples = health?.samples ?? [];
  const graded = samples.filter((s) => s.uptimePercent !== undefined);
  return {
    ...(sample.uptimePercent !== undefined ? { uptimePercent: sample.uptimePercent } : {}),
    ...(sample.downtimeSeconds !== undefined ? { downtimeSeconds: sample.downtimeSeconds } : {}),
    ...(sample.averageLatencyMs !== undefined ? { averageLatencyMs: sample.averageLatencyMs } : {}),
    ...(sample.maxLatencyMs !== undefined ? { maxLatencyMs: sample.maxLatencyMs } : {}),
    ...(sample.packetLossPercent !== undefined ? { packetLossPercent: sample.packetLossPercent } : {}),
    ...(sample.downloadKbps !== undefined ? { downloadKbps: sample.downloadKbps } : {}),
    ...(sample.uploadKbps !== undefined ? { uploadKbps: sample.uploadKbps } : {}),
    ...(sample.at ? { at: sample.at } : {}),
    ...(graded.length
      ? {
          sampleCount: graded.length,
          unstableSamples: graded.filter((s) => (s.uptimePercent ?? 100) < 100).length,
        }
      : {}),
  };
}

/**
 * The WAN rows for a site.
 *
 * `uplinks` wins where the console gives it. Otherwise one row is built from
 * whatever aggregate there is, and — importantly — it is labelled `WAN`
 * rather than `WAN 1`, because a site with two uplinks and one set of
 * numbers must not read as though the numbers belong to the first one.
 */
export function wanLinesFrom(input: {
  site?: Pick<NetworkSite, 'isp' | 'counts'> | undefined;
  health?: WanHealth | null;
  uplinks?: readonly WanUplinkSample[];
}): WanLine[] {
  const build = (sample: WanUplinkSample, id: string): WanLine => {
    const provider = ispIdentity(sample.ispName ?? input.site?.isp?.name ?? input.site?.isp?.organisation);
    return {
      id,
      label: wanLabel(id),
      management: 'unmanaged',
      providerName: provider.name,
      providerColour: provider.colour,
      providerMonogram: provider.monogram,
      ...(provider.domain ? { providerDomain: provider.domain } : {}),
      providerKnown: provider.known,
      ...(sample.publicIp ? { publicIp: sample.publicIp } : {}),
      stats: statsFrom(sample, input.health),
    };
  };

  if (input.uplinks?.length) {
    return input.uplinks.map((uplink, i) => build(uplink, uplink.id ?? `wan${i + 1}`));
  }

  const latest = input.health?.latest;
  const hasAnything = Boolean(latest || input.site?.isp?.name || input.site?.counts?.wanConfigurations);
  if (!hasAnything) return [];

  const sample: WanUplinkSample = {
    ...(latest?.ispName ? { ispName: latest.ispName } : {}),
    ...(latest?.uptimePercent !== undefined ? { uptimePercent: latest.uptimePercent } : {}),
    ...(input.health?.downtimeSeconds !== undefined ? { downtimeSeconds: input.health.downtimeSeconds } : {}),
    ...(latest?.averageLatencyMs !== undefined ? { averageLatencyMs: latest.averageLatencyMs } : {}),
    ...(latest?.maxLatencyMs !== undefined ? { maxLatencyMs: latest.maxLatencyMs } : {}),
    ...(latest?.packetLossPercent !== undefined ? { packetLossPercent: latest.packetLossPercent } : {}),
    ...(latest?.downloadKbps !== undefined ? { downloadKbps: latest.downloadKbps } : {}),
    ...(latest?.uploadKbps !== undefined ? { uploadKbps: latest.uploadKbps } : {}),
    ...(latest?.at ? { at: latest.at } : {}),
  };

  // One row, called `wan`, because which one it is was never reported.
  return [build(sample, 'wan')];
}

/**
 * Which WAN a line we supply is plugged into.
 *
 * The join an engineer makes in their head and should not have to. Tried in
 * order of how much it proves:
 *
 *   `ip`        — the WAN's public address is the line's. Conclusive.
 *   `provider`  — one WAN's provider matches the line's supplier, and only one.
 *   `only-wan`  — there is a single WAN, so there is nothing else it could be.
 *
 * Nothing is returned where two WANs share a provider. "It is one of these
 * two" is not an answer worth printing as though it were one, and a wrong
 * WAN number sends somebody to unplug the working line.
 */
export function matchLineToWan(
  line: { provider?: string; publicIp?: string; serviceId?: string },
  wans: readonly WanLine[],
): { wan: WanLine; matchedBy: NonNullable<WanLine['matchedBy']> } | undefined {
  if (!wans.length) return undefined;

  if (line.publicIp) {
    const byIp = wans.filter((w) => w.publicIp && w.publicIp === line.publicIp);
    if (byIp.length === 1) return { wan: byIp[0]!, matchedBy: 'ip' };
  }

  if (line.provider) {
    const wanted = ispIdentity(line.provider);
    const byProvider = wans.filter((w) => w.providerName === wanted.name);
    if (byProvider.length === 1) return { wan: byProvider[0]!, matchedBy: 'provider' };
    // Two WANs on the same provider: honestly unmatchable from here.
    if (byProvider.length > 1) return undefined;
  }

  if (wans.length === 1) return { wan: wans[0]!, matchedBy: 'only-wan' };
  return undefined;
}

/**
 * The WAN rows to show alongside the lines we supply.
 *
 * A WAN matched to one of our own lines is dropped: it is the same
 * connection, and two rows for one line is how somebody ends up raising a
 * fault on a circuit they have already raised a fault on. The match is
 * handed back separately so the managed line can say which WAN it is.
 */
export function reconcileWans(
  lines: readonly { provider?: string; publicIp?: string; serviceId?: string; id: string }[],
  wans: readonly WanLine[],
): {
  unmanaged: WanLine[];
  /** Line id → the WAN it was matched to. */
  matched: Map<string, { wan: WanLine; matchedBy: NonNullable<WanLine['matchedBy']> }>;
} {
  const matched = new Map<string, { wan: WanLine; matchedBy: NonNullable<WanLine['matchedBy']> }>();
  const taken = new Set<string>();

  // Conclusive matches first, so a weaker one cannot claim a WAN that a
  // stronger one would have taken.
  const order: Array<NonNullable<WanLine['matchedBy']>> = ['ip', 'provider', 'only-wan'];
  for (const strength of order) {
    for (const line of lines) {
      if (matched.has(line.id)) continue;
      const available = wans.filter((w) => !taken.has(w.id));
      const result = matchLineToWan(line, available);
      if (result && result.matchedBy === strength) {
        matched.set(line.id, result);
        taken.add(result.wan.id);
      }
    }
  }

  return {
    unmanaged: wans.filter((w) => !taken.has(w.id)),
    matched,
  };
}
