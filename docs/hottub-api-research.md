# Hot Tub API research

Research date: 2026-07-26.

## Primary references

| Reference                                                                      | Used for                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [Server overview](https://docs.hottubapp.io/developers/server/)                | Endpoint surface and source installation              |
| [Status endpoint](https://docs.hottubapp.io/developers/api/status/)            | Server, channel, group, option, notice, status fields |
| [Videos endpoint](https://docs.hottubapp.io/developers/api/videos/)            | Requests, pages, videos, formats, errors              |
| [Uploaders endpoint](https://docs.hottubapp.io/developers/api/uploaders/)      | Optional creator profiles                             |
| [Page layout rows](https://docs.hottubapp.io/developers/api/page-layout-rows/) | Optional mixed browse layouts                         |
| [URL schemes](https://docs.hottubapp.io/developers/url-schemes/)               | Add-source deep link                                  |
| [FAQ](https://docs.hottubapp.io/faq/)                                          | Official source URL and client troubleshooting        |
| [`hottubapp/api-core`](https://github.com/hottubapp/api-core)                  | Public implementation compatibility evidence          |

## Protocol surface

The documented source endpoints are:

```text
POST /api/status
POST /api/videos
POST /api/uploaders   (optional)
```

This Worker implements all three. `/`, `/health`, `/account`, and `/api/local/*`
are project-specific web endpoints and are not consumed by Hot Tub.

Every protocol and project-specific route is restricted to the exact configured
Cloudflare source IP. Hot Tub must therefore use the source while the device is
routed through one of the approved VPN egress addresses, `92.71.54.161` or
`177.7.57.50`.

## Status

`POST /api/status` returns a server with six channels:

- `xhamster`
- `faphouse-ultra`
- `xvideos`
- `pornhub`
- `fpo`
- `eporner`

The public, browseable channels report `active`. FapHouse reports `degraded`
because only public catalogue metadata is available. None reports `restricted`,
so Hot Tub does not disable the channel selector.

The response also uses documented fields including:

- server and channel status;
- notices;
- Public and Premium channel groups;
- `premium`, `default`, `sortOrder`, and `groupKey`;
- channel tags and maintainers;
- supported sort/catalogue options;
- `cacheDuration`.

Options selected in Hot Tub arrive as top-level `/api/videos` fields. Safe
primitive custom option values are forwarded to compatible Hot Tub upstreams.
Routing fields and local block lists are not disclosed to those upstreams.

## Videos

A typical request is:

```json
{
  "channel": "eporner",
  "query": "",
  "sort": "new",
  "page": 1,
  "pageSize": 40,
  "blockedKeywords": [],
  "blockedUploaders": []
}
```

`channels` takes precedence over `channel`. Selected adapters run concurrently,
invalid/off-domain records are dropped, local block lists are applied, and
multi-channel results are round-robin merged up to `pageSize`.

The response always follows:

```json
{
  "pageInfo": {
    "hasNextPage": false,
    "parameters": {
      "page": 1,
      "pageSize": 40,
      "returnedResults": 0,
      "totalResults": 0
    }
  },
  "items": []
}
```

Provider failures are isolated:

- successful providers still return items when another channel fails;
- partial failures are placed in `pageInfo.message`;
- if all live routes fail, a request-specific last-known-good response is used
  when available;
- if no saved success exists, `pageInfo.error` contains only a generic provider
  message.

Upstream response bodies, URLs, cookies, and exception details are never sent to
the app.

## Video and playback fields

The required leaf fields are:

- `title`
- `url`
- `duration`
- `channel`
- `thumb`

This implementation also supports the current optional fields it receives,
including ID, views, rating, uploader metadata, verification, tags, categories,
upload date, preview, aspect ratio, VR/live state, availability, embed data, and
formats.

The documented contract says `Video.url` is the canonical public watch page,
not a raw CDN stream. `formats[].url` is for a playable format explicitly
supplied by a source. The current adapters therefore return watch pages and do
not invent formats or playback headers. Hot Tub applies its normal extraction
and respects `cacheDuration` when deciding when to refresh extracted details.

FapHouse public catalogue items use `availability: "offline"` because protected
playback cannot be authorised by this source.

## Uploaders

`POST /api/uploaders` accepts `uploaderId` or `uploaderName`. For Eporner,
xHamster, XVideos, and Pornhub, the source returns a stable profile shell and,
when `profileContent` is true, matching public catalogue records. IDs are routed
by their `<channel>:` prefix if the request omits `channel`.

The profile is derived catalogue metadata. It does not represent login,
following, provider playlists, or an authenticated provider account.

fpo.xxx and FapHouse do not advertise creator browsing; their uploader request
returns the documented unsupported/not-found path rather than fabricated data.

## Client-local features

Hot Tub's history, favourites, queue, and other personal app state are local
client features. They are not source endpoints. The absence of a provider
account connection does not disable them.

The private `/account` page in this repository manages only future delegated
provider credentials and optional web-side D1 data. It cannot create a provider
connection when the provider has no delegated API.

## Installation

The source deep link is:

```text
hottub://source?url=https%3A%2F%2Fhottub.joekane.org
```

Hot Tub validates the source through `/api/status`. After a deployment that
changes channel status or options, refresh or remove/re-add the source if the
client is still showing cached channel metadata.

## Compatibility decisions

- Camel-case response fields are used consistently.
- Only leaf video rows are emitted; featured/editorial rows are optional.
- Page size is limited to 100 and no more than ten channels may be requested.
- Public response cache keys include the complete validated request.
- Initial all-provider errors are not cached.
- A saved last-known-good page is retained for seven days and is returned only
  for the exact same request key.
- Private/authenticated data never enters the public video cache.
