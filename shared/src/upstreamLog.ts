/**
 * What an upstream refusal looked like, kept so it can be quoted.
 *
 * This exists because of a real conversation. Zen's systems team asked, of a
 * 401 we were seeing: which base URL, which token endpoint, which client id,
 * the exact response body, and roughly what time. Every one of those is
 * knowable at the moment the call fails and unknowable an hour later, and
 * "it says 401" is not something a supplier can investigate.
 *
 * So a failed upstream call is recorded with enough detail to be pasted into
 * a support email, and no more than that: never a credential, never a
 * bearer token, never a key that happened to be in the query string.
 */

export interface UpstreamFailure {
  /** ISO timestamp of the failure. */
  at: string;
  /** The provider label, e.g. `Zen assurance`. */
  label: string;
  method: string;
  /** The URL called, with any credential in the query string redacted. */
  url: string;
  status?: number;
  statusText?: string;
  /** The response body, truncated. Redacted the same way as the URL. */
  body?: string;
  /**
   * The scope or account the call was made under, where the provider has
   * such a thing. It is the first question a supplier asks.
   */
  scope?: string;
  /** A correlation id from the response headers, where one was sent. */
  requestId?: string;
}

/**
 * Query parameter names whose values must never be written down.
 *
 * Matched loosely on purpose: a name this misses is a key in a log file.
 */
const SENSITIVE_PARAM = /(key|token|secret|password|pwd|auth|signature|sig|subscription)/i;

export const REDACTED = '[redacted]';

/** Strips credentials out of a URL's query string, keeping its shape. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(name)) url.searchParams.set(name, REDACTED);
    }
    // A password in userinfo is rare and catastrophic to log.
    if (url.password) url.password = REDACTED;
    return url.toString();
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

/**
 * Removes anything token-shaped from a response body.
 *
 * Upstream error bodies do sometimes echo the request, and a JWT is
 * recognisable enough to strip on sight. The point is that a body can be
 * pasted into an email without reading every character of it first.
 */
export function redactBody(body: string): string {
  return body
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED)
    .replace(/("(?:access_token|id_token|refresh_token|client_secret|api_?key|password)"\s*:\s*)"[^"]*"/gi, `$1"${REDACTED}"`)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
}

/** How much of a body is worth keeping. Enough to contain an error code. */
export const BODY_LIMIT = 1200;

export function upstreamFailure(entry: Omit<UpstreamFailure, 'at'> & { at?: string }): UpstreamFailure {
  return {
    at: entry.at ?? new Date().toISOString(),
    label: entry.label,
    method: entry.method,
    url: redactUrl(entry.url),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.statusText ? { statusText: entry.statusText } : {}),
    ...(entry.body ? { body: redactBody(entry.body).slice(0, BODY_LIMIT) } : {}),
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
  };
}

const ukTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'medium' })} (UK)`;
};

/**
 * One failure, written out the way a supplier's systems team asked for it.
 *
 * Plain text and no cleverness: this gets pasted into an email.
 */
export function failureReport(entry: UpstreamFailure): string {
  const lines = [
    `When:      ${ukTime(entry.at)}`,
    `Endpoint:  ${entry.method} ${entry.url}`,
    ...(entry.scope ? [`Scope:     ${entry.scope}`] : []),
    `Response:  ${[entry.status, entry.statusText].filter(Boolean).join(' ') || 'no response'}`,
    ...(entry.requestId ? [`Their ref: ${entry.requestId}`] : []),
  ];
  if (entry.body) lines.push('', 'Response body:', entry.body);
  return lines.join('\n');
}

/**
 * Several failures as one report, newest first, with a heading naming the
 * account the calls were made under.
 */
export function supplierReport(
  entries: readonly UpstreamFailure[],
  context: { provider: string; clientId?: string; tokenUrl?: string; baseUrls?: string[] },
): string {
  const head = [
    `${context.provider} — failed API calls from SupportWizard NetKit`,
    ...(context.clientId ? [`Client ID:      ${context.clientId}`] : []),
    ...(context.tokenUrl ? [`Token endpoint: ${context.tokenUrl}`] : []),
    ...(context.baseUrls?.length ? [`Base URLs:      ${context.baseUrls.join(', ')}`] : []),
    `Environment:    production`,
  ];
  if (!entries.length) {
    return [...head, '', 'No failed calls have been recorded since this log was last cleared.'].join('\n');
  }
  const body = entries.map(
    (entry, index) => `--- ${index + 1} of ${entries.length} ---------------------------------------\n${failureReport(entry)}`,
  );
  return [...head, '', ...body].join('\n\n');
}

/** Groups failures by label, for a status board. */
export function failuresByLabel(entries: readonly UpstreamFailure[]): Array<{ label: string; count: number; latest: string }> {
  const map = new Map<string, { count: number; latest: string }>();
  for (const entry of entries) {
    const current = map.get(entry.label);
    if (!current) map.set(entry.label, { count: 1, latest: entry.at });
    else {
      current.count += 1;
      if (entry.at > current.latest) current.latest = entry.at;
    }
  }
  return [...map.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}
