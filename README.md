# Unified Hot Tub Source

A security-first, self-hosted [Hot Tub](https://docs.hottubapp.io/developers/server/)
source for Cloudflare Workers. It exposes the requested providers as separate
channels, but only enables an adapter when a stable and authorised integration
has been verified.

The configured production source is:

```text
https://hottub.joekane.org
```

Add it to Hot Tub with:

```text
hottub://source?url=https%3A%2F%2Fhottub.joekane.org
```

## Provider support

| Provider       | Public browse | Search | Account connection |    History | Likes |  Playlists | Premium |
| -------------- | ------------: | -----: | -----------------: | ---------: | ----: | ---------: | ------: |
| Eporner        |           Yes |    Yes |                 No | Local only |    No | Local only |      No |
| xHamster       |          Stub |   Stub |                 No | Local only |    No | Local only |      No |
| FapHouse Ultra |          Stub |   Stub |                 No | Local only |    No | Local only |      No |
| XVideos        |          Stub |   Stub |                 No | Local only |    No | Local only |      No |
| Pornhub        |          Stub |   Stub |                 No | Local only |    No | Local only |      No |
| fpo.xxx        |          Stub |   Stub |                 No | Local only |    No | Local only |      No |

Eporner browsing and search use its official
[Webmaster API v2](https://www.eporner.com/api/v2/). The other adapters return an
honest `restricted` state and no invented data. The service does not use browser
stealth, CAPTCHA bypasses, copied cookies, DRM circumvention, paywall bypasses,
or password collection.

Provider and regional availability still apply. During the 2026-07-26 live
smoke test, Eporner returned a small `Site Unavailable` HTML response to the
build environment instead of API JSON. The adapter correctly failed closed.
Re-run the opt-in integration test from the deployed Worker's operating region
before relying on live catalogue availability.

## What is included

- Current Hot Tub `POST /api/status`, `POST /api/videos`, and
  `POST /api/uploaders` protocol endpoints
- Provider-isolated dispatch and multi-channel result merging
- Strict request and response validation with Zod
- Public Cache API caching and D1-backed per-IP/per-account rate limits
- Cloudflare Access JWT verification for `/account` and `/api/local/*`
- AES-256-GCM token storage with key rotation support for future authorised
  provider connections
- Local D1 history, favourites, playlists, and followed creators; these never
  claim to sync to a provider
- Origin checks, double-submit CSRF protection, CSP, URL/hostname allowlists,
  timeouts, body limits, and redacted structured logs
- D1 migrations and GitHub Actions for linting, testing, provisioning, migration,
  and deployment

The Worker never proxies or permanently stores media. Eporner items expose the
public provider watch page as `url`. Direct stream formats are not fabricated;
Hot Tub may perform its normal watch-page extraction when `formats` is absent.

## Endpoints

| Method     | Path                            | Access                                    | Purpose                                                            |
| ---------- | ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `GET`      | `/`                             | Public                                    | Source landing page and install link                               |
| `GET`      | `/health`                       | Public                                    | Worker, D1, and adapter health                                     |
| `POST`     | `/api/status`                   | Public                                    | Source/channel discovery                                           |
| `POST`     | `/api/videos`                   | Public                                    | Browse and search                                                  |
| `POST`     | `/api/uploaders`                | Public                                    | Documented unsupported response until an adapter supports profiles |
| `GET`      | `/account`                      | Cloudflare Access                         | Connection metadata; never renders secrets                         |
| `POST`     | `/account/disconnect`           | Access + origin + CSRF                    | Remove a stored connection                                         |
| `GET/POST` | `/api/local/history`            | Access; writes also require origin + CSRF | Local history                                                      |
| `GET/POST` | `/api/local/favourites`         | Access; writes also require origin + CSRF | Local favourites                                                   |
| `POST`     | `/api/local/favourites/remove`  | Access + origin + CSRF                    | Remove a local favourite                                           |
| `POST`     | `/api/local/playlists`          | Access + origin + CSRF                    | Create a local playlist                                            |
| `POST`     | `/api/local/followed-uploaders` | Access + origin + CSRF                    | Follow a creator locally                                           |

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
curl http://localhost:8787/health
curl -X POST http://localhost:8787/api/status \
  -H 'Content-Type: application/json' \
  -d '{}'
curl -X POST http://localhost:8787/api/videos \
  -H 'Content-Type: application/json' \
  -d '{"channel":"eporner","page":1,"pageSize":10}'
```

Run the quality gate with:

```bash
npm run validate
```

Unit tests use fixtures and never call providers. The optional Eporner smoke test
is intentionally excluded from the normal suite:

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

Configure these GitHub Actions variables to enable the account and local-library
routes:

- `ADMIN_ACCESS_TEAM_DOMAIN`
- `ADMIN_ACCESS_AUDIENCE`

See [Deployment](docs/deployment.md) for Cloudflare token permissions, Access
policy setup, local migrations, manual deployment, and custom-domain changes.

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
the content they choose to access. This project does not grant content rights or
provider access. A provider must remain restricted until a documented,
authorised integration is available and its terms permit this use.

Provider APIs and the Hot Tub schema can change. Re-run the optional integration
test and review the research documents before enabling a new adapter.
