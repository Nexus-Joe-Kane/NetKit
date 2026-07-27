import { accountHandler, connectHandler, diagnoseHandler, disconnectHandler } from "./api/account";
import { healthHandler } from "./api/health";
import { libraryHandler } from "./api/library";
import {
  clearLocalHistoryHandler,
  deleteLocalPlaylistHandler,
  localFavouritesHandler,
  localFollowedUploadersHandler,
  localHistoryHandler,
  localPlaylistItemsHandler,
  localPlaylistsHandler,
  localSessionHandler,
  moveLocalPlaylistItemHandler,
  removeLocalFavouriteHandler,
  removeLocalHistoryHandler,
  removeLocalPlaylistItemHandler,
  unfollowLocalUploaderHandler,
  updateLocalPlaylistHandler,
} from "./api/local";
import { statusHandler } from "./api/status";
import { uploadersHandler } from "./api/uploaders";
import { videosHandler } from "./api/videos";
import { verifyAllowedSourceIp } from "./auth/access";
import type { Env, RequestContext } from "./config";
import { HttpError } from "./utils/errors";
import { applySecurityHeaders, cssResponse, errorResponse, htmlResponse } from "./utils/http";
import { logger } from "./utils/logging";
import { appCss, rootPage } from "./views";

type Handler = (context: RequestContext, fetcher: typeof fetch) => Promise<Response>;

function route(method: string, path: string): Handler | undefined {
  const key = `${method} ${path}`;
  const routes: Record<string, Handler> = {
    "GET /": async (context) => htmlResponse(rootPage(context.env)),
    "HEAD /": async (context) => {
      const response = htmlResponse(rootPage(context.env));
      return new Response(null, { status: response.status, headers: response.headers });
    },
    "GET /assets/app.css": async () => cssResponse(appCss),
    "GET /health": healthHandler,
    "POST /api/status": statusHandler,
    "POST /api/videos": videosHandler,
    "POST /api/uploaders": uploadersHandler,
    "GET /library": libraryHandler,
    "GET /account": accountHandler,
    "POST /account/connect": connectHandler,
    "POST /account/diagnose": diagnoseHandler,
    "POST /account/disconnect": disconnectHandler,
    "GET /api/local/session": localSessionHandler,
    "GET /api/local/history": localHistoryHandler,
    "POST /api/local/history": localHistoryHandler,
    "POST /api/local/history/remove": removeLocalHistoryHandler,
    "POST /api/local/history/clear": clearLocalHistoryHandler,
    "GET /api/local/favourites": localFavouritesHandler,
    "POST /api/local/favourites": localFavouritesHandler,
    "POST /api/local/favourites/remove": removeLocalFavouriteHandler,
    "GET /api/local/playlists": localPlaylistsHandler,
    "POST /api/local/playlists": localPlaylistsHandler,
    "POST /api/local/playlists/update": updateLocalPlaylistHandler,
    "POST /api/local/playlists/delete": deleteLocalPlaylistHandler,
    "GET /api/local/playlists/items": localPlaylistItemsHandler,
    "POST /api/local/playlists/items": localPlaylistItemsHandler,
    "POST /api/local/playlists/items/remove": removeLocalPlaylistItemHandler,
    "POST /api/local/playlists/items/move": moveLocalPlaylistItemHandler,
    "GET /api/local/followed-uploaders": localFollowedUploadersHandler,
    "POST /api/local/followed-uploaders": localFollowedUploadersHandler,
    "POST /api/local/followed-uploaders/remove": unfollowLocalUploaderHandler,
  };
  return routes[key];
}

export async function handleRequest(
  request: Request,
  env: Env,
  execution: ExecutionContext,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const started = Date.now();
  const requestId = request.headers.get("X-Request-Id")?.slice(0, 100) || crypto.randomUUID();
  const url = new URL(request.url);
  const context: RequestContext = { env, execution, request, requestId };
  let response: Response;
  try {
    verifyAllowedSourceIp(request, env);
    const handler = route(request.method, url.pathname);
    if (!handler) {
      const knownPath = route("GET", url.pathname) || route("POST", url.pathname);
      if (knownPath) throw new HttpError(405, "Method not allowed.", "method_not_allowed");
      throw new HttpError(404, "Route not found.", "not_found");
    }
    response = await handler(context, fetcher);
  } catch (error) {
    logger.error("request_error", {
      requestId,
      path: url.pathname,
      method: request.method,
      errorType: error instanceof Error ? error.name : "Unknown",
    });
    response = errorResponse(error, requestId);
  }
  response = applySecurityHeaders(response, requestId);
  logger.info("request_complete", {
    requestId,
    path: url.pathname,
    method: request.method,
    status: response.status,
    durationMs: Date.now() - started,
  });
  return response;
}
