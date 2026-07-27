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

The iPhone must route this hostname through the VPN so Cloudflare sees one of
the approved egress addresses, `92.71.54.161` or `177.7.57.50`. Every source
route returns `403` from any other address.

## Provider support

| Provider            | Public browse | Search | Creators | Playback hand-off | Account connection | Premium entitlement |
| ------------------- | ------------: | -----: | -------: | ----------------: | -----------------: | ------------------: |
| 6 bundles           |        Merged | Merged |       No |               Yes |                 No |                  No |
| Eporner             |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| xHamster            |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| XVideos             |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| Pornhub             |           Yes |    Yes |  Derived |               Yes |                 No |                  No |
| fpo.xxx             |           Yes |    Yes |       No |               Yes |                 No |                  No |
| FapHouse Ultra      |  Catalog only |    Yes |       No |                No |             Opt-in |                  No |
| 40 further catalogs |           Yes |    Yes |  Derived |               Yes |                 No |                  No |

The six named public channels above are the **featured** channels. Alongside them
the source carries a further **40 community channels** — RedTube, YouPorn, XNXX,
Tube8, TnAflix, PornTrex, Beeg, Erome, RedGifs and the rest — federated through
the Hot Tub-compatible community source. Each ships only the sort orders its own
upstream declares.

Channels have to pass two separate checks, because **listing and playing fail
independently**. A channel can return a perfect catalogue of items whose watch
pages Hot Tub cannot extract a stream from, and the operator meets that as
"video unavailable" rather than as a broken channel. Nine channels shipped
having passed only the first check and were removed once the second was applied:
`fikfap`, `fyptt`, `hentaitv`, `paradisehill` and `perverzija` have no extractor
at all, and `hqporner`, `pimpbunny`, `porn4fans` and `sxyprn` have one that
cannot parse their pages.

`scripts/check-playability.mjs` runs the second check on a schedule. Hot Tub
extracts playback from `Video.url` itself and its `formats[]` schema is yt-dlp's
format dict field for field, so yt-dlp stands in for the app's extractor. Only a
_missing_ extractor fails the run: a 403, a 410 or an anti-bot interstitial says
where the check ran from, not whether the channel works. Pornhub fails exactly
that way from a datacentre address while working normally on a phone.

### Bundles

A bundle is a virtual channel that fans out to several real ones. `All channels`
is one of six, and is the source default:

| Bundle             | Members                                            | Contents                            |
| ------------------ | -------------------------------------------------- | ----------------------------------- |
| All channels       | the six featured channels                          | the default mixed feed              |
| Mainstream tubes   | Pornhub, XVideos, xHamster, XNXX, RedTube, YouPorn | the largest general-audience tubes  |
| Amateur & creators | Erome, RedGifs, Shooshtime, Tokyo Motion, Pornzog  | creator-uploaded and amateur        |
| Shorts & vertical  | PH Shorties, Tik Porn, Viralxxxporn                | short-form vertical video           |
| Animated & hentai  | Hentai Haven, Rule34Video                          | animation and rule-34               |
| Asian & JAV        | Javtiful, VJAV, Hsex, Tokyo Motion                 | Japanese and wider Asian catalogues |

A bundle is not a provider: `/api/videos` expands it into its members, queries
them in parallel, and interleaves the results round-robin so no single member
dominates. Items keep the channel that actually served them, so playback and
branding are unaffected, and one member being down does not fail the bundle.

Every member was confirmed to return a live catalogue page before being listed,
and a channel may appear in more than one bundle. Membership is editorial, so it
sticks to groupings recognisable from the sites themselves.

**There is deliberately no "Popular" bundle.** Popularity is a sort, not a set of
channels — every bundle already offers `Most Viewed` — so a fixed "popular"
channel list would just be a second Mainstream under a name promising more than
it delivered.

Bundles are capped at **six members**, enforced by a test. A Worker has a bounded
subrequest budget per request, and a bundle spanning all 46 channels would
exhaust it and fail the whole request rather than return a bigger feed. Every
channel remains individually selectable, and the app's own multi-select still
works across any subset.

Filters are only advertised where the provider honours them, verified against
each site rather than assumed:

- **Sort** — fpo.xxx has two real listing orders; FapHouse ignores its sort
  parameter entirely, so no sort control is offered for it.
- **Orientation** (straight/all/gay, and Hot Tub's global preference) — the
  Hot Tub-compatible upstreams behind xHamster, XVideos and Pornhub return
  identical results with and without an orientation parameter, and fpo.xxx has
  no orientation listings, so those channels do not offer the control.

  **Straight** does not narrow the feed at all. Every general catalogue is
  straight by default, so restricting it would only shrink it; Eporner still
  receives `gay=0`.

  **Gay** points `All channels` at the catalogues that genuinely carry it:
  Homo.xxx, the only dedicated gay catalogue among the upstream's 80
  channels, FapHouse with `?orientation=gay`, and Eporner. Eporner needs both
  levers — measured 2026-07-27, `gay=2` on its own returns overwhelmingly trans
  and femboy titles, so the browse query becomes `gay men`, which returns
  male-on-male results.

  A themed bundle is never re-pointed this way. Choosing Gay while browsing
  `Animated & hentai` filters to whichever of its members serve the
  orientation, and leaves the bundle untouched when none do, rather than
  handing back a feed with no animation in it.

- **Duration** — a range slider, applied to merged results, so it behaves the
  same on every channel. Some federated catalogues report a duration of `0`,
  meaning unknown rather than zero seconds; those items are kept rather than
  hidden, so raising the minimum never silently empties a channel that simply
  does not publish lengths.
- **Sort on a bundle** — bundles advertise a generic intent (Newest, Most
  Viewed, Top Rated, Longest) and translate it into each member's own sort ID
  before the request goes out. This was measured: sending a generic `views` to
  the community upstream changes nothing for any channel, while a channel's own
  declared ID genuinely reorders results for most of them. A member that ignores
  even its own declared sort falls back to its default.

Eporner races three public catalogue routes: its documented
[Webmaster API v2](https://www.eporner.com/api/v2/), the official Hot Tub
source, and a compatible community source. xHamster, XVideos, and Pornhub use
the two Hot Tub-compatible sources. fpo.xxx and FapHouse use ordinary public
server-rendered catalogue pages. A seven-day request-specific last-known-good
cache is used only when every live route fails.

FapHouse public metadata is visible, but its items are marked offline because
no delegated subscription API exists. The operator may opt in to connecting
their own FapHouse account at `/account`, using revocable app credentials
generated in the FapHouse portal or a session cookie copied from their own
browser. Either is stored encrypted and used server-side only. That does not yet
enable protected playback — see
[Account connections](docs/account-connections.md) for why, and for the risks.

There is deliberately no xHamster login: that channel is federated through
Hot Tub-compatible upstreams and never contacts xhamster.com, so credentials
would have nowhere to go.

The service does not use browser stealth, CAPTCHA bypasses, DRM circumvention,
or paywall bypasses, and never submits a provider's interactive login form.

## What is included

- Current Hot Tub `POST /api/status`, `POST /api/videos`, and optional
  `POST /api/uploaders` protocol endpoints
- Provider-isolated dispatch and multi-channel result merging
- Self-hosted source and per-bundle artwork, served from the Worker itself so no
  third-party image host is contacted to render the channel list. The tiles are
  drawn by `scripts/generate-icons.mjs`; run `npm run icons` after changing it
- Parallel public-provider fallbacks and last-known-good catalogue responses
- Strict request and response validation with Zod
- Public Cache API caching and D1-backed per-IP/per-account rate limits
- Exact Cloudflare source-IP verification before every route, preconfigured for
  the VPN egress addresses `92.71.54.161` and `177.7.57.50`
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
| `GET`      | `/assets/icon.png`                     | Approved VPN IP                               | Source artwork shown by Hot Tub                              |
| `GET`      | `/assets/icon-<bundle>.png`            | Approved VPN IP                               | Per-bundle artwork; unknown names 404                        |
| `POST`     | `/api/status`                          | Approved VPN IP                               | Source/channel discovery                                     |
| `POST`     | `/api/videos`                          | Approved VPN IP                               | Browse and search                                            |
| `POST`     | `/api/uploaders`                       | Approved VPN IP                               | Creator profiles for adapters with stable creator metadata   |
| `GET`      | `/library`                             | Approved VPN IP                               | Local library page: playlists, favourites, creators, history |
| `GET`      | `/account`                             | Approved VPN IP                               | Connection metadata; never renders secrets                   |
| `POST`     | `/account/connect`                     | Approved VPN IP + origin + CSRF               | Validate and store an encrypted provider session             |
| `POST`     | `/account/diagnose`                    | Approved VPN IP + origin + CSRF               | Report what an entitled session exposes for playback         |
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

Unit tests use fixtures and never call providers, so they stay green through a
total provider outage. The live catalogue test covers browse and search for
every channel and is the only check that catches a provider changing its URLs
or response shape. It is excluded from the normal suite because it needs the
network:

```bash
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

Run it before trusting the provider table above. All six channels were verified
live on 2026-07-27; see [Provider research](docs/provider-research.md) for what
was broken and why.

## Deployment

The deployment workflow runs after a merge to `main`. It creates or reuses a D1
database named `hot-tub`, writes a generated Wrangler configuration with the
real database UUID, applies migrations, configures the optional encryption
secret, and deploys the custom domain.

Configure these GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `TOKEN_ENCRYPTION_KEYS` only when an authorised provider connection is added

`TOKEN_ENCRYPTION_KEYS` is a key ring you generate, not something a provider
issues. It encrypts stored provider credentials with AES-256-GCM, and
`/account/connect` returns `503` until it exists rather than writing a
credential in plaintext. The format is `key_id:base64url-32-bytes`, comma
separated, with the first key encrypting and the rest kept only to decrypt older
values.

The easiest way to set it is the **Provision encryption key** workflow: run it
from the Actions tab and it generates a key on the runner and writes it straight
to the Worker, so the value never appears in a log, a repository secret, or a
terminal. It needs no local tooling and works from a phone. It refuses to
overwrite an existing key unless explicitly told to, because Cloudflare will not
return a stored secret — so a replacement cannot keep the old key in the ring,
and every existing connection would have to be reconnected at `/account`.

Use the repository secret instead only if you want to hold the key yourself, and
then use just one of the two mechanisms: a repository secret overwrites whatever
the workflow set, on every deploy.

The committed configuration already restricts the entire source to:

```text
92.71.54.161,177.7.57.50
```

Set the optional `ADMIN_ALLOWED_IPS` GitHub Actions variable only when replacing
those addresses or adding another comma-separated VPN egress address. The
variable replaces the committed list rather than adding to it, so it must
repeat every address that should keep working.

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
