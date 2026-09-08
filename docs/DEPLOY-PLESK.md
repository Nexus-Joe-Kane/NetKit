# Deploying NetKit to Plesk

> For a shorter checklist in running order, see
> **[GO-LIVE.md](GO-LIVE.md)**. This page is the same ground in more depth,
> plus troubleshooting.

NetKit is a Node application that serves its own SPA. On Plesk that means two
things from the "Adding New Domain" screen: **Deploy using Git** for getting
the code there, and **Node.js** enabled on the domain to run it.

---

## 1. Create the domain

1. **Websites & Domains → Add Domain → Deploy using Git.**
2. Repository URL: `https://github.com/Nexus-Joe-Kane/NetKit`
   Branch: `claude/supportwizard-networking-toolkit-0ltkzx` (or `main` once merged).
3. Let Plesk do the initial pull.

## 2. Enable Node.js

**Websites & Domains → Node.js → Enable Node.js**, then set:

| Setting | Value |
| --- | --- |
| Node.js version | 20 or newer |
| Application mode | `production` |
| Application root | the domain's root, e.g. `/httpdocs` |
| Document root | `/httpdocs/public` |
| Application startup file | `app.js` |

`app.js` at the repository root is the Passenger startup file. The server is
compiled to CommonJS so Passenger loads it without ESM issues, and there are
no native modules to rebuild.

> **Why document root is `public/`** — nginx serves the built SPA assets
> directly, which is faster, and anything that isn't a file on disk falls
> through to Passenger. Express also serves `public/` itself, so the app still
> works if you point the document root at the application root instead.

## 3. Environment variables

Under **Node.js → Custom environment variables**, add at minimum:

```
NODE_ENV=production
SESSION_SECRET=<openssl rand -base64 48>
DATA_DIR=/var/www/vhosts/<domain>/netkit-data
ADMIN_EMAIL=joe@supportwizard.net
ADMIN_PASSWORD=<the password you want for the first sign-in>
```

Then add credentials as they arrive — see `.env.example` for the full list
with explanations. Variables set here take precedence over any `.env` file.

Two worth knowing about before they surprise you:

| Variable | Default | What it does |
| --- | --- | --- |
| `ZEN_ALLOW_ORDERING` | `false` | One of the two locks on placing real orders. The other is the admin-portal switch; both must be open. |
| `AVAILABILITY_DAILY_BUDGET` | `250` | Premises lookups per user per day. Protects the account's shared fair-use quota. `0` removes it. |
| `THINKBROADBAND_API_KEY` | unset | Alt-net and cable coverage — CityFibre, Virgin Media, Community Fibre, G.Network. Without it the coverage rows are demo footprint data, labelled as unchecked. |
| `GIACOM_CLIENT_ID` / `GIACOM_CLIENT_SECRET` | unset | The second wholesale supplier — BT Wholesale, CityFibre, TalkTalk, Virgin Media Business, Sky. Lines from the Giacom account appear alongside Zen's. |
| `GIACOM_QUALIFICATION_PATH` | unset | Leave blank until Giacom confirm the path. See `docs/API-REFERENCE.md`. |

### Two things that matter

**`SESSION_SECRET` is required in production.** The app refuses to mint
sessions without it, because a per-restart random secret would sign everyone
out every time Passenger recycles the process.

**`DATA_DIR` must live outside the Git working tree.** It holds users,
settings and the audit log. If it sits inside the repository, a deployment
that resets the working tree can take your user accounts with it. Point it at
a sibling directory as above, and make sure it is writable by the subscription's
system user:

```bash
mkdir -p /var/www/vhosts/<domain>/netkit-data
chown <sysuser>:psacln /var/www/vhosts/<domain>/netkit-data
chmod 700 /var/www/vhosts/<domain>/netkit-data
```

## 4. Deployment actions

Under **Git → your repository → Deployment actions**, add:

```bash
bash plesk-deploy.sh
```

That script installs dependencies, builds all three packages, ensures the data
directory exists, and touches `tmp/restart.txt` so Passenger reloads. It is
safe to re-run.

If Plesk's deployment actions are disabled on your plan, run the same thing
over SSH from the application root.

## 5. First sign-in

Open the domain. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

If you left `ADMIN_PASSWORD` blank, a strong password is generated and printed
**once** to the application log — read it from **Node.js → Log** or:

```bash
tail -n 50 /var/www/vhosts/<domain>/logs/proxy_access_log
# or wherever Plesk writes the Node app log for the domain
```

You will be forced to change it immediately.

## 6. Turn on email two-factor authentication

1. Add `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to the environment, and restart.
2. Sign in, open **Admin portal → Service status**, and press **Send test email**.
3. Once that test passes, 2FA becomes available and each user can enable it
   on their own account.

2FA is deliberately gated on a *successful* send. An unverified key would
otherwise lock people out of their own accounts.

---

## Housekeeping

**HTTPS.** Issue a Let's Encrypt certificate under **SSL/TLS Certificates**
and turn on "Redirect from http to https". The app sets HSTS and trusts
Plesk's `X-Forwarded-*` headers, so secure cookies work correctly behind the
proxy.

**Restarting.** `touch tmp/restart.txt` in the application root, or use
**Node.js → Restart App**.

**Updating.** Pull in Plesk (or push to the branch if a webhook is set up).
The deployment action rebuilds and restarts.

### Backups

`DATA_DIR` holds the only state that cannot be rebuilt from Git: user
accounts and password hashes, the settings (including the ordering switch and
its daily cap), the append-only audit log, the per-user daily counters and the
recent-lookup lists. Everything else in the application is a build artefact.

`backup-data.sh` in the application root does it. It reads `DATA_DIR` from
`.env` so the backup can never disagree with the app about which directory
matters, writes a dated `tar.gz` with `600` permissions (the archive contains
password hashes and the audit log), verifies the archive is readable before
keeping it, and prunes anything older than `KEEP_DAYS`.

```bash
# Nightly at 02:00 — add via crontab or Plesk → Scheduled Tasks
0 2 * * * /var/www/vhosts/<domain>/httpdocs/backup-data.sh >> /var/log/netkit-backup.log 2>&1
```

| Variable | Default | Notes |
| --- | --- | --- |
| `DATA_DIR` | from `.env`; **required, absolute** | What gets backed up |
| `BACKUP_DIR` | **required, absolute** | Point this inside the Plesk backup set so archives leave the machine |

Both must be absolute paths, and the script refuses to run otherwise. The
relative defaults these once had (`data` and `backups`) resolved against the
Git working tree, so backups were written where the next deploy would delete
them — and where `git add -A` would commit them.
| `KEEP_DAYS` | `14` | Long enough to notice a bad change, short enough not to become its own problem |

**To restore:** stop the app (**Node.js → Disable**), extract the archive over
the parent of `DATA_DIR`, and start it again:

```bash
tar -xzf backups/netkit-data-20260908T020000Z.tar.gz -C /var/www/vhosts/<domain>
```

The audit log is append-only, so a restore rolls it back to the backup point.
If anyone asks about the gap, that is why.

`backups/` is gitignored, so a backup written into the working tree will never
be committed — but keep it outside the tree anyway, for the same reason
`DATA_DIR` is outside it.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "server/dist is missing" in the log | The build did not run. Execute `plesk-deploy.sh`, or `npm ci && npm run build`. |
| 502 / Passenger error page | Check the Node.js log. Usually a missing `SESSION_SECRET` in production, or an unwritable `DATA_DIR`. |
| SPA loads but every API call 401s | Cookies are being dropped. Confirm HTTPS is on and that you are not mixing `www` and apex hostnames. |
| Signed out on every deploy | `SESSION_SECRET` is unset, so a new one is generated per start. |
| Users disappeared after a deploy | `DATA_DIR` is inside the Git working tree. Move it outside and restore from backup. |
| Panels say "not connected" | No credentials are configured yet. Expected — check **Admin portal → Service status** for what is still awaiting keys. |
