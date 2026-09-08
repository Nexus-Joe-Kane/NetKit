import 'dotenv/config';

export type DataMode = 'auto' | 'live' | 'mock';

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
  | 'indirect-quote';

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
  apiKey: string;
  healthPath: string;
  /** Endpoint listing the SIM estate — differs by reseller. */
  simsPath: string;
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

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  /** Where the built SPA lives, served as static files. */
  publicDir: string;
  /** Where users, settings and the audit log are written. */
  dataDir: string;
  sessionSecret: string;
  resend: { apiKey: string; fromEmail: string; fromName: string; configured: boolean };
  corsOrigins: string[];
  /**
   * `auto`  — use live providers where credentials exist, mock the rest.
   * `live`  — never fall back to mock; surface the error instead.
   * `mock`  — always use fixtures (useful for demos and UI work).
   */
  dataMode: DataMode;
  cacheTtlSeconds: number;
  requestTimeoutMs: number;
  rateLimit: { windowMs: number; max: number };
  zen: ZenConfig;
  bt: BtConfig;
  jola: JolaConfig;
  /**
   * Ofcom mobile coverage. The Connected Nations postcode dataset is the
   * dependable route — free, no account. An API base URL is an optional
   * override for accounts that have a live endpoint.
   */
  ofcom: { datasetPath: string; apiBaseUrl: string; apiKey: string };
  /**
   * The recovery supervisor: probes every integration on an interval and
   * tries to fix what it can. On by default — an internal tool that quietly
   * serves demo data because a token expired is worse than one that notices.
   */
  supervisor: { enabled: boolean; intervalSeconds: number; selfTestOnBoot: boolean };
  /**
   * Placing real orders is off unless explicitly enabled. Ordering spends
   * money and books engineer appointments, so it needs a deliberate switch
   * rather than inheriting the credentials that read data.
   */
  allowOrdering: boolean;
  osPlaces: { apiKey: string; baseUrl: string; configured: boolean };
  postcodesIo: { baseUrl: string; enabled: boolean };
  signal: { baseUrl: string; apiKey: string; configured: boolean };
  version: string;
}

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (cached) return cached;
  const osKey = str('OS_PLACES_API_KEY');
  const signalKey = str('SIGNAL_API_KEY');
  const signalBase = str('SIGNAL_API_BASE_URL');
  cached = {
    env: (str('NODE_ENV', 'development') as AppConfig['env']),
    port: num('PORT', 3000),
    publicDir: str('PUBLIC_DIR', ''),
    dataDir: str('DATA_DIR', 'data'),
    sessionSecret: str('SESSION_SECRET'),
    resend: {
      apiKey: str('RESEND_API_KEY'),
      fromEmail: str('RESEND_FROM_EMAIL', 'no-reply@supportwizard.net'),
      fromName: str('RESEND_FROM_NAME', 'SupportWizard NetKit'),
      configured: Boolean(str('RESEND_API_KEY')),
    },
    corsOrigins: str('CORS_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataMode: (str('DATA_MODE', 'auto') as DataMode),
    cacheTtlSeconds: num('CACHE_TTL_SECONDS', 900),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 12_000),
    rateLimit: { windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000), max: num('RATE_LIMIT_MAX', 120) },
    zen: loadZen(),
    bt: loadBt(),
    allowOrdering: bool('ZEN_ALLOW_ORDERING', false),
    ofcom: {
      datasetPath: str('OFCOM_DATASET_PATH'),
      apiBaseUrl: str('OFCOM_API_BASE_URL'),
      apiKey: str('OFCOM_API_KEY'),
    },
    supervisor: {
      enabled: bool('SUPERVISOR_ENABLED', true),
      // Five minutes is frequent enough to catch a token expiry before a
      // user does, and rare enough to be invisible to the upstreams.
      intervalSeconds: Math.max(60, num('SUPERVISOR_INTERVAL_SECONDS', 300)),
      selfTestOnBoot: bool('SELFTEST_ON_BOOT', true),
    },
    jola: {
      baseUrl: str('JOLA_BASE_URL'),
      apiKey: str('JOLA_API_KEY'),
      healthPath: str('JOLA_HEALTH_PATH', '/api/sims'),
      simsPath: str('JOLA_SIMS_PATH', '/api/sims'),
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
    signal: { baseUrl: signalBase, apiKey: signalKey, configured: Boolean(signalBase) },
    version: str('APP_VERSION', '1.0.0'),
  };
  return cached;
}

/** Test hook — drops the memoised config so env changes take effect. */
export function resetConfig(): void {
  cached = null;
}

/** Whether a given provider should run live, given credentials and DATA_MODE. */
export function shouldRunLive(providerConfigured: boolean): boolean {
  const mode = config().dataMode;
  if (mode === 'mock') return false;
  if (mode === 'live') return true;
  return providerConfigured;
}
