import {
  clientKey,
  deviceKind,
  deviceKindLabel,
  displayName,
  headcount,
  ticketRate,
  type ClientIndexEntry,
  type ClientProfile,
  type NetworkDevice,
  type TicketStats,
} from '@sw/shared';
import { documentedClient, itGlueConfigured } from '../providers/docs/itGlue';
import { devicesForHost, networkSites, unifiConfigured } from '../providers/network/unifi';
import { clientContextByName, zendeskConfigured } from '../providers/tickets/zendesk';
import { assignmentsForClient } from './assignments';
import { findClients } from './clientIndex';
import * as ops from './operations';

/**
 * Everything we hold about one customer, gathered once.
 *
 * The tab this feeds exists because nothing else answers "tell me about this
 * client". The lookup answers "what is at this address", which is a
 * different question and the wrong one when somebody rings about their
 * contract, their headcount, or how many tickets they raised last month.
 *
 * Every source is gathered independently and every failure is recorded
 * rather than thrown. A client page with the SIMs missing is worth having; a
 * client page that will not load because IT Glue returned a 401 is worth
 * nothing, and the page can say which source failed rather than looking
 * identical to a customer we genuinely hold nothing about.
 */

/** How many Office 365 users the documentation records for a client. */
function licenceCount(client: Awaited<ReturnType<typeof documentedClient>>): number | undefined {
  if (!client) return undefined;

  /*
   * IT Glue has no headcount field. What it has is a configuration or asset
   * per licensed user for tenants that sync Microsoft 365, so the count of
   * those is the estimate. Matched on the kind rather than the name,
   * because a tenant that renamed the asset type would otherwise report
   * zero and read as "no staff".
   */
  const users = client.configurations.filter((c) =>
    /\b(office\s*365|microsoft\s*365|o365|m365|mailbox|licen[cs]e)\b/i.test(`${c.kind ?? ''} ${c.name}`),
  );
  return users.length || undefined;
}

export async function buildClientProfile(input: { key?: string; name: string }): Promise<ClientProfile> {
  const generatedAt = new Date().toISOString();
  const sources: ClientProfile['sources'] = [];

  // The local index is the anchor: it already knows the aliases, the sites
  // and which supplier references belong to this client.
  const [indexed] = findClients(input.key ?? input.name, 1);
  const entry: ClientIndexEntry =
    indexed ??
    ({
      key: input.key ?? clientKey(input.name),
      name: input.name,
      aliases: [],
      sites: [],
      serviceRefs: [],
      sources: [],
      seenAt: generatedAt,
    } satisfies ClientIndexEntry);

  // Addresses somebody has pinned to this client count as sites too.
  for (const assignment of assignmentsForClient(entry.key)) {
    const already = entry.sites.some((s) => s.uprn === assignment.uprn);
    if (already) continue;
    entry.sites = [
      ...entry.sites,
      {
        name: assignment.siteName ?? assignment.addressLine ?? assignment.uprn,
        uprn: assignment.uprn,
        ...(assignment.postcode ? { postcode: assignment.postcode } : {}),
        ...(assignment.addressLine ? { address: assignment.addressLine } : {}),
      },
    ];
  }

  const profile: ClientProfile = {
    entry,
    display: displayName(entry),
    staff: headcount({}),
    sources,
    generatedAt,
  };

  /* ---- The documentation ------------------------------------------- */
  let licences: number | undefined;
  if (!itGlueConfigured()) {
    sources.push({ name: 'IT Glue', ok: true, detail: 'not connected' });
  } else {
    try {
      const documented = await documentedClient(entry.name);
      if (documented) {
        const locationName = new Map(documented.locations.map((l) => [l.id, l.name]));
        profile.configurations = documented.configurations.slice(0, 200).map((c) => ({
          id: c.id,
          name: c.name,
          ...(c.kind ? { type: c.kind } : {}),
          ...(c.hostname ? { hostname: c.hostname } : {}),
          ...(c.primaryIp ? { ip: c.primaryIp } : {}),
          ...(c.locationId && locationName.get(c.locationId) ? { siteName: locationName.get(c.locationId)! } : {}),
        }));
        // How many, never which — and never a value. An engineer opens IT
        // Glue to read a password, so the read is logged there.
        profile.credentialCount = documented.credentials.length;
        licences = licenceCount(documented);
      }
      sources.push({ name: 'IT Glue', ok: true, ...(documented ? {} : { detail: 'no matching organisation' }) });
    } catch (err) {
      sources.push({ name: 'IT Glue', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /* ---- The consoles ------------------------------------------------- */
  if (!unifiConfigured()) {
    sources.push({ name: 'UniFi', ok: true, detail: 'not connected' });
  } else {
    try {
      const sites = await networkSites();
      const theirs = sites.filter((site) => clientKey(site.name) === entry.key || findClients(site.name, 1)[0]?.key === entry.key);

      const devices: NonNullable<ClientProfile['devices']> = [];
      for (const site of theirs.slice(0, 8)) {
        const kit = await devicesForHost(site.hostId).catch(() => [] as NetworkDevice[]);
        for (const device of kit) {
          devices.push({
            id: device.id,
            name: device.name,
            ...(device.model ? { model: device.model } : {}),
            kind: deviceKindLabel(deviceKind(device)),
            siteName: site.name,
            ...(device.status ? { status: device.status } : {}),
          });
        }
      }
      if (devices.length) profile.devices = devices;
      sources.push({
        name: 'UniFi',
        ok: true,
        ...(theirs.length ? {} : { detail: 'no site matched this client' }),
      });
    } catch (err) {
      sources.push({ name: 'UniFi', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  /* ---- The SIMs ----------------------------------------------------- */
  try {
    const estate = await ops.simEstate();
    const theirs = estate.data.sims.filter((sim) => sim.clientName && clientKey(sim.clientName) === entry.key);
    if (theirs.length) {
      profile.sims = theirs.map((sim) => ({
        ...(sim.msisdn ? { msisdn: sim.msisdn } : {}),
        ...(sim.iccid ? { iccid: sim.iccid } : {}),
        ...(sim.network ? { operator: sim.network } : {}),
        ...(sim.tariff ? { tariff: sim.tariff } : {}),
        ...(sim.state ? { state: sim.state } : {}),
        ...(sim.usedPercentReported !== undefined ? { usedPercent: sim.usedPercentReported } : {}),
      }));
    }
    sources.push({ name: 'Jola', ok: true, ...(theirs.length ? {} : { detail: 'no SIMs on this client' }) });
  } catch (err) {
    sources.push({ name: 'Jola', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  /* ---- The helpdesk ------------------------------------------------- */
  if (!zendeskConfigured()) {
    sources.push({ name: 'Zendesk', ok: true, detail: 'not connected' });
  } else {
    try {
      const context = await clientContextByName(entry.name);
      if (context) {
        const requesters = new Map<string, number>();
        for (const ticket of context.openTickets) {
          const who = ticket.requesterName ?? ticket.requesterEmail;
          if (who) requesters.set(who, (requesters.get(who) ?? 0) + 1);
        }

        const stats: TicketStats = {
          open: context.openTicketCount,
          // What is fetched is the open queue, not a 30-day history: Zendesk
          // will not give a count without a search, and a search per client
          // page is a request nobody needs. Stated rather than inflated.
          raisedRecently: context.openTicketCount,
          solvedRecently: 0,
          ...(requesters.size
            ? {
                topRequesters: [...requesters.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([name, tickets]) => ({ name, tickets })),
              }
            : {}),
        };
        profile.tickets = stats;
        // The contact count as a headcount fallback, flagged by `headcount`.
        profile.staff = headcount({
          ...(licences !== undefined ? { licences } : {}),
          ...(requesters.size ? { helpdeskContacts: requesters.size } : {}),
        });
        const rate = ticketRate(stats, profile.staff);
        if (rate) profile.rate = rate;
      }
      sources.push({ name: 'Zendesk', ok: true, ...(context ? {} : { detail: 'no matching organisation' }) });
    } catch (err) {
      sources.push({ name: 'Zendesk', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // Where the helpdesk did not answer, the licence count still stands.
  if (profile.staff.basis === 'none' && licences !== undefined) {
    profile.staff = headcount({ licences });
  }

  /* ---- What we supply ---------------------------------------------- */
  if (entry.serviceRefs.length) {
    profile.services = entry.serviceRefs.slice(0, 40).map((reference) => ({
      reference,
      supplier: /^\d/.test(reference) ? 'Giacom' : 'Zen',
    }));
  }

  return profile;
}
