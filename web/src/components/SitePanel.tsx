import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { matchBanner, type DocumentedConfiguration, type NetworkDevice, type SiteContext } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, Empty, Label, Spinner, formatDateTime, type ChipTone } from './ui';
import { Tabs, TabPanel, type TabDef } from './Tabs';

/**
 * What is at this site: what the documentation says, and what the network
 * says.
 *
 * Kept as two halves rather than merged into one list, because they
 * disagree. The documentation is what somebody wrote down, possibly two
 * years ago; the controller is what is plugged in this minute. A merged view
 * would have to pick a winner for every field and would be wrong about half
 * of them, so both are shown and labelled and the engineer decides.
 *
 * Every match carries its confidence in the open, because the join between
 * these systems is a company name and a name is not an id. The failure mode
 * worth designing against is one restaurant's kit appearing under another's
 * address, so a weak match says it is weak.
 */

type SiteTab = 'equipment' | 'documented' | 'wan' | 'credentials' | 'sites';

const CONFIDENCE_TONE: Record<string, ChipTone> = {
  exact: 'ok',
  strong: 'ok',
  weak: 'warn',
  none: 'crit',
};

export function SitePanel({ uprn, clientName }: { uprn?: string; clientName?: string }): ReactElement {
  const [context, setContext] = useState<SiteContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SiteTab>('equipment');
  const [nameOverride, setNameOverride] = useState('');

  const load = useCallback(
    async (name?: string) => {
      if (!uprn) return;
      setLoading(true);
      setError(null);
      try {
        setContext(await api.siteContext(uprn, name));
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load what is at this site.');
      } finally {
        setLoading(false);
      }
    },
    [uprn],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!uprn) {
    return (
      <Card title="What is at this site" eyebrow="Documentation and network" index="05" accent={4}>
        <Empty title="No UPRN">
          This premises has no UPRN, so there is nothing stable to look its documentation up by.
        </Empty>
      </Card>
    );
  }

  if (loading && !context) return <Spinner label="Reading the documentation and the controller" />;

  const bothOff =
    context?.status.documentation.mode === 'skipped' && context?.status.network.mode === 'skipped';

  const tabs: Array<TabDef<SiteTab>> = [
    {
      id: 'equipment',
      label: 'Equipment',
      ...(context?.devices?.length ? { count: context.devices.length } : {}),
    },
    {
      id: 'documented',
      label: 'Documented',
      ...(context?.documented?.configurations.length ? { count: context.documented.configurations.length } : {}),
    },
    { id: 'wan', label: 'Internet' },
    {
      id: 'credentials',
      label: 'Credentials',
      ...(context?.documented?.credentials.length ? { count: context.documented.credentials.length } : {}),
    },
    {
      id: 'sites',
      label: 'Other sites',
      ...(context?.networkSites?.length ? { count: context.networkSites.length } : {}),
    },
  ];

  return (
    <Card
      title="What is at this site"
      eyebrow={context?.documented?.name ?? clientName ?? 'Documentation and network'}
      index="05"
      accent={4}
      meta={
        <button type="button" className="btn btn--ghost btn--small" onClick={() => void load(nameOverride || undefined)}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      }
      tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Site sections" />}
    >
      <TabPanel>
        {error && <Alert tone="error">{error}</Alert>}

        {bothOff && (
          <Alert tone="info">
            Neither IT Glue nor UniFi Site Manager is connected. Add their keys in Admin portal → Credentials and
            this fills in — there is nothing else to configure.
          </Alert>
        )}

        {context && <MatchBanner context={context} onSearch={(name) => { setNameOverride(name); void load(name); }} />}

        {tab === 'equipment' && <EquipmentTab context={context} />}
        {tab === 'documented' && <DocumentedTab context={context} />}
        {tab === 'wan' && <WanTab context={context} />}
        {tab === 'credentials' && <CredentialsTab context={context} />}
        {tab === 'sites' && <SitesTab context={context} />}
      </TabPanel>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * How sure are we that this is the right company and site?
 * ------------------------------------------------------------------ */

function MatchBanner({
  context,
  onSearch,
}: {
  context: SiteContext;
  onSearch: (name: string) => void;
}): ReactElement | null {
  const [name, setName] = useState(context.query);

  // The decision lives in `matchBanner`, tested, because it has four
  // outcomes with a real order of precedence and one of them used to be
  // wrong: with nothing connected the panel claimed nothing matched.
  const banner = matchBanner(context);
  const ambiguous = banner === 'ambiguous';
  const nothing = banner === 'no-match';

  if (banner === 'none') return null;

  if (banner === 'matched') {
    // Matched confidently. Say what to, quietly, and get out of the way.
    return (
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {context.documentedLocation && (
          <Chip tone={CONFIDENCE_TONE[context.documentedLocation.confidence] ?? 'idle'}>
            IT Glue: {context.documentedLocation.location.name} — {context.documentedLocation.reason}
          </Chip>
        )}
        {context.networkSite && (
          <Chip tone={CONFIDENCE_TONE[context.networkSite.confidence] ?? 'idle'}>
            UniFi: {context.networkSite.site.name} — {context.networkSite.reason}
          </Chip>
        )}
      </div>
    );
  }

  return (
    <div className="flag flag--warn" style={{ marginBottom: 14 }}>
      <span className="flag__marker" aria-hidden="true" />
      <span>
        <strong>
          {ambiguous
            ? `More than one organisation could be “${context.query}”`
            : nothing
              ? `Nothing matched “${context.query}”`
              : 'Matched, but not confidently'}
        </strong>
        <span className="flag__detail">
          {ambiguous ? (
            <>
              {context.documentedOptions!.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="btn btn--ghost btn--small"
                  style={{ marginRight: 6, marginTop: 6 }}
                  onClick={() => onSearch(o.name)}
                >
                  {o.name}
                </button>
              ))}
            </>
          ) : (
            <>
              These systems are joined on the company name, and the name here does not line up. Try the name as
              the customer is filed under in IT Glue or Site Manager.
            </>
          )}
        </span>
        <span className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <input
            className="field__input"
            style={{ maxWidth: 260 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Client name to search"
          />
          <button type="button" className="btn btn--primary btn--small" onClick={() => onSearch(name.trim())}>
            Look again
          </button>
        </span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The tabs
 * ------------------------------------------------------------------ */

const DEVICE_TONE = (status?: string): ChipTone =>
  status === 'online' ? 'ok' : status === 'offline' ? 'crit' : 'idle';

function EquipmentTab({ context }: { context: SiteContext | null }): ReactElement {
  const devices = context?.devices ?? [];
  if (!devices.length) {
    return (
      <Empty title="No equipment reported">
        {context?.status.network.mode === 'skipped'
          ? 'UniFi Site Manager is not connected, so there is nothing live to read.'
          : context?.networkSite
            ? 'The controller has this site but reports no devices on its console.'
            : 'No controller site could be tied to this premises, so there is no console to read equipment from.'}
      </Empty>
    );
  }

  return (
    <>
      {context?.networkSite && (
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px', maxWidth: 700 }}>
          Live from the console managing <strong>{context.networkSite.site.name}</strong>. Site Manager keys
          equipment to a console rather than a site, so where one console serves several sites this is the
          console's whole list.
        </p>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Device</th>
              <th>Model</th>
              <th>State</th>
              <th className="col-optional">IP</th>
              <th className="col-optional">Firmware</th>
              <th className="col-optional">Since</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DeviceRow({ device }: { device: NetworkDevice }): ReactElement {
  return (
    <tr>
      <td>
        <strong style={{ color: 'var(--sw-ink)' }}>{device.name}</strong>
        {device.note && <div className="muted" style={{ fontSize: 11.5 }}>{device.note}</div>}
      </td>
      <td>
        {device.model ?? device.shortModel ?? '—'}
        {device.isConsole && (
          <>
            {' '}
            <Chip tone="info">console</Chip>
          </>
        )}
      </td>
      <td>
        <Chip tone={DEVICE_TONE(device.status)} dot>
          {device.status ?? 'unknown'}
        </Chip>
      </td>
      <td className="col-optional sw-mono">{device.ip ?? '—'}</td>
      <td className="col-optional">
        {device.firmware ?? '—'}
        {device.updateAvailable && (
          <>
            {' '}
            <Chip tone="warn">{device.updateAvailable} available</Chip>
          </>
        )}
      </td>
      {/* There is no uptime field in this API — the boot time is what it publishes. */}
      <td className="col-optional">{formatDateTime(device.startedAt) ?? '—'}</td>
    </tr>
  );
}

function DocumentedTab({ context }: { context: SiteContext | null }): ReactElement {
  const documented = context?.documented;
  if (!documented) {
    return (
      <Empty title="Nothing documented here">
        {context?.status.documentation.mode === 'skipped'
          ? context.status.documentation.error ??
            'IT Glue is not connected, so there is no documentation to read.'
          : `No IT Glue organisation matched “${context?.query ?? ''}”.`}
      </Empty>
    );
  }

  const location = context?.documentedLocation?.location;
  const rows = location
    ? // Where a location matched, lead with its own kit and keep the rest.
      [
        ...documented.configurations.filter((c) => c.locationId === location.id),
        ...documented.configurations.filter((c) => c.locationId !== location.id),
      ]
    : documented.configurations;

  if (!rows.length) {
    return <Empty title="No configurations documented">IT Glue has this client but no equipment against it.</Empty>;
  }

  return (
    <>
      <div className="kv" style={{ marginBottom: 12 }}>
        <Cell label="Organisation" value={documented.name} />
        {documented.status && <Cell label="Status" value={documented.status} />}
        <Cell label="Matched" value={documented.matchReason} />
        {location && <Cell label="This premises is" value={location.name} />}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th className="col-optional">Hostname</th>
              <th className="col-optional">IP</th>
              <th className="col-optional">Serial</th>
              <th>At</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ConfigurationRow key={row.id} row={row} atThisSite={row.locationId === location?.id} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0', maxWidth: 700 }}>
        This is what was written down, not what is plugged in. Where it disagrees with the Equipment tab, the
        Equipment tab is the network and this is the record of it.
      </p>
    </>
  );
}

function ConfigurationRow({
  row,
  atThisSite,
}: {
  row: DocumentedConfiguration;
  atThisSite: boolean;
}): ReactElement {
  return (
    <tr style={atThisSite ? undefined : { opacity: 0.72 }}>
      <td>
        {row.url ? (
          <a href={row.url} target="_blank" rel="noreferrer">
            <strong>{row.name}</strong>
          </a>
        ) : (
          <strong style={{ color: 'var(--sw-ink)' }}>{row.name}</strong>
        )}
        {row.manufacturer && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            {[row.manufacturer, row.model].filter(Boolean).join(' ')}
          </div>
        )}
      </td>
      <td>{row.kind ?? '—'}</td>
      <td className="col-optional sw-mono">{row.hostname ?? '—'}</td>
      <td className="col-optional sw-mono">{row.primaryIp ?? '—'}</td>
      <td className="col-optional sw-mono">{row.serialNumber ?? '—'}</td>
      <td>{atThisSite ? <Chip tone="ok">this site</Chip> : (row.locationName ?? 'no location')}</td>
    </tr>
  );
}

function WanTab({ context }: { context: SiteContext | null }): ReactElement {
  const wan = context?.wan;
  const site = context?.networkSite?.site;

  if (!wan && !site) {
    return (
      <Empty title="No internet data">
        {context?.status.network.mode === 'skipped'
          ? 'UniFi Site Manager is not connected.'
          : 'No controller site could be tied to this premises.'}
      </Empty>
    );
  }

  const minutes = wan ? Math.round(wan.downtimeSeconds / 60) : 0;

  return (
    <>
      <div className="kv">
        {site?.isp?.name && <Cell label="ISP the controller sees" value={site.isp.name} />}
        {site?.gateway?.model && <Cell label="Gateway" value={site.gateway.model} />}
        {wan?.latest?.uptimePercent !== undefined && (
          <Cell label="Uptime, latest sample" value={`${wan.latest.uptimePercent}%`} />
        )}
        {wan && <Cell label="Downtime, last 24 hours" value={minutes ? `${minutes} minutes` : 'none recorded'} />}
        {wan?.latest?.averageLatencyMs !== undefined && (
          <Cell label="Latency, average" value={`${wan.latest.averageLatencyMs} ms`} />
        )}
        {wan?.latest?.maxLatencyMs !== undefined && (
          <Cell label="Latency, worst" value={`${wan.latest.maxLatencyMs} ms`} />
        )}
        {wan?.latest?.packetLossPercent !== undefined && (
          <Cell label="Packet loss" value={`${wan.latest.packetLossPercent}%`} />
        )}
        {site?.wanUptimePercent !== undefined && (
          <Cell label="Uptime the site reports" value={`${site.wanUptimePercent}%`} />
        )}
        {wan?.latest?.at && <Cell label="Last sample" value={formatDateTime(wan.latest.at) ?? wan.latest.at} />}
      </div>

      {site?.internetIssues && (
        <Alert tone="warn">The controller is reporting current internet trouble at this site.</Alert>
      )}

      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0', maxWidth: 700 }}>
        Site Manager publishes no live WAN interface state, so this is uptime and latency over a window rather
        than “the WAN is up right now”. Downtime in the last day is the useful number: it is what tells you
        whether a fault the customer reported actually happened.
      </p>
    </>
  );
}

function CredentialsTab({ context }: { context: SiteContext | null }): ReactElement {
  const credentials = context?.documented?.credentials ?? [];
  if (!credentials.length) {
    return <Empty title="No credentials documented">IT Glue has none recorded against this client.</Empty>;
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>What it is</th>
              <th>Username</th>
              <th className="col-optional">Category</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {credentials.map((credential) => (
              <tr key={credential.id}>
                <td>
                  <strong style={{ color: 'var(--sw-ink)' }}>{credential.name}</strong>
                  {credential.url && <div className="muted" style={{ fontSize: 11.5 }}>{credential.url}</div>}
                </td>
                <td className="sw-mono">{credential.username ?? '—'}</td>
                <td className="col-optional">{credential.category ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  {credential.documentationUrl && (
                    <a
                      className="btn btn--ghost btn--small"
                      href={credential.documentationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in IT Glue
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0', maxWidth: 700 }}>
        Names and usernames only — NetKit never asks IT Glue for a password value, on any endpoint. Open it in IT
        Glue when you need one: that logs who read it, and pulling secrets through a second system would double
        the places they can leak from and halve the audit trail.
      </p>
    </>
  );
}

function SitesTab({ context }: { context: SiteContext | null }): ReactElement {
  const sites = context?.networkSites ?? [];
  const locations = context?.documented?.locations ?? [];

  if (!sites.length && !locations.length) {
    return <Empty title="No other sites">Nothing else is recorded for this client in either system.</Empty>;
  }

  return (
    <div className="stack stack--tight">
      {sites.length > 0 && (
        <div>
          <Label>Controller sites</Label>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Devices</th>
                  <th className="col-optional">Clients</th>
                  <th>Uptime</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.siteId}>
                    <td>
                      <strong style={{ color: 'var(--sw-ink)' }}>{site.name}</strong>
                      {site.siteId === context?.networkSite?.site.siteId && (
                        <>
                          {' '}
                          <Chip tone="ok">this premises</Chip>
                        </>
                      )}
                    </td>
                    <td>
                      {site.counts?.totalDevices ?? '—'}
                      {site.counts?.offlineDevices ? (
                        <>
                          {' '}
                          <Chip tone="crit">{site.counts.offlineDevices} offline</Chip>
                        </>
                      ) : null}
                    </td>
                    <td className="col-optional">
                      {(site.counts?.wiredClients ?? 0) + (site.counts?.wifiClients ?? 0) || '—'}
                    </td>
                    <td>{site.wanUptimePercent !== undefined ? `${site.wanUptimePercent}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {locations.length > 0 && (
        <div>
          <Label>Documented locations</Label>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Address</th>
                  <th className="col-optional">Postcode</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((location) => (
                  <tr key={location.id}>
                    <td>
                      <strong style={{ color: 'var(--sw-ink)' }}>{location.name}</strong>
                      {location.primary && (
                        <>
                          {' '}
                          <Chip tone="info">primary</Chip>
                        </>
                      )}
                    </td>
                    <td>{[...location.addressLines, location.city].filter(Boolean).join(', ') || '—'}</td>
                    <td className="col-optional sw-mono">{location.postcode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
