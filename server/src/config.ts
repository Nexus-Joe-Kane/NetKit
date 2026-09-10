import 'dotenv/config';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { consoleIdFromUrl, normaliseControllerUrl } from '@sw/shared';


const str = (key: string, fallback = ''): string => (process.env[key] ?? '').trim() || fallback;
const num = (key: string, fallback: number): number => {
  const v = Number.parseInt(str(key), 10);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (key: string, fallback: boolean): boolean => {
  const v = str(key).toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

/**
 * Zen's endpoint paths live in config rather than in code. The Zen partner
 * API surface differs by account and product family, so when the API docs
 * land these are the only values that need changing — no adapter rewrite.
 */
export type ZenScope =
  | 'indirect-availability'
  | 'indirect-service'
  | 'indirect-order'
  | 'indirect-placeorder'
  | 'indirect-changeservice'
  | 'indirect-customerengagement'
  | 'indirect-broadbandconnection'
  | 'indirect-cdr'
  | 'indirect-diagnostics'
  | 'indirect-faults'
  | 'indirect-quote'
  /*
   * Outages sit behind their own scope, not under `indirect-faults`.
   *
   * This is the fix for a 401 that looked like an entitlement problem and
   * was not: the token minted fine under `indirect-faults` — Zen's identity
   * server issues it happily — and the major-service-outages endpoints then
   * refused the call. Zen confirmed the client already had `read-outages`,
   * which is what those endpoints actually check. We were asking for the
   * wrong scope, and our own error message blamed their account for it.
   */
  | 'read-outages';

/**
 * Zen Indirect API configuration, per the official OAuth overview.
 *
 * Auth is OAuth 2.0 client credentials against `id.zen.co.uk`, with the
 * client id/secret sent as HTTP Basic and the scope requested per token.
 * Two separate gateways sit behind the same credentials.
 */
export interface ZenConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  selfServiceBaseUrl: string;
  assuranceBaseUrl: string;
  /** Scopes granted to these credentials. Unlisted scopes are not attempted. */
  scopes: ZenScope[];
  configured: boolean;
}

function loadZen(): ZenConfig {
  const clientId = str('ZEN_CLIENT_ID');
  const clientSecret = str('ZEN_CLIENT_SECRET');
  const scopes = str(
    'ZEN_SCOPES',
    [
      'indirect-availability',
      'indirect-service',
      'indirect-order',
      'indirect-placeorder',
      'indirect-broadbandconnection',
      'indirect-diagnostics',
      'indirect-faults',
      'read-outages',
      'indirect-cdr',
      'indirect-quote',
      'indirect-customerengagement',
      'indirect-changeservice',
    ].join(','),
  )
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean) as ZenScope[];

  return {
    clientId,
    clientSecret,
    tokenUrl: str('ZEN_TOKEN_URL', 'https://id.zen.co.uk/connect/token'),
    selfServiceBaseUrl: str('ZEN_SELF_SERVICE_BASE_URL', 'https://gateway.api.indirect.zen.co.uk/self-service'),
    assuranceBaseUrl: str('ZEN_ASSURANCE_BASE_URL', 'https://gateway.api.indirect.zen.co.uk/assurance'),
    scopes,
    configured: Boolean(clientId && clientSecret),
  };
}

/**
 * BT developer products. Each product is keyed by the same id the admin
 * status board uses, so a new BT product is one env pair plus one probe.
 * BT does not publish auth details without an account, so base URL and
 * token URL are configurable rather than hard-coded.
 */
export interface BtProductConfig {
  apiKey: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export interface BtConfig {
  products: Record<string, BtProductConfig>;
}

export interface JolaConfig {
  baseUrl: string;
  /** Basic-auth username half. */
  apiKey: string;
  /** Basic-auth password half. Both halves are required. */
  secretKey: string;
  configured: boolean;
}

function loadBt(): BtConfig {
  const product = (prefix: string): BtProductConfig => ({
    apiKey: str(`${prefix}_KEY`),
    baseUrl: str(`${prefix}_BASE_URL`),
    clientId: str(`${prefix}_CLIENT_ID`),
    clientSecret: str(`${prefix}_CLIENT_SECRET`),
    tokenUrl: str(`${prefix}_TOKEN_URL`, str('BT_TOKEN_URL')),
  });
  return {
    products: {
      'bt-home-network': product('BT_HOME_NETWORK'),
      'bt-imei-lookup': product('BT_IMEI_LOOKUP'),
      'bt-location-insights': product('BT_LOCATION_INSIGHTS'),
    },
  };
}

/**
 * Giacom Integrations API scopes, verbatim from their published OpenAPI
 * security scheme. Scope is bound to the token, so tokens cache per scope.
 */
export type GiacomScope =
  | 'integrations/serviceQualification.read'
  | 'integrations/serviceQualification.submit'
  | 'integrations/serviceInventory.read'
  | 'integrations/serviceCatalogue.read'
  | 'integrations/resourceInventory.read'
  | 'integrations/address.manage'
  | 'integrations/appointment.manage'
  | 'integrations/serviceOrder.read'
  | 'integrations/serviceOrder.submit'
  | 'integrations/serviceActivation.read'
  | 'integrations/organization.read'
  | 'integrations/notifications.read';

/**
 * Giacom (formerly Digital Wholesale Solutions) — the second wholesale
 * supplier. TM Forum Open APIs, OAuth 2.0 client credentials.
 *
 * They carry BT Wholesale, CityFibre, TalkTalk Business, Virgin Media
 * Business and Sky Business, which is the gap Zen leaves: Zen answers for
 * Openreach and nothing else.
 *
 * `environment` picks between their published production and UAT hosts, so a
 * new integration can be proved against UAT without touching code.
 */
export interface GiacomConfig {
  clientId: string;
  clientSecret: string;
  environment: 'production' | 'uat';
  baseUrl: string;
  tokenUrl: string;
  /**
   * TMF645 ServiceQualification — the per-address serviceability check.
   *
   * The scope (`serviceQualification.read` / `.submit`) is in Giacom's
   * published security scheme, but no path for it appears in their public
   * OpenAPI document — so it is granted and documented per tenant. Configure
   * the path once Giacom confirm it and availability goes live; until then
   * the integration reads the service inventory and catalogue only.
   */
  qualificationPath: string;
  scopes: GiacomScope[];
  configured: boolean;
}

function loadGiacom(): GiacomConfig {
  const clientId = str('GIACOM_CLIENT_ID');
  const clientSecret = str('GIACOM_CLIENT_SECRET');
  const environment = (str('GIACOM_ENVIRONMENT', 'production') === 'uat' ? 'uat' : 'production') as
    | 'production'
    | 'uat';

  // Defaults are Giacom's own published servers, so only credentials are
  // normally needed.
  const defaultBase =
    environment === 'uat' ? 'https://api.uat.integrations.giacom.com/v2' : 'https://api.integrations.giacom.com/v2';
  const defaultToken =
    environment === 'uat'
      ? 'https://auth.uat.integrations.giacom.com/oauth2/token'
      : 'https://auth.integrations.giacom.com/oauth2/token';

  const scopes = str(
    'GIACOM_SCOPES',
    [
      'integrations/serviceInventory.read',
      'integrations/serviceCatalogue.read',
      'integrations/resourceInventory.read',
      'integrations/address.manage',
      'integrations/serviceQualification.read',
      'integrations/serviceQualification.submit',
    ].join(','),
  )
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean) as GiacomScope[];

  return {
    clientId,
    clientSecret,
    environment,
    baseUrl: str('GIACOM_BASE_URL', defaultBase),
    tokenUrl: str('GIACOM_TOKEN_URL', defaultToken),
    qualificationPath: str('GIACOM_QUALIFICATION_PATH', ''),
    scopes,
    configured: Boolean(clientId && clientSecret),
  };
}

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  /** Where the built SPA lives, served as static files. */
  publicDir: string;
  /** Where users, settings and the audit log are written. */
  dataDir: string;
  sessionSecret: string;
  resend: { apiKey: string; fromEmail: string; fromName: string; configured: boolean };
  /**
   * Where the portal is reachable, for links that leave the app.
   *
   * Needed because a note on a Zendesk ticket is read outside NetKit, so a
   * relative link is useless there. Left empty, those notes say "open NetKit
   * under Visits" rather than printing a broken URL, which is the better
   * failure.
   */
  publicUrl: string;
  /**
   * Microsoft Entra ID sign-in.
   *
   * `configured` gates whether the sign-in screen offers the button at all.
   * Half-configured is treated as not configured, and the reason is shown in
   * the admin portal rather than left as a missing button.
   */
  microsoft: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    allowedDomains: string[];
    configured: boolean;
  };
  corsOrigins: string[];
  /**
   * `auto`  — use live providers where credentials exist, mock the rest.
   * `live`  — never fall back to mock; surface the error instead.
   * `mock`  — always use fixtures (useful for demos and UI work).
   */
  cacheTtlSeconds: number;
  requestTimeoutMs: number;
  rateLimit: { windowMs: number; max: number };
  zen: ZenConfig;
  giacom: GiacomConfig;
  bt: BtConfig;
  jola: JolaConfig;
  /**
   * Ofcom mobile coverage. The Connected Nations postcode dataset is the
   * dependable route — free, no account. An API base URL is an optional
   * override for accounts that have a live endpoint.
   */
  /**
   * Ofcom mobile coverage. Dataset only — Ofcom publish no mobile coverage
   * API. Their developer portal sells Broadband Coverage (Basic/Premium)
   * and nothing else; see `ofcomBroadband` for that one.
   */
  ofcom: { datasetPath: string };
  /**
   * Ofcom's Connected Nations Broadband API — free with a developer account,
   * 50,000 requests a month on the Basic tier.
   *
   * Per-premises predicted speeds keyed by UPRN. It names no operator, by
   * Ofcom's deliberate policy, so it answers "what can this premises get"
   * and never "who from" — which is exactly why it sits beside the offers
   * rather than among them.
   */
  ofcomBroadband: { apiKey: string; baseUrl: string; datasetPath: string; configured: boolean };
  /**
   * Ofcom's Mobile Checker: per-UPRN, per-operator coverage.
   *
   * A separate subscription from the broadband API, on a different host,
   * with its own key — so having one does not give you the other.
   */
  ofcomMobile: { apiKey: string; baseUrl: string; configured: boolean };
  /**
   * Downdetector, for national supplier status.
   *
   * The paths are configurable because their API reference is behind their
   * enterprise login: what ships is built from the endpoint names their own
   * integration documentation gives, and being able to correct a path
   * without a deploy is the difference between a five-minute fix and a
   * release.
   */
  downdetector: {
    clientId: string;
    clientSecret: string;
    baseUrl: string;
    tokenUrl: string;
    /** `{slug}` is replaced with the provider's Downdetector slug. */
    statusPath: string;
    configured: boolean;
  };
  /** Zendesk Support: ticket notes, and the customer's own site contacts. */
  zendesk: { subdomain: string; email: string; apiToken: string; configured: boolean };
  /**
   * IT Glue, for what the site is documented as having.
   *
   * The base URL is configurable because IT Glue run three regional hosts
   * and an EU account is a 404 against the US one, which reads as "no such
   * organisation" rather than "wrong data centre".
   */
  itGlue: { apiKey: string; baseUrl: string; configured: boolean };
  /**
   * UniFi, by two roads to the same API.
   *
   * The console's own Network Integration API is the primary: no third party
   * in the middle, no dependency on Ubiquiti's cloud being up, and it
   * answers in milliseconds rather than over the internet and back.
   *
   * Site Manager — Ubiquiti's cloud — is the fallback, and it earns its
   * place twice over: it is the only road to a console that is not
   * reachable from this server, and it is the only thing that can enumerate
   * every site on the account, because a console only knows itself.
   */
  unifi: {
    /** Site Manager key. Read-only, by Ubiquiti's own note. */
    apiKey: string;
    baseUrl: string;
    configured: boolean;
    /**
     * A Network Integration key, which is a different key from the Site
     * Manager one above and the only one that can be given instructions.
     * A deployment can read every site and still not be able to restart
     * anything, and the error says exactly that rather than "403".
     *
     * This one is for the cloud road, through the Connector Proxy.
     */
    integrationKey: string;
    /** True where restarts and port power-cycles are possible. */
    actionsConfigured: boolean;
    /**
     * The console's own address, e.g. https://192.168.1.1. Empty means
     * there is no local road and everything goes through the cloud.
     */
    controllerUrl: string;
    /** A Network Integration key created on the console itself. */
    controllerKey: string;
    /**
     * How to trust the console's certificate. A console on a private
     * address has its own, so plain verification fails — and would fail
     * quietly, with the cloud fallback covering for it, which is the worst
     * of both. One of these three is what makes the local road work.
     */
    controllerCaCert: string;
    controllerFingerprint: string;
    controllerInsecureTls: boolean;
    /**
     * The Site Manager host id of our own console, from the address bar at
     * unifi.ui.com/consoles/<id>. Needed for the cloud road, and used as
     * the default console for local calls that name one.
     */
    consoleId: string;
    /** True where the console can be tried before the cloud. */
    controllerConfigured: boolean;
  };
  openCellId: { apiKey: string; baseUrl: string; searchPath: string; radiusMetres: number; configured: boolean };
  /**
   * The recovery supervisor: probes every integration on an interval and
   * tries to fix what it can. On by default — an internal tool that quietly
   * stops answering because a token expired is worse than one that notices.
   */
  supervisor: {
    enabled: boolean;
    intervalSeconds: number;
    selfTestOnBoot: boolean;
    /**
     * How long an integration must keep failing before a person is emailed.
     * Recovery handles the transient cases; this is for the ones it cannot.
     */
    escalateAfterMinutes: number;
  };
  /**
   * Placing real orders is off unless explicitly enabled. Ordering spends
   * money and books engineer appointments, so it needs a deliberate switch
   * rather than inheriting the credentials that read data.
   */
  allowOrdering: boolean;
  /**
   * Fair-use rationing. Zen's availability endpoint is explicitly not for
   * bulk checking, so each user gets a daily budget. `0` removes the limit.
   */
  quotas: { availabilityPerUserPerDay: number };
  /**
   * Companies House. Free with a registration key. Adds business context to
   * a premises — status, incorporation, SIC codes and overdue filings.
   */
  companiesHouse: { apiKey: string; baseUrl: string; configured: boolean };
  /**
   * thinkbroadband's availability API — alt-net and cable coverage.
   *
   * The only obtainable source that covers CityFibre, Virgin Media,
   * Community Fibre and G.Network at once, and a data licence rather than a
   * wholesale agreement. Paths and the auth style are configurable because
   * thinkbroadband publish the specification to licensees only.
   */
  thinkbroadband: {
    apiKey: string;
    baseUrl: string;
    availabilityPath: string;
    /** Some licences key the query string rather than a header. */
    apiKeyInQuery: boolean;
    configured: boolean;
  };
  osPlaces: { apiKey: string; baseUrl: string; configured: boolean };
  postcodesIo: { baseUrl: string; enabled: boolean };
  version: string;
}

let cached: AppConfig | null = null;

/**
 * Where the only unrecoverable state lives: user accounts, settings, the
 * audit log.
 *
 * A relative default is dangerous here rather than merely untidy. Resolved
 * against the application root, `data` lands in `httpdocs/data` -- inside the
 * Git working tree -- so a deploy that resets the tree takes every user
 * account with it. That default shipped and was only masked on the live
 * deployment because Plesk happened to inject an absolute path over it.
 *
 * So: no relative default. In production an absolute `DATA_DIR` is required
 * and the process refuses to start without one, because failing at boot is
 * recoverable and discovering it after a deploy is not. Development gets an
 * absolute path of its own so `npm run dev` still works.
 */
function resolveDataDir(): string {
  const raw = str('DATA_DIR');
  const env = str('NODE_ENV', 'development');

  if (raw) {
    if (!isAbsolute(raw)) {
      throw new Error(
        `DATA_DIR must be an absolute path, got "${raw}". ` +
          'A relative path resolves inside the deployment directory, where a ' +
          'tree-resetting deploy would delete every user account. ' +
          'Use something like /var/www/vhosts/<domain>/netkit-data.',
      );
    }
    return raw;
  }

  if (env === 'production') {
    throw new Error(
      'DATA_DIR is not set. It must be an absolute path outside the ' +
        'deployment directory, because it holds the user accounts, settings ' +
        'and audit log -- the only state that cannot be rebuilt from Git. ' +
        'Set it in Plesk under Node.js -> Custom environment variables.',
    );
  }

  // Development only, and absolute so it can never be confused for a
  // path inside whatever directory the dev server happened to start in.
  return resolvePath(process.cwd(), '.data-dev');
}

/**
 * Entra settings, read through the same allow-listed names as everything
 * else so the vault and the environment agree.
 *
 * The domain list is split here rather than at the point of use: one place
 * to decide that " SupportWizard.net " and "supportwizard.net" are the same
 * thing beats three places quietly disagreeing.
 */
function loadMicrosoft(): AppConfig['microsoft'] {
  const tenantId = str('MICROSOFT_TENANT_ID');
  const clientId = str('MICROSOFT_CLIENT_ID');
  const clientSecret = str('MICROSOFT_CLIENT_SECRET');
  return {
    tenantId,
    clientId,
    clientSecret,
    allowedDomains: str('MICROSOFT_ALLOWED_DOMAINS')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
    configured: Boolean(tenantId && clientId && clientSecret),
  };
}

/**
 * UniFi settings, both roads.
 *
 * The console URL is normalised here rather than at the point of use, and a
 * Site Manager address pasted into the console field is rejected: it would
 * send every "local" call to Ubiquiti while the status panel claimed the
 * connection was direct.
 */
function loadUnifi(): AppConfig['unifi'] {
  const controller = normaliseControllerUrl(str('UNIFI_CONTROLLER_URL'));
  const controllerKey = str('UNIFI_CONTROLLER_API_KEY') || str('UNIFI_INTEGRATION_KEY');
  const consoleRaw = str('UNIFI_CONSOLE_ID');
  return {
    apiKey: str('UNIFI_API_KEY'),
    baseUrl: str('UNIFI_BASE_URL', 'https://api.ui.com').replace(/\/+$/, ''),
    configured: Boolean(str('UNIFI_API_KEY')),
    integrationKey: str('UNIFI_INTEGRATION_KEY'),
    actionsConfigured: Boolean(str('UNIFI_INTEGRATION_KEY') || (controller.url && controllerKey)),
    controllerUrl: controller.url ?? '',
    controllerKey,
    controllerCaCert: str('UNIFI_CONTROLLER_CA_CERT'),
    controllerFingerprint: str('UNIFI_CONTROLLER_FINGERPRINT'),
    controllerInsecureTls: bool('UNIFI_CONTROLLER_INSECURE_TLS', false),
    // A console id pasted as the whole unifi.ui.com URL is the common case,
    // because that is what is in the address bar.
    consoleId: consoleIdFromUrl(consoleRaw) ?? consoleRaw,
    controllerConfigured: Boolean(controller.url && controllerKey),
  };
}

export function config(): AppConfig {
  if (cached) return cached;
  const osKey = str('OS_PLACES_API_KEY');
  cached = {
    env: (str('NODE_ENV', 'development') as AppConfig['env']),
    port: num('PORT', 3000),
    publicDir: str('PUBLIC_DIR', ''),
    dataDir: resolveDataDir(),
    sessionSecret: str('SESSION_SECRET'),
    resend: {
      apiKey: str('RESEND_API_KEY'),
      fromEmail: str('RESEND_FROM_EMAIL', 'no-reply@supportwizard.net'),
      fromName: str('RESEND_FROM_NAME', 'SupportWizard NetKit'),
      configured: Boolean(str('RESEND_API_KEY')),
    },
    publicUrl: str('PUBLIC_URL').replace(/\/+$/, ''),
    microsoft: loadMicrosoft(),
    corsOrigins: str('CORS_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cacheTtlSeconds: num('CACHE_TTL_SECONDS', 900),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 12_000),
    rateLimit: { windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000), max: num('RATE_LIMIT_MAX', 120) },
    zen: loadZen(),
    giacom: loadGiacom(),
    bt: loadBt(),
    allowOrdering: bool('ZEN_ALLOW_ORDERING', false),
    quotas: { availabilityPerUserPerDay: Math.max(0, num('AVAILABILITY_DAILY_BUDGET', 250)) },
    openCellId: {
      /*
       * `OPENCELLID` is accepted as well as `OPENCELLID_API_KEY`.
       *
       * OpenCelliD call the value a token and the obvious variable name for
       * it is the bare product name — which is what actually got set on the
       * server, leaving the panel reading "not connected" with a perfectly
       * good token sitting next to it. Reading both is one line; making
       * somebody find that out by staring at a status board is not.
       */
      apiKey: str('OPENCELLID_API_KEY') || str('OPENCELLID') || str('OPENCELLID_TOKEN'),
      baseUrl: str('OPENCELLID_BASE_URL', 'https://opencellid.org'),
      // Configurable because it is the one part of this integration taken
      // from public documentation rather than a response we have seen.
      searchPath: str('OPENCELLID_SEARCH_PATH', '/cell/getInArea'),
      radiusMetres: Math.min(20_000, Math.max(500, num('OPENCELLID_RADIUS_METRES', 4000))),
      configured: Boolean(str('OPENCELLID_API_KEY') || str('OPENCELLID') || str('OPENCELLID_TOKEN')),
    },
    zendesk: {
      // A bare subdomain or a full host; both get pasted in.
      subdomain: str('ZENDESK_SUBDOMAIN'),
      email: str('ZENDESK_EMAIL'),
      apiToken: str('ZENDESK_API_TOKEN'),
      configured: Boolean(str('ZENDESK_SUBDOMAIN') && str('ZENDESK_EMAIL') && str('ZENDESK_API_TOKEN')),
    },
    itGlue: {
      apiKey: str('ITGLUE_API_KEY'),
      baseUrl: str('ITGLUE_BASE_URL', 'https://api.itglue.com').replace(/\/+$/, ''),
      configured: Boolean(str('ITGLUE_API_KEY')),
    },
    unifi: loadUnifi(),
    ofcomBroadband: {
      apiKey: str('OFCOM_BROADBAND_API_KEY'),
      /*
       * The Connected Nations fixed postcode release, as a failover.
       *
       * Unlike mobile, Ofcom publish fixed broadband per postcode, so this is
       * a real per-postcode answer rather than an area average. Point it at
       * the folder the zip extracts to. Used only when the API has no key or
       * does not answer, and every figure from it is labelled as a dated file
       * rather than a current prediction.
       */
      datasetPath: str('OFCOM_BROADBAND_DATASET_PATH'),
      baseUrl: str('OFCOM_BROADBAND_BASE_URL', 'https://api-proxy.ofcom.org.uk/broadband'),
      configured: Boolean(str('OFCOM_BROADBAND_API_KEY')),
    },
    ofcomMobile: {
      apiKey: str('OFCOM_MOBILE_API_KEY'),
      baseUrl: str('OFCOM_MOBILE_BASE_URL', 'https://apim-cnapi-shared-prod.azure-api.net/mobilechecker'),
      configured: Boolean(str('OFCOM_MOBILE_API_KEY')),
    },
    downdetector: {
      clientId: str('DOWNDETECTOR_CLIENT_ID'),
      clientSecret: str('DOWNDETECTOR_CLIENT_SECRET'),
      baseUrl: str('DOWNDETECTOR_BASE_URL', 'https://downdetectorapi.com/v2').replace(/\/+$/, ''),
      tokenUrl: str('DOWNDETECTOR_TOKEN_URL', 'https://downdetectorapi.com/v2/oauth2/token'),
      statusPath: str('DOWNDETECTOR_STATUS_PATH', 'companies/{slug}/status'),
      configured: Boolean(str('DOWNDETECTOR_CLIENT_ID') && str('DOWNDETECTOR_CLIENT_SECRET')),
    },
    thinkbroadband: {
      apiKey: str('THINKBROADBAND_API_KEY'),
      baseUrl: str('THINKBROADBAND_BASE_URL', 'https://api.thinkbroadband.com'),
      availabilityPath: str('THINKBROADBAND_AVAILABILITY_PATH', '/availability'),
      apiKeyInQuery: bool('THINKBROADBAND_KEY_IN_QUERY', false),
      configured: Boolean(str('THINKBROADBAND_API_KEY')),
    },
    companiesHouse: {
      apiKey: str('COMPANIES_HOUSE_API_KEY'),
      baseUrl: str('COMPANIES_HOUSE_BASE_URL', 'https://api.company-information.service.gov.uk'),
      configured: Boolean(str('COMPANIES_HOUSE_API_KEY')),
    },
    ofcom: {
      datasetPath: str('OFCOM_DATASET_PATH'),
    },
    supervisor: {
      enabled: bool('SUPERVISOR_ENABLED', true),
      // Five minutes is frequent enough to catch a token expiry before a
      // user does, and rare enough to be invisible to the upstreams.
      intervalSeconds: Math.max(60, num('SUPERVISOR_INTERVAL_SECONDS', 300)),
      selfTestOnBoot: bool('SELFTEST_ON_BOOT', true),
      escalateAfterMinutes: Math.max(5, num('SUPERVISOR_ESCALATE_AFTER_MINUTES', 60)),
    },
    jola: {
      // Jola's SIM Portal. The path structure is fixed and documented, so
      // unlike the guessed endpoints this replaced there is nothing to
      // configure beyond the host.
      baseUrl: str('JOLA_BASE_URL', 'https://simportal-api.azurewebsites.net'),
      apiKey: str('JOLA_API_KEY'),
      secretKey: str('JOLA_SECRET_KEY'),
      configured: Boolean(str('JOLA_API_KEY') && str('JOLA_SECRET_KEY')),
    },
    osPlaces: {
      apiKey: osKey,
      baseUrl: str('OS_PLACES_BASE_URL', 'https://api.os.uk/search/places/v1'),
      configured: Boolean(osKey),
    },
    postcodesIo: {
      baseUrl: str('POSTCODES_IO_BASE_URL', 'https://api.postcodes.io'),
      enabled: bool('POSTCODES_IO_ENABLED', true),
    },
    version: str('APP_VERSION', '1.0.0'),
  };
  return cached;
}

/**
 * Drops the memoised config so environment changes take effect.
 *
 * Started as a test hook and is now load-bearing: credentials can be changed
 * from the admin portal, the vault writes the new value into the environment,
 * and this is what makes the next read see it. That is the whole reason a key
 * can be added without a restart.
 */
export function resetConfig(): void {
  cached = null;
}


