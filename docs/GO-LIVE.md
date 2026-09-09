# NetKit — go live

One page, in order, from an empty Plesk subscription to a working portal.
`DEPLOY-PLESK.md` has the same ground in more depth plus troubleshooting;
this is the checklist.

---

## Part 1 — Get it running (about 20 minutes)

Nothing here needs a single API credential. At the end you will have a
working portal, and the admin board will tell you exactly
which integrations are still waiting on keys.

### 1. Create the domain

**Websites & Domains → Add Domain → Deploy using Git**

- Repository: `https://github.com/Nexus-Joe-Kane/NetKit`
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

**Set the Node.js version before the first deploy, and check it after.** Plesk
often defaults to something much older than 20 — v17 is common — and it uses
that version for the "Installing the application dependencies" step it runs on
its own, which happens before any deployment action you write. Under Node 17
the install prints a wall of `EBADENGINE` warnings and then leaves a
`node_modules` the app cannot boot from.

If a deploy has already run under an older Node, changing the version is not
enough on its own — the bad tree is still on disk:

```bash
# over SSH, from the application root
rm -rf node_modules */node_modules
```

Then re-run the deployment action.

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

The script finds its own tools, because Plesk does not provide them. It runs
deployment actions with a near-empty `PATH`, so it resolves Node itself out of
`/opt/plesk/node/*/bin`, `~/.nvm` and the standard directories, picks the
newest it finds at version 20 or above, and stops with an explanation rather
than building under anything older.

If the deploy log shows this:

```
plesk-deploy.sh: line 9: dirname: command not found
plesk-deploy.sh: line 11: node: command not found
plesk-deploy.sh: line 11: npm: command not found
```

you are running a version of the script from before that fix — pull the
latest commit on the deployment branch and run the action again.

**If Node itself will not start**, with errors naming `GLIBC_2.28`,
`GLIBCXX_3.4.2x` or `CXXABI_1.3.x`:

```
node: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by node)
node: /lib64/libstdc++.so.6: version `GLIBCXX_3.4.22' not found (required by node)
```

that is not a permissions or PATH problem and re-running will not help. The
Node binary was built for a newer OS than the server runs. Official Node 18,
20 and 22 builds all require glibc 2.28; EL7-era systems (CentOS 7,
RHEL 7, CloudLinux 7) ship glibc 2.17 and cannot run them at all.

Confirm which situation you are in:

```bash
bash plesk-doctor.sh
```

It is read-only. It prints the OS, the glibc version, and every Node it can
find with whether that Node actually starts — so an installed-but-unrunnable
Node 20 is visible as `BROKEN` rather than looking like a missing one.

If glibc is older than 2.28 there are two honest options, and no third:

1. **Move the site to a newer OS** — the clean fix. Anything with glibc 2.28
   or newer (Alma/Rocky 8+, Debian 10+, Ubuntu 20.04+) runs official builds.
2. **Install a Node 20 built for glibc 2.17** — the `glibc-217` variant on
   `unofficial-builds.nodejs.org`, or a Plesk Node package your host builds
   for that OS. Ask the host first; they may already have one.

Do not unpack a generic `linux-x64` Node tarball over a working install — that
is precisely what produces the errors above, and it will also break any other
Node site on the server.

**If Plesk's version dropdown only offers 17.9.1 or lower** (typically 17.9.1,
16.20.2, 14.21.3, 12.22.12), that list is not a Plesk setting you can change —
it is every Node package Plesk builds for the server's OS, and it stops there
on EL7. The OS is the constraint, not Plesk.

Node 17 is not a usable fallback here. Every outbound call in the server —
Zen, Giacom, BT, Ofcom, Resend — uses the global `fetch`, which arrived in
Node 18. On 17 it is undefined unless you launch with `--experimental-fetch`,
and `helmet` also declares Node 18 as its floor. The app would install and
then throw on the first lookup.

Two routes, in the order worth trying:

1. **Move the domain to a Plesk server on a current OS** — Alma or Rocky 8+,
   Debian 11+, Ubuntu 22.04+. Node 20 and 22 then appear in that dropdown
   with no manual work, and Plesk's migration tool moves the domain, mail and
   databases across. Ask the host: on shared or managed hosting this is
   usually a request, not a project. This is the fix worth pushing for —
   CentOS 7 stopped getting security patches in June 2024 and Node 17 in
   June 2022, which is a poor foundation for a tool holding customer line
   data, quite apart from this build.

2. **Add a Node 20 built for the old glibc**, if the OS cannot move yet.
   This works, but not the way you would expect, and the obvious approach
   does not work at all. What follows was established on the live server.

   Take the `glibc-217` variant for the Node 20 line from
   `unofficial-builds.nodejs.org` (check the release listing — that variant
   is published for some lines and not others), unpack it into
   `/opt/plesk/node/20`, and confirm the binary starts:

   ```bash
   /opt/plesk/node/20/bin/node -v
   ```

   That must print a version. If it prints another `GLIBC_` error you have
   the wrong variant, and nothing below will help.

   **Plesk will not discover it.** The Node.js extension only knows versions
   it installed itself — its cache holds the tarballs it fetched — so a
   working Node 20 sitting in `/opt/plesk/node/20` never appears in the
   dropdown. On this server `/opt/plesk/node/18` had sat there unlisted
   since 2022. Nor can you ask Plesk to adopt it:
   `plesk ext nodejs --install -version 20.19.0` answers *"The Node.js
   version 20.19.0 was not found"*, because it only offers builds Plesk
   packages for the host OS. (The real CLI is `plesk ext nodejs`, with
   `--versions`, `--enable`, `--disable`, `--install`, `--uninstall`,
   `--set-version`, `--get-version`. There is no `plesk sbin nodemng`.)

   **Overriding Passenger in Apache directives does not work either.**
   Passenger takes the *first* `PassengerNodejs` directive it sees, which is
   the nodejs extension's own line in the generated `httpd.conf`. Anything
   you add under Additional Apache directives is included later and silently
   ignored — an `apachectl graceful` plus an app restart still spawned
   `/opt/plesk/node/17/bin/node`.

   What actually works is to put the new Node where Plesk already looks:

   ```bash
   cd /opt/plesk/node
   mv 17 17.node17-orig
   ln -s 20 17          # check first that no other domain uses 17
   ```

   Two consequences to know about. The panel still displays the old version
   number while running the new one — 17.9.1 shown, 20.19.0 executing — and
   `plesk ext nodejs --versions` still lists the old set. And once `public/`
   contains a built `index.html`, requests to `/` are served statically and
   never reach Passenger, so touching `tmp/restart.txt` only takes effect
   after a request to a dynamic route such as `/healthz`.

   To revert: `rm 17 && mv 17.node17-orig 17`.

   Treat all of this as a stopgap. Unofficial builds are not on the host's
   update path, so nothing patches that Node for you, and the symlink is a
   surprise waiting for whoever next looks at the panel.

Either way, `bash plesk-doctor.sh` confirms the result — the new Node should
appear as `RUNS`, not `BROKEN`.

### 6. Check it came up

```bash
curl -s https://<domain>/healthz     # expect {"ok":true,...}
```

Then sign in. **Expect panels to say they are not connected** — that is correct
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

**Part 1 is done.** The portal works. Everything below turns a not-connected panel into
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

### Ofcom mobile coverage — free, no account

```
OFCOM_DATASET_PATH=/var/www/vhosts/<domain>/netkit-data/ofcom-mobile-coverage.csv
```

Mobile signal stops being modelled and becomes Ofcom's published prediction.

**There is no postcode-level mobile file — do not go looking for one.** Ofcom
publish mobile coverage per parliamentary constituency (`pcon`), per local or
unitary authority (`laua`), per devolved constituency (`devcon`) and per
nation. Postcode-unit files exist only for *fixed broadband*. Connected
Nations 2022, 2025 and the Spring 2026 update were all checked: no CSV in any
mobile zip carries a postcode column.

So point this at a `pcon` or `laua` CSV from a Connected Nations mobile
release. A postcode is then answered in two hops — postcodes.io maps it to its
constituency and local authority, and that area is looked up in the file — and
every operator row in the UI is labelled with the area the figure describes,
because a constituency contains both a city centre and a valley with no
signal and this cannot tell them apart.

Constituency is tried before local authority, being the finer of the two.
Column names are interpreted rather than hard-coded, so a new Ofcom release
keeps working, and a postcode-keyed file would be used directly if Ofcom ever
publish one.

### Ofcom broadband API — also free, also just a signup

```
OFCOM_BROADBAND_API_KEY=
```

Sign up at [api.ofcom.org.uk/signup](https://api.ofcom.org.uk/signup/),
subscribe to **Broadband Coverage (Basic)** under Products (50,000 requests a
month), and take the Primary key from your Profile page.

Adds Ofcom's own per-premises predicted speeds to the site report, keyed by
UPRN. Two uses: an independent second opinion when a wholesale estimate looks
wrong, and the honest free answer to "is there gigabit at this address" before
any wholesale account is connected.

**It names no operator** — Ofcom withhold that as commercially confidential —
so it appears beside the availability table, never as a row in it.

**The mobile API is not on this portal.** `api.ofcom.org.uk` sells the two
broadband products and nothing else, so there is no mobile product to request
with this key. Ofcom's mobile coverage API lives on a separate platform and
your access request for it is in. Until it comes back, mobile coverage comes
from the Connected Nations dataset above.

### OS Places

```
OS_PLACES_API_KEY=
```

Authoritative UPRN and address search. Zen has no UPRN endpoint, so this is
what makes a bare UPRN resolve to a real premises.

**On searching a name plus a town.** OS Places `/find` ranks on relevance and
is entitled to ignore a word, so `megans richmond` came back with nine
Megan's in nine other towns and none in Richmond: the name alone scores well
enough on a hundred namesakes to fill three pages before the premises that
satisfies both words is reached. Re-ranking a page that does not contain the
answer cannot produce it.

A postcode district *can* be searched for, because it is in the address text
OS indexes. So when nothing accounts for every word typed, the word that came
back empty is resolved to the districts it covers (postcodes.io: place name →
point → nearest live postcodes → districts, cached for a week) and the search
is run again with the district standing in for it. Two districts at most, and
only after a query has already failed, so the common case costs nothing extra.

When even that finds nothing, the list says so rather than presenting
near-misses as answers: it names the word no premises came back for and
suggests the postcode. Usually that means AddressBase does not carry the
trading name at that address yet, which no amount of searching will fix.

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

### Resend — optional, and only for credentials

```
RESEND_API_KEY=
RESEND_FROM_EMAIL=no-reply@supportwizard.net
```

Restart, then **Admin portal → Service status → Send test email**. 2FA only
becomes available once a send has actually succeeded — an unverified key
would otherwise lock people out of their own accounts.

Two things need a mailer and cannot use anything else: **sign-in codes** and
**account invites**, because both carry a credential and a credential does
not belong in a queue every agent can open. Everything else NetKit sends —
supervisor escalations, watched-premises alerts — goes down whichever channel
is configured, and prefers Zendesk. See the next section.

With no Resend key at all, NetKit still runs: 2FA is unavailable, new
accounts get their temporary password shown on screen to the admin who
created them, and notices become Zendesk tickets.

### Credentials, without touching Plesk again

Everything below can be set in **Admin portal → Credentials** instead of in
the environment, and takes effect immediately — no restart. Each integration
has a **Test without saving** button next to it, so a pasted key is proved
before it changes anything that is running.

Two things to know:

- The vault is encrypted at rest with a key derived from `SESSION_SECRET`.
  That one has to stay in Plesk, because it is the key the rest are locked
  with. Rotating it makes the stored credentials unreadable, and the portal
  and the boot log both say so plainly rather than leaving the integrations
  looking merely unconfigured.
- Anything already set in Plesk keeps working and is labelled "from Plesk".
  Saving the same key in the portal takes over from it; removing it in the
  portal hands it back at the next restart. So moving over is gradual, not a
  cutover.

Stored values are never shown again — not even the first four characters,
because four characters of an API key is four characters an attacker does not
have to guess. The list says where the live value comes from, how long it is,
and who set it when.

### IT Glue — what the site is documented as having

```
ITGLUE_API_KEY=
ITGLUE_BASE_URL=https://api.itglue.com
```

The key comes from **Account → Settings → API Keys**. The base URL matters:
IT Glue run three regional hosts (`api.itglue.com`, `api.eu.itglue.com`,
`api.au.itglue.com`) and the wrong one answers as though the data simply is
not there rather than as an error. The service-status probe says so if it
looks like that has happened.

Do **not** enable "Password Access" on the key. NetKit never asks IT Glue for
a password value, on any endpoint — it reads the name, the username and the
link. An engineer who needs a password opens IT Glue, which records that they
did; pulling secrets through a second system would double the places they can
leak from and halve the audit trail.

What turns on: an **On site** tab on every premises report, showing the
documented equipment at that location, which credentials exist, and the
client's other sites. The join is the company name — IT Glue does not know a
Zendesk organisation id — so every match shows how confidently it was made,
and an ambiguous one offers the candidates rather than picking one.

### UniFi Site Manager — what the network says

```
UNIFI_API_KEY=
```

From **unifi.ui.com → Settings → API Keys**. It is shown once. Read-only,
which is all this needs.

Site Manager rather than a local controller, deliberately: one key reaches
every site on the account, where a controller is one site and a hole in
somebody's firewall.

What turns on, alongside the documented view: the live equipment list with
each device's state and firmware, and **Internet** — WAN uptime, latency,
packet loss and *downtime over the last day* for that site. That last figure
is the useful one: it is what tells you whether a fault the customer reported
actually happened. Ubiquiti publish no live WAN interface state, so this is a
window rather than a right-now, and the page says so.

One quirk worth knowing: Site Manager keys equipment to a *console*, not a
site, so where one console serves several sites the equipment list is the
console's whole list. The tab says which console it came from.

### The portal's own address

```
PUBLIC_URL=https://comms.supportwizard.net
```

Only used for links that leave the app — the note on a Zendesk ticket that
pulls Sam into a visit decision carries a link straight to that visit. A
relative link is useless in an email, so with this unset those notes say
"open NetKit under Visits" instead of printing a broken URL.

### Zendesk — the ticket side of a fault

```
ZENDESK_SUBDOMAIN=
ZENDESK_EMAIL=
ZENDESK_API_TOKEN=
```

`ZENDESK_EMAIL` is an agent account; the token comes from **Admin Centre →
Apps and integrations → APIs → Zendesk API**. Auth is Basic with
`<email>/token` as the username, which is Zendesk's own scheme.

Three things turn on:

- **Private notes.** Raising a fault or running a line test with a ticket
  number recorded against it writes what went to the supplier and what came
  back as a private note. Engineers see it; the customer does not.
- **Site contacts.** The site-contact picker on the fault form reads the
  contacts on that ticket's organisation, so a name and number handed to an
  engineer is chosen rather than remembered. It cannot offer somebody from a
  different customer.
- **The site-visit message.** The one deliberately public reply: a visit is
  booked with the supplier, a slot will follow, 24 hours' notice to change
  it, and a charge if nobody is on site.
- **Outbound notices.** With Zendesk configured, anything NetKit needs to
  tell a person becomes an internal ticket tagged `netkit-alert` rather than
  an email: a supervisor escalation when an integration stays broken, and a
  change at a watched premises. That is the better home for them — a ticket
  can be assigned and closed, where an email is read once and gone. The
  people who would have been emailed are added as collaborators, so they
  still get Zendesk's own notification. If Zendesk rejects the ticket and a
  Resend key is present, the notice falls back to email and the audit log
  records both the fallback and Zendesk's reason.

**Admin portal → Service status** names the live channel, so there is no
guessing from which keys are filled in. With neither Zendesk nor Resend, a
notice is still written to the audit log with the reason it could not be
sent — nothing is silently dropped.

The agent needs to see tickets, users and organisations, and to comment. A
restricted agent will read some tickets and not others, which shows up as
"Zendesk has no ticket N" for tickets that plainly exist.

**Every fault goes to the supplier with `help@supportwizard.net` and
`020 7043 3171`, and that is enforced on the server rather than defaulted in
the form.** An engineer can tick a box to be added to the ticket, which is
where updates land anyway.

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

## Outstanding work

`HANDOVER.md` in this directory is the live list — everything outstanding,
what is settled and will not change, and what is worth building next. The
item below is the one that matters most.

## One thing still outstanding

**Rotate the admin password.** It has never been in this repository — the
account seeds from `ADMIN_PASSWORD` and only a scrypt hash is stored — but it
has been in a chat conversation and in a screenshot of the Plesk environment
variables panel. Change it in **Node.js → Custom environment variables** and
restart the app.

Repository Actions, listed here previously as broken, is fixed: `ci.yml` is
being picked up, and the `(Unnamed workflow)` startup failures stop at run
#68.
