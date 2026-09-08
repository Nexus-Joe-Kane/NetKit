import type {
  AddressMatch,
  AddressRecord,
  AddressRegistration,
  AddressSuggestion,
  ApiError,
  ApiResult,
  AppointmentSlot,
  AvailableTests,
  CallRecord,
  CompanyContext,
  EstateUsageReport,
  EthernetQuoteSet,
  FaultRecord,
  FootfallInsight,
  ImeiLookup,
  Incident,
  LineRecord,
  LineTestResult,
  LineTestType,
  NetworkConfiguration,
  NetworkConnectivityCheck,
  NumberPortCheck,
  OrderingGate,
  OrderQuote,
  OrderRecord,
  PlaceOrderRequest,
  PlaceOrderResult,
  ProfileOptions,
  ProviderNotification,
  RaiseFaultRequest,
  RdnsRecord,
  ServiceHistory,
  ResolvedIdentifier,
  SearchResponse,
  SimEstate,
  SiteReport,
  StabilityReport,
  UsageReport,
} from '@sw/shared';

/** One premises or identifier this user looked up recently. */
export interface RecentLookup {
  query: string;
  kind: string;
  label?: string;
  uprn?: string;
  postcode?: string;
  at: string;
}

/** Every operational response says whether it came from a live API. */
export interface Sourced {
  mode: 'live' | 'mock';
  providerError?: string;
}

/**
 * API client.
 *
 * Every response is the `ApiResult` envelope, so this unwraps it once and
 * throws a typed `ApiClientError` that the UI can render directly — no
 * `response.ok` checks scattered through components.
 */

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiError['code'],
    message: string,
    readonly suggestions?: AddressSuggestion[],
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
      ...init,
    });
  } catch {
    throw new ApiClientError('upstream_error', 'Could not reach the server. Check your connection and try again.');
  }

  let payload: ApiResult<T> | null = null;
  try {
    payload = (await res.json()) as ApiResult<T>;
  } catch {
    throw new ApiClientError('internal', `The server returned an unreadable response (${res.status}).`, undefined, res.status);
  }

  if (!payload || payload.ok !== true) {
    const error = payload && payload.ok === false ? payload.error : undefined;
    throw new ApiClientError(
      error?.code ?? 'internal',
      error?.message ?? `Request failed (${res.status}).`,
      error?.suggestions,
      res.status,
    );
  }
  return payload.data;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  twoFactorEnabled: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  lockedUntil?: string;
}

export interface SessionState {
  authenticated: boolean;
  user?: PublicUser;
  mustChangePassword?: boolean;
  twoFactorAvailable?: boolean;
  awaitingTwoFactor?: boolean;
  email?: string;
  warning?: string;
  /** True when premises lookups are answered from fixtures. */
  demoData?: boolean;
}

export const api = {
  session: () => request<SessionState>('/api/auth/session'),
  login: (email: string, password: string) => post<SessionState>('/api/auth/login', { email, password }),
  verifyCode: (code: string) => post<SessionState>('/api/auth/verify', { code }),
  resendCode: () => post<{ sent: boolean; email: string }>('/api/auth/resend'),
  logout: () => post<{ signedOut: boolean }>('/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ changed: boolean }>('/api/auth/password', { currentPassword, newPassword }),
  setTwoFactor: (enabled: boolean) => post<{ twoFactorEnabled: boolean }>('/api/auth/two-factor', { enabled }),

  /* ---- Lookups ---------------------------------------------------- */

  search: (q: string, uprn?: string) =>
    request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}${uprn ? `&uprn=${encodeURIComponent(uprn)}` : ''}`),

  suggest: (q: string) =>
    request<{ query: ResolvedIdentifier; suggestions: AddressSuggestion[]; postcodes: string[] }>(
      `/api/suggest?q=${encodeURIComponent(q)}`,
    ),

  site: (uprn: string) => request<SiteReport>(`/api/site/${encodeURIComponent(uprn)}`),

  addressesAt: (postcode: string) =>
    request<{ postcode: string; addresses: AddressRecord[]; suggestions: AddressSuggestion[] }>(
      `/api/addresses?postcode=${encodeURIComponent(postcode)}`,
    ),

  linesAt: (uprn: string) =>
    request<{ address: AddressRecord; lines: LineRecord[] }>(`/api/lines?uprn=${encodeURIComponent(uprn)}`),

  lineBy: (q: string) => request<{ query: ResolvedIdentifier; lines: LineRecord[]; message?: string }>(
    `/api/lines?q=${encodeURIComponent(q)}`,
  ),

  /* ---- Network status --------------------------------------------- */

  networkStatus: (past = false) =>
    request<Sourced & { outages: Incident[]; plannedWork: Incident[]; checkedAt: string }>(
      `/api/network/status${past ? '?past=true' : ''}`,
    ),

  outagesForService: (zenReference: string) =>
    request<Sourced & { outages: Incident[] }>(`/api/network/status/${encodeURIComponent(zenReference)}`),

  /* ---- Faults ------------------------------------------------------ */

  faults: (state: 'open' | 'closed' = 'open', zenReference?: string) =>
    request<Sourced & { faults: FaultRecord[]; state: string }>(
      `/api/faults?state=${state}${zenReference ? `&zenReference=${encodeURIComponent(zenReference)}` : ''}`,
    ),

  raiseFault: (input: RaiseFaultRequest) =>
    post<Sourced & { fault: FaultRecord }>('/api/faults', input),

  /* ---- Diagnostics -------------------------------------------------- */

  availableTests: (zenReference: string, technology?: string) =>
    request<Sourced & AvailableTests>(
      `/api/diagnostics/${encodeURIComponent(zenReference)}/tests${technology ? `?technology=${encodeURIComponent(technology)}` : ''}`,
    ),

  latestTest: (zenReference: string, type: LineTestType, technology?: string) =>
    request<Sourced & { result: LineTestResult }>(
      `/api/diagnostics/${encodeURIComponent(zenReference)}/tests/${type}${technology ? `?technology=${encodeURIComponent(technology)}` : ''}`,
    ),

  runTest: (zenReference: string, type: LineTestType, technology?: string) =>
    post<Sourced & { result: LineTestResult }>(`/api/diagnostics/${encodeURIComponent(zenReference)}/tests/${type}`, {
      ...(technology ? { technology } : {}),
    }),

  profileOptions: (zenReference: string) =>
    request<Sourced & ProfileOptions>(`/api/diagnostics/${encodeURIComponent(zenReference)}/profile`),

  requestProfileChange: (zenReference: string, profileCode: string) =>
    post<Sourced & { result: LineTestResult }>(`/api/diagnostics/${encodeURIComponent(zenReference)}/profile`, {
      profileCode,
    }),

  stability: (zenReference: string, days = 30) =>
    request<Sourced & StabilityReport>(`/api/diagnostics/${encodeURIComponent(zenReference)}/stability?days=${days}`),

  usage: (zenReference: string, period: 'day' | 'month' | 'current_month' = 'current_month') =>
    request<Sourced & UsageReport>(`/api/diagnostics/${encodeURIComponent(zenReference)}/usage?period=${period}`),

  /* ---- Recent lookups ---------------------------------------------- */

  recent: () => request<{ recent: RecentLookup[] }>('/api/recent'),
  clearRecent: () => request<{ cleared: boolean }>('/api/recent', { method: 'DELETE' }),

  /* ---- Orders ------------------------------------------------------ */

  orders: (view: 'status' | 'wip' | 'search' = 'status', q?: string) =>
    request<Sourced & { orders: OrderRecord[]; view: string }>(
      `/api/orders?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    ),

  cancelOrder: (zenReference: string, reason: string) =>
    post<Sourced & { ok: boolean; message?: string }>(`/api/orders/${encodeURIComponent(zenReference)}/cancel`, { reason }),

  orderPricing: (productCode: string, productName?: string) =>
    request<Sourced & OrderQuote>(
      `/api/orders/pricing?productCode=${encodeURIComponent(productCode)}${productName ? `&productName=${encodeURIComponent(productName)}` : ''}`,
    ),

  appointments: (params: { availabilityReference: string; productCode: string; goldAddressKey: string; districtCode: string }) =>
    request<Sourced & { slots: AppointmentSlot[] }>(`/api/orders/appointments?${new URLSearchParams(params).toString()}`),

  /** Whether ordering is unlocked for this user, and if not, why not. */
  orderingGate: () => request<OrderingGate>('/api/orders/gate'),

  /**
   * Places a real order. `confirmAddressLine` is the retyped address — the
   * server compares it and refuses on a mismatch, so this is not a
   * client-side courtesy that can be skipped by calling the API directly.
   */
  placeOrder: (request_: PlaceOrderRequest & { confirmAddressLine: string }) =>
    post<Sourced & PlaceOrderResult & { gate: OrderingGate }>('/api/orders', request_),

  /* ---- Address references ------------------------------------------ */

  addressMatch: (params: { postcode: string; postTown?: string; premiseName?: string; thoroughfareNumber?: string }) =>
    request<Sourced & AddressMatch>(
      `/api/tools/address-match?${new URLSearchParams(params as Record<string, string>).toString()}`,
    ),

  registerAddress: (body: {
    postcode: string;
    buildingName?: string;
    buildingNumber?: string;
    thoroughfare: string;
    postTown: string;
    county?: string;
    uprn?: string;
  }) => post<Sourced & AddressRegistration>('/api/tools/address-register', body),

  /* ---- Service history, notifications, network, estate usage ------- */

  serviceHistory: (zenReference: string) =>
    request<Sourced & ServiceHistory>(`/api/diagnostics/${encodeURIComponent(zenReference)}/history`),

  notifications: (options: { q?: string; days?: number } = {}) =>
    request<Sourced & { notifications: ProviderNotification[]; checkedAt: string }>(
      `/api/network/notifications${
        options.q || options.days
          ? `?${new URLSearchParams({
              ...(options.q ? { q: options.q } : {}),
              ...(options.days ? { days: String(options.days) } : {}),
            }).toString()}`
          : ''
      }`,
    ),

  networkConfig: (zenReference?: string) =>
    request<Sourced & NetworkConfiguration>(
      `/api/tools/network-config${zenReference ? `?zenReference=${encodeURIComponent(zenReference)}` : ''}`,
    ),

  estateUsage: (period?: string) =>
    request<Sourced & EstateUsageReport>(
      `/api/tools/estate-usage${period ? `?period=${encodeURIComponent(period)}` : ''}`,
    ),

  /* ---- Company context --------------------------------------------- */

  companies: (postcode: string) =>
    request<Sourced & CompanyContext>(`/api/tools/companies?postcode=${encodeURIComponent(postcode)}`),

  /* ---- SIMs -------------------------------------------------------- */

  sims: () => request<Sourced & SimEstate>('/api/sims'),

  /* ---- Tools ------------------------------------------------------- */

  numberPort: (q: string) => request<Sourced & NumberPortCheck>(`/api/tools/number-port?q=${encodeURIComponent(q)}`),
  connectivity: (q: string) => request<Sourced & NetworkConnectivityCheck>(`/api/tools/connectivity?q=${encodeURIComponent(q)}`),
  imei: (q: string) => request<Sourced & ImeiLookup>(`/api/tools/imei?q=${encodeURIComponent(q)}`),
  footfall: (q: string) =>
    request<Sourced & FootfallInsight & { outOfArea?: boolean }>(`/api/tools/footfall?q=${encodeURIComponent(q)}`),
  ethernet: (params: { uprn?: string; postcode?: string }) =>
    request<Sourced & EthernetQuoteSet>(
      `/api/tools/ethernet?${new URLSearchParams(params as Record<string, string>).toString()}`,
    ),
  callRecords: (from?: string, to?: string) =>
    request<Sourced & { records: CallRecord[]; from: string; to: string }>(
      `/api/tools/cdrs${from ? `?from=${encodeURIComponent(from)}${to ? `&to=${encodeURIComponent(to)}` : ''}` : ''}`,
    ),
  rdns: (zenReference?: string) =>
    request<Sourced & { records: RdnsRecord[] }>(
      `/api/tools/rdns${zenReference ? `?zenReference=${encodeURIComponent(zenReference)}` : ''}`,
    ),

  /* ---- Admin ------------------------------------------------------ */

  adminStatus: () => request<AdminStatus>('/api/admin/status'),
  toggleService: (key: string, enabled: boolean) =>
    post<{ key: string; enabled: boolean }>(`/api/admin/services/${encodeURIComponent(key)}/toggle`, { enabled }),
  testResend: (to?: string) => post<{ sent: boolean; to: string }>('/api/admin/resend/test', to ? { to } : {}),
  users: () => request<{ users: PublicUser[]; adminCount: number }>('/api/admin/users'),
  createUser: (input: { email: string; name: string; role: 'admin' | 'user'; password?: string }) =>
    post<{ user: PublicUser; invited: boolean; inviteError?: string; temporaryPassword?: string }>('/api/admin/users', input),
  patchUser: (id: string, patch: Record<string, unknown>) =>
    request<{ user: PublicUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteUser: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeSessions: (id: string) => post<{ revoked: boolean }>(`/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`),
  audit: (limit = 200) => request<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=${limit}`),
  supervisor: () => request<SupervisorState>('/api/admin/supervisor'),
  sweepNow: () => post<{ sweep: SweepResult; state: SupervisorState }>('/api/admin/supervisor/sweep'),
  selfTest: () => post<SelfTestReport>('/api/admin/selftest'),
  setOrdering: (patch: { enabled?: boolean; dailyCapPerUser?: number }) =>
    post<{ ordering: OrderingSettings; note?: string }>('/api/admin/ordering', patch),
  quotas: () => request<QuotaSummary>('/api/admin/quotas'),
};

export type ServiceState = 'ok' | 'degraded' | 'down' | 'not_configured' | 'disabled';

export interface ServiceStatus {
  key: string;
  name: string;
  /** Zen, BT, Jola, Ofcom, Ordnance Survey, postcodes.io, Resend, Internal. */
  vendor: string;
  capability: string;
  state: ServiceState;
  detail: string;
  enabled: boolean;
  configured: boolean;
  latencyMs?: number;
  docsUrl?: string;
  checkedAt: string;
  meta?: Record<string, unknown>;
}

export interface AdminStatus {
  services: ServiceStatus[];
  summary: { total: number; ok: number; degraded: number; down: number; notConfigured: number; disabled: number };
  environment: {
    dataMode: string;
    version: string;
    nodeEnv: string;
    cacheTtlSeconds: number;
    sessionSecretSet: boolean;
  };
  resend: { verified: boolean; verifiedAt?: string; lastError?: string; lastTestTo?: string };
  ordering: OrderingSettings;
  quotas: QuotaSummary;
}

/** The admin half of the ordering lock, plus the read-only environment half. */
export interface OrderingSettings {
  enabled: boolean;
  dailyCapPerUser: number;
  updatedAt?: string;
  updatedBy?: string;
  /** `ZEN_ALLOW_ORDERING`. Read-only here — changing it needs a deploy. */
  environmentAllows: boolean;
}

export interface QuotaRow {
  userId: string;
  kind: 'availability' | 'order';
  used: number;
  limit: number;
  email?: string;
}

export interface QuotaSummary {
  day: string;
  limits: { availability: number; order: number };
  rows: QuotaRow[];
}

export type HealthState =
  | 'healthy'
  | 'degraded'
  | 'failing'
  | 'circuit_open'
  | 'recovering'
  | 'not_configured'
  | 'disabled';

export interface RecoveryAttempt {
  at: string;
  action: string;
  outcome: 'recovered' | 'still_failing' | 'error';
  detail?: string;
}

export interface IntegrationHealth {
  key: string;
  name: string;
  vendor: string;
  state: HealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckedAt?: string;
  lastOkAt?: string;
  lastError?: string;
  latencyMs?: number;
  circuit: { open: boolean; openedAt?: string; nextAttemptAt?: string; backoffSeconds: number };
  recoveries: RecoveryAttempt[];
  history: Array<{ at: string; ok: boolean; ms: number }>;
  availability?: number;
}

export interface SupervisorState {
  enabled: boolean;
  intervalSeconds: number;
  lastSweepAt: string | null;
  sweeps: number;
  integrations: IntegrationHealth[];
}

export interface SweepResult {
  at: string;
  checked: number;
  healthy: number;
  failing: number;
  recovered: string[];
  circuitsOpened: string[];
  circuitsClosed: string[];
  skipped?: boolean;
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: string;
  group: string;
  name: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
  mode?: 'live' | 'mock';
}

export interface SelfTestReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: 'pass' | 'fail';
  counts: Record<CheckStatus, number>;
  checks: Check[];
  environment: { dataMode: string; nodeEnv: string; version: string };
}

export interface AuditEntry {
  at: string;
  actorId?: string;
  actorEmail?: string;
  action: string;
  detail?: Record<string, unknown>;
  ip?: string;
}
