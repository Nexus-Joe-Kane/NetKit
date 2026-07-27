# Provider research

Research date: 2026-07-26. Live re-verification: 2026-07-27.

## Live verification, 2026-07-27

The table below was previously design intent rather than measured behaviour:
the whole unit suite runs on fixtures, and the only live test covered Eporner.
Running every adapter against its real provider found **three of six channels
returning nothing**, and four distinct defects behind them.

| Channel        | Before                                | Cause                                                |
| -------------- | ------------------------------------- | ---------------------------------------------------- |
| xHamster       | Empty, no error (and it is `default`) | Empty upstream won the race; strict item array       |
| fpo.xxx        | "requires browser verification"       | Stale catalogue paths; anti-bot regex false positive |
| FapHouse Ultra | HTTP 404                              | Provider dropped its `/en/` locale prefix            |
| Eporner        | Worked, but marginally                | Own API answers in ~6s against an 8s timeout         |

Defects found and fixed:

1. **An empty upstream page won the race.** `hottubapp.io` answers `200` with
   zero items and no error for xHamster and Eporner. Being the fastest reply,
   it won `Promise.any` and starved out the community upstream that had the
   real results. Sources are now raced for the first _non-empty_ page
   (`src/providers/race.ts`), and an empty page is trusted only when every
   source agrees — if one failed, the error is reported so the caller can
   serve its last-known-good page instead of showing an empty channel.
2. **One malformed record discarded the whole page.** Items were validated as
   `z.array(upstreamVideoSchema)`, which is all-or-nothing. Upstreams routinely
   emit records with an empty `thumb` — three such records in a page of ten
   rejected the seven good ones. Records are now validated individually and the
   bad ones dropped, which is what the surrounding code already intended.
3. **The anti-bot check false-positived.** It matched a bare `captcha`, and both
   fpo.xxx and FapHouse serve a Cloudflare Turnstile script
   (`turnstile/v0/api.js?compat=recaptcha`) on ordinary catalogue pages, so
   every fetch failed closed. It now matches genuine interstitial markers only.
4. **Stale catalogue URLs.** fpo.xxx paginates by path segment (`/new-1/`,
   `/new-1/3/`, `/search/<q>/3/`); its `/videos/` and `?page=` forms return 404.
   FapHouse removed its `/en/` prefix.

All six channels now return browse and search results with valid watch and
thumbnail URLs. `tests/integration/providers.integration.test.ts` asserts this
for every adapter and is the only check that catches a provider changing its
URLs or response shape:

```bash
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

The public HTML catalogues (fpo.xxx, FapHouse) depend on page structure and
should be expected to break again; run the integration test before assuming a
channel still works.

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

The first route returning a page with actual items wins. An upstream page
containing only an error, and an upstream page containing no items at all, are
both treated as failed routes rather than as successful empty results.

### Other federated channels

xHamster, XVideos, and Pornhub race the official and community Hot
Tub-compatible sources. Responses are parsed with Zod one record at a time, so a
malformed entry is dropped rather than discarding the page, and every watch,
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
