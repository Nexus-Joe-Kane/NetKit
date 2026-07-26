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

Cloudflare's relevant primary references are:

- [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare visitor location headers](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-connecting-ip)

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

The committed Wrangler configuration already allows the fixed VPN egress address
`92.71.54.161`. An optional Actions variable can override it:

| Variable            | Required | Example                     | Purpose                                    |
| ------------------- | -------- | --------------------------- | ------------------------------------------ |
| `ADMIN_ALLOWED_IPS` | No       | `92.71.54.161,2001:db8::10` | Exact comma-separated VPN egress addresses |

The workflow uses GitHub's `production` environment. Add reviewers or branch
rules there if deployment needs a human gate.

## Private-route IP allowlist

The Worker restricts:

```text
/account*
/api/local/*
```

It compares Cloudflare's `CF-Connecting-IP` header with `ADMIN_ALLOWED_IPS`.
Only an exact match is accepted. `X-Forwarded-For`, query parameters, cookies,
and client-supplied identity headers are not trusted for this decision.

For the default configuration, the browsing device must send its traffic through
the fixed VPN server so Cloudflare sees:

```text
92.71.54.161
```

Requests from any other address return `403 admin_ip_forbidden`. An empty
allowlist fails closed with `503 admin_ip_not_configured`. Public Hot Tub routes
remain available from every address.

Do not create a Cloudflare Access application over these paths. If one already
exists, remove those destinations; otherwise Access will intercept the request
before the Worker's IP check.

This authenticates the VPN egress, not an individual person. Anyone able to
route through that VPN server receives the same admin access, so protect the VPN
credentials and server accordingly.

## Automatic deployment

On each push to `main`, `.github/workflows/deploy.yml`:

1. installs pinned dependencies with `npm ci`;
2. runs formatting, lint, type checking, unit tests, and a Wrangler dry-run;
3. lists D1 databases using the Cloudflare API;
4. creates `hot-tub` only if it does not exist;
5. writes `.generated.wrangler.jsonc` with the real D1 UUID and any optional IP
   allowlist override;
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
`CLOUDFLARE_API_TOKEN`; optional `ADMIN_ALLOWED_IPS` and `D1_DATABASE_NAME`
override defaults.

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

Then deploy. The landing page and `hottub://source` link derive from
`PUBLIC_BASE_URL`.

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
`pageInfo.error`.

Test the private route twice:

```bash
# Off the VPN: expected HTTP 403.
curl -i https://hottub.joekane.org/account

# Connected through the fixed VPN: expected HTTP 200.
curl -i https://hottub.joekane.org/account
```

## Troubleshooting

- **D1 API permission denied:** confirm the API token has Account/D1/Edit and
  belongs to `CLOUDFLARE_ACCOUNT_ID`.
- **Custom domain rejected:** confirm `joekane.org` is in the same account and
  the token has zone route permission.
- **Private route returns 403 while connected to the VPN:** confirm the VPN is
  full-tunnel for this hostname and that its visible IPv4 is exactly
  `92.71.54.161`. Disable IPv6 for the test if it bypasses the IPv4 VPN exit.
- **Private route returns 503:** `ADMIN_ALLOWED_IPS` was overridden with an empty
  value or removed from the generated configuration; restore it and redeploy.
- **Private route shows a Cloudflare login:** remove the old Access application
  destinations for `/account*` and `/api/local/*`.
- **Eporner returns an empty page with an error:** review Worker logs and the
  provider's API and regional availability. The 2026-07-26 build-environment
  smoke test received a provider `Site Unavailable` HTML response; the adapter
  intentionally rejected it rather than parsing HTML or bypassing a restriction.
  Upstream details are not exposed to clients.
- **Source does not add:** confirm `/api/status` accepts POST over the public
  hostname and that no edge rule covers `/api/*` broadly.
