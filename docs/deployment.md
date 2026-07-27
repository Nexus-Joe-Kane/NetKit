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

The committed Wrangler configuration already allows the VPN egress addresses
`92.71.54.161` and `177.7.57.50`. An optional Actions variable can override it:

| Variable            | Required | Example                    | Purpose                                    |
| ------------------- | -------- | -------------------------- | ------------------------------------------ |
| `ADMIN_ALLOWED_IPS` | No       | `92.71.54.161,177.7.57.50` | Exact comma-separated VPN egress addresses |

The variable **replaces** the committed list rather than extending it, so it
must repeat every address that should keep working. Leaving it unset is the
normal case; the committed list is then the whole allowlist.

The workflow uses GitHub's `production` environment. Add reviewers or branch
rules there if deployment needs a human gate.

## Whole-source IP allowlist

The Worker restricts every path:

```text
/*
```

It compares Cloudflare's `CF-Connecting-IP` header with `ADMIN_ALLOWED_IPS`.
Only an exact match is accepted. `X-Forwarded-For`, query parameters, cookies,
and client-supplied identity headers are not trusted for this decision.

For the default configuration, the browsing device must send its traffic through
one of the VPN servers so Cloudflare sees one of:

```text
92.71.54.161
177.7.57.50
```

Requests from any other address return `403 admin_ip_forbidden`. An empty
allowlist fails closed with `503 admin_ip_not_configured`. This includes the
landing page, assets, health endpoint, and every Hot Tub API request.

Do not create a Cloudflare Access application over this hostname. If one already
exists, remove that destination; otherwise Access will intercept the request
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
7. deploys the Worker and custom domain;
8. sets `TOKEN_ENCRYPTION_KEYS` when the secret is present;
9. verifies the deployment is live and locked down.

The zero UUID in committed `wrangler.jsonc` is a safe placeholder. The generated
file is gitignored and written mode `0600`.

Steps 7 and 8 are in that order deliberately. `wrangler secret put` targets an
existing Worker, so setting the secret first fails on a first deploy or after
the Worker has been deleted. Secrets apply to the live Worker immediately, so
no redeploy is needed afterwards.

### Deployment verification

The source rejects every address except the VPN egress, so a GitHub runner can
never receive a `200`. `403 admin_ip_forbidden` is therefore the success
signal — it proves DNS resolves, the Worker is serving on the custom domain,
and the allowlist is switched on. The final step polls `/health` until it sees
that, and fails the deployment on a `200`, a `5xx`, or a timeout.

Because the whole deployment is recreated from configuration, deleting the
Worker in the Cloudflare dashboard is a safe way to start over: the next push
to `main` recreates the Worker, the D1 database if missing, and the custom
domain. Data already stored in D1 is only lost if the database itself is
deleted.

### Public hostnames

`workers_dev` and `preview_urls` are disabled, so `hottub.joekane.org` is the
only address serving this Worker. Re-enable them in `wrangler.jsonc` only if
you need a fallback URL while debugging a custom-domain problem; the IP
allowlist applies to those hostnames too, but they are additional public
surface that a single-operator deployment does not need.

## Provider health

`.github/workflows/provider-health.yml` runs the live catalogue test daily and
on demand. The unit suite runs on fixtures and stays green through a total
provider outage, so this is the check that notices a provider changing its
URLs or response shape. It deliberately does not gate deployment: a failure
there means a channel is broken, not that a change is bad.

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

### Provisioning the encryption key without a terminal

The **Provision encryption key** workflow (`workflow_dispatch`) does the same
thing from the Actions tab, which works from a phone. It generates 32 random
bytes on the runner, pipes them directly into `wrangler secret put`, and never
echoes the value, so the key exists only on the Worker — not in a log, a
repository secret, or a shell history.

It refuses to run when a key is already present unless `replace` is ticked.
Cloudflare does not return a stored secret's value, so a replacement cannot keep
the previous key in the ring the way a normal rotation does; every existing
connection becomes undecryptable and has to be reconnected at `/account`.

Choose one mechanism. If the `TOKEN_ENCRYPTION_KEYS` repository secret is set,
the deploy workflow rewrites the Worker's copy on every deploy and will overwrite
whatever this workflow provisioned.

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

Run the success checks while connected through the fixed VPN:

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

Both video requests should return HTTP 200 with non-empty `items`. Each item must
contain a public watch-page `url`, not a raw media URL. Run the checks a second
time and confirm `X-Cache` is `HIT`.

Test the whole-source boundary twice:

```bash
# Off the VPN: expected HTTP 403.
curl -i https://hottub.joekane.org/

# Connected through the fixed VPN: both expected HTTP 200.
curl -i https://hottub.joekane.org/
curl -i https://hottub.joekane.org/account
```

## Troubleshooting

- **D1 API permission denied:** confirm the API token has Account/D1/Edit and
  belongs to `CLOUDFLARE_ACCOUNT_ID`.
- **Custom domain rejected:** confirm `joekane.org` is in the same account and
  the token has zone route permission.
- **Source returns 403 while connected to the VPN:** confirm the VPN is
  full-tunnel for this hostname and that its visible IPv4 is exactly
  `92.71.54.161`. Disable IPv6 for the test if it bypasses the IPv4 VPN exit.
- **Source returns 503:** `ADMIN_ALLOWED_IPS` was overridden with an empty
  value or removed from the generated configuration; restore it and redeploy.
- **Source shows a Cloudflare login:** remove the old Access application for the
  hostname.
- **A channel returns an empty page with an error:** review Worker logs and test
  the official Hot Tub source, community source, and provider from the Worker's
  region. The source races compatible routes and serves a request-specific
  last-known-good result after a prior success. If all routes fail before one
  has ever succeeded, the generic error is intentional; upstream response
  bodies are never exposed to clients.
- **Source does not add:** confirm the iPhone is using the VPN and that
  `/api/status` accepts POST from `92.71.54.161`.
