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

## `pageInfo.parameters` must hold strings

The iOS client rejected valid responses with a generic
`APIError -1 / "Server Error"` while the diagnostics showed a `200` carrying a
full page of usable items. Nothing in the response was an error.

The cause is a type mismatch the prose documentation does not make obvious.
The published types
([`@hottubapp/api-core`](https://www.npmjs.com/package/@hottubapp/api-core),
`VideoResult`) declare:

```ts
pageInfo?: {
  hasNextPage: boolean;
  parameters?: Record<string, string>;
  [key: string]: any;
};
```

`parameters` is `Record<string, string>`, and the client decodes it strictly.
This source was emitting `page`, `pageSize`, `returnedResults`, and
`totalResults` as JSON numbers, so decoding failed and the app reported a
server error for a response the server considered successful. Neither
reference source triggers it: `hottubapp.io` omits `parameters` entirely and
puts `total` at the top level of `pageInfo`, where `[key: string]: any`
permits any type.

Every value under `parameters` is now serialised as a string, and
`tests/videos.test.ts` asserts it. The failure mode is worth remembering: an
invalid `pageInfo` is indistinguishable, from the app, from the source being
down — the items are fine and never get rendered.

`totalResults` is also omitted unless a provider actually reported one, rather
than sending `"0"` alongside a full page of results.

## Range controls are undocumented

The public field reference describes channel options only as lists of choices,
so a duration slider looks impossible from the documentation alone. The official
source's live `/api/status` shows otherwise:

```json
{
  "id": "durationSecondsRange",
  "title": "Duration",
  "systemImage": "timer",
  "options": [],
  "properties": {
    "control": "range",
    "min": "0",
    "max": "3600",
    "step": "60",
    "displayDivisor": "60",
    "unit": "min",
    "ticks": "[{\"value\":0,\"label\":\"0 min\"}, ...]",
    "minClientVersion": "2.3.0",
    "minClientBuild": "41"
  }
}
```

Three things worth noting, none of them documented:

- `properties` is an extra object on a channel option, and `control: "range"`
  is what makes the client draw a slider instead of a picker.
- Every value under `properties` is a **string**, including `ticks`, which is
  JSON encoded as text. This is the same trap as `pageInfo.parameters`.
- `options` is an empty array. A schema requiring at least one choice — as this
  project's did — rejects the control outright.

The client-version gate is reproduced as published, so builds older than
2.3.0/41 do not render a control they cannot draw.

What the app sends back when the slider moves is not documented either, so
`parseDurationRange` accepts `"min,max"`, `"min-max"`, `"min..max"`, a
two-element array, and `{min,max}`/`{from,to}` objects, and treats anything
unrecognised as no filter rather than as an empty result. The range is applied
to merged results instead of pushed down to providers, because only some of
them can express duration upstream while every item carries one.

## Status

`POST /api/status` returns a server with seven channels:

- `all` — the merged channel, and the source default. It is not a provider;
  `/api/videos` expands it into every browsable channel.
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
      "page": "1",
      "pageSize": "40",
      "returnedResults": "0"
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
