# Security

## Security posture

This Worker treats public metadata retrieval, private account data, and media
playback as separate trust domains. It fetches only documented provider JSON,
keeps private data behind Cloudflare Access, and never acts as a generic URL or
media proxy.

The main security boundaries are:

| Boundary                  | Control                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| Untrusted Hot Tub request | Body-size limit, content-type allowlist, Zod validation                           |
| Provider response         | Timeout, hostname allowlist, redirect refusal, byte limit, JSON/schema validation |
| Private account data      | Cloudflare Access edge policy plus in-Worker JWT verification                     |
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
- no cross-host redirect (`redirect: "error"`).

The Eporner adapter can fetch only `eporner.com` and its subdomains. Returned
watch pages, thumbnails, and uploader URLs are checked against the same
allowlist. Local-library writes also verify that every supplied video/profile
URL belongs to the selected provider.

Provider requests use an eight-second abort timeout. Adding a new adapter
requires a new narrow allowlist; a user-controlled hostname is never acceptable.

## Authentication

Cloudflare Access should protect `/account*` and `/api/local/*`. The Worker does
not trust network placement alone. It verifies the
`Cf-Access-Jwt-Assertion`:

- `alg` must be `RS256`;
- `kid` must match a current RSA key from the configured team JWKS endpoint;
- the signature must verify;
- `iss` must equal the configured team domain;
- `aud` must include the configured application audience;
- `sub` must be present;
- `exp` and optional `nbf` must be valid.

JWKS values are cached in memory for one hour. An unknown key ID clears the
cache and fails the request, allowing a following request to refetch after key
rotation without accepting an unknown signature.

The account database key is a SHA-256 digest of issuer plus subject. Email is
display-only and is not used as a durable identifier.

## CSRF, cookies, and origins

Every private state-changing request requires:

1. a valid Access identity;
2. an exact `Origin` equal to `PUBLIC_BASE_URL`;
3. a CSRF value matching a cookie using constant-time comparison.

The CSRF cookie is named `__Host-hottub_csrf` and is:

- `Secure`;
- `HttpOnly`;
- `SameSite=Strict`;
- scoped to `Path=/`;
- limited to one hour.

The `__Host-` prefix prevents a Domain attribute and requires a secure origin.
There is no application session cookie; Access owns the authentication session.
Redirects are fixed same-origin paths.

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
sort, custom filters, block lists, and client version. Authenticated routes use
`Cache-Control: no-store`.

If an authenticated provider adapter is added, its responses must not enter the
public cache. Signed or premium playback URLs must not be cached past their
actual expiry; this project currently emits neither.

## Rate limiting

D1 counters apply per-IP limits to public routes and per-Access-account limits
to private routes. Identifiers are hashed before storage. Responses expose
standard limit, remaining, and reset metadata when applicable.

Provider-specific upstream limits are additionally protected by the Cache API.
Eporner does not document a request-per-time quota in its public API reference,
so conservative caching and page-size limits are used.

## Logging and privacy

Logs are one-line JSON with timestamp, severity, event, request ID, method,
route, status, duration, provider ID, and coarse failure type. Keys containing
authorization, cookies, history, passwords, secrets, signed data, tokens, or
URLs are automatically redacted.

Never add raw request/response logging. In particular, do not log:

- provider or Access tokens;
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
- No copied/shared cookies or raw password capture.
- No DRM, paywall, entitlement, subscription, or geographic bypass.
- No media proxying or permanent media storage.
- No claim that local history/favourites/playlists sync to providers.

When an authorised provider integration is unavailable, the only safe state is
the restricted adapter.

## Residual risks

- Provider schemas and terms can change without notice. The adapter fails closed
  at its output boundary but availability can still degrade.
- D1 fixed-window limits are intentionally simple and may permit a short burst
  at a window boundary.
- Hot Tub may perform its own extraction from a returned public watch page when
  `formats` is absent; that behavior is outside this Worker.
- Access policy correctness remains an operator responsibility. Do not create an
  Access rule broad enough to expose private routes to unintended identities.
- Public API metadata can still describe adult content. Operators must apply
  applicable age, content, and jurisdiction controls.

## Reporting and response

Treat a suspected token or key leak as an incident:

1. revoke the provider token if any;
2. replace `TOKEN_ENCRYPTION_KEYS`, retaining only non-compromised decrypt keys;
3. rotate the Cloudflare API token;
4. review Access and Worker logs using correlation IDs;
5. remove affected D1 connection rows;
6. redeploy and document the incident without copying secrets into issues.
