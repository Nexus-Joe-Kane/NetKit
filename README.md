# Unified Hot Tub Source

A security-first, self-hosted [Hot Tub](https://docs.hottubapp.io/developers/server/)
source for Cloudflare Workers. It exposes the requested providers as separate
channels and implements Hot Tub's current browse, search, uploader, and
watch-page hand-off contract.

The configured production source is:

```text
https://hottub.joekane.org
```

Add it to Hot Tub with:

```text
hottub://source?url=https%3A%2F%2Fhottub.joekane.org
```

The iPhone must route this hostname through the VPN so Cloudflare sees
`92.71.54.161`. Every source route returns `403` from any other address.

## Provider support

| Provider       | Public browse | Search | Creators | Playback hand-off | Account connection | Premium entitlement |
| -------------- | ------------: | -----: | -------: | ----------------: | -----------------: | ------------------: |
| Eporner        |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| xHamster       |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| XVideos        |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| Pornhub        |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| fpo.xxx        |           Yes |    Yes |       No |               Yes |                 No |                  No |
| FapHouse Ultra |  Catalog only |    Yes |       No |                No |                 No |                  No |

Eporner races three public catalogue routes: its documented
[Webmaster API v2](https://www.eporner.com/api/v2/), the official Hot Tub
source, and a compatible community source. xHamster, XVideos, and Pornhub use
the two Hot Tub-compatible sources. fpo.xxx and FapHouse use ordinary public
server-rendered catalogue pages. A seven-day request-specific last-known-good
cache is used only when every live route fails.

FapHouse public metadata is visible, but its items are deliberately marked
offline because no provider-supported delegated subscription API was found.
The service does not use browser stealth, CAPTCHA bypasses, copied cookies,
DRM circumvention, paywall bypasses, or password collection.

## What is included

- Current Hot Tub `POST /api/status`, `POST /api/videos`, and optional
  `POST /api/uploaders` protocol endpoints
- Provider-isolated dispatch and multi-channel result merging
- Parallel public-provider fallbacks and last-known-good catalogue responses
- Strict request and response validation with Zod
- Public Cache API caching and D1-backed per-IP/per-account rate limits
- Exact Cloudflare source-IP verification before every route, preconfigured for
  the fixed VPN egress address `92.71.54.161`
- AES-256-GCM token storage with key rotation support for future authorised
  provider connections
- Optional private D1 history, favourites, ordered playlists, and followed
  creators, with a no-JavaScript `/library` page to manage them; Hot Tub itself
  keeps its own history, favourites, and queues locally on the device
- Origin checks, double-submit CSRF protection, CSP, URL/hostname allowlists,
  timeouts, body limits, and redacted structured logs
- D1 migrations and GitHub Actions for linting, testing, provisioning, migration,
  and deployment

The Worker never proxies or permanently stores media. Items expose a public
provider watch page as `url`; Hot Tub performs its normal playback extraction
when `formats` is absent. Whether a particular public page remains playable is
still controlled by the provider and the user's region.

## Endpoints

| Method     | Path                                   | Access                                        | Purpose                                                      |
| ---------- | -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `GET`      | `/`                                    | Approved VPN IP                               | Source landing page and install link                         |
| `GET`      | `/health`                              | Approved VPN IP                               | Worker, D1, and adapter health                               |
| `POST`     | `/api/status`                          | Approved VPN IP                               | Source/channel discovery                                     |
| `POST`     | `/api/videos`                          | Approved VPN IP                               | Browse and search                                            |
| `POST`     | `/api/uploaders`                       | Approved VPN IP                               | Creator profiles for adapters with stable creator metadata   |
| `GET`      | `/library`                             | Approved VPN IP                               | Local library page: playlists, favourites, creators, history |
| `GET`      | `/account`                             | Approved VPN IP                               | Connection metadata; never renders secrets                   |
| `POST`     | `/account/disconnect`                  | Approved VPN IP + origin + CSRF               | Remove a stored connection                                   |
| `GET/POST` | `/api/local/history`                   | Approved VPN IP; writes require origin + CSRF | Local history                                                |
| `POST`     | `/api/local/history/remove`            | Approved VPN IP + origin + CSRF               | Remove one history record                                    |
| `POST`     | `/api/local/history/clear`             | Approved VPN IP + origin + CSRF               | Clear all history                                            |
| `GET/POST` | `/api/local/favourites`                | Approved VPN IP; writes require origin + CSRF | Local favourites                                             |
| `POST`     | `/api/local/favourites/remove`         | Approved VPN IP + origin + CSRF               | Remove a local favourite                                     |
| `GET/POST` | `/api/local/playlists`                 | Approved VPN IP; writes require origin + CSRF | List or create local playlists                               |
| `POST`     | `/api/local/playlists/update`          | Approved VPN IP + origin + CSRF               | Rename or re-describe a playlist                             |
| `POST`     | `/api/local/playlists/delete`          | Approved VPN IP + origin + CSRF               | Delete a playlist and its items                              |
| `GET/POST` | `/api/local/playlists/items`           | Approved VPN IP; writes require origin + CSRF | List a playlist's ordered items, or append one               |
| `POST`     | `/api/local/playlists/items/remove`    | Approved VPN IP + origin + CSRF               | Remove a playlist item                                       |
| `POST`     | `/api/local/playlists/items/move`      | Approved VPN IP + origin + CSRF               | Reorder a playlist item                                      |
| `GET/POST` | `/api/local/followed-uploaders`        | Approved VPN IP; writes require origin + CSRF | List creators, or follow one locally                         |
| `POST`     | `/api/local/followed-uploaders/remove` | Approved VPN IP + origin + CSRF               | Unfollow a creator                                           |

## Local development

Requirements: Node.js 22 or newer and npm.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Then verify:

```bash
curl http://localhost:8787/health \
  -H 'CF-Connecting-IP: 92.71.54.161'
curl -X POST http://localhost:8787/api/status \
  -H 'CF-Connecting-IP: 92.71.54.161' \
  -H 'Content-Type: application/json' \
  -d '{}'
curl -X POST http://localhost:8787/api/videos \
  -H 'CF-Connecting-IP: 92.71.54.161' \
  -H 'Content-Type: application/json' \
  -d '{"channel":"eporner","page":1,"pageSize":10}'
```

Run the quality gate with:

```bash
npm run validate
```

Unit tests use fixtures and never call providers. The optional live catalogue
smoke test is intentionally excluded from the normal suite:

```bash
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

## Deployment

The deployment workflow runs after a merge to `main`. It creates or reuses a D1
database named `hot-tub`, writes a generated Wrangler configuration with the
real database UUID, applies migrations, configures the optional encryption
secret, and deploys the custom domain.

Configure these GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `TOKEN_ENCRYPTION_KEYS` only when an authorised provider connection is added

The committed configuration already restricts the entire source to:

```text
92.71.54.161
```

Set the optional `ADMIN_ALLOWED_IPS` GitHub Actions variable only when replacing
that address or adding another comma-separated VPN egress address.

See [Deployment](docs/deployment.md) for Cloudflare token permissions, IP
allowlist behavior, local migrations, manual deployment, and custom-domain
changes.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Security](docs/security.md)
- [Account connections and local library](docs/account-connections.md)
- [Provider research](docs/provider-research.md)
- [Hot Tub API research](docs/hottub-api-research.md)
- [Provider development](docs/provider-development.md)

## Legal and operational boundaries

Operators are responsible for provider terms, local law, age restrictions, and
the content they choose to access. This project does not grant content rights,
provider accounts, subscriptions, or premium entitlements.

Provider APIs and the Hot Tub schema can change. Re-run the optional integration
test and review the research documents before enabling a new adapter.
