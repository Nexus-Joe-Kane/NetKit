import type { SimEstate, SimRecord, SimState } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { notConfigured } from '../../lib/errors';
import { pickArray, pickBool, pickNumber, pickString } from '../zen/map';

/**
 * Jola Mobile Manager.
 *
 * Worth noting that Zen's `/api/cellular/*` endpoints are already
 * Jola-backed, so for SIMs bought through Zen this is redundant — it earns
 * its place only for SIMs held directly with Jola. Endpoint paths are
 * configurable because the Mobile Manager API surface differs by reseller.
 */

function jolaState(raw?: string): SimState {
  const v = (raw ?? '').toUpperCase();
  if (v.includes('ACTIVE') || v.includes('LIVE')) return 'active';
  if (v.includes('SUSPEND') || v.includes('BARRED')) return 'suspended';
  if (v.includes('CEAS') || v.includes('TERMINAT') || v.includes('DISCONNECT')) return 'ceased';
  if (v.includes('PENDING') || v.includes('STOCK') || v.includes('SPARE')) return 'pending';
  if (v.includes('TEST')) return 'test';
  return 'unknown';
}

async function jolaCall<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T | null> {
  const cfg = config();
  if (!cfg.jola.baseUrl || !cfg.jola.apiKey) {
    throw notConfigured('Jola is not configured. Set JOLA_BASE_URL and JOLA_API_KEY.');
  }

  const url = new URL(`${cfg.jola.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) {
    if (v) url.searchParams.set(k, v);
  }

  return fetchJson<T>(url.toString(), {
    headers: {
      Authorization: `Bearer ${cfg.jola.apiKey}`,
      'X-API-Key': cfg.jola.apiKey,
    },
    label: 'Jola Mobile Manager',
    timeoutMs: cfg.requestTimeoutMs,
    notFoundAsNull: true,
  });
}

export function mapJolaSim(raw: unknown): SimRecord | null {
  const iccid = pickString(raw, 'iccid', 'iccId', 'ICCID', 'simSerial');
  if (!iccid) return null;

  return {
    iccid,
    ...(pickString(raw, 'msisdn', 'phoneNumber', 'number') ? { msisdn: pickString(raw, 'msisdn', 'phoneNumber', 'number') } : {}),
    ...(pickString(raw, 'imsi', 'IMSI') ? { imsi: pickString(raw, 'imsi', 'IMSI') } : {}),
    state: jolaState(pickString(raw, 'status', 'state', 'simStatus')),
    ...(pickString(raw, 'network', 'operator', 'carrier') ? { network: pickString(raw, 'network', 'operator', 'carrier') } : {}),
    ...(pickNumber(raw, 'allowance', 'dataAllowance', 'bundleSize') != null
      ? { allowanceBytes: pickNumber(raw, 'allowance', 'dataAllowance', 'bundleSize') }
      : {}),
    ...(pickNumber(raw, 'usage', 'dataUsed', 'usedBytes') != null
      ? { usedBytes: pickNumber(raw, 'usage', 'dataUsed', 'usedBytes') }
      : {}),
    ...(pickArray(raw, 'bars', 'barrings').length
      ? {
          bars: pickArray(raw, 'bars', 'barrings')
            .map((b) => (typeof b === 'string' ? b : pickString(b, 'name', 'type', 'bar')))
            .filter((b): b is string => Boolean(b)),
        }
      : {}),
    ...(pickBool(raw, 'attached', 'isAttached', 'online') != null
      ? { attached: pickBool(raw, 'attached', 'isAttached', 'online') }
      : {}),
    ...(pickString(raw, 'lastSeen', 'lastActivity', 'lastSeenAt')
      ? { lastSeenAt: pickString(raw, 'lastSeen', 'lastActivity', 'lastSeenAt') }
      : {}),
    ...(pickString(raw, 'apn') ? { apn: pickString(raw, 'apn') } : {}),
    ...(pickString(raw, 'ipAddress', 'ip') ? { ipAddress: pickString(raw, 'ipAddress', 'ip') } : {}),
    provider: 'Jola Mobile Manager',
    source: 'jola',
  };
}

export async function fetchJolaEstate(): Promise<SimEstate> {
  const cfg = config();
  const json = await jolaCall<unknown>(cfg.jola.simsPath);
  const rows = Array.isArray(json) ? json : pickArray(json, 'sims', 'results', 'data', 'items');
  const sims = rows.map(mapJolaSim).filter((s): s is SimRecord => s !== null);

  const poolRaw = (json as { pool?: unknown })?.pool;
  const pool = poolRaw
    ? {
        ...(pickString(poolRaw, 'name') ? { name: pickString(poolRaw, 'name') } : {}),
        ...(pickNumber(poolRaw, 'size', 'sizeBytes') != null ? { sizeBytes: pickNumber(poolRaw, 'size', 'sizeBytes') } : {}),
        ...(pickNumber(poolRaw, 'usage', 'usedBytes') != null ? { usedBytes: pickNumber(poolRaw, 'usage', 'usedBytes') } : {}),
        ...(pickNumber(poolRaw, 'simCount', 'count') != null ? { simCount: pickNumber(poolRaw, 'simCount', 'count') } : {}),
      }
    : undefined;

  return {
    sims,
    ...(pool && Object.keys(pool).length ? { pool } : {}),
    checkedAt: new Date().toISOString(),
    sources: ['jola'],
  };
}

/** Looks a single SIM up by ICCID or MSISDN. */
export async function findJolaSim(identifier: string): Promise<SimRecord | null> {
  const estate = await fetchJolaEstate();
  const needle = identifier.replace(/\s/g, '').toLowerCase();
  return (
    estate.sims.find(
      (s) => s.iccid.toLowerCase() === needle || (s.msisdn ?? '').replace(/\D/g, '').endsWith(needle.replace(/\D/g, '')),
    ) ?? null
  );
}

export const __jolaTesting = { jolaState };
