import { ProviderError } from "../utils/errors";

/**
 * FapHouse publishes no OAuth or delegated-access API, so the only way to act
 * on behalf of an entitled account without collecting a password or defeating
 * the login form's bot protection is for the operator to sign in themselves
 * and hand over the resulting session cookie.
 *
 * The cookie is stored encrypted and used server-side only. Nothing here logs
 * in, submits credentials, or solves a challenge.
 */

const FAPHOUSE_HOST = "faphouse.com";
const SESSION_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Markers that only render for a signed-in account. */
const SIGNED_IN_MARKERS: readonly RegExp[] = [
  /\/api\/auth\/signout/i,
  /"isAuthenticated"\s*:\s*true/i,
  /&quot;isAuthenticated&quot;\s*:\s*true/i,
  /\/api\/profile\//i,
];

/** Markers that only render for an anonymous visitor. */
const SIGNED_OUT_MARKERS: readonly RegExp[] = [
  /\/api\/auth\/signin/i,
  /\/api\/signup\/generate-username/i,
];

export interface SessionProbe {
  authenticated: boolean;
  /** Detail suitable for showing the operator; never contains the cookie. */
  detail: string;
}

function normaliseCookie(value: string): string {
  // Accept either a full `Cookie:` header value pasted from developer tools
  // or a single `name=value` pair.
  return value
    .replace(/^\s*cookie\s*:\s*/i, "")
    .split(/[\r\n]+/)[0]!
    .trim();
}

/**
 * Rejects anything that cannot be a cookie header, so a mistyped paste fails
 * here rather than being stored and silently never working.
 */
export function assertUsableCookie(value: string): string {
  const cookie = normaliseCookie(value);
  if (!/^[^\s=;]+=[^;]*(?:;\s*[^\s=;]+=[^;]*)*$/.test(cookie)) {
    throw new ProviderError("faphouse-ultra", "session cookie is not a valid cookie header");
  }
  return cookie;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchWithSession(
  fetcher: typeof fetch,
  url: URL,
  cookie: string,
): Promise<{ status: number; html: string }> {
  if (url.protocol !== "https:" || !url.hostname.endsWith(FAPHOUSE_HOST)) {
    throw new ProviderError("faphouse-ultra", "URL is outside the provider allowlist");
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Cookie: cookie,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("faphouse-ultra", "provider request failed", true);
  }
  return { status: response.status, html: await readLimited(response) };
}

/**
 * Confirms a pasted cookie actually represents a signed-in session, so a stale
 * or mistyped one is rejected at connect time instead of appearing to work.
 */
export async function probeSession(fetcher: typeof fetch, cookie: string): Promise<SessionProbe> {
  const { status, html } = await fetchWithSession(
    fetcher,
    new URL("https://faphouse.com/videos"),
    cookie,
  );
  if (status >= 400) {
    return { authenticated: false, detail: `FapHouse answered HTTP ${status}.` };
  }
  const signedIn = SIGNED_IN_MARKERS.filter((marker) => marker.test(html)).length;
  const signedOut = SIGNED_OUT_MARKERS.filter((marker) => marker.test(html)).length;
  if (signedIn === 0) {
    return {
      authenticated: false,
      detail:
        signedOut > 0
          ? "FapHouse served the signed-out page, so the cookie is not a live session."
          : "No signed-in markers were found on the response.",
    };
  }
  return {
    authenticated: true,
    detail: `Session accepted (${signedIn} signed-in marker${signedIn === 1 ? "" : "s"}).`,
  };
}

export interface PlaybackProbe {
  status: number;
  /** Distinct media URLs found, with query strings stripped. */
  mediaUrls: string[];
  /** Internal API paths referenced by the page. */
  apiPaths: string[];
  /** Whether anything looked like a real stream rather than a preview asset. */
  foundStreamCandidate: boolean;
  notes: string[];
}

const PREVIEW_MARKERS = /heat-preview|heatmap|preview_v\d|-\d{2,4}x\d{2,4}\.mp4/i;

/**
 * Reports what an entitled session actually exposes on a watch page.
 *
 * The anonymous page carries only heat-map scrubbing previews and no playable
 * source, so the shape of the authenticated response is unknown until an
 * operator with a subscription runs this. Its output is what a real format
 * resolver should be written against.
 */
export async function probePlayback(
  fetcher: typeof fetch,
  cookie: string,
  watchUrl: string,
): Promise<PlaybackProbe> {
  const { status, html } = await fetchWithSession(fetcher, new URL(watchUrl), cookie);
  const notes: string[] = [];

  const rawMedia = new Set<string>();
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'\\\s<>]{10,400}?\.(?:mp4|m3u8|mpd)/gi)) {
    rawMedia.add(match[0].replace(/\\\//g, "/"));
  }
  const media = [...rawMedia];
  const streams = media.filter((url) => !PREVIEW_MARKERS.test(url));

  const apiPaths = [
    ...new Set(
      [...html.matchAll(/(?:"|&quot;)(\/api\/[a-zA-Z0-9/_{}\-.]{2,80})(?:"|&quot;)/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].slice(0, 40);

  if (media.length > 0 && streams.length === 0) {
    notes.push("Only preview assets were present; no playable source is embedded in the HTML.");
  }
  if (streams.length > 0) {
    notes.push("Playable source candidates are embedded directly in the watch page.");
  }
  if (/\/api\/auth\/signin/i.test(html)) {
    notes.push("The page still renders signed-out markers; the session may have expired.");
  }

  return {
    status,
    // Query strings are dropped so signed tokens are never rendered or logged.
    mediaUrls: streams.slice(0, 10).map((url) => url.split("?")[0]!),
    apiPaths,
    foundStreamCandidate: streams.length > 0,
    notes,
  };
}
