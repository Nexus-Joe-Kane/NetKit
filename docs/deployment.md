# Deployment

## Result

The production configuration targets:

```text
https://hottub.joekane.org
```

The repository contains a custom-domain route, D1 binding, migrations, and a
GitHub Actions deployment that does not require editing a database UUID into
source control.

## Prerequisites

- A Cloudflare account with the `joekane.org` zone active in the same account
- Permission to create Workers, D1 databases, and Worker custom domains
- GitHub Actions enabled for the repository
- Node.js 22 or newer for local work
- A Cloudflare Zero Trust team if `/account` and `/api/local/*` will be used

Cloudflare's relevant primary references are:

- [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Validating Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

## GitHub configuration

Create a scoped Cloudflare API token. It needs the equivalent of:

- Account / Workers Scripts / Edit
- Account / D1 / Edit
- Zone / Workers Routes / Edit for `joekane.org`

Avoid a Global API Key.

Add these repository or `production` environment secrets:

| Secret                  | Required | Purpose                                        |
| ----------------------- | -------- | ---------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes      | Selects the Cloudflare account                 |
| `CLOUDFLARE_API_TOKEN`  | Yes      | Provisions D1, applies migrations, and deploys |
| `TOKEN_ENCRYPTION_KEYS` | No today | Encrypts future authorised provider tokens     |

Add these Actions variables when enabling private routes:

| Variable                   | Example                        | Purpose                                    |
| -------------------------- | ------------------------------ | ------------------------------------------ |
| `ADMIN_ACCESS_TEAM_DOMAIN` | `example.cloudflareaccess.com` | Expected Access token issuer and JWKS host |
| `ADMIN_ACCESS_AUDIENCE`    | Access application AUD tag     | Expected JWT audience                      |

The workflow uses GitHub's `production` environment. Add reviewers or branch
rules there if deployment needs a human gate.

## Cloudflare Access

Create one self-hosted Access application for:

```text
hottub.joekane.org/account*
hottub.joekane.org/api/local/*
```

Use an identity policy appropriate for the operator. Copy the application AUD
tag and team domain into the GitHub variables above.

Access is enforced twice:

1. Cloudflare's edge policy blocks unauthorised traffic.
2. The Worker validates the assertion header and claims.

Without both variables, private routes deliberately return
`503 access_not_configured`; public Hot Tub routes continue to work.

## Automatic deployment

On each push to `main`, `.github/workflows/deploy.yml`:

1. installs pinned dependencies with `npm ci`;
2. runs formatting, lint, type checking, unit tests, and a Wrangler dry-run;
3. lists D1 databases using the Cloudflare API;
4. creates `hot-tub` only if it does not exist;
5. writes `.generated.wrangler.jsonc` with the real D1 UUID and Access values;
6. applies all remote migrations;
7. sets `TOKEN_ENCRYPTION_KEYS` when the secret is present;
8. deploys the Worker and custom domain.

The zero UUID in committed `wrangler.jsonc` is a safe placeholder. The generated
file is gitignored and written mode `0600`.

## Encryption key

No current adapter stores provider tokens, so the key is optional until a real
authorised account integration is added. Generate a 32-byte base64url key:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

Store it as:

```text
2026-01:<generated-value>
```

Rotation uses a comma-separated key ring. The first key encrypts new values;
older keys remain decrypt-only:

```text
2027-01:<new-key>,2026-01:<old-key>
```

Do not remove an old key until all rows carrying its `encryption_key_id` have
been read and re-saved under the new primary key.

## Manual deployment

Export credentials in your shell, then:

```bash
npm ci
npm run validate
node scripts/prepare-deploy-config.mjs .generated.wrangler.jsonc
npx wrangler d1 migrations apply hot-tub --remote \
  --config .generated.wrangler.jsonc
npx wrangler deploy --config .generated.wrangler.jsonc
```

If token storage is enabled:

```bash
printf '%s' "$TOKEN_ENCRYPTION_KEYS" |
  npx wrangler secret put TOKEN_ENCRYPTION_KEYS \
    --config .generated.wrangler.jsonc
```

The preparation script reads `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`; optional `ADMIN_ACCESS_TEAM_DOMAIN`,
`ADMIN_ACCESS_AUDIENCE`, and `D1_DATABASE_NAME` override defaults.

## Local development and D1

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Wrangler stores local D1 state under `.wrangler/`. `.dev.vars` and this state are
gitignored.

Use the fixture-only validation suite:

```bash
npm run validate
```

The live Eporner check is opt-in because CI must not depend on an external adult
provider:

```bash
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

## Changing the hostname

Update both values in `wrangler.jsonc`:

```json
{
  "routes": [{ "pattern": "new.example.com", "custom_domain": true }],
  "vars": { "PUBLIC_BASE_URL": "https://new.example.com" }
}
```

Then update the Cloudflare Access application domain and deploy. The landing
page and `hottub://source` link derive from `PUBLIC_BASE_URL`.

## Migration operations

Apply locally:

```bash
npm run db:migrate:local
```

Apply remotely when using a prepared configuration:

```bash
npx wrangler d1 migrations apply hot-tub --remote \
  --config .generated.wrangler.jsonc
```

Create future migrations with an ordered filename such as
`migrations/0002_add_feature.sql`. Migrations must be forward-only and safe for
existing rows.

## Post-deployment checks

```bash
curl https://hottub.joekane.org/health
curl -X POST https://hottub.joekane.org/api/status \
  -H 'Content-Type: application/json' -d '{}'
curl -X POST https://hottub.joekane.org/api/videos \
  -H 'Content-Type: application/json' \
  -d '{"channel":"eporner","page":1,"pageSize":10}'
curl -X POST https://hottub.joekane.org/api/videos \
  -H 'Content-Type: application/json' \
  -d '{"channel":"xhamster","page":1}'
```

The last request should return HTTP 200 with no items and an honest
`pageInfo.error`. `/account` should redirect through Access at the edge and only
render after a valid assertion.

## Troubleshooting

- **D1 API permission denied:** confirm the API token has Account/D1/Edit and
  belongs to `CLOUDFLARE_ACCOUNT_ID`.
- **Custom domain rejected:** confirm `joekane.org` is in the same account and
  the token has zone route permission.
- **Private route returns 503:** set both Access variables and redeploy.
- **Private route returns 401 behind Access:** verify the AUD tag belongs to the
  exact Access application and the team domain has no scheme or path.
- **Eporner returns an empty page with an error:** review Worker logs and the
  provider's API and regional availability. The 2026-07-26 build-environment
  smoke test received a provider `Site Unavailable` HTML response; the adapter
  intentionally rejected it rather than parsing HTML or bypassing a restriction.
  Upstream details are not exposed to clients.
- **Source does not add:** confirm `/api/status` accepts POST over the public
  hostname and that Access does not cover `/api/*` broadly.
