# Deploying NetKit to Plesk

NetKit is a Node application that serves its own SPA. On Plesk that means two
things from the "Adding New Domain" screen: **Deploy using Git** for getting
the code there, and **Node.js** enabled on the domain to run it.

---

## 1. Create the domain

1. **Websites & Domains → Add Domain → Deploy using Git.**
2. Repository URL: `https://github.com/Nexus-Joe-Kane/HotTub`
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

**Backups.** Back up `DATA_DIR`. Everything else is rebuildable from Git.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "server/dist is missing" in the log | The build did not run. Execute `plesk-deploy.sh`, or `npm ci && npm run build`. |
| 502 / Passenger error page | Check the Node.js log. Usually a missing `SESSION_SECRET` in production, or an unwritable `DATA_DIR`. |
| SPA loads but every API call 401s | Cookies are being dropped. Confirm HTTPS is on and that you are not mixing `www` and apex hostnames. |
| Signed out on every deploy | `SESSION_SECRET` is unset, so a new one is generated per start. |
| Users disappeared after a deploy | `DATA_DIR` is inside the Git working tree. Move it outside and restore from backup. |
| Everything says "Demo data" | No credentials are configured yet. Expected — check **Admin portal → Service status** for what is still awaiting keys. |
