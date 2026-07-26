import type { RequestContext } from "../config";
import { sha256 } from "./ids";

function getDefaultCache(): Cache | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default: Cache }).default;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export async function videoCacheRequest(
  baseUrl: URL,
  requestBody: Record<string, unknown>,
): Promise<Request> {
  const digest = await sha256(JSON.stringify(sortValue(requestBody)));
  return new Request(new URL(`/__cache/videos/${digest}`, baseUrl), { method: "GET" });
}

export async function matchPublicCache(key: Request): Promise<Response | undefined> {
  return getDefaultCache()?.match(key);
}

export function putPublicCache(context: RequestContext, key: Request, response: Response): void {
  const cache = getDefaultCache();
  if (!cache) return;
  context.execution.waitUntil(cache.put(key, response.clone()));
}
