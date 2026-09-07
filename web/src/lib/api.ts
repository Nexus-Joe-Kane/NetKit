import type {
  AddressRecord,
  AddressSuggestion,
  ApiError,
  ApiResult,
  LineRecord,
  ResolvedIdentifier,
  SearchResponse,
  SiteReport,
} from '@sw/shared';

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
};

export type ServiceState = 'ok' | 'degraded' | 'down' | 'not_configured' | 'disabled';

export interface ServiceStatus {
  key: string;
  name: string;
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
}

export interface AuditEntry {
  at: string;
  actorId?: string;
  actorEmail?: string;
  action: string;
  detail?: Record<string, unknown>;
  ip?: string;
}
