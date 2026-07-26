# Provider development

## Principle

An adapter is a policy boundary, not just a mapper. It may be activated only
when the upstream integration is stable, authorised, and compatible with a
Cloudflare Worker. If any of those conditions is missing, keep the restricted
stub.

## Interface

`src/providers/types.ts` defines:

```ts
export interface ProviderCapabilities {
  publicBrowse: boolean;
  publicSearch: boolean;
  uploaderBrowse: boolean;
  authenticatedAccess: boolean;
  history: boolean;
  likes: boolean;
  playlists: boolean;
  premiumAccess: boolean;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly channel: Channel;
  readonly capabilities: ProviderCapabilities;
  readonly status: ChannelStatus;
  readonly integration: "official" | "public" | "unavailable";
  readonly unavailableReason?: string;

  listVideos(request: VideosRequest, context: ProviderContext): Promise<ProviderVideoPage>;

  searchVideos(request: VideosRequest, context: ProviderContext): Promise<ProviderVideoPage>;

  getUploader?(request: UploadersRequest, context: ProviderContext): Promise<Uploader | null>;
}
```

Every capability is explicit. Do not infer support from the presence of a
method, and do not set a flag before its implementation and tests exist.

## Activation checklist

Before replacing a stub:

- link an official API, developer, partner, RSS, or export reference;
- record provider terms and any redistribution/display requirements;
- document authentication, scopes, expiry, rate limits, regional restrictions,
  and data retention;
- verify the integration does not depend on CAPTCHA solving, browser stealth,
  fingerprint spoofing, undocumented session cookies, or HTML scraping outside
  project policy;
- verify Workers runtime compatibility;
- add the smallest exact outbound hostname allowlist;
- define a Zod schema for the upstream payload;
- map only fields actually supplied;
- add fixtures and adapter/endpoint tests;
- update both research and support matrices;
- run the optional live test manually;
- review caching against the provider's terms and authentication state.

An internal site JSON endpoint is not automatically a supported public API.
Browser-accessible content is not automatically permitted for automated
retrieval.

## Implementation shape

1. Add or update `src/providers/<provider>.ts`.
2. Keep provider request/response types inside that module.
3. Declare a stable lowercase channel ID.
4. Add only options that the adapter consumes.
5. Construct upstream URLs from constants and validated scalar parameters.
6. Use `fetchProviderJson` or an equally strict helper.
7. Parse upstream JSON with Zod.
8. Convert each item to the Hot Tub `Video` model.
9. Validate every outbound watch, thumbnail, preview, uploader, and format URL.
10. Return `ProviderVideoPage`; let the protocol handler perform final
    validation and merging.

Do not return the upstream body directly.

## Normalisation rules

- `Video.url` is the canonical public provider watch page, never a CDN stream.
- Playable HLS/MP4 URLs belong only in `formats[].url`.
- Do not invent `formats`; omit them if the authorised API does not provide
  them.
- `duration` is integer seconds.
- `rating` is a 0–100 percentage.
- `channel` must exactly match the adapter ID.
- Invalid/off-domain URLs cause the item to be dropped.
- Unknown optional fields are omitted rather than guessed.
- Provider IDs remain opaque strings.
- `hasNextPage` comes from provider pagination, not item count heuristics when
  authoritative metadata exists.
- Uploader profiles are enabled only when the provider exposes stable profile
  identifiers and the adapter implements `getUploader`.

## Filters

Advertise a channel option only if it has a deterministic upstream mapping.
The option `id` becomes a top-level `/api/videos` request field. Validate the
value against an allowlist and map it to known upstream constants.

Never concatenate a custom filter into a URL or query language. Unknown values
should select a safe default.

## Authentication

Preferred mechanisms, in order:

1. OAuth with PKCE and a minimal scope set;
2. provider-issued short-lived access and refresh tokens;
3. provider-issued API tokens intended for delegated client use.

Do not accept provider passwords. Do not copy browser cookies. Do not automate a
login form. Do not expose a connect UI for a provider whose only available
mechanism is an undocumented session.

Use `ConnectionRepository` for encrypted token storage. Context-bind tokens to
the user and provider. Keep capability and entitlement checks server-side.

Authenticated responses must use `no-store` or a user-partitioned private cache.
Never place them in the existing anonymous Cache API path.

## Errors

Throwing from an adapter is safe: the protocol layer catches it, logs only the
provider ID and request ID, and emits a generic unavailable message.

For a provider-declared limitation, return:

```ts
{
  items: [],
  hasNextPage: false,
  error: "Provider is unavailable: concise public reason"
}
```

Do not include upstream status bodies, URLs, cookies, tokens, stack traces, or
anti-bot details.

## Tests

Unit tests must use captured, sanitised fixtures and cover:

- browse and search mapping;
- supported sorts and filters;
- pagination;
- upstream schema drift;
- malformed and off-domain URLs;
- timeout/network failure;
- response normalisation;
- block-list behavior at the protocol layer;
- multi-provider partial failure;
- uploader behavior if implemented;
- authentication expiry and refresh if implemented.

Put live tests under `tests/integration` and require an explicit environment
switch. CI should not depend on provider availability.

## Restricted adapter template

For an unavailable provider:

```ts
export const exampleProvider = createUnavailableProvider({
  id: "example",
  name: "Example",
  description: "Awaiting an authorised, stable provider integration.",
  reason: "no supported public or delegated API was verified",
  sortOrder: 70,
});
```

This keeps the requested channel visible without simulating browse, auth, or
premium capability.
