# NetKit — handover

Everything outstanding, everything worth considering, and the things that are
settled so nobody re-opens them.

Written 08 September 2026. `main` at the merge of #35.

---

## Ofcom mobile: a request is in

There **is** an Ofcom mobile API, on a different platform from the broadband
one, and a request for access has been submitted.

Worth recording what was and was not true here, because I had this wrong for a
while in both directions. On `api.ofcom.org.uk` — the developer portal that
serves the broadband API — the only products are Broadband Coverage (Basic)
and (Premium). That is why a mobile key never appeared there and why the
speculative mobile branch in this codebase was removed: it called that portal
with a guessed endpoint and the wrong subscription header, so it could never
have worked. What does not follow, and what I asserted anyway, is that no
Ofcom mobile API exists anywhere.

**When the request is granted, send me the base URL, the auth scheme and
whatever field documentation comes with it and I will wire it in.** I am not
going to guess the shape a second time — guessing is what produced the dead
branch, and a provider that looks configured but silently answers nothing is
worse than one that is honestly absent.

`server/src/providers/signal/ofcom.ts` is structured to take it: it reads a
dataset today, keyed by postcode where one is available and by area
otherwise, and a live source slots in ahead of the file with the file staying
as the offline fallback.

Until then the CSV route below works and needs no key at all.

## Part 1 — Outstanding, in the order I would do them

### 1. Rotate the admin password

Still open, and now the oldest item on this list. It has never been in the
repository — the account seeds from `ADMIN_PASSWORD` and only a scrypt hash is
stored — but it has been in a chat conversation and in a screenshot of the
Plesk environment panel.

**Plesk → Node.js → Custom environment variables**, change `ADMIN_PASSWORD`,
restart the app.

### 2. Point `OFCOM_DATASET_PATH` at the file already on the server

This clears the yellow banner on every site report and turns mobile signal
from modelled into Ofcom's published prediction. The file is already there.

```
OFCOM_DATASET_PATH=/var/www/vhosts/comms.supportwizard.net/netkit-data/ofcom-mobile-coverage-2025-2026.csv
```

Its `release` / `level` / `area_code` / `area_name` columns are all
recognised, and where the file holds two publications the newer one wins.

Figures are labelled in the UI as constituency- or authority-level, because
that is the finest resolution Ofcom publish for mobile — a constituency
contains both a city centre and a valley with no signal, and the tool says so
rather than implying a per-doorstep reading.

### 3. Jola needs both credential halves

```
JOLA_API_KEY=<from the Jola tile>
JOLA_SECRET_KEY=<the other half>
```

The API is HTTP Basic and a key on its own is not a credential. This is what
the old 401s were. `JOLA_HEALTH_PATH` and `JOLA_SIMS_PATH` no longer exist —
delete them if they are still set, they did nothing but let someone guess a
path.

### 4. Zen assurance: an entitlement conversation, not a bug

`Zen assurance responded 401 Unauthorized` on network status, while faults
work. Tokens are minted per scope, so Zen granted the scope at the identity
server and the account is not entitled to that endpoint.

Nothing in the code can fix this. The error message now names the scope and
the path — quote those to your Zen account manager and ask for the endpoint to
be enabled.

### 5. Ask Giacom for the serviceability path

`GIACOM_QUALIFICATION_PATH` is deliberately empty. Their TM Forum
`serviceQualification` resource exists but the path is not published, and a
guessed path returning 404 would read as "no coverage here" — which is worse
than no answer. Ask Comms Cloud Market for it and set it.

Until then Giacom answer availability through `/service` only.

### 6. The server's operating system

CentOS 7.9, glibc 2.17, and Plesk offers no Node above 17.9.1 for it. The app
needs 20. It is currently running on a Node 20 built for glibc 2.17, reached
by symlinking `/opt/plesk/node/17` to a manually installed `20`.

That works and it is a stopgap. The panel shows 17.9.1 while running 20.19.0,
`plesk ext nodejs --versions` still lists the old set, and nothing patches
that Node for you. CentOS 7 stopped getting security patches in June 2024.

**Ask the host to move the domain to a current OS** (Alma/Rocky 8+, Debian
11+, Ubuntu 22.04+). Node 20 and 22 then appear in the dropdown natively and
the symlink comes out. Details and the revert command are in `GO-LIVE.md`.

### 7. Keys that unlock panels currently saying they are not connected

| Variable | What it turns on |
| --- | --- |
| `OFCOM_BROADBAND_API_KEY` | Ofcom's own per-premises predicted speeds, as an independent second opinion |
| `THINKBROADBAND_API_KEY` | Alt-net coverage — Community Fibre, G.Network, Virgin and the rest |
| `COMPANIES_HOUSE_API_KEY` | The whole company record. Free with registration; it is the **Primary key** on your Profile page |
| `BT_HOME_NETWORK_KEY` | "Is this mobile actually on the network right now" |
| `BT_IMEI_LOOKUP_KEY` | The handset behind a number |
| `BT_LOCATION_INSIGHTS_KEY` | Footfall, Greater London only |
| `RESEND_API_KEY` | Email two-factor and account invites. Optional otherwise — notices prefer Zendesk |
| `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` | Ticket notes, site contacts, and outbound notices as internal tickets |

Every one of these can now be set in **Admin portal → Credentials** rather
than in the environment, with a test button per integration, and takes effect
without a restart. `SESSION_SECRET` and `DATA_DIR` are the exceptions and stay
in Plesk: one is the key the vault is encrypted with, the other is where the
vault lives.

**Admin portal → Service status** lists all 27 integration probes with
exactly what each is waiting for. That is the authoritative view, not this
table.

### 8. BT's locked wholesale APIs

Your request covered OAuth 2, Address Management, WBC Broadband Availability
and WBC Copper Line Availability. That is the right minimum for the
availability half.

Two things it does not cover, and both matter here:

- **Anything keyed on a CLI or line access ID for an existing service** — line
  characteristics, service details. The whole "tell me about this line"
  promise leans on this.
- **Fault status and line testing** — worth more than usual to you because
  Giacom publish no fault or diagnostics API at all, so BT would be filling a
  hole that currently has nothing in it.

I have deliberately not guessed BT's product names for those; their catalogue
naming is not public and a wrong name wastes the two-day SLA. Describe the
capability and let them map it. Expect them to ask for a wholesale account
number rather than approving on the spot.

---

## Part 2 — Settled, so nobody re-opens it

- **Openreach have no obtainable API.** Availability comes via Zen and Giacom
  as resellers. BT's locked wholesale products (above) are the nearest thing.
- **Giacom publish no faults, diagnostics or line-test API.**
  `troubleTicket`, `diagnostic` and `serviceTest` appear zero times in their
  specification. A Giacom circuit is visible here in full, but a fault on it
  goes through their portal. That is their API surface, not a gap in this.
- **No free source can name an alt-net at an address.** Ofcom hold the
  per-operator split and withhold it as commercially confidential; their
  schema has no operator field at all. That is why Ofcom's prediction sits
  beside the availability table and never as a row in it, and why alt-net
  coverage needs thinkbroadband.
- **Jola is largely redundant for SIMs bought through Zen** — Zen's
  `/api/cellular/*` endpoints are Jola-backed. It earns its place for SIMs
  held directly with Jola.
- **Ordering is behind two locks and stays there.** `ZEN_ALLOW_ORDERING` plus
  an admin switch, both off by default, and each order needs the installation
  address retyped. Ordering spends money and books engineers.

---

## Part 3 — Worth building next

Seven of these have shipped since this document was written. What is left,
and why, is below them.

### Shipped

- **Bulk lookup.** Top of Tools. Paste a column of postcodes, UPRNs,
  addresses or CLIs, get a row each with best technology, speed, orderable
  count and lines in place, exportable. Built around the fair-use budget:
  three at a time, the budget reserved atomically per row, and anything the
  budget could not cover marked `skipped` rather than attempted.
- **Fault SLA countdowns.** Time remaining on the faults board, coloured,
  ticking, and in the CSV. The supplier's own commitment wins over a generic
  target; a cleared fault is judged when it cleared rather than drifting
  further past its target every time the page opens.
- **Officer disqualification.** A critical flag on the company record and a
  badge on the officer. Free on the Companies House key.
- **Other appointments.** The companies an officer runs elsewhere, live and
  troubled first — a director of four dissolved companies and one new one is
  the pattern worth seeing before agreeing credit.
- **Print the whole report.** Printing used to capture only the open tab.
  There is now an A4 layout covering every section, on brand, with a picker
  for which sections go on the page — and the layout tightens as more are
  ticked, so a full report still lands on a sensible number of sheets.
- **Nearest masts, per operator.** Cell sites near the premises with a
  distance each, from OpenCelliD, three per network. This is the honest
  counterweight to coverage published per constituency: "the nearest EE site
  is 4.2 km away across a hill" explains what an area-level figure cannot.
  Built and tested; it goes live the moment `OPENCELLID_API_KEY` is set, and
  says what it is waiting for until then.
- **Watch a premises.** A "build planned 20 Sept 2027" FTTP row is worth
  nothing unless somebody remembers to look again, and nobody does. There is
  now a **Watch this premises** button on the site report and a **Watched
  premises** list under Tools. Each watch is re-checked roughly once a day by
  the supervisor sweep — oldest first, five per sweep, and never against the
  budget a person needs for live work — and you are emailed only when
  something actually moves: a technology arriving or going, an FTTP build
  status or RFS date changing, the orderable count changing. A speed estimate
  wobbling by a megabit between two Openreach checks is deliberately not a
  change, because a watch that emails on noise gets muted within a week.
  Twenty watches per person, because every one of them is a real availability
  check on a schedule.

### Shipped since

- **Which network to try.** The mobile tab now combines Ofcom's prediction,
  OpenCelliD mast distance and BT footfall into one recommendation, and says
  which of the three it used, what it is missing, and how much weight to put
  on the answer. Where two operators are within five points, mast distance
  separates them; where the masts point somewhere the prediction does not,
  that is raised as a suggestion rather than an override — a model and a mast
  position disagreeing is a reason for an engineer to look, not a reason to
  overrule the regulator. In a crowded area the shorter path is argued more
  strongly, because a cell has finite capacity and a prediction of
  propagation does not know that.
- **A way out of the area-only case.** The Connected Nations file names no
  operator, so it can never rank one. On backup data the panel offers Ofcom's
  own public checker — which is per-operator — with the postcode on the
  clipboard, and a box to enter the four ratings it showed. The
  recommendation is then rebuilt from those, labelled as the engineer's
  reading rather than as our data, and not saved.

### Blocked on something from you

Nothing on the original list is still unbuilt for want of time. What is left
is waiting on somebody outside this repository.

**Zen `indirect-changeservice` — half a day, needs the endpoint paths.** The
scope is in your `ZEN_SCOPES` and no endpoint calls it, because Zen do not
publish the paths for it and this is precisely where guessing has already
cost us once: the dead Ofcom mobile branch called a guessed endpoint with the
wrong header and could never have worked. Ask Zen for the changeservice
endpoint documentation and this becomes a short job.

### Deliberately not done

The three lowest-value items from the original list — a command palette,
Teams or Slack alerts, and a dark theme — were dropped as agreed.

## Part 4 — State of the thing

- **27 integration probes** on the admin status board, each saying what it is
  waiting for. Ten vendors:
  Zen, Giacom, BT, Jola, Ofcom, Ordnance Survey, Companies House,
  postcodes.io, thinkbroadband and Resend.
- **266 tests** (96 shared, 170 server), plus a `check:secrets` guard that
  fails the build if a credential ever lands in `.env.example`.
- **A self-test on every boot** — 29 checks, read-only, results on the admin
  board.
- **Zero native dependencies**, server compiled to CommonJS for Passenger.
- **Nightly backup** of `DATA_DIR` at 02:00, 14-day retention, writing outside
  the Git tree.

### Things to know about the deployment

- `DATA_DIR` and `BACKUP_DIR` must be absolute. The app refuses to start in
  production without `DATA_DIR`, and the backup script refuses relative paths
  for either. A relative path used to resolve inside the Git working tree,
  where a deploy would delete every user account.
- `.env.example` is committed and the app never reads it. Real values go in
  `.env` or, better on Plesk, the Node.js environment panel.
- Once `public/` holds a built `index.html`, requests to `/` are served
  statically and never reach Passenger — so `touch tmp/restart.txt` only takes
  effect after a request to a dynamic route such as `/healthz`.
- `bash plesk-doctor.sh` is read-only and prints the OS, glibc version and
  every Node it can find with whether that Node actually starts.

### Honest limits on what has been verified

Everything built against Zen, Giacom, BT, thinkbroadband and Jola has been
verified against stand-in servers serving those APIs' documented shapes, and
against induced failures. **None of it has been verified against your live
credentials**, because I have never held them. OS Places, postcodes.io,
Companies House and the Ofcom broadband API are the ones with a real key in
play on the server.

The first live call to each of Zen assurance, Giacom and Jola is therefore
still a test. When one disagrees with what the code expects, the field mappers
are deliberately tolerant of alternative spellings — but send me the response
and I will fix the mapping properly rather than guess again.
