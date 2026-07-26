# Hot Tub API research

Research date: 2026-07-26.

## Sources and evidence levels

| Source                                                                         | Type                           | Outcome                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- |
| [Server overview](https://docs.hottubapp.io/developers/server/)                | Documented                     | Canonical endpoint set, source URL scheme, channels, notices, naming                          |
| [Status endpoint](https://docs.hottubapp.io/developers/api/status/)            | Documented                     | Status/channel/group/options/status-enum contract and popup example                           |
| [Videos endpoint](https://docs.hottubapp.io/developers/api/videos/)            | Documented                     | Requests, pagination, video, uploader, format, and error/message fields                       |
| [Uploaders endpoint](https://docs.hottubapp.io/developers/api/uploaders/)      | Documented                     | Optional uploader profile request/response and error behavior                                 |
| [Page layout rows](https://docs.hottubapp.io/developers/api/page-layout-rows/) | Documented                     | Mixed leaf/featured browse item shapes                                                        |
| [URL schemes](https://docs.hottubapp.io/developers/url-schemes/)               | Documented                     | Add-source and in-app URL actions                                                             |
| [`hottubapp/mock-api`](https://github.com/hottubapp/mock-api)                  | Observed public implementation | Minimal example behavior; narrower than current docs                                          |
| [`hottubapp/api-core`](https://github.com/hottubapp/api-core)                  | Observed public implementation | Published models/extractors; includes runtime/provider approaches unsuitable here             |
| `https://hottub.spacemoehre.de`                                                | Attempted observation          | Host could not be safely/reliably retrieved in the research environment; no behavior inferred |

“Documented” below means stated by the current public docs. “Observed” means
found in the public example/package. “Assumption” means a compatibility choice
where the documents are silent. “Project decision” describes this Worker and is
not presented as part of Hot Tub's contract.

## Endpoint surface

Documented server endpoints:

```text
POST /api/status
POST /api/videos
POST /api/uploaders   (optional)
```

This project implements all three plus non-protocol `/`, `/health`, `/account`,
and Access-protected local-library routes.

## `POST /api/status`

### Documented request

The body may contain `clientVersion` and any global option values previously
advertised by the server.

```json
{
  "clientVersion": "2.2.7-38",
  "sort": "new"
}
```

### Documented response

Only `id` and `name` are truly required for a server. Channel objects require
`id` and `name`. Current optional server fields include:

- `subtitle`, `description`, `iconUrl`, `color`, `status`;
- `notices`;
- `channels`;
- `channelGroups`;
- `nsfw`, `categories`, `options`, `filtersFooter`;
- a popup system shown in the documentation's implementation section.

Current optional channel fields include:

- `description`, `premium`, `favicon`, `image`, `status`;
- `categories`, `tags`, `options`, `maintainers`;
- `nsfw`, `default`, `sortOrder`, `groupKey`;
- `ytdlpCommand`, `cacheDuration`.

Project response, abbreviated:

```json
{
  "id": "joe-unified-hottub",
  "name": "Joe's Unified Hot Tub Source",
  "status": "active",
  "nsfw": true,
  "notices": [
    {
      "status": "info",
      "message": "Official public integration available"
    }
  ],
  "channels": [
    {
      "id": "eporner",
      "name": "Eporner",
      "status": "active",
      "default": true,
      "options": []
    },
    {
      "id": "xhamster",
      "name": "xHamster",
      "status": "restricted"
    }
  ],
  "channelGroups": [
    {
      "id": "public",
      "title": "Public",
      "channelIds": ["xhamster", "xvideos", "pornhub", "fpo", "eporner"]
    },
    {
      "id": "premium",
      "title": "Premium",
      "channelIds": ["faphouse-ultra"]
    }
  ]
}
```

The actual Eporner response advertises sort, catalogue orientation, and quality
options. Restricted providers advertise no non-functional filters.

### Channels and groups

**Documented:** `channelGroups` has `id`, `title`, ordered `channelIds`, and
optional `systemImage`. It takes precedence over per-channel `groupKey` and
`sortOrder`. Without either mechanism, the client creates default premium and
general groups.

**Project decision:** only Public and Premium are emitted because they contain
real channel IDs. “Connected Accounts” and “Personal Library” are not emitted as
empty or invented protocol groups. Local-library routes are not Hot Tub
channels.

### Notices

**Documented:** a notice has `status` plus optional `message`, `details`,
`priority`, and `url`. Priority notices can appear on Home; regular notices are
shown less prominently.

**Project decision:** notices explain Eporner's official integration and the
five intentionally unavailable adapters. Provider limitations use a valid
channel `restricted` status plus human-readable notice/reason.

### Status enum

Documented values are:

```text
active normal ok inactive degraded maintenance restricted
error unknown testing
```

The Worker schema accepts only these values. It uses `active` for the server and
Eporner, and `restricted` for adapters without an authorised integration.

### Options and filters

**Documented:** an option has `id`, `title`, `options`, and optional
`systemImage`, `colorName`, `multiSelect`, and `value`. Choices have `id`,
`title`, optional `description`, and may contain nested options. Selected option
IDs are sent back as top-level request keys.

**Project decision:** Eporner exposes only values that map directly to the
official API:

- `sort`: popular, newest, rating, weekly, monthly, longest, shortest;
- `orientation`: exclude gay, all, gay only;
- `quality`: exclude low quality, all, low quality only.

Tags/categories/creator/playlist/history/likes/follow filters are not advertised
because the current adapters cannot implement them.

### Popup support

**Documented:** the status page contains a multi-page popup example with
sections, toggles, conditional actions, and custom views.

**Observed documentation difference:** `popup` appears in the example and popup
section but is not listed in the main `ServerStatus` field table. The older mock
surface is narrower.

**Project decision:** no popup is emitted. The source has no onboarding state
that requires one, and omitting the optional structure is safer than
reconstructing fields that are unnecessary here.

## `POST /api/videos`

### Documented request

```json
{
  "query": "example",
  "channels": ["eporner"],
  "sort": "new",
  "page": 1,
  "pageSize": 40,
  "clientVersion": "2.2.7-38",
  "blockedKeywords": ["blocked phrase"],
  "blockedUploaders": ["uploader-id"],
  "orientation": "all",
  "quality": "high"
}
```

Documented defaults are empty `query`, `relevance`, page 1, page size 40, and
empty block lists. `channels` overrides `channel`. Custom server options arrive
as top-level keys.

**Project limits:** one to ten channels, page size 1–100, page up to 1,000,000,
query up to 200 characters, and at most 100 entries in either block list.

### Documented response

```json
{
  "pageInfo": {
    "hasNextPage": true,
    "error": null,
    "message": null,
    "parameters": {
      "totalResults": 1000
    }
  },
  "items": [
    {
      "id": "provider-id",
      "title": "Example",
      "url": "https://provider.example/watch/example",
      "duration": 600,
      "channel": "provider",
      "thumb": "https://provider.example/thumb/example.jpg"
    }
  ]
}
```

`pageInfo.hasNextPage` is required. Optional metadata is
`recommendations`, `error`, `message`, and arbitrary `parameters`.

The required leaf video fields are `title`, `url`, `duration`, `channel`, and
`thumb`; `id` is optional. Other documented fields include views, percent
rating, uploader name/URL/ID, tags, categories, upload date, preview,
`formats`, aspect ratio, partial uploader profile, live state, availability,
and embed data. The current docs also describe server/client-derived aliases
such as `network` and `isVR`.

### Watch page and formats

**Documented:** top-level `url` is the canonical public watch page. It must not
be a stream or raw CDN URL. Direct playable HLS/MP4 URLs belong in
`formats[].url`.

Documented format metadata includes URL, format identifier, extension,
protocol, request headers, resolution/width/height, frame rate, codecs,
bitrates, dynamic range, aspect ratio, file size, language, and container.
`httpHeaders` is intended for headers legitimately required to request that
format.

**Project decision:** the Eporner public API does not document direct playback
formats, so the adapter omits `formats`. It returns only the public watch page.
The Hot Tub client may apply its normal extraction behavior; the Worker does not
scrape or proxy playback and never invents headers or media URLs.

### Pagination and merge behavior

**Documented:** page numbers and `hasNextPage` drive pagination.

**Project decision:** each selected adapter receives the same page and page
size. Provider results are round-robin merged up to the requested size.
`hasNextPage` is true when any adapter has another page. Total results are
summed only where providers report them.

Provider failures are isolated:

- one failure plus successful providers produces items and
  `pageInfo.message`;
- all selected providers unavailable produces an empty page and
  `pageInfo.error`;
- restricted adapters return an empty page without a network call.

### Block lists

**Documented:** the request contains `blockedKeywords` and
`blockedUploaders`.

**Project decision:** matching is case-insensitive. Keywords are checked against
title and tags; uploader blocks match uploader ID or name. Filtering occurs
after provider validation and before the cross-provider merge.

### Browse layouts

**Documented:** Home browse `items` may mix leaf videos with featured row
objects. A featured row has `type`, nested `items`, and no top-level `url`;
`grid` renders an inline 2×2 block and other types render rails.

**Project decision:** this source returns only leaf videos. Its current provider
has no authoritative featured-row data, so emitting layout rows would invent
editorial structure. The endpoint remains compatible with the basic documented
leaf array.

## `POST /api/uploaders`

### Documented request

At least one identifier is required:

```json
{
  "uploaderId": "abc123",
  "profileContent": true,
  "profileVideosSort": "uploadDate",
  "profileVideosOrder": "desc",
  "query": "current search"
}
```

`uploaderName` may replace `uploaderId`. A successful minimum profile contains
`id` and `name`. Optional fields cover URL/channel, verification, counts,
avatars, descriptions, channel statistics, videos, tapes, playlists,
calls-to-action, tips, layouts, and mixed browse items.

Documented errors are `400` when neither identifier is supplied, `404` when no
uploader matches, and `500` for internal failure.

**Project decision:** no enabled provider supplies a stable uploader-profile
contract. The endpoint validates the request and returns a documented `404`
`uploader_not_supported` response. It does not fabricate an empty uploader with
an ID/name.

## URL schemes

The documented source installation shape is:

```text
hottub://source?url=https://api.example.com
```

Hot Tub validates a source by calling its status endpoint. Other documented
actions include web view, search, profile, play, notifications, and debug
messages.

**Project decision:** the root page derives and URL-encodes the production
install link from `PUBLIC_BASE_URL`:

```text
hottub://source?url=https%3A%2F%2Fhottub.joekane.org
```

No user-controlled URL is redirected or fetched.

## Naming conventions

**Documented:** the iOS client flexibly decodes snake_case and camelCase through
snake-case conversion. Current guidance recommends choosing one style per
payload; snake_case is recommended moving forward, while camelCase offers
backward compatibility with the documented model names.

**Project decision:** this Worker consistently emits camelCase because the
current endpoint examples and TypeScript models use those names. It never emits
both aliases in one payload.

## Caching behavior

**Documented:** `Channel.cacheDuration` controls how long extracted video
details may remain valid before re-extraction. The docs do not define an HTTP
cache algorithm for source responses.

**Assumption:** ordinary HTTP cache headers and stable query-sensitive keys are
safe for anonymous public metadata when provider terms allow them.

**Project decision:**

- status: `public, max-age=60, stale-while-revalidate=300`;
- videos: Cache API with the same policy and a digest of the full validated
  request;
- CSS: one day;
- health, account, local library, errors, and uploader responses: `no-store`;
- no authenticated or signed media response enters a shared cache.

`X-Cache` reports `HIT` or `MISS` for video metadata.

## Observed differences and compatibility notes

1. Current docs are broader than the public mock, including channel groups,
   nested options, uploader layout/content, popup guidance, live metadata, and
   mixed browse rows.
2. The published API-core repository contains provider extractors and
   Node/browser-oriented dependencies. It is useful as observed model evidence
   but is not automatically suitable for a Worker or evidence that a provider
   authorises its extraction method.
3. The status docs say only server/channel `id` and `name` are truly required,
   while this project intentionally requires a non-empty channel list and
   validates a stricter safe subset.
4. The popup system is described outside the principal field-reference table.
   It is treated as optional and omitted.
5. The videos docs describe fields that may be server/client-derived. This
   project emits only adapter-sourced fields and does not synthesize `network`,
   `isVR`, embed data, or playable formats.
6. `hottub.spacemoehre.de` could not be reliably observed from the research
   environment. No undocumented dependency or behavior was copied from it.

## Implementation decisions summary

| Topic                  | Decision                                                              |
| ---------------------- | --------------------------------------------------------------------- |
| Protocol names         | Consistent camelCase                                                  |
| Output shape           | Strictly validated leaf videos                                        |
| Groups                 | Public and Premium only                                               |
| Restricted providers   | Valid `restricted` status plus explanatory notice/error               |
| Playback               | Public watch page; formats only if an authorised API supplies them    |
| Uploaders              | Documented 404 until an adapter supports profiles                     |
| Multi-provider failure | Partial success with message; all-failed empty result with error      |
| Popup/layout rows      | Omitted because current data does not justify them                    |
| HTTP cache             | Public anonymous status/videos only                                   |
| Account data           | Separate Access-protected local API, not represented as provider sync |
