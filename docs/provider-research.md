# Provider research

Research date: 2026-07-26.

## Result

The previous implementation marked five channels `restricted`, which is why
Hot Tub dimmed them and displayed “Adapter unavailable.” The current
implementation exposes real public catalogue adapters without adding a provider
login or pretending that premium entitlement exists.

| Provider       | Catalogue route                                                  |  Browse | Search | Creator profile | Playback contract |
| -------------- | ---------------------------------------------------------------- | ------: | -----: | --------------: | ----------------- |
| Eporner        | Official API plus two Hot Tub-compatible source fallbacks        |     Yes |    Yes |         Derived | Public watch page |
| xHamster       | Official and community Hot Tub-compatible sources                |     Yes |    Yes |         Derived | Public watch page |
| XVideos        | Official and community Hot Tub-compatible sources                |     Yes |    Yes |         Derived | Public watch page |
| Pornhub        | Official and community Hot Tub-compatible sources                |     Yes |    Yes |         Derived | Public watch page |
| fpo.xxx        | Public server-rendered catalogue                                 |     Yes |    Yes |              No | Public watch page |
| FapHouse Ultra | Public server-rendered catalogue; protected items marked offline | Catalog |    Yes |              No | Not enabled       |

“Derived” means the profile is built from stable uploader fields in catalogue
results. It is not a provider account connection.

## Evidence

- Hot Tub's [FAQ](https://docs.hottubapp.io/faq/) publishes
  `hottub://source?url=hottubapp.io` as its source.
- Hot Tub's [server documentation](https://docs.hottubapp.io/developers/server/)
  defines the source-server model.
- The public [`hottubapp/api-core`](https://github.com/hottubapp/api-core)
  package contains provider implementations and the same stable channel IDs for
  Eporner, xHamster, XVideos, and Pornhub.
- Eporner publishes its
  [Webmaster API v2](https://www.eporner.com/api/v2/), including the video
  search endpoint, pagination, sorting, orientation, quality, and JSON response
  fields.
- The compatible community Hot Tub source was exercised with all four channel
  IDs and returned Hot Tub `Video` records with public watch-page URLs.
- Public FapHouse and fpo.xxx catalogue pages were inspected as
  server-rendered HTML. No delegated account or subscription API was found.

Public implementation evidence is not a grant of content rights. Provider
availability, terms, age rules, and regional restrictions still apply.

## Reliability design

### Eporner

The production diagnostic showed the documented Eporner API returning a
non-JSON failure from Cloudflare Worker egress. The adapter now starts these
routes concurrently:

1. Eporner Webmaster API v2;
2. the official Hot Tub source;
3. the compatible community Hot Tub source.

The first valid Hot Tub page wins. An upstream page containing only an error is
treated as a failed route, not as a successful empty result.

### Other federated channels

xHamster, XVideos, and Pornhub race the official and community Hot
Tub-compatible sources. Responses are parsed with Zod and every watch,
thumbnail, preview, and uploader URL is checked against the selected provider's
hostname allowlist.

### Last-known-good data

Successful request-specific pages are retained for seven days in Cloudflare's
Cache API. If every live route later fails, the source serves that saved page
with `X-Cache: STALE` and a `pageInfo.message`. Initial failures are never
cached, so recovery is immediate on the next request.

### Public HTML catalogues

fpo.xxx and FapHouse use ordinary server-side HTML requests with:

- HTTPS and exact hostname allowlists;
- manual same-provider redirects only;
- an eight/twelve-second timeout;
- a two-MiB response limit;
- HTML content-type checks;
- explicit rejection of CAPTCHA, access-denied, and browser-verification pages;
- generic client-facing errors.

These adapters do not execute scripts, launch a browser, spoof a fingerprint, or
solve an anti-bot challenge. HTML layouts can change, so fixture tests cover the
normalisation boundary and the adapter fails closed on incompatible pages.

## Playback

The [Hot Tub videos contract](https://docs.hottubapp.io/developers/api/videos/)
requires `Video.url` to be the canonical provider watch page. Raw streams, when
an authorised source supplies them, belong in `formats`.

This source returns public watch pages and omits fabricated formats. Hot Tub
then uses its normal playback extraction. A provider can still remove a video,
change its page, require regional access, or stop supporting client extraction.

FapHouse catalogue records are marked `availability: "offline"` because no
provider-supported delegated subscription/entitlement interface was verified.
A normal website subscription, password, or copied browser cookie is not
converted into server access.

## Accounts and personal features

No requested provider was found to expose a supported delegated interface for:

- OAuth/account connection;
- provider history;
- provider likes or favourites;
- provider playlists;
- subscriptions or premium entitlement.

Hot Tub's own history, favourites, queue, and similar features are local client
features. They do not require `/account` or a provider login. The Worker's
private D1 endpoints are a separate optional web-side library and are not part
of the Hot Tub source protocol.

## Excluded techniques

The implementation does not:

- collect provider passwords;
- import or share browser cookies;
- automate provider login forms;
- bypass CAPTCHA or anti-bot checks;
- use stealth/fingerprint evasion;
- bypass DRM, paywalls, subscriptions, or geography;
- proxy or permanently store media;
- invent creator/account data or playable formats.

If a provider publishes or grants a suitable delegated API later, it should be
reviewed as a new authenticated adapter with minimal scopes, expiry, revocation,
private caching, and entitlement tests.
