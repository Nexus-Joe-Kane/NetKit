import type { VideoFormat } from "../hottub/schemas";
import { ProviderError } from "../utils/errors";

/**
 * FapHouse publishes no OAuth or delegated-access API, but `/api/auth/signin`
 * is a plain JSON endpoint taking `login` and `password`. There are therefore
 * two ways to connect an account:
 *
 * 1. Revocable, app-specific credentials generated in the operator's account
 *    portal. Preferred — the session renews itself when it lapses, and the
 *    credentials can be withdrawn without touching the account password.
 * 2. A session cookie the operator copies from their own signed-in browser.
 *    No renewal, so it has to be re-pasted when it expires.
 *
 * Both are stored encrypted and used server-side only. Nothing here solves a
 * challenge or works around bot protection; the sign-in endpoint accepts an
 * ordinary JSON request.
 */

const FAPHOUSE_HOST = "faphouse.com";

/**
 * Sent on every provider request and echoed into `formats[].httpHeaders`, so
 * the CDN sees the same client that was issued the signed URL.
 */
export const PLAYBACK_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
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
        "User-Agent": PLAYBACK_USER_AGENT,
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

const SIGNIN_URL = new URL("https://faphouse.com/api/auth/signin");

export interface CredentialSignIn {
  authenticated: boolean;
  detail: string;
  /** Cookie header to replay on subsequent authenticated requests. */
  sessionCookie?: string;
  premium?: boolean;
}

interface SignInBody {
  errors?: Record<string, string[]>;
  userId?: number | string | null;
  hasGoldSubscription?: boolean;
}

function collectSetCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw =
    headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ?? "").split(/,(?=[^;]+=)/);
  return raw
    .map((entry) => entry.split(";", 1)[0]!.trim())
    .filter((pair) => /^[^\s=;]+=[^;]*$/.test(pair) && !/=(?:deleted|)$/.test(pair))
    .join("; ");
}

function firstError(body: SignInBody): string | undefined {
  for (const messages of Object.values(body.errors ?? {})) {
    if (messages?.[0]) return messages[0];
  }
  return undefined;
}

/**
 * Exchanges credentials for a session.
 *
 * FapHouse has no OAuth, but `/api/auth/signin` is a plain JSON endpoint
 * taking `login` and `password` and answering with `userId` and
 * `hasGoldSubscription`. Storing revocable, app-specific credentials rather
 * than a copied cookie means the session can be renewed automatically when it
 * expires, and the operator can revoke them without touching their account
 * password.
 */
export async function signIn(
  fetcher: typeof fetch,
  login: string,
  password: string,
): Promise<CredentialSignIn> {
  let response: Response;
  try {
    response = await fetcher(SIGNIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": PLAYBACK_USER_AGENT,
      },
      body: JSON.stringify({ login, password }),
      redirect: "manual",
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("faphouse-ultra", "provider request failed", true);
  }

  let body: SignInBody;
  try {
    body = JSON.parse(await readLimited(response)) as SignInBody;
  } catch {
    // A non-JSON answer means the endpoint changed or a challenge intervened.
    return { authenticated: false, detail: `Sign-in returned HTTP ${response.status}.` };
  }

  const error = firstError(body);
  if (error || !body.userId) {
    // The provider's own wording is surfaced, truncated, and never echoes the
    // submitted credentials.
    return { authenticated: false, detail: (error ?? "Sign-in was rejected.").slice(0, 160) };
  }

  const sessionCookie = collectSetCookie(response);
  if (!sessionCookie) {
    return { authenticated: false, detail: "Sign-in succeeded but returned no session cookie." };
  }
  return {
    authenticated: true,
    sessionCookie,
    premium: body.hasGoldSubscription === true,
    detail: body.hasGoldSubscription
      ? "Signed in with an active Gold subscription."
      : "Signed in. The account has no Gold subscription, so protected titles stay unavailable.",
  };
}

/**
 * Reads how long a stream actually runs.
 *
 * FapHouse serves trailers over HLS from the same CDN as the full video — its
 * own page advertises an `hlsTrailers` experiment — so neither the hostname nor
 * the file extension distinguishes them, and picking by resolution happily
 * returned a 39-second trailer for an 11-minute title. A playlist states its
 * own length, so the only reliable discriminator is to read it.
 *
 * Returns `undefined` for anything that is not an HLS playlist, or when the
 * playlist cannot be read; the caller then falls back rather than discarding a
 * candidate it simply could not measure.
 */
export async function measureStreamSeconds(
  fetcher: typeof fetch,
  url: string,
  depth = 0,
): Promise<number | undefined> {
  if (!/\.m3u8(?:$|\?)/i.test(url) || depth > 1) return undefined;
  let text: string;
  try {
    const response = await fetcher(url, {
      headers: { "User-Agent": PLAYBACK_USER_AGENT, Referer: "https://faphouse.com/" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    text = await response.text();
  } catch {
    return undefined;
  }

  const durations = [...text.matchAll(/#EXTINF:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  if (durations.length > 0) {
    const total = durations.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    return total > 0 ? total : undefined;
  }

  // A master playlist lists variants rather than segments; follow the first.
  const variant = text
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0 && !line.startsWith("#"));
  if (!variant) return undefined;
  return measureStreamSeconds(fetcher, new URL(variant.trim(), url).toString(), depth + 1);
}

/**
 * A stream shorter than this fraction of the catalogue duration is a trailer,
 * not the title. Deliberately loose: HLS segment totals drift a little from
 * the advertised runtime, and rejecting a real stream is worse than keeping a
 * slightly mismeasured one.
 */
const MIN_LENGTH_RATIO = 0.6;

/** How many candidates are measured before giving up and taking them as-is. */
const MAX_MEASURED_CANDIDATES = 3;

/**
 * Keeps only the candidates that run close to the advertised length.
 *
 * Without the catalogue duration to compare against there is nothing to judge,
 * so every candidate is kept. Unmeasurable candidates are kept too — dropping
 * a stream this cannot read would trade a wrong video for no video.
 */
async function selectFullLengthStreams(
  fetcher: typeof fetch,
  streams: readonly string[],
  expectedSeconds: number | undefined,
): Promise<string[]> {
  if (!expectedSeconds || expectedSeconds <= 0 || streams.length <= 1) return [...streams];

  const kept: string[] = [];
  const unmeasured: string[] = [];
  for (const url of streams.slice(0, MAX_MEASURED_CANDIDATES)) {
    const seconds = await measureStreamSeconds(fetcher, url);
    if (seconds === undefined) {
      unmeasured.push(url);
      continue;
    }
    if (seconds >= expectedSeconds * MIN_LENGTH_RATIO) kept.push(url);
  }
  if (kept.length > 0) return kept;
  // Everything measurable was a trailer; fall back to whatever could not be
  // measured rather than returning nothing playable at all.
  return unmeasured.length > 0 ? unmeasured : [...streams];
}

/** Ordered biggest-first, so the client's default pick is the best quality. */
const HEIGHT_PATTERN = /(?:^|[^0-9])(2160|1440|1080|720|480|360|240)p?(?:[^0-9]|$)/i;

function heightOf(url: string): number | undefined {
  const height = Number(HEIGHT_PATTERN.exec(url)?.[1]);
  return Number.isFinite(height) ? height : undefined;
}

/**
 * Turns an entitled watch page into Hot Tub `formats[]`.
 *
 * Supplying formats does two things the app cannot do for itself here. It
 * bypasses yt-dlp extraction, which has no session and therefore never sees a
 * protected source, and it carries `httpHeaders`, which the Hot Tub docs name
 * as the mechanism for CDN hotlink protection — a device diagnostic showed
 * playback failing with no Referer sent and `NSURLErrorDomain -1008`.
 *
 * The session cookie is deliberately *not* included in those headers. The
 * signed URL already carries its own token and expiry, so the cookie should be
 * unnecessary, and shipping an account credential to the client is not
 * something to do on an assumption. If a CDN turns out to require it,
 * `/account/diagnose` reports that explicitly and it becomes a decision to take
 * knowingly rather than a default.
 */
export async function resolvePlaybackFormats(
  fetcher: typeof fetch,
  cookie: string,
  watchUrl: string,
  expectedSeconds?: number,
): Promise<VideoFormat[]> {
  const probe = await probePlayback(fetcher, cookie, watchUrl, { redact: false });
  const candidates = await selectFullLengthStreams(fetcher, probe.rawStreams, expectedSeconds);
  const seen = new Set<string>();
  const formats: VideoFormat[] = [];
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    const height = heightOf(url);
    const isHls = /\.m3u8(?:$|\?)/i.test(url);
    formats.push({
      url,
      ext: isHls ? "mp4" : "mp4",
      protocol: isHls ? "m3u8_native" : "https",
      ...(height === undefined ? {} : { height, resolution: `${height}p` }),
      httpHeaders: {
        Referer: new URL(watchUrl).origin + "/",
        "User-Agent": PLAYBACK_USER_AGENT,
      },
    });
  }
  formats.sort((left, right) => (right.height ?? 0) - (left.height ?? 0));
  return formats.slice(0, 10);
}

export interface PlaybackProbe {
  status: number;
  /** Distinct media URLs found, with every signed token redacted. */
  mediaUrls: string[];
  /** Internal API paths referenced by the page. */
  apiPaths: string[];
  /** Whether anything looked like a real stream rather than a preview asset. */
  foundStreamCandidate: boolean;
  /** When the first candidate's signed URL stops working, if it says so. */
  expiresAt?: string;
  /** Minutes of life left in that token at the moment of probing. */
  expiresInMinutes?: number;
  /**
   * Whether the CDN served the first candidate without the account session.
   * This decides whether a format resolver can hand Hot Tub a plain URL or
   * would have to ship the account's cookie to the client to make it play.
   */
  playableWithoutSession?: boolean;
  /** Unredacted stream URLs, for the resolver. Never rendered or logged. */
  rawStreams: string[];
  notes: string[];
}

const PREVIEW_MARKERS = /heat-preview|heatmap|preview_v\d|-\d{2,4}x\d{2,4}\.mp4/i;

/**
 * Signed CDN URLs carry `<token>,<expiry>` as a *path* segment rather than a
 * query string, so stripping the query — which is what this used to do — left
 * live tokens on screen. Everything that looks like a signature is replaced,
 * and the expiry is reported separately as a plain timestamp.
 */
export function redactSignedUrl(url: string): string {
  const withoutQuery = url.split("?")[0]!;
  return withoutQuery.replace(/\/[A-Za-z0-9+/=_-]{16,},\d{9,}/g, "/<signed>");
}

/** Reads the `,<epoch-seconds>` expiry that follows a signature. */
export function signedUrlExpiry(url: string): Date | undefined {
  const seconds = Number(/,(\d{9,11})(?:[/,]|$)/.exec(url.split("?")[0]!)?.[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Asks the CDN for a single byte, deliberately without the account cookie.
 *
 * A signed URL that answers here is playable by the app directly. One that does
 * not would only work if the source handed the account's session to the client,
 * which is not something to do silently.
 */
async function reachableAnonymously(fetcher: typeof fetch, url: string): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    void response.body?.cancel();
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  }
}

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
  options: { redact?: boolean } = {},
): Promise<PlaybackProbe> {
  const { status, html } = await fetchWithSession(fetcher, new URL(watchUrl), cookie);
  const notes: string[] = [];

  const rawMedia = new Set<string>();
  // Escaped slashes are allowed *throughout* the path, not just after the
  // scheme: these URLs are usually embedded in JSON, where every separator
  // arrives as `\/`. Excluding backslashes from the path — as this originally
  // did — truncated the match at the first one, so a JSON-embedded source was
  // silently invisible even though the unescaping below assumed otherwise.
  const mediaPattern = /https?:(?:\\?\/){2}(?:[^"'\\\s<>]|\\\/){10,400}?\.(?:mp4|m3u8|mpd)/gi;
  for (const match of html.matchAll(mediaPattern)) {
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

  const first = streams[0];
  const expiry = first ? signedUrlExpiry(first) : undefined;
  const expiresInMinutes = expiry
    ? Math.round((expiry.getTime() - Date.now()) / 60_000)
    : undefined;

  // Skipped when resolving formats: it costs a subrequest per item and only
  // informs the operator-facing diagnostic.
  const probeAnonymous = options.redact !== false;
  const playableWithoutSession =
    first && probeAnonymous ? await reachableAnonymously(fetcher, first) : undefined;
  if (playableWithoutSession === true) {
    notes.push("The CDN served the signed URL without the account session.");
  } else if (playableWithoutSession === false) {
    notes.push("The CDN refused the signed URL without the account session.");
  }

  return {
    status,
    mediaUrls: streams.slice(0, 10).map(redactSignedUrl),
    rawStreams: streams.slice(0, 10),
    apiPaths,
    foundStreamCandidate: streams.length > 0,
    expiresAt: expiry?.toISOString(),
    expiresInMinutes,
    playableWithoutSession,
    notes,
  };
}
