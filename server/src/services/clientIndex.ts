import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  buildIndex,
  clientKey,
  clientIndexStale,
  emptyClientIndex,
  foldContribution,
  searchClients,
  type ClientContribution,
  type ClientIndexEntry,
  type ClientIndexFile,
  type LineRecord,
  type SiteReport,
} from '@sw/shared';
import { config } from '../config';
import { itGlueConfigured } from '../providers/docs/itGlue';
import { fetchJson } from '../lib/http';
import { simEstate } from './operations';

/**
 * Who our customers are and where, held locally.
 *
 * The point of it: the suppliers cannot be searched by customer name, so
 * searching one used to mean asking five APIs per keystroke and getting
 * nothing back. This is pulled once a day into a small file, searched with no
 * network at all, and a click on a client substitutes the postcode or UPRN
 * behind them — which is something the suppliers *can* search for. The call
 * that goes upstream is the same one as before; it just stops being a guess.
 *
 * Sources contribute what they can list, and none of them is required. IT
 * Glue is the best of them: organisations with locations and postcodes. Jola
 * gives customers with their SIMs' sites. Zendesk gives names, which are the
 * join key even without an address. Site Manager gives site names. Zen and
 * Giacom cannot be listed by customer at all — they have no such endpoint —
 * so they fill in from ordinary use instead: every premises anyone looks up
 * teaches the index what is there, and that half needs no permission from
 * anybody.
 */

const indexPath = (): string => join(resolvePath(config().dataDir), 'client-index.json');

let cache: ClientIndexFile | null = null;

function state(): ClientIndexFile {
  if (!cache) {
    try {
      cache = existsSync(indexPath())
        ? (JSON.parse(readFileSync(indexPath(), 'utf8')) as ClientIndexFile)
        : emptyClientIndex();
    } catch {
      cache = emptyClientIndex();
    }
    if (!Array.isArray(cache.entries)) cache.entries = [];
    if (!cache.sources) cache.sources = {};
  }
  return cache;
}

function persist(): void {
  try {
    const path = indexPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state()), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // The index is a convenience rebuilt from upstream, so failing to write
    // it must not fail the lookup that triggered the write.
  }
}

/* ------------------------------------------------------------------ *
 * Pulling the lists
 * ------------------------------------------------------------------ */

/**
 * IT Glue organisations, with their locations.
 *
 * The best source, because a location carries a postal code — which is the
 * thing that makes a name searchable upstream. Paged to a bound rather than
 * exhaustively: an estate larger than this is a different problem from the
 * one this solves.
 */
async function fromItGlue(): Promise<ClientContribution[]> {
  const cfg = config();
  const get = async <T>(path: string): Promise<T | null> =>
    fetchJson<T>(`${cfg.itGlue.baseUrl}${path}`, {
      label: 'IT Glue',
      headers: { 'x-api-key': cfg.itGlue.apiKey, Accept: 'application/vnd.api+json' },
      timeoutMs: Math.min(cfg.requestTimeoutMs, 15_000),
      retries: 1,
      notFoundAsNull: true,
    });

  interface Row<T> {
    id?: string;
    attributes?: T;
  }
  interface OrgAttrs {
    name?: string;
    'organization-status-name'?: string;
  }
  interface LocAttrs {
    name?: string;
    'organization-id'?: number | string;
    'organization-name'?: string;
    'postal-code'?: string | null;
    'address-1'?: string | null;
    city?: string | null;
  }

  const orgs: Array<Row<OrgAttrs>> = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await get<{ data?: Array<Row<OrgAttrs>> }>(`/organizations?page[size]=500&page[number]=${page}`);
    const batch = body?.data ?? [];
    orgs.push(...batch);
    if (batch.length < 500) break;
  }

  // Locations are fetched estate-wide rather than per organisation: one
  // request per client would be hundreds of requests against a 3000-per-five-
  // minutes limit, and every location carries its organisation's name anyway.
  const locations: Array<Row<LocAttrs>> = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await get<{ data?: Array<Row<LocAttrs>> }>(`/locations?page[size]=500&page[number]=${page}`);
    const batch = body?.data ?? [];
    locations.push(...batch);
    if (batch.length < 500) break;
  }

  const byOrg = new Map<string, ClientContribution>();
  for (const org of orgs) {
    const name = org.attributes?.name?.trim();
    if (!name) continue;
    byOrg.set(String(org.id ?? name), { name, source: 'itglue', sites: [], serviceRefs: [] });
  }

  for (const location of locations) {
    const orgId = location.attributes?.['organization-id'];
    const orgName = location.attributes?.['organization-name']?.trim();
    const entry = (orgId != null ? byOrg.get(String(orgId)) : undefined) ?? (orgName ? { name: orgName, source: 'itglue', sites: [], serviceRefs: [] } : undefined);
    if (!entry) continue;
    if (orgId != null && !byOrg.has(String(orgId))) byOrg.set(String(orgId), entry);

    const postcode = location.attributes?.['postal-code']?.trim();
    const address = [location.attributes?.['address-1'], location.attributes?.city]
      .filter((p): p is string => Boolean(p?.trim()))
      .join(', ');

    entry.sites!.push({
      name: location.attributes?.name?.trim() || postcode || 'Unnamed location',
      ...(postcode ? { postcode } : {}),
      ...(address ? { address } : {}),
    });
  }

  return [...byOrg.values()];
}

/**
 * Jola customers, with the sites their SIMs are at.
 *
 * Free, because the estate is fetched and cached for the SIMs page anyway.
 */
async function fromJola(): Promise<ClientContribution[]> {
  const estate = await simEstate();
  const byClient = new Map<string, ClientContribution>();

  for (const sim of estate.data?.sims ?? []) {
    const name = sim.clientName?.trim();
    if (!name) continue;

    const existing = byClient.get(name.toLowerCase()) ?? { name, source: 'jola', sites: [], serviceRefs: [] };
    if (sim.site || sim.postcode) {
      existing.sites!.push({
        name: sim.site?.trim() || sim.postcode || 'Unnamed site',
        ...(sim.postcode ? { postcode: sim.postcode } : {}),
      });
    }
    if (sim.zenReference) existing.serviceRefs!.push(sim.zenReference);
    byClient.set(name.toLowerCase(), existing);
  }

  return [...byClient.values()];
}

/**
 * Zendesk organisations.
 *
 * Names with no addresses, which is still worth having: the name is the join
 * key across every other system, so an organisation here makes a client
 * findable even before anything knows where they are.
 */
async function fromZendesk(): Promise<ClientContribution[]> {
  const cfg = config();
  const auth = Buffer.from(`${cfg.zendesk.email}/token:${cfg.zendesk.apiToken}`).toString('base64');
  const raw = cfg.zendesk.subdomain.trim().replace(/\/+$/, '');
  const base = /^https?:\/\//i.test(raw) ? `${raw}/api/v2` : `https://${raw.includes('.') ? raw : `${raw}.zendesk.com`}/api/v2`;

  const out: ClientContribution[] = [];
  let url: string | null = `${base}/organizations.json?per_page=100`;

  for (let page = 0; page < 20 && url; page += 1) {
    const body: { organizations?: Array<{ name?: string }>; next_page?: string | null } | null = await fetchJson(url, {
      label: 'Zendesk',
      headers: { Authorization: `Basic ${auth}` },
      timeoutMs: Math.min(cfg.requestTimeoutMs, 15_000),
      retries: 1,
      notFoundAsNull: true,
    });
    for (const org of body?.organizations ?? []) {
      const name = org.name?.trim();
      if (name) out.push({ name, source: 'zendesk' });
    }
    url = body?.next_page ?? null;
  }

  return out;
}

/*
 * Site Manager is deliberately not a source here.
 *
 * It was, briefly, and it was wrong. Its site names are *site* names —
 * "Willow Brockley Rise" — and treating them as client names invented three
 * clients out of one, each with no address, which then outranked the real
 * entry in the search. Matching them back onto the right client would need
 * the fuzzy name match rather than the exact key, and the payoff is a site
 * name with no postcode attached, which is the one thing the index does not
 * need. The On site tab already does that join properly, per premises.
 */

/* ------------------------------------------------------------------ *
 * Building and refreshing
 * ------------------------------------------------------------------ */

interface SourceDef {
  key: string;
  configured: () => boolean;
  run: () => Promise<ClientContribution[]>;
  /** Said on the admin page when the source cannot be listed at all. */
  note?: string;
}

const SOURCES: SourceDef[] = [
  { key: 'itglue', configured: () => itGlueConfigured(), run: fromItGlue },
  { key: 'jola', configured: () => config().jola.configured, run: fromJola },
  { key: 'zendesk', configured: () => config().zendesk.configured, run: fromZendesk },
];

/**
 * Rebuilds the index from every configured source.
 *
 * One source failing is recorded against that source and does not stop the
 * others: an index built from three of four is worth having, and the admin
 * page says which one is missing.
 */
export async function rebuildClientIndex(): Promise<ClientIndexFile> {
  const file = state();
  const now = new Date().toISOString();
  const contributions: ClientContribution[] = [];

  for (const source of SOURCES) {
    if (!source.configured()) {
      file.sources[source.key] = { ok: false, count: 0, detail: 'not configured', at: now };
      continue;
    }
    try {
      const rows = await source.run();
      contributions.push(...rows);
      file.sources[source.key] = { ok: true, count: rows.length, at: now };
    } catch (err) {
      file.sources[source.key] = {
        ok: false,
        count: 0,
        detail: err instanceof Error ? err.message : String(err),
        at: now,
      };
    }
  }

  /*
   * Zen and Giacom have no customer-listing endpoint, so they are not sources
   * here. Recorded rather than omitted, because "no Zen clients in the index"
   * would otherwise look like a fault when it is the shape of their API.
   */
  file.sources.zen = {
    ok: true,
    count: 0,
    detail: 'no customer list endpoint — fills in from lookups',
    at: now,
  };
  file.sources.giacom = { ...file.sources.zen };

  const { entries, added, removed } = buildIndex(file.entries, contributions, now);
  file.entries = entries;
  file.builtAt = now;
  if (added.length || removed.length) file.lastChange = { added, removed, at: now };
  persist();
  return file;
}

/** True when the index has not been built inside a day. */
export const indexStale = (now: Date = new Date()): boolean => clientIndexStale(state(), now);

let rebuilding: Promise<unknown> | null = null;

/**
 * Rebuilds if it is stale, at most once at a time.
 *
 * Started rather than awaited by the caller: a keystroke must not wait for
 * four suppliers. The first search of the day is answered from yesterday's
 * file, which is exactly as good, and tomorrow's is already being fetched.
 */
export function refreshIfStale(): void {
  if (rebuilding || !indexStale()) return;
  rebuilding = rebuildClientIndex()
    .catch(() => undefined)
    .finally(() => {
      rebuilding = null;
    });
}

/* ------------------------------------------------------------------ *
 * Learning from ordinary use
 * ------------------------------------------------------------------ */

/**
 * Teaches the index what a lookup just proved.
 *
 * This is what covers Zen and Giacom, who publish no customer list. Somebody
 * looking up a premises establishes the client name, the postcode, the UPRN
 * and every service reference at it — all four of the things the index wants,
 * confirmed against live data rather than a stale export.
 *
 * Never throws and never blocks: it rides on a report that has already been
 * built and returned.
 */
export function learnFromReport(report: SiteReport): void {
  try {
    const name = report.address.organisation?.trim() || report.address.buildingName?.trim();
    if (!name) return;

    const refs = report.lines
      .map((line: LineRecord) => line.serviceId ?? line.orderRef)
      .filter((ref): ref is string => Boolean(ref));

    const file = state();
    const key = clientKey(name);
    if (!key) return;

    const existing = file.entries.find((e) => e.key === key);
    const updated = foldContribution(
      existing,
      {
        name,
        source: 'learned',
        sites: [
          {
            name: report.address.dependentLocality ?? report.address.postTown ?? report.address.postcode,
            postcode: report.address.postcode,
            ...(report.uprn ?? report.address.uprn ? { uprn: report.uprn ?? report.address.uprn! } : {}),
            address: report.address.singleLine,
          },
        ],
        serviceRefs: refs,
      },
      new Date().toISOString(),
    );

    file.entries = existing
      ? file.entries.map((e) => (e.key === key ? updated : e))
      : [...file.entries, updated].sort((a, b) => a.name.localeCompare(b.name));
    persist();
  } catch {
    // A lookup must not fail because the index could not learn from it.
  }
}

/* ------------------------------------------------------------------ *
 * Reading it
 * ------------------------------------------------------------------ */

/** Clients matching a typed term. Local, so it costs nothing. */
export function findClients(term: string, limit = 6): ClientIndexEntry[] {
  refreshIfStale();
  return searchClients(state().entries, term, limit);
}

/** What the admin page shows: size, age, and which sources answered. */
export function clientIndexStatus(): {
  entries: number;
  sites: number;
  builtAt?: string;
  stale: boolean;
  sources: ClientIndexFile['sources'];
  lastChange?: ClientIndexFile['lastChange'];
} {
  const file = state();
  return {
    entries: file.entries.length,
    sites: file.entries.reduce((total, entry) => total + entry.sites.length, 0),
    ...(file.builtAt ? { builtAt: file.builtAt } : {}),
    stale: clientIndexStale(file),
    sources: file.sources,
    ...(file.lastChange ? { lastChange: file.lastChange } : {}),
  };
}

/** Test hooks. */
export function resetClientIndex(): void {
  cache = emptyClientIndex();
  persist();
}

export function reloadClientIndex(): void {
  cache = null;
}
