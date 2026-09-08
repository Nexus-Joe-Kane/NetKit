import { config, type GiacomScope, type ZenScope } from '../config';
import { zenPing } from '../providers/zen/client';
import { zenAvailabilityQuota } from '../providers/zen/adapters';
import { isProviderEnabled, settings } from '../auth/store';
import { fetchJson } from '../lib/http';
import { datasetStatus } from '../providers/signal/ofcom';
import { giacomPing } from '../providers/giacom/client';

/**
 * Service status for the admin portal.
 *
 * Every integration the portal can talk to is listed here, whether or not it
 * is configured, so the admin page doubles as the "what still needs
 * credentials" checklist. Probes are cheap and run in parallel.
 */

export type ServiceState = 'ok' | 'degraded' | 'down' | 'not_configured' | 'disabled';

export interface ServiceStatus {
  /** Stable key used by the toggle endpoint. */
  key: string
  name: string;
  vendor:
    | 'Zen'
    | 'BT'
    | 'Jola'
    | 'Ofcom'
    | 'Ordnance Survey'
    | 'postcodes.io'
    | 'Companies House'
    | 'thinkbroadband'
    | 'Giacom'
    | 'Resend'
    | 'Internal';
  /** What this integration gives the portal. */
  capability: string;
  state: ServiceState;
  detail: string;
  /** Whether an admin has switched this off. */
  enabled: boolean;
  /** True when credentials are present. */
  configured: boolean;
  latencyMs?: number;
  /** Documentation or signup link, for anything not yet connected. */
  docsUrl?: string;
  checkedAt: string;
  /** Extra provider-specific facts, e.g. the Zen fair-use quota. */
  meta?: Record<string, unknown>;
}

interface Probe {
  key: string;
  name: string;
  vendor: ServiceStatus['vendor'];
  capability: string;
  docsUrl?: string;
  configured: () => boolean;
  /** Returns state + detail. Only called when configured and enabled. */
  run: () => Promise<{ state: ServiceState; detail: string; meta?: Record<string, unknown> }>;
}

const zenScopeProbe = (key: string, name: string, capability: string, scope: ZenScope): Probe => ({
  key,
  name,
  vendor: 'Zen',
  capability,
  docsUrl: 'https://apidocs.zen.co.uk/',
  configured: () => config().zen.configured && config().zen.scopes.includes(scope),
  run: async () => {
    const result = await zenPing(scope);
    return result.ok
      ? { state: 'ok' as const, detail: `Authenticated for ${scope}.` }
      : { state: 'down' as const, detail: result.detail };
  },
});

/**
 * Giacom grant each of their twenty-one scopes individually, so every
 * capability gets its own probe. A credential that works for the service
 * inventory can still be refused serviceability, and the board should say
 * which one rather than reporting "Giacom" as one thing.
 */
const giacomScopeProbe = (key: string, name: string, capability: string, scope: GiacomScope): Probe => ({
  key,
  name,
  vendor: 'Giacom',
  capability,
  docsUrl: 'https://docs.integrations.giacom.com/',
  configured: () => config().giacom.configured && config().giacom.scopes.includes(scope),
  run: async () => {
    const result = await giacomPing(scope);
    return result.ok
      ? { state: 'ok' as const, detail: `Authenticated for ${scope}.` }
      : { state: 'down' as const, detail: result.detail };
  },
});

function probes(): Probe[] {
  const cfg = config();
  return [
    // ---- Zen ------------------------------------------------------------
    zenScopeProbe(
      'zen-availability',
      'Zen — Availability & address',
      'Postcode/UPRN address search, WBC + Openreach availability, number porting checks',
      'indirect-availability',
    ),
    zenScopeProbe('zen-service', 'Zen — Services & ceases', 'Existing line lookup by CLI, service ID, postcode or Zen reference', 'indirect-service'),
    zenScopeProbe('zen-diagnostics', 'Zen — Diagnostics (Assurance)', 'Copper line tests, xDSL/TAM/KBD tests, FTTP and SOGEA service tests', 'indirect-diagnostics'),
    zenScopeProbe('zen-faults', 'Zen — Faults & outages (Assurance)', 'Open faults, fault raising, major service outages, planned engineering work', 'indirect-faults'),
    zenScopeProbe('zen-broadbandconnection', 'Zen — Connection & SIMs', 'RADIUS state, IP allocations, router config, cellular SIM usage (Jola-backed)', 'indirect-broadbandconnection'),
    zenScopeProbe('zen-order', 'Zen — Orders', 'Order search, status, WIP report and cancellation', 'indirect-order'),
    zenScopeProbe('zen-placeorder', 'Zen — Product ordering', 'Placing provide orders and retrieving pricing', 'indirect-placeorder'),
    zenScopeProbe('zen-cdr', 'Zen — Call records', 'Call data records for voice services', 'indirect-cdr'),
    zenScopeProbe('zen-quote', 'Zen — Ethernet quotes', 'Ethernet / leased line quotations', 'indirect-quote'),
    zenScopeProbe(
      'zen-customerengagement',
      'Zen — Provider notices',
      'Price changes, product withdrawals, stop-sell and migration notices',
      'indirect-customerengagement',
    ),
    zenScopeProbe(
      'zen-changeservice',
      'Zen — Service changes',
      'Regrades and configuration changes to an existing service',
      'indirect-changeservice',
    ),

    // ---- Ordnance Survey ------------------------------------------------
    {
      key: 'os-places',
      name: 'OS Places',
      vendor: 'Ordnance Survey',
      capability: 'Authoritative UPRN lookup and free-text address search (AddressBase Premium)',
      docsUrl: 'https://osdatahub.os.uk/plans',
      configured: () => cfg.osPlaces.configured,
      run: async () => {
        const started = Date.now();
        const url = `${cfg.osPlaces.baseUrl}/postcode?postcode=SW1A1AA&maxresults=1&key=${encodeURIComponent(cfg.osPlaces.apiKey)}`;
        const res = await fetchJson<{ header?: { totalresults?: number } }>(url, {
          label: 'OS Places',
          timeoutMs: 8000,
          retries: 0,
          notFoundAsNull: true,
        });
        return {
          state: res ? ('ok' as const) : ('degraded' as const),
          detail: res ? 'Reachable and authenticated.' : 'Reachable but returned no results for the probe postcode.',
          meta: { probeMs: Date.now() - started },
        };
      },
    },

    // ---- Giacom ---------------------------------------------------------
    // Scopes are granted individually, so each capability is probed
    // separately: a working credential can still be refused one scope.
    giacomScopeProbe(
      'giacom-services',
      'Giacom — Service inventory',
      'Live and ceased services on the Giacom account, so a premises shows lines from both suppliers',
      'integrations/serviceInventory.read',
    ),
    giacomScopeProbe(
      'giacom-qualification',
      'Giacom — Serviceability',
      'Per-address availability across BT Wholesale, CityFibre, TalkTalk and Virgin Media Business',
      'integrations/serviceQualification.submit',
    ),
    giacomScopeProbe(
      'giacom-address',
      'Giacom — Address matching',
      'BT Wholesale address validation, returning the Openreach ALK for cross-checking Zen',
      'integrations/address.manage',
    ),
    giacomScopeProbe(
      'giacom-catalogue',
      'Giacom — Product catalogue',
      'Service specifications: what the Giacom account can sell',
      'integrations/serviceCatalogue.read',
    ),

    // ---- thinkbroadband -------------------------------------------------
    {
      key: 'thinkbroadband',
      name: 'thinkbroadband',
      vendor: 'thinkbroadband',
      capability: 'Alt-net and cable coverage — CityFibre, Virgin Media, Community Fibre, G.Network and others',
      docsUrl: 'https://www.thinkbroadband.com/broadband-availability-api',
      configured: () => cfg.thinkbroadband.configured,
      run: async () => {
        const started = Date.now();
        const query = new URLSearchParams({
          postcode: 'SW1A 1AA',
          ...(cfg.thinkbroadband.apiKeyInQuery ? { key: cfg.thinkbroadband.apiKey } : {}),
        });
        const res = await fetchJson<unknown>(
          `${cfg.thinkbroadband.baseUrl}${cfg.thinkbroadband.availabilityPath}?${query.toString()}`,
          {
            label: 'thinkbroadband',
            headers: cfg.thinkbroadband.apiKeyInQuery
              ? {}
              : { Authorization: `Bearer ${cfg.thinkbroadband.apiKey}`, 'X-API-Key': cfg.thinkbroadband.apiKey },
            timeoutMs: 8000,
            retries: 0,
            notFoundAsNull: true,
          },
        );
        return {
          state: res ? ('ok' as const) : ('degraded' as const),
          detail: res
            ? 'Reachable and authenticated.'
            : 'Reachable but returned nothing for the probe postcode — check the licence covers availability lookups.',
          meta: { probeMs: Date.now() - started },
        };
      },
    },

    // ---- Companies House ------------------------------------------------
    {
      key: 'companies-house',
      name: 'Companies House',
      vendor: 'Companies House',
      capability: 'Company status, incorporation, SIC codes and overdue filings at a premises',
      docsUrl: 'https://developer.company-information.service.gov.uk/',
      configured: () => cfg.companiesHouse.configured,
      run: async () => {
        const started = Date.now();
        // The API key is the Basic username with an empty password.
        const basic = Buffer.from(`${cfg.companiesHouse.apiKey}:`).toString('base64');
        const res = await fetchJson<{ company_name?: string }>(
          // Companies House's own company number, which will always exist.
          `${cfg.companiesHouse.baseUrl}/company/00000006`,
          {
            label: 'Companies House',
            headers: { Authorization: `Basic ${basic}` },
            timeoutMs: 8000,
            retries: 0,
            notFoundAsNull: true,
          },
        );
        return {
          state: res ? ('ok' as const) : ('degraded' as const),
          detail: res ? 'Reachable and authenticated.' : 'Reachable but the probe company was not returned.',
          meta: { probeMs: Date.now() - started },
        };
      },
    },

    // ---- postcodes.io ---------------------------------------------------
    {
      key: 'postcodes-io',
      name: 'postcodes.io',
      vendor: 'postcodes.io',
      capability: 'Free postcode geography — post town, ward, constituency, coordinates. No key required',
      docsUrl: 'https://postcodes.io/',
      configured: () => cfg.postcodesIo.enabled,
      run: async () => {
        const res = await fetchJson<{ result?: unknown }>(`${cfg.postcodesIo.baseUrl}/postcodes/SW1A1AA`, {
          label: 'postcodes.io',
          timeoutMs: 6000,
          retries: 0,
          notFoundAsNull: true,
        });
        return res?.result
          ? { state: 'ok' as const, detail: 'Reachable.' }
          : { state: 'degraded' as const, detail: 'Reachable but returned no result.' };
      },
    },

    // ---- Ofcom ----------------------------------------------------------
    {
      key: 'ofcom-coverage',
      name: 'Ofcom mobile coverage',
      vendor: 'Ofcom',
      capability:
        'Published per-operator coverage for voice, 4G and 5G, indoor and outdoor. Free Connected Nations open data — no account',
      docsUrl: 'https://www.ofcom.org.uk/research-and-data/multi-sector-research/infrastructure-research',
      configured: () => Boolean(cfg.ofcom.datasetPath || cfg.ofcom.apiBaseUrl),
      run: async () => {
        if (cfg.ofcom.apiBaseUrl && !cfg.ofcom.datasetPath) {
          return { state: 'ok' as const, detail: `Configured against ${cfg.ofcom.apiBaseUrl}.` };
        }
        const status = datasetStatus();
        if (!status.loaded) {
          return {
            state: 'down' as const,
            detail: `Dataset not readable at ${status.path ?? cfg.ofcom.datasetPath}. Download the Connected Nations postcode file and point OFCOM_DATASET_PATH at it.`,
          };
        }
        if (!status.columnsUnderstood) {
          return {
            state: 'degraded' as const,
            detail: `Dataset loaded (${status.rows} postcodes) but no operator columns were recognised — the header format may have changed.`,
          };
        }
        return {
          state: 'ok' as const,
          detail: `${status.rows?.toLocaleString('en-GB')} postcodes indexed from ${status.columnsUnderstood} recognised columns.`,
          meta: { path: status.path, loadedAt: status.loadedAt, columnsUnderstood: status.columnsUnderstood },
        };
      },
    },

    // ---- Resend ---------------------------------------------------------
    {
      key: 'resend',
      name: 'Resend',
      vendor: 'Resend',
      capability: 'Transactional email — required before email two-factor authentication can be enabled',
      docsUrl: 'https://resend.com/docs',
      configured: () => cfg.resend.configured,
      run: async () => {
        const state = settings().resend;
        if (state.verified) {
          return {
            state: 'ok' as const,
            detail: `Delivery test passed${state.verifiedAt ? ` on ${new Date(state.verifiedAt).toLocaleString('en-GB')}` : ''}. Email 2FA is available.`,
            meta: { verifiedAt: state.verifiedAt, lastTestTo: state.lastTestTo },
          };
        }
        return {
          state: 'degraded' as const,
          detail: state.lastError
            ? `Key present but the last delivery test failed: ${state.lastError}`
            : 'Key present but no delivery test has been run yet. Run the test to enable email 2FA.',
        };
      },
    },

    // ---- BT: connected but awaiting credentials -------------------------
    ...btProbes(),

    // ---- Jola -----------------------------------------------------------
    {
      key: 'jola-mobile-manager',
      name: 'Jola Mobile Manager',
      vendor: 'Jola',
      capability: 'Business SIM estate — usage, bars, bolt-ons. Note Zen’s cellular endpoints are already Jola-backed',
      docsUrl: 'https://developers.mobilemanager.co.uk/Help',
      configured: () => Boolean(cfg.jola.apiKey && cfg.jola.baseUrl),
      run: async () => {
        const res = await fetchJson<unknown>(`${cfg.jola.baseUrl.replace(/\/$/, '')}/${cfg.jola.healthPath.replace(/^\//, '')}`, {
          headers: { Authorization: `Bearer ${cfg.jola.apiKey}` },
          label: 'Jola',
          timeoutMs: 8000,
          retries: 0,
          notFoundAsNull: true,
        });
        return res !== null
          ? { state: 'ok' as const, detail: 'Reachable and authenticated.' }
          : { state: 'degraded' as const, detail: 'Reachable but the probe endpoint returned nothing.' };
      },
    },

    // ---- Internal -------------------------------------------------------
    {
      key: 'fixtures',
      name: 'Demo data engine',
      vendor: 'Internal',
      capability: 'Deterministic fixture data so the portal is usable before every credential is in place',
      configured: () => cfg.dataMode !== 'live',
      run: async () => ({
        state: cfg.dataMode === 'mock' ? ('ok' as const) : ('ok' as const),
        detail:
          cfg.dataMode === 'mock'
            ? 'Forced on — every panel is showing demo data.'
            : 'Standing by. Used only where a live provider is unavailable.',
      }),
    },
  ];
}

/** BT products, keyed to what each one actually delivers for this portal. */
function btProbes(): Probe[] {
  const cfg = config();
  const items: Array<{ key: string; name: string; capability: string; envVar: string }> = [
    {
      key: 'bt-home-network',
      name: 'BT — Home Network',
      capability: 'Confirms whether a phone number is currently connected to EE’s network',
      envVar: 'BT_HOME_NETWORK_KEY',
    },
    {
      key: 'bt-imei-lookup',
      name: 'BT — IMEI Lookup',
      capability: 'Retrieves the IMEI associated with an MSISDN',
      envVar: 'BT_IMEI_LOOKUP_KEY',
    },
    {
      key: 'bt-location-insights',
      name: 'BT — Location Insights for London',
      capability: 'Footfall activity and visitor catchments. London only',
      envVar: 'BT_LOCATION_INSIGHTS_KEY',
    },
  ];

  return items.map((item) => ({
    key: item.key,
    name: item.name,
    vendor: 'BT' as const,
    capability: item.capability,
    docsUrl: 'https://developer.bt.com/products',
    configured: () => Boolean(cfg.bt.products[item.key]?.apiKey),
    run: async () => {
      const product = cfg.bt.products[item.key];
      if (!product?.baseUrl) {
        return {
          state: 'not_configured' as const,
          detail: `Key present but no base URL. Set the endpoint once BT confirms it for your account.`,
        };
      }
      const res = await fetchJson<unknown>(product.baseUrl, {
        headers: { Authorization: `Bearer ${product.apiKey}` },
        label: item.name,
        timeoutMs: 8000,
        retries: 0,
        notFoundAsNull: true,
      });
      return res !== null
        ? { state: 'ok' as const, detail: 'Reachable and authenticated.' }
        : { state: 'degraded' as const, detail: 'Reachable but the probe returned nothing.' };
    },
  }));
}

/** Evaluates one probe. Shared by the full sweep and single re-checks. */
async function evaluate(probe: Probe): Promise<ServiceStatus> {
  const enabled = isProviderEnabled(probe.key);
  const configured = probe.configured();
  const base: ServiceStatus = {
    key: probe.key,
    name: probe.name,
    vendor: probe.vendor,
    capability: probe.capability,
    state: 'not_configured',
    detail: '',
    enabled,
    configured,
    ...(probe.docsUrl ? { docsUrl: probe.docsUrl } : {}),
    checkedAt: new Date().toISOString(),
  };

  if (!enabled) return { ...base, state: 'disabled', detail: 'Switched off by an administrator.' };
  if (!configured) return { ...base, state: 'not_configured', detail: 'Awaiting credentials.' };

  const started = Date.now();
  try {
    const outcome = await probe.run();
    return {
      ...base,
      state: outcome.state,
      detail: outcome.detail,
      latencyMs: Date.now() - started,
      ...(outcome.meta ? { meta: outcome.meta } : {}),
    };
  } catch (err) {
    return {
      ...base,
      state: 'down',
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

/** Attaches the Zen fair-use quota to the availability row, where it belongs. */
function withQuota(results: ServiceStatus[]): ServiceStatus[] {
  const quota = zenAvailabilityQuota();
  if (quota) {
    const row = results.find((r) => r.key === 'zen-availability');
    if (row) row.meta = { ...(row.meta ?? {}), remainingAvailabilityChecks: quota.remaining, quotaReadAt: quota.at };
  }
  return results;
}

/** Runs every probe in parallel and returns the full status board. */
export async function serviceStatuses(): Promise<ServiceStatus[]> {
  return withQuota(await Promise.all(probes().map(evaluate)));
}

/**
 * Re-checks a single integration. Recovery uses this rather than a full
 * sweep: re-probing all seventeen after every recovery action made sweeps
 * slow enough to overlap and abort one another.
 */
export async function probeService(key: string): Promise<ServiceStatus | null> {
  const probe = probes().find((p) => p.key === key);
  if (!probe) return null;
  return withQuota([await evaluate(probe)])[0] ?? null;
}
