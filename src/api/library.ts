import { verifyAdminIp } from "../auth/access";
import { csrfCookie, newCsrfToken } from "../auth/csrf";
import type { RequestContext } from "../config";
import { LocalLibraryRepository } from "../storage/library";
import { htmlResponse } from "../utils/http";
import { enforceRateLimit } from "../utils/rate-limit";
import { libraryPage } from "../views";

export async function libraryHandler(context: RequestContext): Promise<Response> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(context, "library", 120, 60, identity.userKey);
  const repository = new LocalLibraryRepository(context.env.DB);

  const [history, favourites, playlists, followed] = await Promise.all([
    repository.listHistory(identity.userKey, 50),
    repository.listFavourites(identity.userKey, 50),
    repository.listPlaylists(identity.userKey),
    repository.listFollowedUploaders(identity.userKey),
  ]);

  const selectedId = new URL(context.request.url).searchParams.get("playlist");
  const selected = playlists.find((playlist) => playlist.id === selectedId) ?? playlists[0];
  const items = selected ? await repository.listPlaylistItems(identity.userKey, selected.id) : [];

  const csrfToken = newCsrfToken();
  return htmlResponse(
    libraryPage(context.env, {
      history,
      favourites,
      playlists,
      selectedPlaylist: selected,
      playlistItems: items,
      followed,
      csrfToken,
    }),
    200,
    { "Set-Cookie": csrfCookie(csrfToken) },
  );
}
