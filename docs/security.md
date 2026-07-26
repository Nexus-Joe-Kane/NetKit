# Security

## Security posture

This Worker treats public metadata retrieval, private account data, and media
playback as separate trust domains. It fetches only fixed public catalogue
routes, keeps private data behind an exact VPN egress-IP allowlist, and never
acts as a generic URL or media proxy.

The main security boundaries are:

| Boundary                  | Control                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| Untrusted Hot Tub request | Body-size limit, content-type allowlist, Zod validation                           |
| Provider response         | Timeout, hostname allowlist, bounded redirects, byte limit, content/schema checks |
| Private account data      | Exact in-Worker `CF-Connecting-IP` allowlist for the fixed VPN egress             |
| Browser state change      | Same-origin check plus double-submit CSRF token                                   |
| Stored provider secret    | AES-256-GCM with context binding and versioned key ID                             |
| Public cache              | Only anonymous browse responses; complete request included in key                 |
| Logs and client errors    | Redacted structured fields and generic error envelopes                            |

## Input and output validation

- Request bodies are limited to 64 KiB using both `Content-Length` and streamed
  byte counting.
- Accepted request media types are `application/json`, `text/plain` containing
  JSON, and `application/x-www-form-urlencoded`.
- Strings, arrays, page numbers, page size, and filter counts have explicit
  limits.
- `/api/videos` requires at least one channel. `channels` overrides `channel`.
- Normalised provider items are validated individually; an invalid item is
  dropped rather than weakening the schema.
- Complete API responses are validated before serialisation.
- JSON responses are limited to 4 MiB. Provider bodies are limited to 2 MiB.
- Production errors never include a stack trace, upstream body, or provider
  exception text.

## SSRF and open-proxy prevention

The client cannot provide a fetch URL. Each provider owns a constant endpoint
and a fixed hostname allowlist. URL validation requires:

- HTTPS;
- no embedded username or password;
- exact allowed hostname or its subdomain;
- no redirect outside the same provider allowlist.

Each adapter has separate endpoint, watch-page, and asset hostname allowlists.
Returned watch pages, thumbnails, previews, and uploader URLs are checked
against the selected provider allowlist. Local-library writes also verify that
every supplied video/profile URL belongs to the selected provider.

JSON source requests use an eight-second abort timeout; public HTML requests use
the common twelve-second ceiling. HTML responses are rejected when they contain
CAPTCHA, access-denied, or browser-verification markers. Adding a new adapter
requires a new narrow allowlist; a user-controlled hostname is never acceptable.

## Private-route access control

`/account*` and `/api/local/*` compare the Cloudflare-provided
`CF-Connecting-IP` value with the comma-separated `ADMIN_ALLOWED_IPS`
configuration. Production defaults to the fixed VPN address `92.71.54.161`.

The comparison is exact and fails closed:

- a matching source address is accepted;
- a missing or different address returns `403 admin_ip_forbidden`;
- an empty allowlist returns `503 admin_ip_not_configured`;
- `X-Forwarded-For` and `X-Real-IP` are never accepted as substitutes.

This boundary relies on requests reaching the Worker through Cloudflare, which
sets `CF-Connecting-IP` at its edge. It authenticates possession of the VPN path,
not a human identity. Anyone able to egress through the approved VPN server
receives the same access.

Private D1 records use a stable, hashed single-admin key. Deliberately changing
the allowed VPN address therefore does not orphan the existing local library.

## CSRF, cookies, and origins

Every private state-changing request requires:

1. an approved VPN source IP;
2. an exact `Origin` equal to `PUBLIC_BASE_URL`;
3. a CSRF value matching a cookie using constant-time comparison.

The CSRF cookie is named `__Host-hottub_csrf` and is:

- `Secure`;
- `HttpOnly`;
- `SameSite=Strict`;
- scoped to `Path=/`;
- limited to one hour.

The `__Host-` prefix prevents a Domain attribute and requires a secure origin.
There is no application authentication session cookie. Redirects are fixed
same-origin paths.

## Token encryption and rotation

`provider_connections` is ready for a future authorised delegated provider flow.
Tokens are never stored in plaintext. Each value uses:

- AES-256-GCM;
- a fresh 96-bit IV;
- a 128-bit authentication tag;
- additional authenticated data containing the hashed user key and provider ID;
- an envelope carrying format version and encryption key ID.

`TOKEN_ENCRYPTION_KEYS` is a comma-separated key ring:

```text
new-id:<base64url-32-bytes>,old-id:<base64url-32-bytes>
```

The first key encrypts; the named key decrypts existing envelopes. Rotation is:

1. prepend a new key;
2. deploy;
3. re-save old connection rows through `ConnectionRepository`;
4. verify no row references the old key ID;
5. remove the old key.

The current provider set has no authorised token flow, so no token is collected.
The presence of a storage table is not a claim that account integration exists.

## Browser security headers

All responses include:

- Content Security Policy;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY`;
- `Referrer-Policy: no-referrer`;
- same-origin opener and resource policies;
- a restrictive Permissions Policy;
- a correlation `X-Request-Id`.

HTML permits only self-hosted styles, self connections, and HTTPS/data images.
Scripts, frames, objects, and cross-origin form actions are denied.

## Caching

Only public `/api/videos` data is cached. Cache keys include the canonicalised
complete validated request, including provider/channel, query, page, size,
sort, custom filters, block lists, and client version. A separate seven-day
last-known-good entry is written only for successful, non-empty responses and
is used only when all live routes fail. Failed initial responses are not cached.
Authenticated routes use `Cache-Control: no-store`.

If an authenticated provider adapter is added, its responses must not enter the
public cache. Signed or premium playback URLs must not be cached past their
actual expiry; this project currently emits neither.

## Rate limiting

D1 counters apply per-IP limits to public routes and per-admin limits to private
routes. Identifiers are hashed before storage. Responses expose standard limit,
remaining, and reset metadata when applicable.

Provider-specific upstream limits are additionally protected by the Cache API.
Eporner does not document a request-per-time quota in its public API reference,
so conservative caching and page-size limits are used.

## Logging and privacy

Logs are one-line JSON with timestamp, severity, event, request ID, method,
route, status, duration, provider ID, and coarse failure type. Keys containing
authorization, cookies, history, passwords, secrets, signed data, tokens, or
URLs are automatically redacted.

Never add raw request/response logging. In particular, do not log:

- provider tokens or authentication headers;
- cookies or authorization headers;
- signed media URLs;
- watch-page URLs;
- search bodies that may reveal preferences;
- viewing history or local-library records;
- provider response bodies.

Cloudflare observability is enabled. Operators must set an appropriate retention
policy and limit log access.

## Media and provider boundaries

- No CAPTCHA or anti-bot bypass.
- No browser fingerprint evasion.
- No headless browser or client-side script execution.
- No copied/shared cookies or raw password capture.
- No DRM, paywall, entitlement, subscription, or geographic bypass.
- No media proxying or permanent media storage.
- No claim that local history/favourites/playlists sync to providers.

When a capability such as login or premium entitlement has no supported route,
that capability remains false even if public catalogue browsing is available.

## Residual risks

- Provider schemas and terms can change without notice. The adapter fails closed
  at its output boundary but availability can still degrade.
- D1 fixed-window limits are intentionally simple and may permit a short burst
  at a window boundary.
- Hot Tub may perform its own extraction from a returned public watch page when
  `formats` is absent; that behavior is outside this Worker.
- A VPN credential or server compromise gives the attacker private-route
  access. Keep VPN credentials narrow, patch the server, and review its logs.
- A changed VPN egress address causes private routes to fail closed until
  `ADMIN_ALLOWED_IPS` is updated. IPv6 traffic that bypasses the IPv4 tunnel is
  correctly rejected.
- Public API metadata can still describe adult content. Operators must apply
  applicable age, content, and jurisdiction controls.

## Reporting and response

Treat a suspected token or key leak as an incident:

1. revoke the provider token if any;
2. replace `TOKEN_ENCRYPTION_KEYS`, retaining only non-compromised decrypt keys;
3. rotate the Cloudflare API token;
4. review VPN and Worker logs using correlation IDs;
5. remove affected D1 connection rows;
6. redeploy and document the incident without copying secrets into issues.
