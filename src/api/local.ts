import { z } from "zod";
import { verifyAdminIp } from "../auth/access";
import { csrfCookie, newCsrfToken, requireCsrf } from "../auth/csrf";
import type { RequestContext } from "../config";
import { getProvider } from "../providers/registry";
import { LocalLibraryRepository } from "../storage/library";
import { HttpError } from "../utils/errors";
import { jsonResponse, parseBody, requireSameOrigin } from "../utils/http";
import { enforceRateLimit } from "../utils/rate-limit";
import { assertAllowedHttpsUrl, getPublicBaseUrl } from "../utils/urls";

const providerHosts: Record<string, readonly string[]> = {
  xhamster: ["xhamster.com"],
  "faphouse-ultra": ["faphouse.com"],
  xvideos: ["xvideos.com"],
  pornhub: ["pornhub.com"],
  fpo: ["fpo.xxx"],
  eporner: ["eporner.com"],
};

const localVideoSchema = z.object({
  providerId: z.string().min(1).max(64),
  videoId: z.string().min(1).max(256),
  videoUrl: z.string().url(),
  title: z.string().min(1).max(500),
  thumb: z.string().url().optional(),
  duration: z.coerce.number().int().nonnegative().max(86_400).optional(),
  progressSeconds: z.coerce.number().int().nonnegative().max(86_400).optional(),
});

const removeFavouriteSchema = z.object({
  providerId: z.string().min(1).max(64),
  videoId: z.string().min(1).max(256),
});

const playlistSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

const followSchema = z.object({
  providerId: z.string().min(1).max(64),
  uploaderId: z.string().min(1).max(200),
  uploaderName: z.string().min(1).max(200),
  uploaderUrl: z.string().url().optional(),
  avatar: z.string().url().optional(),
});

function validateProviderUrl(providerId: string, value: string): string {
  if (!getProvider(providerId)) throw new HttpError(400, "Unknown provider.", "unknown_provider");
  const hosts = providerHosts[providerId];
  if (!hosts) throw new HttpError(400, "Provider URL policy is unavailable.", "invalid_url");
  try {
    return assertAllowedHttpsUrl(value, hosts).toString();
  } catch {
    throw new HttpError(400, "URL does not belong to the selected provider.", "invalid_url");
  }
}

async function authenticated(
  context: RequestContext,
  write: boolean,
): Promise<{ userKey: string }> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(
    context,
    write ? "local-write" : "local-read",
    write ? 60 : 120,
    60,
    identity.userKey,
  );
  if (write) {
    requireSameOrigin(context.request, getPublicBaseUrl(context.env.PUBLIC_BASE_URL).origin);
    requireCsrf(context.request, context.request.headers.get("X-CSRF-Token") ?? "");
  }
  return identity;
}

export async function localSessionHandler(context: RequestContext): Promise<Response> {
  await authenticated(context, false);
  const token = newCsrfToken();
  return jsonResponse({ csrfToken: token }, 200, { "Set-Cookie": csrfCookie(token) });
}

export async function localHistoryHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticated(context, context.request.method === "POST");
  const repository = new LocalLibraryRepository(context.env.DB);
  if (context.request.method === "GET") {
    return jsonResponse({ items: await repository.listHistory(identity.userKey) });
  }
  const body = await parseBody(context.request, localVideoSchema);
  body.videoUrl = validateProviderUrl(body.providerId, body.videoUrl);
  if (body.thumb) body.thumb = validateProviderUrl(body.providerId, body.thumb);
  await repository.recordHistory(identity.userKey, body);
  return jsonResponse({ saved: true }, 201);
}

export async function localFavouritesHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticated(context, context.request.method === "POST");
  const repository = new LocalLibraryRepository(context.env.DB);
  if (context.request.method === "GET") {
    return jsonResponse({ items: await repository.listFavourites(identity.userKey) });
  }
  const body = await parseBody(context.request, localVideoSchema);
  body.videoUrl = validateProviderUrl(body.providerId, body.videoUrl);
  if (body.thumb) body.thumb = validateProviderUrl(body.providerId, body.thumb);
  await repository.addFavourite(identity.userKey, body);
  return jsonResponse({ saved: true }, 201);
}

export async function removeLocalFavouriteHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticated(context, true);
  const body = await parseBody(context.request, removeFavouriteSchema);
  const removed = await new LocalLibraryRepository(context.env.DB).removeFavourite(
    identity.userKey,
    body.providerId,
    body.videoId,
  );
  return jsonResponse({ removed });
}

export async function createLocalPlaylistHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticated(context, true);
  const body = await parseBody(context.request, playlistSchema);
  const id = await new LocalLibraryRepository(context.env.DB).createPlaylist(
    identity.userKey,
    body.name,
    body.description,
  );
  return jsonResponse({ id }, 201);
}

export async function followLocalUploaderHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticated(context, true);
  const body = await parseBody(context.request, followSchema);
  if (body.uploaderUrl) {
    body.uploaderUrl = validateProviderUrl(body.providerId, body.uploaderUrl);
  }
  if (body.avatar) body.avatar = validateProviderUrl(body.providerId, body.avatar);
  await new LocalLibraryRepository(context.env.DB).followUploader(identity.userKey, body);
  return jsonResponse({ saved: true }, 201);
}
