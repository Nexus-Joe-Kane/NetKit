import { DEFAULT_BASE_URL } from "../config";
import { ProviderError } from "./errors";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 12_000;
const PROVIDER_USER_AGENT = "UnifiedHotTubSource/2.0 (+https://hottub.joekane.org)";

export function getPublicBaseUrl(configured: string | undefined): URL {
  const candidate = configured?.trim() || DEFAULT_BASE_URL;
  const url = new URL(candidate);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_BASE_URL must be a clean HTTPS origin.");
  }
  url.pathname = "/";
  return url;
}

export function isAllowedHostname(hostname: string, allowedHostnames: readonly string[]): boolean {
  const normalised = hostname.toLowerCase();
  return allowedHostnames.some((allowed) => {
    const expected = allowed.toLowerCase();
    return normalised === expected || normalised.endsWith(`.${expected}`);
  });
}

export function assertAllowedHttpsUrl(value: string, allowedHostnames: readonly string[]): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !isAllowedHostname(url.hostname, allowedHostnames)
  ) {
    throw new Error("URL is outside the provider allowlist.");
  }
  return url;
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Provider response exceeded the configured size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

interface ProviderFetchOptions {
  method?: "GET" | "POST";
  headers?: HeadersInit;
  body?: string;
  expectedContentType: "json" | "html";
  allowRedirects?: boolean;
  timeoutMs?: number;
}

async function fetchProviderResponse(
  providerId: string,
  fetcher: typeof fetch,
  initialUrl: URL,
  allowedHostnames: readonly string[],
  options: ProviderFetchOptions,
): Promise<Response> {
  let url = assertAllowedHttpsUrl(initialUrl.toString(), allowedHostnames);
  const method = options.method ?? "GET";

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let response: Response;
    try {
      const headers = new Headers(options.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", PROVIDER_USER_AGENT);
      response = await fetcher(url, {
        method,
        headers,
        body: options.body,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError(providerId, "provider request failed", true);
    }

    if (
      options.allowRedirects &&
      method === "GET" &&
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) {
        throw new ProviderError(providerId, "provider returned an invalid redirect");
      }
      url = assertAllowedHttpsUrl(new URL(location, url).toString(), allowedHostnames);
      continue;
    }

    if (!response.ok) {
      throw new ProviderError(
        providerId,
        `provider returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes(options.expectedContentType)) {
      throw new ProviderError(
        providerId,
        `provider returned a non-${options.expectedContentType.toUpperCase()} response`,
      );
    }
    return response;
  }

  throw new ProviderError(providerId, "provider redirected too many times");
}

export async function fetchProviderJson(
  providerId: string,
  fetcher: typeof fetch,
  url: URL,
  allowedHostnames: readonly string[],
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchProviderResponse(providerId, fetcher, url, allowedHostnames, {
    expectedContentType: "json",
    headers: { Accept: "application/json" },
    timeoutMs,
  });
  try {
    return JSON.parse(await readLimitedText(response, MAX_PROVIDER_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(providerId, "provider returned invalid JSON");
  }
}

export async function postProviderJson(
  providerId: string,
  fetcher: typeof fetch,
  url: URL,
  allowedHostnames: readonly string[],
  payload: unknown,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchProviderResponse(providerId, fetcher, url, allowedHostnames, {
    method: "POST",
    expectedContentType: "json",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    timeoutMs,
  });
  try {
    return JSON.parse(await readLimitedText(response, MAX_PROVIDER_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(providerId, "provider returned invalid JSON");
  }
}

export async function fetchProviderHtml(
  providerId: string,
  fetcher: typeof fetch,
  url: URL,
  allowedHostnames: readonly string[],
): Promise<string> {
  const response = await fetchProviderResponse(providerId, fetcher, url, allowedHostnames, {
    expectedContentType: "html",
    allowRedirects: true,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-GB,en;q=0.8",
    },
  });
  const html = await readLimitedText(response, MAX_PROVIDER_RESPONSE_BYTES);
  if (/captcha|cf-chl-|verify you are human|access denied/i.test(html)) {
    throw new ProviderError(providerId, "provider requires interactive browser verification");
  }
  return html;
}

export function validateRedirectTarget(value: string, baseUrl: URL): URL {
  const target = new URL(value, baseUrl);
  if (target.origin !== baseUrl.origin) throw new Error("Cross-origin redirects are not allowed.");
  return target;
}
