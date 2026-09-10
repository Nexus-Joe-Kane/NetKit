import {
  matchSites,
  resolveClient,
  type AddressRecord,
  type DocumentedLocation,
  type MatchConfidence,
  type NetworkSite,
  type SectionStatus,
  type SiteCandidate,
  type SiteContext,
} from '@sw/shared';
import { documentedClient, documentedClientOptions, itGlueConfigured } from '../providers/docs/itGlue';
import { devicesForHost, networkSites, unifiConfigured, wanHealth } from '../providers/network/unifi';

/**
 * What we hold about a customer's site, gathered from every system that
 * knows about it.
 *
 * Assembled per premises rather than per company, because that is the
 * question an engineer actually asks: not "what does this client have" but
 * "what is at this address".
 *
 * Both halves degrade on their own. An equipment list is worth having
 * without the documentation, and the documentation is worth having when the
 * controller is unreachable, so neither failure takes the other down.
 *
 * Every match carries its confidence, because the join between these
 * systems is a company name and a name is not an id. A weak match is shown
 * with its reason and never presented as fact — attaching one restaurant's
 * kit to another's report is the failure mode worth designing against.
 */

const ok = (mode: 'live' | 'skipped', durationMs?: number): SectionStatus => ({
  ok: true,
  mode,
  ...(durationMs !== undefined ? { durationMs } : {}),
});

const failed = (error: unknown): SectionStatus => ({
  ok: false,
  mode: 'live',
  error: error instanceof Error ? error.message : String(error),
});

/** A documented location, in the shape the site matcher understands. */
function asCandidate(location: DocumentedLocation): SiteCandidate {
  return {
    id: location.id,
    name: location.name,
    ...(location.postcode ? { postcode: location.postcode } : {}),
    ...(location.addressLines.length || location.city
      ? { address: [...location.addressLines, location.city].filter(Boolean).join(', ') }
      : {}),
    ...(location.region ? { labels: [location.region] } : {}),
  };
}

/**
 * A controller site as a candidate.
 *
 * No postcode, because Site Manager holds none — the name and the ISP name
 * are all there is to go on, which is exactly the case the site matcher
 * falls back to.
 */
function siteAsCandidate(site: NetworkSite): SiteCandidate {
  const labels = [site.description, site.isp?.name, site.isp?.organisation].filter((l): l is string => Boolean(l));
  return { id: site.siteId, name: site.name, ...(labels.length ? { labels } : {}) };
}

export async function buildSiteContext(input: {
  /** The company name to join on, usually the premises organisation. */
  name: string;
  address: AddressRecord;
}): Promise<SiteContext> {
  const query = input.name.trim();

  const documentation = await gatherDocumentation(query, input.address);
  const network = await gatherNetwork(query, input.address);

  return {
    query,
    ...documentation.value,
    ...network.value,
    status: { documentation: documentation.status, network: network.status },
    generatedAt: new Date().toISOString(),
  };
}

async function gatherDocumentation(
  query: string,
  address: AddressRecord,
): Promise<{ value: Partial<SiteContext>; status: SectionStatus }> {
  if (!itGlueConfigured()) return { value: {}, status: ok('skipped') };
  if (!query) {
    return {
      value: {},
      status: {
        ok: true,
        mode: 'skipped',
        error: 'This premises has no organisation name, so there is nothing to look the documentation up by.',
      },
    };
  }

  const started = Date.now();
  try {
    const client = await documentedClient(query);
    if (!client) {
      // Nothing matched confidently. The options are worth returning: an
      // engineer who knows the customer can pick, where the matcher could
      // only have guessed.
      const options = await documentedClientOptions(query).catch(() => []);
      return {
        value: options.length ? { documentedOptions: options } : {},
        status: ok('live', Date.now() - started),
      };
    }

    const { match } = matchSites(client.locations.map(asCandidate), address);
    const location = match ? client.locations.find((l) => l.id === match.site.id) : undefined;

    return {
      value: {
        documented: client,
        ...(location && match
          ? {
              documentedLocation: {
                location,
                confidence: match.confidence as MatchConfidence,
                reason: match.reason,
              },
            }
          : {}),
      },
      status: ok('live', Date.now() - started),
    };
  } catch (err) {
    return { value: {}, status: failed(err) };
  }
}

async function gatherNetwork(
  query: string,
  address: AddressRecord,
): Promise<{ value: Partial<SiteContext>; status: SectionStatus }> {
  if (!unifiConfigured()) return { value: {}, status: ok('skipped') };

  const started = Date.now();
  try {
    const all = await networkSites();
    if (!all.length) return { value: {}, status: ok('live', Date.now() - started) };

    /*
     * Two narrowings, in this order.
     *
     * The company name first, because a site called "Mayfair" exists on more
     * than one customer's account and the whole estate is in one list here.
     * Then the premises, among that company's sites. Doing it the other way
     * round would match a locality across customers, which is the mistake
     * that puts one restaurant's kit on another's report.
     *
     * Where the name matches nothing, every site is a candidate for the
     * premises match — a site named after the address is still worth finding
     * when the company name in the controller bears no resemblance to the
     * one in AddressBase, which happens whenever a group trades under
     * several brands.
     */
    const byClient = query ? resolveClient(all, query, (site) => site.name) : { match: null, options: [] };
    const scoped = byClient.options.length ? byClient.options.map((o) => o.record) : all;

    const { match } = matchSites(scoped.map(siteAsCandidate), address);
    const site = match ? scoped.find((s) => s.siteId === match.site.id) : undefined;

    if (!site || !match) {
      return { value: { networkSites: scoped }, status: ok('live', Date.now() - started) };
    }

    // Only now is anything fetched per site: the device list and the WAN
    // feed are both a request each, and neither is worth making until there
    // is a site to make it about.
    const [devices, wan] = await Promise.all([
      devicesForHost(site.hostId, site.siteId).catch(() => []),
      wanHealth(site.hostId, site.siteId).catch(() => null),
    ]);

    return {
      value: {
        networkSites: scoped,
        networkSite: { site, confidence: match.confidence as MatchConfidence, reason: match.reason },
        ...(devices.length ? { devices } : {}),
        ...(wan ? { wan } : {}),
      },
      status: ok('live', Date.now() - started),
    };
  } catch (err) {
    return { value: {}, status: failed(err) };
  }
}
