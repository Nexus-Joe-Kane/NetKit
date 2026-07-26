# Provider research

Research date: 2026-07-26.

## Method and classification

The review prioritised provider-owned developer/API pages, provider terms, the
current Hot Tub documentation, and public source repositories. A browser-facing
site or internal JSON call was not treated as an authorised API.

Classifications:

- **Supported officially** — provider-published interface intended for
  integration.
- **Supported publicly** — explicit public interface with a stable public
  contract, though not presented as a full official developer API.
- **Undocumented** — observed or historically referenced, but without a current
  provider-supported contract suitable for implementation.
- **Unsupported** — no suitable supported interface was verified. This describes
  this project's integration decision, not a claim that a provider can never
  offer the feature.
- **Not implemented** — an interface exists, but this project does not use that
  capability.

Absence of published documentation is not proof that no private partner program
exists. Private integration can be reconsidered only with provider-issued
documentation and credentials.

## Discovery and authentication interfaces

| Provider       | Public API                                 | Authenticated API | OAuth       | API tokens  | Developer programme  | Partner API  | RSS/export                            | JSON                 | GraphQL      | Supported session auth |
| -------------- | ------------------------------------------ | ----------------- | ----------- | ----------- | -------------------- | ------------ | ------------------------------------- | -------------------- | ------------ | ---------------------- |
| Eporner        | Supported officially                       | Unsupported       | Unsupported | Unsupported | Supported officially | Unsupported  | Supported officially; not implemented | Supported officially | Unsupported  | Unsupported            |
| xHamster       | Unsupported                                | Unsupported       | Unsupported | Unsupported | Unsupported          | Unsupported  | Unsupported                           | Undocumented         | Undocumented | Unsupported            |
| FapHouse Ultra | Unsupported                                | Unsupported       | Unsupported | Unsupported | Unsupported          | Unsupported  | Unsupported                           | Undocumented         | Undocumented | Unsupported            |
| XVideos        | Unsupported                                | Unsupported       | Unsupported | Unsupported | Unsupported          | Unsupported  | Unsupported                           | Undocumented         | Undocumented | Unsupported            |
| Pornhub        | Undocumented (legacy Webmaster references) | Unsupported       | Unsupported | Unsupported | Undocumented         | Undocumented | Unsupported                           | Undocumented         | Undocumented | Unsupported            |
| fpo.xxx        | Unsupported                                | Unsupported       | Unsupported | Unsupported | Unsupported          | Unsupported  | Unsupported                           | Undocumented         | Undocumented | Unsupported            |

## Account, entitlement, and operating capabilities

| Provider       | History access | Favourites/likes | Playlists   | Subscriptions | Premium playback | Request rate limits                   | Regional rules                                                     | API terms                                          |
| -------------- | -------------- | ---------------- | ----------- | ------------- | ---------------- | ------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Eporner        | Unsupported    | Unsupported      | Unsupported | Unsupported   | Unsupported      | Undocumented beyond pagination bounds | Undocumented; `Site Unavailable` observed from the research egress | Supported officially                               |
| xHamster       | Unsupported    | Unsupported      | Unsupported | Unsupported   | Unsupported      | Undocumented                          | Undocumented                                                       | General site terms only                            |
| FapHouse Ultra | Unsupported    | Unsupported      | Unsupported | Unsupported   | Unsupported      | Undocumented                          | Undocumented                                                       | General site terms only                            |
| XVideos        | Unsupported    | Unsupported      | Unsupported | Unsupported   | Unsupported      | Undocumented                          | Undocumented                                                       | General site terms only                            |
| Pornhub        | Unsupported    | Unsupported      | Unsupported | Unsupported   | Unsupported      | Undocumented                          | Undocumented                                                       | General site terms; current API terms not verified |
| fpo.xxx        | Unsupported    | Unsupported      | Unsupported | Unsupported   | Unsupported      | Undocumented                          | Undocumented                                                       | General site terms only                            |

“Unsupported” premium playback means unsupported through a documented
server-to-server integration. It does not describe what a subscriber can watch
on the provider's own site. This Worker never tries to transfer or bypass that
entitlement.

## Implemented provider matrix

| Provider       | Public browse | Search | Uploader browse | Account | History | Likes | Playlists | Premium |
| -------------- | ------------: | -----: | --------------: | ------: | ------: | ----: | --------: | ------: |
| Eporner        |           Yes |    Yes |              No |      No |      No |    No |        No |      No |
| xHamster       |          Stub |   Stub |              No |      No |      No |    No |        No |      No |
| FapHouse Ultra |          Stub |   Stub |              No |      No |      No |    No |        No |      No |
| XVideos        |          Stub |   Stub |              No |      No |      No |    No |        No |      No |
| Pornhub        |          Stub |   Stub |              No |      No |      No |    No |        No |      No |
| fpo.xxx        |          Stub |   Stub |              No |      No |      No |    No |        No |      No |

The local D1 library is separate from these provider capabilities.

## Eporner

### Verified interface

Eporner publishes an official
[Webmaster API v2](https://www.eporner.com/api/v2/) with:

- `GET /api/v2/video/search/`;
- `GET /api/v2/video/id/`;
- `GET /api/v2/video/removed/`;
- JSON or XML output;
- documented CSV/RSS feeds;
- page sizes from 1 to 1000;
- query, page, thumbnail size, sort, orientation (`gay`), and low-quality (`lq`)
  controls.

This project implements only the JSON search endpoint because it covers public
browse (`query=all`) and search with the least upstream access. ID lookup,
removed-video lists, XML, CSV, and RSS are **Not implemented**.

The API supplies canonical watch URLs, thumbnails, duration, views, rating,
keywords, upload date, and sometimes uploader metadata. It does not supply a
documented account/OAuth or premium interface.

### Implementation decision

Status: **Supported officially and implemented**.

The Worker maps the official response to leaf Hot Tub videos. It does not scrape
the watch page and does not invent direct stream formats. Every returned URL
must be HTTPS on `eporner.com` or a subdomain. Requests use an eight-second
timeout, redirect refusal, a two-MiB response limit, a maximum Hot Tub page size
of 100, and public cache protection.

The provider page documents pagination limits but no requests-per-time quota.
That part is classified **Undocumented**; the project applies its own rate limit
and caching.

The opt-in live test on 2026-07-26 received HTTP 200 `text/html` with the title
`Site Unavailable` instead of JSON from the documented endpoint. This may be an
egress, provider-policy, or regional restriction; the response did not identify
which. The adapter failed closed and no bypass was attempted. This observation
does not change the API's official documentation, but production availability
must be verified from the deployed Cloudflare region.

## xHamster

### Findings

No current provider-published public API, OAuth flow, provider token scheme,
delegated account API, export, or account-library contract was verified.

The public [`hottubapp/api-core`](https://github.com/hottubapp/api-core)
repository was inspected as implementation evidence, not provider
authorisation. Its xHamster path relies on a headless-browser stack with stealth
behavior. That is outside this project's explicit security and provider-policy
boundary and is not reused.

### Implementation decision

Status: **Unsupported; restricted stub**.

The channel reports that no supported public or delegated API was verified and
that browser-stealth/anti-bot workarounds are excluded. It returns no fabricated
videos.

## FapHouse Ultra

### Findings

No provider-published OAuth, API-token, delegated entitlement, catalogue, or
premium-playback API was verified. A normal website subscription is not a
machine-to-machine grant and cannot be converted into one by collecting a
password or copying a browser cookie.

### Implementation decision

Status: **Unsupported; restricted premium stub**.

The channel remains in the Premium group so users can see the requested
provider, but every capability is false. No subscription, paywall, signed URL,
or DRM path is attempted.

## XVideos

### Findings

No official public developer API or delegated account interface was verified.
Public community implementations and the Hot Tub API-core implementation rely
on HTML extraction. Browser-visible HTML is not treated as a stable authorised
contract for this project.

### Implementation decision

Status: **Unsupported; restricted stub**.

HTML scraping and internal endpoints are intentionally excluded. The adapter
can be revisited if XVideos publishes or grants a suitable integration.

## Pornhub

### Findings

Legacy “Webmasters API” references exist publicly, but a current provider-owned,
supported integration contract could not be verified during this review. The
provider page could not be relied on as a current specification, and no
supported account, OAuth, favourites, playlists, subscription, or premium
playback interface was identified.

Historical endpoint references are therefore classified **Undocumented**, not
officially supported. Implementing against an old third-party description would
create an unstable and potentially unauthorised adapter.

### Implementation decision

Status: **Unsupported; restricted stub**.

The adapter states that legacy Webmaster endpoints require current verification
or a provider agreement before activation.

## fpo.xxx

### Findings

No documented public API, OAuth flow, provider-issued token, developer
programme, export, or account-library interface was verified. Internal site
requests, if any, are not a public integration contract.

### Implementation decision

Status: **Unsupported; restricted stub**.

The adapter exposes no capabilities and performs no network request.

## Excluded techniques

The research did not pursue and the implementation does not contain:

- CAPTCHA solving or anti-bot bypass;
- browser fingerprint or stealth automation;
- password interception or credential stuffing;
- copied, shared, or stolen cookies;
- undocumented login/session replay;
- DRM or paywall circumvention;
- subscription-entitlement or geographic bypass;
- extraction of protected media for unauthorised users.

## Re-evaluation criteria

A stub can move to active only when the provider offers a current documented or
contracted interface, the operator is authorised to use it, and the adapter
passes the checklist in [Provider development](provider-development.md). The
research date and source links must be updated in the same change.
