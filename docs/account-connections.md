# Account connections and local library

## What Hot Tub handles itself

Hot Tub does not use this page to enable browsing, playback, history,
favourites, or queues. Its personal app features are stored locally on the
device. The source protocol has no account-connect callback and consists of
status, videos, and optional uploader profiles.

The `/account` page is therefore an administrative capability screen for this
Worker. Seeing “No provider accounts are connected” is expected and does not
mean the Hot Tub app is unauthenticated or broken.

## Current state

None of the requested providers has a verified OAuth, provider-issued token, or
delegated account API suitable for this project. Therefore:

- no provider login form exists;
- no password, cookie, or browser session is requested;
- no provider account is connected by the current UI;
- provider-side history, likes, playlists, subscriptions, and premium playback
  are not claimed;
- the `/account` page truthfully shows no connections.

The account infrastructure is deliberately ready for a future authorised
adapter without pretending that such an adapter exists today.

## Whole-source VPN IP allowlist

The allowlist protects every route:

```text
/*
```

The committed `ADMIN_ALLOWED_IPS` value is `92.71.54.161,177.7.57.50`. The
Worker compares Cloudflare's exact `CF-Connecting-IP` header against that list
before routing any request. No Cloudflare Access application or login page is
required.

The client must route through the fixed VPN server. Requests from another
address return `403`, including Hot Tub status, browse, search, uploader,
landing-page, asset, and health requests. See [Deployment](deployment.md) before
overriding the allowlist.

`GET /account` displays only:

- provider ID;
- token expiry;
- advertised capabilities;
- last sync;
- last error;
- created/updated times through the repository model;
- a disconnect action.

Encrypted access and refresh tokens are never selected into the presentation
model and never rendered.

## Local library

Local data is private D1 data keyed to a stable, hashed single-admin identity. It
is not imported from or pushed back to any provider.

| Method | Path                                   | Behavior                                         |
| ------ | -------------------------------------- | ------------------------------------------------ |
| `GET`  | `/api/local/session`                   | Issues an hour-long CSRF token/cookie            |
| `GET`  | `/api/local/history`                   | Lists the latest 100 local history records       |
| `POST` | `/api/local/history`                   | Creates or updates progress for a provider video |
| `POST` | `/api/local/history/remove`            | Removes one history record                       |
| `POST` | `/api/local/history/clear`             | Removes every history record                     |
| `GET`  | `/api/local/favourites`                | Lists the latest 100 local favourites            |
| `POST` | `/api/local/favourites`                | Adds or updates a local favourite                |
| `POST` | `/api/local/favourites/remove`         | Removes a local favourite                        |
| `GET`  | `/api/local/playlists`                 | Lists playlists with their item counts           |
| `POST` | `/api/local/playlists`                 | Creates a named local playlist                   |
| `POST` | `/api/local/playlists/update`          | Renames or re-describes a playlist               |
| `POST` | `/api/local/playlists/delete`          | Deletes a playlist and its items                 |
| `GET`  | `/api/local/playlists/items`           | Lists one playlist's items in order              |
| `POST` | `/api/local/playlists/items`           | Appends a provider video to a playlist           |
| `POST` | `/api/local/playlists/items/remove`    | Removes an item and closes the position gap      |
| `POST` | `/api/local/playlists/items/move`      | Moves an item to an absolute position            |
| `GET`  | `/api/local/followed-uploaders`        | Lists followed creators                          |
| `POST` | `/api/local/followed-uploaders`        | Creates or updates a local creator follow        |
| `POST` | `/api/local/followed-uploaders/remove` | Unfollows a creator                              |

`GET /api/local/playlists/items` takes the playlist as a `?playlistId=` query
parameter; every other playlist route takes `playlistId` in the body.

Playlist item positions are always a dense `0..n-1` sequence. Adding appends to
the end, removing closes the gap, and a move past either end clamps to the first
or last slot.

All local writes require:

```http
Origin: https://hottub.joekane.org
Cookie: __Host-hottub_csrf=<token>
X-CSRF-Token: <same-token>
```

Every write also accepts the token as a `csrf` body field instead of the header,
which is how the `/account/disconnect` and `/library` HTML forms submit it. A
write sent as `application/x-www-form-urlencoded` answers with a `303` redirect
back to `/library` rather than a JSON body, so the forms work without JavaScript.

## The `/library` page

`GET /library` renders the D1 library for the approved VPN address: playlists and
their ordered items, favourites, followed creators, and watch history, each with
forms for the mutations above. The page ships no JavaScript and no inline styles,
because the HTML content security policy sets neither `script-src` nor
`style-src 'unsafe-inline'`.

Provider video, thumbnail, uploader, and avatar URLs are accepted only when
their host matches the selected provider allowlist. This prevents the local API
from becoming arbitrary URL storage.

## Example local history write

While connected through the allowed VPN, first obtain a CSRF token from the
private session endpoint. A browser receives the matching cookie:

```http
GET /api/local/session

{"csrfToken":"..."}
```

Then:

```http
POST /api/local/history
Content-Type: application/json
Origin: https://hottub.joekane.org
X-CSRF-Token: ...
Cookie: __Host-hottub_csrf=...

{
  "providerId": "eporner",
  "videoId": "abc123",
  "videoUrl": "https://www.eporner.com/hd-porn/abc123/example/",
  "title": "Example",
  "duration": 600,
  "progressSeconds": 120
}
```

This records local progress only.

## D1 connection data

`provider_connections` stores:

- an opaque row ID;
- hashed single-admin user key;
- provider ID;
- encrypted access and refresh token envelopes;
- token expiry;
- encryption key ID;
- a JSON capability snapshot;
- last sync/error metadata;
- timestamps.

`ConnectionRepository.save` requires an encryption key ring and encrypts before
binding values to D1. `list` returns metadata only. `get` decrypts only when a
key ring is explicitly supplied.

## Requirements for a future connection flow

A new provider may expose a Connect action only after all of these are true:

1. the provider documents an OAuth, API-token, or delegated-access mechanism;
2. its terms allow this client/server use;
3. redirect URIs and scopes are fixed and minimal;
4. state and PKCE are validated where OAuth applies;
5. passwords and raw browser cookies are never collected;
6. token refresh and revocation are implemented;
7. entitlements come from the provider and are never inferred;
8. private browse results bypass or partition public caching;
9. capability, expiry, sync, and error states are visible in `/account`;
10. fixture tests cover expiry, rotation, revocation, and provider failures.

Premium media may be returned only when the provider explicitly confirms the
requesting user's entitlement and supplies an authorised playable URL. Signed
URLs must not be logged or cached beyond their expiry.

## Disconnect and deletion

Disconnect removes only the matching user's provider connection. Local history,
favourites, playlists, and follows remain separate by design and are cleared from
`/library` or the local endpoints instead. An operator who needs full erasure
should delete rows for the hashed `user_key` from every local table using a
controlled D1 administrative process.

The project does not provide an unauthenticated erasure endpoint because that
would weaken the private-data boundary.
