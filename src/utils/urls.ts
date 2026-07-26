import { DEFAULT_BASE_URL } from "../config";
import { ProviderError } from "./errors";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

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

export async function fetchProviderJson(
  providerId: string,
  fetcher: typeof fetch,
  url: URL,
  allowedHostnames: readonly string[],
): Promise<unknown> {
  assertAllowedHttpsUrl(url.toString(), allowedHostnames);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "UnifiedHotTubSource/1.0 (+https://hottub.joekane.org)",
      },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ProviderError(providerId, "provider request failed", true);
  }
  if (!response.ok) {
    throw new ProviderError(
      providerId,
      `provider returned HTTP ${response.status}`,
      response.status >= 500 || response.status === 429,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new ProviderError(providerId, "provider returned a non-JSON response");
  }
  try {
    return JSON.parse(await readLimitedText(response, MAX_PROVIDER_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(providerId, "provider returned invalid JSON");
  }
}

export function validateRedirectTarget(value: string, baseUrl: URL): URL {
  const target = new URL(value, baseUrl);
  if (target.origin !== baseUrl.origin) throw new Error("Cross-origin redirects are not allowed.");
  return target;
}
