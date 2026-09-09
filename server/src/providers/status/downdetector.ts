import {
  MAJOR_PROVIDERS,
  sortByTrouble,
  stateFromReports,
  type ProviderState,
  type ProviderStatus,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * Downdetector, for "is this supplier having a bad morning nationally".
 *
 * The first question when three sites go off within ten minutes. If BT are
 * down across the country then the line tests will say what the status page
 * already said, and the useful work is telling the affected customers rather
 * than raising five faults that get closed as a known incident.
 *
 * Two things to be honest about.
 *
 * **The exact paths are unverified.** Downdetector's API reference sits
 * behind their enterprise login. What is built here comes from the endpoint
 * names their own Sumo Logic integration documents — company search,
 * current status, the 24-hour baseline, reports for a slug — on the base URL
 * that integration names. Every path is overridable from the environment for
 * exactly that reason, and the ping says so. When the key arrives, an hour
 * with the real documentation will either confirm this or need two URL
 * strings changed.
 *
 * **Nothing here is load-bearing.** The dashboard, the sweep and the fault
 * attribution all work with no status source configured at all. A national
 * outage does not prove this customer's fault is part of it, and a green
 * status page does not prove it is not — so this is shown alongside a
 * diagnosis and never feeds into one. A decoration that can take the outage
 * board down with it is not a decoration.
 */

const statusCache = new TtlCache<ProviderStatus[]>(5 * 60 * 1000, 4);
const tokenCache = { token: '', expiresAt: 0 };

export const downdetectorConfigured = (): boolean => config().downdetector.configured;

export function clearDowndetectorCache(): void {
  statusCache.clear();
  tokenCache.token = '';
  tokenCache.expiresAt = 0;
}

/**
 * An access token, via OAuth2 client credentials.
 *
 * Id and secret in a Basic header, which is what their integration
 * documentation describes and what the spec prescribes for this grant.
 * Cached until a minute before it expires: a token fetched per request would
 * triple the calls for no benefit.
 */
async function accessToken(): Promise<string> {
  const cfg = config().downdetector;
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body = await fetchJson<{ access_token?: string; expires_in?: number }>(cfg.tokenUrl, {
    label: 'Downdetector',
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    timeoutMs: 10_000,
    retries: 1,
  });

  const token = body?.access_token;
  if (!token) throw new Error('Downdetector returned no access token.');
  tokenCache.token = token;
  tokenCache.expiresAt = Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
  return token;
}

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Reads whichever field name the payload happens to use. */
function pick(row: Record<string, unknown> | undefined, ...names: string[]): unknown {
  if (!row) return undefined;
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return undefined;
}

/**
 * One provider's status.
 *
 * Reports are read against that provider's own baseline, because absolute
 * counts mean nothing across providers — BT's quiet afternoon is more
 * reports than G.Network's worst day. Where the payload states a status
 * outright that is preferred over our own arithmetic: it is their judgement
 * about their own data.
 */
export function toStatus(input: { provider: string; payload: unknown; checkedAt: string }): ProviderStatus {
  const row = (input.payload ?? {}) as Record<string, unknown>;
  const nested = (pick(row, 'data', 'status', 'result') ?? {}) as Record<string, unknown>;

  const reports = num(pick(row, 'reports', 'count', 'num_reports')) ?? num(pick(nested, 'reports', 'count'));
  const baseline =
    num(pick(row, 'baseline', 'baseline_24h', 'expected')) ?? num(pick(nested, 'baseline', 'expected'));

  const stated = String(pick(row, 'indicator', 'state', 'severity') ?? pick(nested, 'indicator', 'state') ?? '')
    .toLowerCase()
    .trim();

  const state: ProviderState = stated
    ? stated.includes('major') || stated.includes('outage') || stated.includes('critical')
      ? 'outage'
      : stated.includes('minor') || stated.includes('degrad') || stated.includes('warn')
        ? 'degraded'
        : stated.includes('none') || stated.includes('ok') || stated.includes('operational')
          ? 'ok'
          : stateFromReports(reports, baseline)
    : stateFromReports(reports, baseline);

  return {
    provider: input.provider,
    state,
    ...(reports !== undefined ? { reports } : {}),
    ...(baseline !== undefined ? { detail: `against a normal ${Math.round(baseline)}` } : {}),
    checkedAt: input.checkedAt,
    source: 'downdetector',
  };
}

/** The URL for one provider's status, with the slug substituted. */
export function statusUrl(slug: string): string {
  const cfg = config().downdetector;
  const path = cfg.statusPath.replace('{slug}', encodeURIComponent(slug)).replace(/^\//, '');
  return `${cfg.baseUrl.replace(/\/$/, '')}/${path}`;
}

/**
 * The majors, worst first.
 *
 * One call per provider, cached for five minutes: nine providers is about
 * 2,600 calls a day, well inside any sane enterprise quota.
 *
 * Never throws. A provider whose own call failed comes back as `unknown`
 * rather than dropping out of the list, because a missing row reads as "we
 * did not check" where an `unknown` row reads as "we could not find out" —
 * and only one of those is true.
 */
export async function majorProviderStatus(): Promise<{ rows: ProviderStatus[]; error?: string }> {
  const cfg = config().downdetector;
  const checkedAt = new Date().toISOString();

  if (!cfg.configured) {
    return { rows: [], error: 'Downdetector is not connected, so national supplier status is not being checked.' };
  }

  try {
    const rows = await statusCache.wrap('majors', async () => {
      const token = await accessToken();

      const results = await Promise.all(
        MAJOR_PROVIDERS.map(async (provider): Promise<ProviderStatus> => {
          try {
            const payload = await fetchJson<unknown>(statusUrl(provider.slug), {
              label: 'Downdetector',
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
              timeoutMs: 8000,
              retries: 0,
              notFoundAsNull: true,
            });
            return toStatus({ provider: provider.name, payload, checkedAt });
          } catch {
            // One provider failing is not the whole strip failing.
            return { provider: provider.name, state: 'unknown', checkedAt, source: 'downdetector' };
          }
        }),
      );

      return sortByTrouble(results);
    });
    return { rows };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A quick probe for the service-status board.
 *
 * Deliberately the token endpoint rather than a data one: a key that cannot
 * get a token is misconfigured, and a key that can but returns nothing for
 * one slug is a slug problem, which is a different conversation.
 */
export async function downdetectorPing(): Promise<{ ok: boolean; detail: string }> {
  if (!downdetectorConfigured()) {
    return { ok: false, detail: 'No Downdetector client id and secret are set.' };
  }
  try {
    await accessToken();
    return {
      ok: true,
      detail:
        'Authenticated. The data paths come from Downdetector’s integration documentation rather than their ' +
        'API reference, which is behind their login — confirm them and override with DOWNDETECTOR_STATUS_PATH ' +
        'if they differ.',
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
