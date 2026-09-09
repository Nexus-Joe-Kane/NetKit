import {
  resolveClient,
  type DocumentedClient,
  type DocumentedConfiguration,
  type DocumentedCredential,
  type DocumentedLocation,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * IT Glue — what the site is documented as having.
 *
 * The documentation and the network disagree often enough that conflating
 * them would be worse than showing neither, so everything here is labelled
 * as documented and shown alongside live state rather than merged into it.
 *
 * Two things about the API worth knowing before reading the mapping.
 * Responses are JSON:API, so every record is `{ id, type, attributes }` and
 * the attribute keys are dasherised — `serial-number`, not `serial_number`.
 * The *filters*, confusingly, are snake_case: `filter[organization_id]`.
 * Both spellings are documented that way; this is not a guess.
 *
 * There is no version prefix in the paths, and there are three regional
 * hosts. An EU account queried against the US host answers 404, which reads
 * as "no such organisation" rather than "wrong data centre" — hence the base
 * URL being configurable and the ping saying so.
 */

/** JSON:API record. */
interface Resource<T> {
  id?: string;
  type?: string;
  attributes?: T;
}

interface OrganisationAttrs {
  name?: string;
  'organization-status-name'?: string;
  'organization-type-name'?: string;
  'short-name'?: string;
  primary?: boolean;
  'resource-url'?: string;
}

interface ConfigurationAttrs {
  name?: string;
  hostname?: string;
  'primary-ip'?: string;
  'mac-address'?: string;
  'serial-number'?: string;
  'asset-tag'?: string;
  'configuration-type-name'?: string;
  'manufacturer-name'?: string;
  'model-name'?: string;
  'operating-system-name'?: string;
  'location-id'?: number | string | null;
  'location-name'?: string | null;
  notes?: string | null;
  'warranty-expires-at'?: string | null;
  'resource-url'?: string;
  'updated-at'?: string;
  archived?: boolean;
}

interface LocationAttrs {
  name?: string;
  primary?: boolean;
  'address-1'?: string | null;
  'address-2'?: string | null;
  city?: string | null;
  'postal-code'?: string | null;
  'region-name'?: string | null;
  'country-name'?: string | null;
  phone?: string | null;
}

interface PasswordAttrs {
  name?: string;
  username?: string | null;
  url?: string | null;
  'password-category-name'?: string | null;
  'resource-url'?: string | null;
  'updated-at'?: string;
}

interface Page<T> {
  data?: Array<Resource<T>> | Resource<T> | null;
  meta?: { 'total-pages'?: number; 'total-count'?: number };
}

/**
 * How many pages to walk.
 *
 * IT Glue default 50 per page and cap a request at 1000, and allow 3000
 * requests per five minutes. A client with more than 500 documented
 * configurations at one site is not a client this tool is being asked about,
 * so two pages of 250 is generous and cheap.
 */
const PAGE_SIZE = 250;
const MAX_PAGES = 2;

const clientCache = new TtlCache<DocumentedClient | null>(15 * 60 * 1000, 200);

export const itGlueConfigured = (): boolean => config().itGlue.configured;

export function clearItGlueCache(): void {
  clientCache.clear();
}

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

async function get<T>(path: string): Promise<Page<T> | null> {
  const cfg = config();
  return fetchJson<Page<T>>(`${cfg.itGlue.baseUrl}${path}`, {
    label: 'IT Glue',
    headers: {
      'x-api-key': cfg.itGlue.apiKey,
      // Only required with a payload, but harmless and it documents intent.
      Accept: 'application/vnd.api+json',
    },
    timeoutMs: Math.min(cfg.requestTimeoutMs, 10_000),
    retries: 1,
    notFoundAsNull: true,
  });
}

/** Walks pages until a short one, then stops. */
async function list<T>(path: string): Promise<Array<Resource<T>>> {
  const rows: Array<Resource<T>> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const joiner = path.includes('?') ? '&' : '?';
    const body = await get<T>(`${path}${joiner}page[size]=${PAGE_SIZE}&page[number]=${page}`);
    const data = body?.data;
    // The flexible-assets example in IT Glue's own docs shows `data` as a
    // single object rather than an array, so both shapes are accepted here
    // rather than trusting the index endpoints to be consistent.
    const batch = Array.isArray(data) ? data : data ? [data] : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

function toLocation(row: Resource<LocationAttrs>): DocumentedLocation {
  const a = row.attributes ?? {};
  // There is no single combined address field; IT Glue store two lines.
  const lines = [text(a['address-1']), text(a['address-2'])].filter((l): l is string => Boolean(l));
  return {
    id: String(row.id ?? ''),
    name: text(a.name) ?? 'Unnamed location',
    ...(a.primary === true ? { primary: true } : {}),
    addressLines: lines,
    ...(text(a.city) ? { city: text(a.city)! } : {}),
    ...(text(a['postal-code']) ? { postcode: text(a['postal-code'])! } : {}),
    ...(text(a['region-name']) ? { region: text(a['region-name'])! } : {}),
    ...(text(a['country-name']) ? { country: text(a['country-name'])! } : {}),
    ...(text(a.phone) ? { phone: text(a.phone)! } : {}),
  };
}

function toConfiguration(row: Resource<ConfigurationAttrs>): DocumentedConfiguration {
  const a = row.attributes ?? {};
  return {
    id: String(row.id ?? ''),
    name: text(a.name) ?? 'Unnamed configuration',
    ...(text(a['configuration-type-name']) ? { kind: text(a['configuration-type-name'])! } : {}),
    ...(text(a.hostname) ? { hostname: text(a.hostname)! } : {}),
    ...(text(a['primary-ip']) ? { primaryIp: text(a['primary-ip'])! } : {}),
    ...(text(a['mac-address']) ? { macAddress: text(a['mac-address'])! } : {}),
    ...(text(a['serial-number']) ? { serialNumber: text(a['serial-number'])! } : {}),
    ...(text(a['asset-tag']) ? { assetTag: text(a['asset-tag'])! } : {}),
    ...(text(a['manufacturer-name']) ? { manufacturer: text(a['manufacturer-name'])! } : {}),
    ...(text(a['model-name']) ? { model: text(a['model-name'])! } : {}),
    ...(text(a['operating-system-name']) ? { operatingSystem: text(a['operating-system-name'])! } : {}),
    ...(a['location-id'] != null ? { locationId: String(a['location-id']) } : {}),
    ...(text(a['location-name']) ? { locationName: text(a['location-name'])! } : {}),
    ...(text(a.notes) ? { notes: text(a.notes)! } : {}),
    ...(text(a['warranty-expires-at']) ? { warrantyExpires: text(a['warranty-expires-at'])! } : {}),
    ...(text(a['resource-url']) ? { url: text(a['resource-url'])! } : {}),
    ...(text(a['updated-at']) ? { updatedAt: text(a['updated-at'])! } : {}),
    ...(a.archived === true ? { archived: true } : {}),
  };
}

/**
 * Credentials, without the credentials.
 *
 * IT Glue will return password values when a key is configured to allow it,
 * and NetKit does not ask — not on the index, not on the detail endpoint,
 * nowhere. An engineer who needs a password opens IT Glue, which records
 * that they did. Pulling secrets through a second system doubles the places
 * they can leak from and halves the audit trail, and the only thing it buys
 * is one fewer click.
 */
function toCredential(row: Resource<PasswordAttrs>): DocumentedCredential {
  const a = row.attributes ?? {};
  return {
    id: String(row.id ?? ''),
    name: text(a.name) ?? 'Unnamed password',
    ...(text(a.username) ? { username: text(a.username)! } : {}),
    ...(text(a.url) ? { url: text(a.url)! } : {}),
    ...(text(a['password-category-name']) ? { category: text(a['password-category-name'])! } : {}),
    ...(text(a['resource-url']) ? { documentationUrl: text(a['resource-url'])! } : {}),
    ...(text(a['updated-at']) ? { updatedAt: text(a['updated-at'])! } : {}),
  };
}

/**
 * Everything IT Glue holds about a company, found by name.
 *
 * The name is the only join available — IT Glue does not know a Zendesk
 * organisation id — so the match is ranked and its confidence travels with
 * the answer. `filter[name]` is documented as a partial match, so it does
 * the narrowing and `resolveClient` does the deciding: two organisations
 * containing the word is a choice for the engineer, not a guess here.
 */
export async function documentedClient(name: string): Promise<DocumentedClient | null> {
  const query = name.trim();
  if (!query || !itGlueConfigured()) return null;

  return clientCache.wrap(`org:${query.toLowerCase()}`, async () => {
    const organisations = await list<OrganisationAttrs>(
      `/organizations?filter[name]=${encodeURIComponent(query)}`,
    );
    if (!organisations.length) return null;

    const resolved = resolveClient(
      organisations,
      query,
      (row) => row.attributes?.name ?? '',
    );
    const chosen = resolved.match;
    if (!chosen || !chosen.record.id) return null;

    const orgId = String(chosen.record.id);
    const attrs = chosen.record.attributes ?? {};

    // Three independent calls, and any one of them failing is a gap rather
    // than a failure: an equipment list is still worth having without the
    // locations, and vice versa.
    const [locations, configurations, credentials] = await Promise.all([
      list<LocationAttrs>(`/organizations/${orgId}/relationships/locations`).catch(() => []),
      list<ConfigurationAttrs>(`/configurations?filter[organization_id]=${orgId}&filter[archived]=false`).catch(
        () => [],
      ),
      list<PasswordAttrs>(`/passwords?filter[organization_id]=${orgId}`).catch(() => []),
    ]);

    return {
      id: orgId,
      name: attrs.name ?? query,
      ...(text(attrs['organization-status-name']) ? { status: text(attrs['organization-status-name'])! } : {}),
      ...(text(attrs['short-name']) ? { shortName: text(attrs['short-name'])! } : {}),
      confidence: chosen.confidence,
      matchReason: chosen.reason,
      ...(text(attrs['resource-url']) ? { url: text(attrs['resource-url'])! } : {}),
      locations: locations.map(toLocation),
      configurations: configurations.map(toConfiguration),
      credentials: credentials.map(toCredential),
    };
  });
}

/**
 * The organisations that could be meant, for when the name is ambiguous.
 *
 * Separate from the lookup so a picker does not pay for locations,
 * configurations and passwords it is not going to show.
 */
export async function documentedClientOptions(
  name: string,
): Promise<Array<{ id: string; name: string; confidence: string; reason: string }>> {
  const query = name.trim();
  if (!query || !itGlueConfigured()) return [];
  const organisations = await list<OrganisationAttrs>(`/organizations?filter[name]=${encodeURIComponent(query)}`);
  return resolveClient(organisations, query, (row) => row.attributes?.name ?? '')
    .options.filter((option) => option.record.id)
    .map((option) => ({
      id: String(option.record.id),
      name: option.name,
      confidence: option.confidence,
      reason: option.reason,
    }));
}

export async function itGluePing(): Promise<{ ok: boolean; detail: string }> {
  if (!itGlueConfigured()) return { ok: false, detail: 'ITGLUE_API_KEY is not set.' };
  try {
    // One organisation is enough to prove the key and the region.
    const body = await get<OrganisationAttrs>('/organizations?page[size]=1');
    const rows = Array.isArray(body?.data) ? body!.data! : body?.data ? [body.data] : [];
    const total = body?.meta?.['total-count'];
    const host = new URL(config().itGlue.baseUrl).host;
    if (!rows.length && total === undefined) {
      return {
        ok: false,
        detail:
          `${host} answered, but with no organisations and no count. If the account is in the EU or Australia ` +
          'data centre, set ITGLUE_BASE_URL to api.eu.itglue.com or api.au.itglue.com — the wrong host answers ' +
          'as though the data simply is not there.',
      };
    }
    return {
      ok: true,
      detail: `Connected to ${host}${total !== undefined ? `, ${total} organisations` : ''}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message };
  }
}
