import { config } from '../../config';
import { clearUnifiCache } from './unifi';
import { integrationCall } from './unifiTransport';

/**
 * The things we can actually tell UniFi to do.
 *
 * A short list on purpose, and the shortness is Ubiquiti's, not a choice.
 * Their APIs come in three tiers and only one of them takes instructions:
 *
 *   Site Manager (`api.ui.com/v1`)   read only. Their own note: "The API key
 *                                    is currently read-only."
 *   Network Integration API          reads, plus a small set of actions --
 *                                    restart a device, power-cycle a port,
 *                                    authorise a client, adopt a device.
 *   The internal controller API      everything their web UI can do,
 *                                    documented nowhere and supported not at
 *                                    all.
 *
 * Only the middle tier is used here. Speed tests and WAN or DNS
 * configuration exist solely on the internal API, so the portal links out to
 * the console for those rather than writing a customer's live network
 * through an endpoint that can change shape on a firmware update without
 * anybody being told.
 *
 * The middle tier is reached two ways, and `integrationCall` decides which:
 * the console's own address where it is reachable from this server, and
 * Ubiquiti's Connector Proxy where it is not. Same paths either way. The
 * cloud road needs console firmware 5.0.3 or newer and a Network
 * Integration key, which is a different key from the Site Manager one -- so
 * a deployment can read every site and still not be able to restart
 * anything, and the error says exactly that rather than "403".
 */

export const unifiActionsConfigured = (): boolean =>
  Boolean(config().unifi.integrationKey || config().unifi.controllerConfigured);

export function unifiActionsUnavailableReason(): string | undefined {
  const unifi = config().unifi;
  if (unifi.controllerConfigured || unifi.integrationKey) return undefined;
  return (
    'Nothing can be restarted from here yet. It needs a UniFi Network Integration key, which is a different key ' +
    'from the Site Manager one — that one is read-only by Ubiquiti’s own design, so a 403 from it is not a ' +
    'broken portal. Make one at UniFi Network → Settings → Control Plane → Integrations, then either give the ' +
    'console’s own address to use it directly, or give the console id to reach it through Ubiquiti’s cloud, ' +
    'which additionally needs console firmware 5.0.3 or newer.'
  );
}

async function post<T>(consoleId: string, path: string, body: unknown): Promise<T | null> {
  return integrationCall<T>({
    path,
    method: 'POST',
    body,
    ...(consoleId ? { consoleId } : {}),
    timeoutMs: Math.min(config().requestTimeoutMs, 15_000),
    // Never retried. A restart is not idempotent from the customer's point of
    // view: a retry that succeeds after a timeout that also succeeded takes
    // the site down twice.
    retries: 0,
  });
}

export interface ActionOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Restarts one device.
 *
 * Deliberately narrow: one device, named, with the caller having already
 * confirmed. There is no "restart the site" here, because the gateway going
 * down takes the access points with it and somebody who wanted one AP
 * restarted would take the whole office off.
 */
export async function restartDevice(input: {
  consoleId: string;
  siteId: string;
  deviceId: string;
}): Promise<ActionOutcome> {
  const reason = unifiActionsUnavailableReason();
  if (reason) return { ok: false, detail: reason };

  try {
    await post(input.consoleId, `/sites/${encodeURIComponent(input.siteId)}/devices/${encodeURIComponent(input.deviceId)}/actions`, {
      action: 'RESTART',
    });
    // The device list now says something untrue for the next minute or two.
    clearUnifiCache();
    return { ok: true, detail: 'Restart sent. The device drops off for a minute or two before it comes back.' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Power-cycles one switch port.
 *
 * The action that fixes a hung camera or access point without sending
 * anybody, and the one worth having most.
 */
export async function powerCyclePort(input: {
  consoleId: string;
  siteId: string;
  deviceId: string;
  portIndex: number;
}): Promise<ActionOutcome> {
  const reason = unifiActionsUnavailableReason();
  if (reason) return { ok: false, detail: reason };

  try {
    await post(
      input.consoleId,
      `/sites/${encodeURIComponent(input.siteId)}/devices/${encodeURIComponent(input.deviceId)}/interfaces/ports/${input.portIndex}/actions`,
      { action: 'POWER_CYCLE' },
    );
    clearUnifiCache();
    return { ok: true, detail: `Port ${input.portIndex} power-cycled. Whatever is on it reboots.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * The things we deliberately do not do
 * ------------------------------------------------------------------ */

/**
 * Where to go for what the API will not do.
 *
 * A link, not a stub that throws. An engineer who wants a speed test wants
 * it now, and two clicks into the console beats a button that does nothing
 * or one that writes config through an undocumented endpoint.
 */
export interface ConsoleDeepLink {
  label: string;
  url: string;
  why: string;
}

export function consoleLinks(input: { consoleId?: string; siteId?: string; deviceId?: string }): ConsoleDeepLink[] {
  const base = 'https://unifi.ui.com';
  const site = input.consoleId && input.siteId
    ? `${base}/consoles/${encodeURIComponent(input.consoleId)}/network/${encodeURIComponent(input.siteId)}`
    : base;

  return [
    {
      label: 'Run a speed test',
      url: `${site}/dashboard`,
      why: 'Ubiquiti publish no speed-test endpoint. It exists only on the internal API their own interface uses.',
    },
    {
      label: 'WAN and DNS settings',
      url: `${site}/settings/internet`,
      why:
        'Changing DNS or WAN settings is not in the documented API either. Doing it through the internal one ' +
        'would mean writing a customer’s live network through an endpoint that can change without notice.',
    },
    ...(input.deviceId
      ? [
          {
            label: 'This device in the console',
            url: `${site}/devices/${encodeURIComponent(input.deviceId)}`,
            why: 'Everything the console can do to it, including the things the API cannot.',
          },
        ]
      : []),
  ];
}
