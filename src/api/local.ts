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
  "faphouse-ultra": ["faphouse.com", "faphouse2.com", "faphouse4k.com"],
  xvideos: ["xvideos.com"],
  pornhub: ["pornhub.com"],
  fpo: ["fpo.xxx"],
  eporner: ["eporner.com"],
};

const providerAssetHosts: Record<string, readonly string[]> = {
  xhamster: ["xhamster.com", "xhcdn.com"],
  "faphouse-ultra": ["faphouse.com", "faphouse2.com", "faphouse4k.com", "flixcdn.com"],
  xvideos: ["xvideos.com", "xvideos-cdn.com"],
  pornhub: ["pornhub.com", "phncdn.com"],
  fpo: ["fpo.xxx"],
  eporner: ["eporner.com"],
};

/**
 * Every write accepts the CSRF token in either the `X-CSRF-Token` header (the
 * JSON API) or a `csrf` body field (the server-rendered forms on /library),
 * so both callers share one set of endpoints.
 */
const csrfField = z.string().min(32).max(200).optional();

const localVideoSchema = z.object({
  csrf: csrfField,
  providerId: z.string().min(1).max(64),
  videoId: z.string().min(1).max(256),
  videoUrl: z.string().url(),
  title: z.string().min(1).max(500),
  thumb: z.string().url().optional(),
  duration: z.coerce.number().int().nonnegative().max(86_400).optional(),
  progressSeconds: z.coerce.number().int().nonnegative().max(86_400).optional(),
});

const videoRefSchema = z.object({
  csrf: csrfField,
  providerId: z.string().min(1).max(64),
  videoId: z.string().min(1).max(256),
});

const playlistSchema = z.object({
  csrf: csrfField,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

const playlistRefSchema = z.object({
  csrf: csrfField,
  playlistId: z.string().min(1).max(64),
});

const playlistUpdateSchema = z
  .object({
    csrf: csrfField,
    playlistId: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "Provide a new name or description.",
  });

const playlistItemSchema = localVideoSchema.extend({
  playlistId: z.string().min(1).max(64),
});

const playlistItemRefSchema = videoRefSchema.extend({
  playlistId: z.string().min(1).max(64),
});

const playlistMoveSchema = playlistItemRefSchema.extend({
  position: z.coerce.number().int().nonnegative().max(10_000),
});

const followSchema = z.object({
  csrf: csrfField,
  providerId: z.string().min(1).max(64),
  uploaderId: z.string().min(1).max(200),
  uploaderName: z.string().min(1).max(200),
  uploaderUrl: z.string().url().optional(),
  avatar: z.string().url().optional(),
});

const uploaderRefSchema = z.object({
  csrf: csrfField,
  providerId: z.string().min(1).max(64),
  uploaderId: z.string().min(1).max(200),
});

const clearSchema = z.object({ csrf: csrfField });

function validateProviderUrl(providerId: string, value: string, asset = false): string {
  if (!getProvider(providerId)) throw new HttpError(400, "Unknown provider.", "unknown_provider");
  const hosts = (asset ? providerAssetHosts : providerHosts)[providerId];
  if (!hosts) throw new HttpError(400, "Provider URL policy is unavailable.", "invalid_url");
  try {
    return assertAllowedHttpsUrl(value, hosts).toString();
  } catch {
    throw new HttpError(400, "URL does not belong to the selected provider.", "invalid_url");
  }
}

function validateVideoUrls<T extends { providerId: string; videoUrl: string; thumb?: string }>(
  body: T,
): T {
  body.videoUrl = validateProviderUrl(body.providerId, body.videoUrl);
  if (body.thumb) body.thumb = validateProviderUrl(body.providerId, body.thumb, true);
  return body;
}

/**
 * Reads-only: verify the source IP and spend rate-limit budget. Writes call
 * `authorizeWrite` after the body is parsed, because a form-encoded caller
 * carries its CSRF token in that body.
 */
async function authenticate(
  context: RequestContext,
  bucket: string,
  limit: number,
): Promise<{ userKey: string }> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(context, bucket, limit, 60, identity.userKey);
  return identity;
}

function requireWriteOrigin(context: RequestContext): void {
  requireSameOrigin(context.request, getPublicBaseUrl(context.env.PUBLIC_BASE_URL).origin);
}

function authorizeWrite(context: RequestContext, bodyToken?: string): void {
  requireCsrf(context.request, context.request.headers.get("X-CSRF-Token") ?? bodyToken ?? "");
}

/**
 * Form posts from /library expect to land back on the page they submitted
 * from; JSON callers expect a JSON body.
 */
function isFormSubmission(context: RequestContext): boolean {
  const contentType = context.request.headers.get("content-type") ?? "";
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function writeResponse(
  context: RequestContext,
  value: Record<string, unknown>,
  status = 201,
  redirectTo = "/library",
): Response {
  if (!isFormSubmission(context)) return jsonResponse(value, status);
  return new Response(null, {
    status: 303,
    headers: { "Cache-Control": "no-store", Location: redirectTo },
  });
}

export async function localSessionHandler(context: RequestContext): Promise<Response> {
  await authenticate(context, "local-read", 120);
  const token = newCsrfToken();
  return jsonResponse({ csrfToken: token }, 200, { "Set-Cookie": csrfCookie(token) });
}

export async function localHistoryHandler(context: RequestContext): Promise<Response> {
  const repository = new LocalLibraryRepository(context.env.DB);
  if (context.request.method === "GET") {
    const identity = await authenticate(context, "local-read", 120);
    return jsonResponse({ items: await repository.listHistory(identity.userKey) });
  }
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, localVideoSchema);
  authorizeWrite(context, body.csrf);
  validateVideoUrls(body);
  await repository.recordHistory(identity.userKey, body);
  return writeResponse(context, { saved: true });
}

export async function removeLocalHistoryHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, videoRefSchema);
  authorizeWrite(context, body.csrf);
  const removed = await new LocalLibraryRepository(context.env.DB).removeHistoryEntry(
    identity.userKey,
    body.providerId,
    body.videoId,
  );
  return writeResponse(context, { removed }, 200);
}

export async function clearLocalHistoryHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, clearSchema);
  authorizeWrite(context, body.csrf);
  const removed = await new LocalLibraryRepository(context.env.DB).clearHistory(identity.userKey);
  return writeResponse(context, { removed }, 200);
}

export async function localFavouritesHandler(context: RequestContext): Promise<Response> {
  const repository = new LocalLibraryRepository(context.env.DB);
  if (context.request.method === "GET") {
    const identity = await authenticate(context, "local-read", 120);
    return jsonResponse({ items: await repository.listFavourites(identity.userKey) });
  }
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, localVideoSchema);
  authorizeWrite(context, body.csrf);
  validateVideoUrls(body);
  await repository.addFavourite(identity.userKey, body);
  return writeResponse(context, { saved: true });
}

export async function removeLocalFavouriteHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, videoRefSchema);
  authorizeWrite(context, body.csrf);
  const removed = await new LocalLibraryRepository(context.env.DB).removeFavourite(
    identity.userKey,
    body.providerId,
    body.videoId,
  );
  return writeResponse(context, { removed }, 200);
}

export async function localPlaylistsHandler(context: RequestContext): Promise<Response> {
  const repository = new LocalLibraryRepository(context.env.DB);
  if (context.request.method === "GET") {
    const identity = await authenticate(context, "local-read", 120);
    return jsonResponse({ items: await repository.listPlaylists(identity.userKey) });
  }
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, playlistSchema);
  authorizeWrite(context, body.csrf);
  const id = await repository.createPlaylist(identity.userKey, body.name, body.description);
  return writeResponse(context, { id });
}

export async function updateLocalPlaylistHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, playlistUpdateSchema);
  authorizeWrite(context, body.csrf);
  const updated = await new LocalLibraryRepository(context.env.DB).updatePlaylist(
    identity.userKey,
    body.playlistId,
    { name: body.name, description: body.description },
  );
  if (!updated) throw new HttpError(404, "Playlist was not found.", "playlist_not_found");
  return writeResponse(context, { updated }, 200);
}

export async function deleteLocalPlaylistHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, playlistRefSchema);
  authorizeWrite(context, body.csrf);
  const deleted = await new LocalLibraryRepository(context.env.DB).deletePlaylist(
    identity.userKey,
    body.playlistId,
  );
  if (!deleted) throw new HttpError(404, "Playlist was not found.", "playlist_not_found");
  return writeResponse(context, { deleted }, 200);
}

export async function localPlaylistItemsHandler(context: RequestContext): Promise<Response> {
  const repository = new LocalLibraryRepository(context.env.DB);
  if (context.request.method === "GET") {
    const identity = await authenticate(context, "local-read", 120);
    const playlistId = new URL(context.request.url).searchParams.get("playlistId") ?? "";
    if (!playlistId) {
      throw new HttpError(400, "playlistId is required.", "invalid_request");
    }
    const playlist = await repository.getPlaylist(identity.userKey, playlistId);
    if (!playlist) throw new HttpError(404, "Playlist was not found.", "playlist_not_found");
    return jsonResponse({
      playlist,
      items: await repository.listPlaylistItems(identity.userKey, playlistId),
    });
  }
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, playlistItemSchema);
  authorizeWrite(context, body.csrf);
  validateVideoUrls(body);
  const added = await repository.addPlaylistItem(identity.userKey, body.playlistId, body);
  if (!added) throw new HttpError(404, "Playlist was not found.", "playlist_not_found");
  return writeResponse(context, { saved: true });
}

export async function removeLocalPlaylistItemHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, playlistItemRefSchema);
  authorizeWrite(context, body.csrf);
  const removed = await new LocalLibraryRepository(context.env.DB).removePlaylistItem(
    identity.userKey,
    body.playlistId,
    body.providerId,
    body.videoId,
  );
  return writeResponse(context, { removed }, 200);
}

export async function moveLocalPlaylistItemHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, playlistMoveSchema);
  authorizeWrite(context, body.csrf);
  const moved = await new LocalLibraryRepository(context.env.DB).movePlaylistItem(
    identity.userKey,
    body.playlistId,
    body.providerId,
    body.videoId,
    body.position,
  );
  if (!moved) throw new HttpError(404, "Playlist item was not found.", "playlist_item_not_found");
  return writeResponse(context, { moved }, 200);
}

export async function localFollowedUploadersHandler(context: RequestContext): Promise<Response> {
  const repository = new LocalLibraryRepository(context.env.DB);
  if (context.request.method === "GET") {
    const identity = await authenticate(context, "local-read", 120);
    return jsonResponse({ items: await repository.listFollowedUploaders(identity.userKey) });
  }
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, followSchema);
  authorizeWrite(context, body.csrf);
  if (!getProvider(body.providerId)) {
    throw new HttpError(400, "Unknown provider.", "unknown_provider");
  }
  if (body.uploaderUrl) {
    body.uploaderUrl = validateProviderUrl(body.providerId, body.uploaderUrl);
  }
  if (body.avatar) body.avatar = validateProviderUrl(body.providerId, body.avatar, true);
  await repository.followUploader(identity.userKey, body);
  return writeResponse(context, { saved: true });
}

export async function unfollowLocalUploaderHandler(context: RequestContext): Promise<Response> {
  const identity = await authenticate(context, "local-write", 60);
  requireWriteOrigin(context);
  const body = await parseBody(context.request, uploaderRefSchema);
  authorizeWrite(context, body.csrf);
  const removed = await new LocalLibraryRepository(context.env.DB).unfollowUploader(
    identity.userKey,
    body.providerId,
    body.uploaderId,
  );
  return writeResponse(context, { removed }, 200);
}
