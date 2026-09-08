# NetKit — go live

One page, in order, from an empty Plesk subscription to a working portal.
`DEPLOY-PLESK.md` has the same ground in more depth plus troubleshooting;
this is the checklist.

---

## Part 1 — Get it running (about 20 minutes)

Nothing here needs a single API credential. At the end you will have a
working portal serving demo data, and the admin board will tell you exactly
which integrations are still waiting on keys.

### 1. Create the domain

**Websites & Domains → Add Domain → Deploy using Git**

- Repository: `https://github.com/Nexus-Joe-Kane/HotTub`
- Branch: `main`

Let Plesk take the first pull.

### 2. Create the data directory — before you start the app

Over SSH. It **must** live outside the Git working tree, or a deploy that
resets the tree takes your user accounts with it.

```bash
mkdir -p /var/www/vhosts/<domain>/netkit-data
chown <sysuser>:psacln /var/www/vhosts/<domain>/netkit-data
chmod 700 /var/www/vhosts/<domain>/netkit-data
```

`<sysuser>` is on **Web Hosting Access**.

### 3. Enable Node.js

**Websites & Domains → Node.js → Enable Node.js**

| Setting | Value |
| --- | --- |
| Node.js version | 20 or newer |
| Application mode | `production` |
| Application root | `/httpdocs` |
| Document root | `/httpdocs/public` |
| Application startup file | `app.js` |

Document root points at `public/` so nginx serves the built SPA directly and
anything that is not a file on disk falls through to Passenger.

### 4. Environment variables

**Node.js → Custom environment variables.** The minimum to boot:

```
NODE_ENV=production
SESSION_SECRET=<openssl rand -base64 48>
DATA_DIR=/var/www/vhosts/<domain>/netkit-data
ADMIN_EMAIL=joe@supportwizard.net
ADMIN_PASSWORD=<something new — not the one from chat>
```

`SESSION_SECRET` is **required** in production: the app refuses to mint
sessions without it rather than generating a per-restart one that signs
everyone out every time Passenger recycles.

Leave `ADMIN_PASSWORD` unset and a strong one is generated, printed **once**
to the application log, and forced to change on first sign-in. Either is fine.

### 5. Build and start

**Git → your repository → Deployment actions:**

```bash
bash plesk-deploy.sh
```

Installs dependencies, builds all three packages, creates `DATA_DIR` at `700`
if missing, touches `tmp/restart.txt` so Passenger reloads. Safe to re-run.
If deployment actions are not on your plan, run it over SSH from `/httpdocs`.

### 6. Check it came up

```bash
curl -s https://<domain>/healthz     # expect {"ok":true,...}
```

Then sign in. **Expect every panel to say "Demo data"** — that is correct
until credentials land, and **Admin portal → Service status** lists all 26
integrations with exactly what each is waiting for.

### 7. HTTPS — before you give anyone the URL

**SSL/TLS Certificates → Let's Encrypt**, then turn on "Redirect from http to
https". Session cookies are `secure` in production, so sign-in will not work
over plain HTTP. The app sets HSTS and trusts Plesk's `X-Forwarded-*`.

### 8. Nightly backup

```bash
# Plesk → Scheduled Tasks, or crontab
0 2 * * * /var/www/vhosts/<domain>/httpdocs/backup-data.sh >> /var/log/netkit-backup.log 2>&1
```

Set `BACKUP_DIR` somewhere the Plesk backup set already collects, so archives
leave the machine. `DATA_DIR` is the only thing in the whole deployment that
cannot be rebuilt from Git.

**Part 1 is done.** The portal works. Everything below turns demo data into
real data, and can be done in any order, any time.

---

## Part 2 — Credentials, in the order they pay off

Add each to the environment and restart. Nothing else changes: each one flips
its own panels from demo to live and reports itself on the admin board.

### Zen — do this one first

```
ZEN_CLIENT_ID=
ZEN_CLIENT_SECRET=
```

Unlocks most of the tool: Openreach availability with full engineering
detail, existing lines, faults, diagnostics and line testing, orders, SIMs,
call records, Ethernet quotes, number porting.

Zen grant scopes individually. Defaults request the eleven NetKit uses; trim
`ZEN_SCOPES` to what you actually hold if any come back refused.

### Ofcom mobile coverage — free, no account, biggest quality win per minute

```
OFCOM_DATASET_PATH=/var/www/vhosts/<domain>/netkit-data/ofcom-mobile.csv
```

Download the Connected Nations **postcode-level mobile coverage** file and
point at it. Mobile signal stops being modelled and becomes Ofcom's published
prediction. Column names are interpreted rather than hard-coded, so a new
Ofcom release keeps working.

### OS Places

```
OS_PLACES_API_KEY=
```

Authoritative UPRN and address search. Zen has no UPRN endpoint, so this is
what makes a bare UPRN resolve to a real premises.

### Giacom — your second wholesale supplier

```
GIACOM_CLIENT_ID=
GIACOM_CLIENT_SECRET=
```

Lines on the Giacom account appear at a premises alongside Zen's, each
labelled with its supplier so it is obvious who to ring. Plus BT Wholesale
address validation as a second opinion on the Openreach address key.

**Then ask Giacom two things:**

1. Enable the `serviceQualification` scope and send you the endpoint path.
   Set `GIACOM_QUALIFICATION_PATH` and per-address availability across BT
   Wholesale, CityFibre, TalkTalk, Virgin Media Business and Sky goes live.
   Leave it blank until they confirm — it is not guessed, because a confident
   404 would read as "no coverage".
2. Which alt-nets they can sell you. CityFibre is already in their portfolio;
   if they add Netomnia or Community Fibre it arrives through this same
   integration for free.

Note: **Giacom publish no fault or diagnostics API**, so line testing and
fault raising stay Zen-only. Every Giacom line says so on its own record.

### Resend — turns on email 2FA

```
RESEND_API_KEY=
RESEND_FROM_EMAIL=no-reply@supportwizard.net
```

Restart, then **Admin portal → Service status → Send test email**. 2FA only
becomes available once a send has actually succeeded — an unverified key
would otherwise lock people out of their own accounts. Also enables the
escalation email when the supervisor cannot repair an integration.

### Companies House — free with registration

```
COMPANIES_HOUSE_API_KEY=
```

The **Who is here** tab: every company registered at the premises, with
liquidation, administration and dissolution flagged and sorted to the top.

### thinkbroadband — alt-net coverage

```
THINKBROADBAND_API_KEY=
```

Coverage across CityFibre, Virgin Media, Community Fibre, G.Network and the
rest, by postcode and UPRN. A **data licence, not a carrier contract** —
priced on enquiry. Without it the coverage rows are demo footprint data,
clearly labelled as unchecked.

### BT developer products — three, and the least essential

```
BT_HOME_NETWORK_KEY=          # "is this phone on the network"
BT_IMEI_LOOKUP_KEY=           # handset behind a number, incl. Wi-Fi calling
BT_LOCATION_INSIGHTS_KEY=     # footfall, Greater London only
```

---

## Part 3 — Switches you should know exist

### Ordering is off, behind two locks

Placing an order needs **both**:

1. `ZEN_ALLOW_ORDERING=true` in the environment — needs a deploy to change.
2. The switch in **Admin portal → Ordering & limits**, which makes you type
   `UNLOCK ORDERING`.

Deliberately two, and deliberately not both changeable from the same screen.
Each order additionally needs the installation address retyped by hand, is
capped per user per day (default 3, adjustable 0–50 in the portal), and is
audited before and after.

Without Zen ordering credentials the flow runs as a clearly labelled
**rehearsal** and then refuses — so your team can learn it before the keys
arrive.

### Fair use

```
AVAILABILITY_DAILY_BUDGET=250
```

Premises lookups per user per day. Zen's availability quota is per *account*,
not per user, so one person working through a list can spend everyone's
allowance. Repeat looks at a premises already checked today are free. `0`
removes the limit. Today's counters, per user, are in **Ordering & limits**.

### The supervisor

On by default. Every five minutes it probes all 26 integrations and *fixes*
what it can — re-mints an expired token, drops a poisoned cache, reloads the
Ofcom dataset. Three consecutive failures open a circuit breaker so lookups
skip a dead upstream instead of waiting for its timeout. If recovery cannot
help for an hour, active admins get an email (needs Resend verified).

```
SUPERVISOR_ENABLED=true
SUPERVISOR_INTERVAL_SECONDS=300
SUPERVISOR_ESCALATE_AFTER_MINUTES=60
```

---

## Part 4 — What it will and will not tell you

Worth knowing before your team relies on it, because the honest limits are
not obvious from the screens.

| Network | Where the data comes from | Can you sell it? |
| --- | --- | --- |
| **Openreach** | Zen — authoritative, full engineering detail | Yes |
| **CityFibre, Virgin Media Business, TalkTalk, Sky** | Giacom | Yes, once the qualification path lands |
| **Community Fibre, Hyperoptic, Gigaclear, Netomnia, the rest** | thinkbroadband | No — coverage intelligence only |
| **G.Network** | Nobody. Their own checker, one click from the report | No |

**Anything marked "Not checked" is a footprint, not an address check.** Those
rows sit in their own **Other networks** tab behind a warning, are excluded
from the orderable count, can never be ordered, never become "Best
available", and appear in Copy-as-text under a heading that says so. The
self-test fails outright if any of them ever claims availability.

That tab also carries **direct links to G.Network, Openreach, Virgin Media
and Ofcom's own checkers**, each opening in a new tab. G.Network's opens with
the postcode already filled in. Check you are on a network's *business* tab
before quoting from it.

---

## Day-to-day

| Task | Where |
| --- | --- |
| Restart | `touch tmp/restart.txt`, or **Node.js → Restart App** |
| Update | Pull in Plesk; the deployment action rebuilds and restarts |
| What is broken | **Admin portal → Service status** |
| What broke and what fixed it | **Admin portal → Recovery & self-test** |
| Does this deployment actually work | **Recovery & self-test → Self-test** (29 checks) |
| Add or remove a user | **Admin portal → Users** |
| Who did what | **Admin portal → Audit log** (append-only, CSV export) |

---

## Two things still outstanding

1. **Rotate the admin password shared in chat.** It never entered this
   repository — the account seeds from `ADMIN_PASSWORD` and only a scrypt
   hash is stored — but it is in that conversation's history.
2. **Repository Actions is broken and it is not this code.** Every workflow
   run since 2 August, on `main` and every branch, fails at startup against a
   *deleted* workflow placeholder (`path: BuildFailed`, `state: deleted`) that
   still fires on a schedule. `ci.yml` parses correctly and has never been
   picked up. Worth ten minutes in **Settings → Actions**; the next push after
   this merge will tell you whether replacing the workflow set cleared it.
