import { normaliseCli } from '@sw/shared';
import type { FootfallInsight, ImeiLookup, NetworkConnectivityCheck } from '@sw/shared';
import { btCall } from './client';
import { pickArray, pickBool, pickNumber, pickString } from '../zen/map';

/**
 * BT developer products.
 *
 * Three of the six products BT publishes are useful here:
 *   Home Network                — is a number currently connected to EE
 *   IMEI Lookup                 — the IMEI behind an MSISDN
 *   Location Insights for London — footfall and visitor catchments
 *
 * Response field names are not published without an account, so each mapper
 * accepts the plausible spellings and preserves anything it cannot place.
 */

/** MSISDNs go to BT in E.164 without the plus, which is the usual convention. */
export function toMsisdn(input: string): string {
  const national = normaliseCli(input);
  if (national) return `44${national.slice(1)}`;
  return input.replace(/[^\d]/g, '');
}

/* ---- Home Network: is this phone on the network? -------------------- */

export async function checkNetworkConnectivity(phoneNumber: string): Promise<NetworkConnectivityCheck> {
  const msisdn = toMsisdn(phoneNumber);
  const json = await btCall<unknown>('bt-home-network', {
    path: '/connectivity',
    query: { msisdn, phoneNumber: msisdn },
    emptyAsNull: true,
  });

  const connected =
    pickBool(json, 'connected', 'isConnected', 'attached', 'onNetwork', 'connectivityStatus') ??
    // Some CAMARA-style APIs answer with a status string instead of a boolean.
    (() => {
      const status = (pickString(json, 'status', 'connectivityStatus', 'deviceStatus') ?? '').toUpperCase();
      if (status.includes('CONNECTED') || status.includes('REACHABLE')) return true;
      if (status.includes('NOT_CONNECTED') || status.includes('UNREACHABLE')) return false;
      return undefined;
    })();

  return {
    msisdn: phoneNumber,
    ...(connected != null ? { connected } : {}),
    network: pickString(json, 'network', 'operator', 'mno') ?? 'EE',
    ...(pickBool(json, 'roaming', 'isRoaming') != null ? { roaming: pickBool(json, 'roaming', 'isRoaming') } : {}),
    ...(pickString(json, 'country', 'countryCode') ? { country: pickString(json, 'country', 'countryCode') } : {}),
    ...(pickString(json, 'lastSeen', 'lastSeenAt', 'lastActivity')
      ? { lastSeenAt: pickString(json, 'lastSeen', 'lastSeenAt', 'lastActivity') }
      : {}),
    ...(pickBool(json, 'reachable', 'isReachable') != null
      ? { reachable: pickBool(json, 'reachable', 'isReachable') }
      : {}),
    messages: pickArray(json, 'messages', 'warnings')
      .map((m) => (typeof m === 'string' ? m : pickString(m, 'message', 'text')))
      .filter((m): m is string => Boolean(m)),
    checkedAt: new Date().toISOString(),
    provider: 'BT — Home Network',
    source: 'bt:home-network',
  };
}

/* ---- IMEI lookup ---------------------------------------------------- */

export async function lookupImei(phoneNumber: string): Promise<ImeiLookup> {
  const msisdn = toMsisdn(phoneNumber);
  const json = await btCall<unknown>('bt-imei-lookup', {
    path: '/imei',
    query: { msisdn, phoneNumber: msisdn },
    emptyAsNull: true,
  });

  const imei = pickString(json, 'imei', 'IMEI', 'deviceImei');

  return {
    msisdn: phoneNumber,
    ...(imei ? { imei } : {}),
    // The first eight digits are the Type Allocation Code — the model id.
    ...(imei && imei.length >= 8 ? { tac: imei.slice(0, 8) } : {}),
    ...(pickString(json, 'manufacturer', 'make', 'vendor', 'brand')
      ? { manufacturer: pickString(json, 'manufacturer', 'make', 'vendor', 'brand') }
      : {}),
    ...(pickString(json, 'model', 'deviceModel', 'modelName')
      ? { model: pickString(json, 'model', 'deviceModel', 'modelName') }
      : {}),
    ...(pickArray(json, 'capabilities', 'features').length
      ? {
          capabilities: pickArray(json, 'capabilities', 'features')
            .map((c) => (typeof c === 'string' ? c : pickString(c, 'name', 'capability')))
            .filter((c): c is string => Boolean(c)),
        }
      : {}),
    ...(pickBool(json, 'blacklisted', 'isBlacklisted', 'blocked') != null
      ? { blacklisted: pickBool(json, 'blacklisted', 'isBlacklisted', 'blocked') }
      : {}),
    messages: pickArray(json, 'messages', 'warnings')
      .map((m) => (typeof m === 'string' ? m : pickString(m, 'message', 'text')))
      .filter((m): m is string => Boolean(m)),
    checkedAt: new Date().toISOString(),
    provider: 'BT — IMEI Lookup',
    source: 'bt:imei-lookup',
  };
}

/* ---- Location Insights for London ---------------------------------- */

/**
 * Footfall and visitor catchments. London only — BT is explicit about the
 * coverage, so anything outside it is reported as out of area rather than
 * silently returning nothing.
 */
export async function fetchFootfall(params: {
  postcode?: string;
  latitude?: number;
  longitude?: number;
  from?: string;
  to?: string;
}): Promise<FootfallInsight> {
  const json = await btCall<unknown>('bt-location-insights', {
    path: '/footfall',
    query: {
      ...(params.postcode ? { postcode: params.postcode } : {}),
      ...(params.latitude != null ? { latitude: params.latitude } : {}),
      ...(params.longitude != null ? { longitude: params.longitude } : {}),
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {}),
    },
    emptyAsNull: true,
  });

  const series = pickArray(json, 'series', 'footfall', 'daily', 'results', 'data')
    .map((d) => {
      const date = pickString(d, 'date', 'day');
      const visitors = pickNumber(d, 'visitors', 'count', 'footfall', 'value');
      return date && visitors != null ? { date, visitors } : null;
    })
    .filter((d): d is { date: string; visitors: number } => d !== null);

  const catchment = pickArray(json, 'catchment', 'origins', 'visitorOrigins')
    .map((c) => {
      const area = pickString(c, 'area', 'name', 'origin', 'district');
      const share = pickNumber(c, 'share', 'percentage', 'proportion');
      return area && share != null ? { area, share } : null;
    })
    .filter((c): c is { area: string; share: number } => c !== null);

  const hourly = pickArray(json, 'hourly', 'byHour')
    .map((h) => {
      const hour = pickNumber(h, 'hour');
      const visitors = pickNumber(h, 'visitors', 'count', 'value');
      return hour != null && visitors != null ? { hour, visitors } : null;
    })
    .filter((h): h is { hour: number; visitors: number } => h !== null);

  return {
    areaName: pickString(json, 'areaName', 'area', 'name') ?? params.postcode ?? 'Selected location',
    ...(pickString(json, 'granularity', 'resolution') ? { granularity: pickString(json, 'granularity', 'resolution') } : {}),
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    series,
    ...(catchment.length ? { catchment } : {}),
    ...(hourly.length ? { hourly } : {}),
    coverageNote: 'BT Location Insights covers Greater London only. Locations outside it return no data.',
    provider: 'BT — Location Insights for London',
    source: 'bt:location-insights',
  };
}

/** London bounding box, used to warn before a pointless call. */
export function isLikelyLondon(postcode: string): boolean {
  const area = postcode.trim().toUpperCase().match(/^[A-Z]{1,2}/)?.[0] ?? '';
  return ['E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC', 'BR', 'CR', 'DA', 'EN', 'HA', 'IG', 'KT', 'RM', 'SM', 'TW', 'UB', 'WD'].includes(
    area,
  );
}
