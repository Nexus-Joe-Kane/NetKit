# NetKit — handover

Everything outstanding, everything worth considering, and the things that are
settled so nobody re-opens them.

Written 08 September 2026. `main` at the merge of #35.

---

## Read this first: Ofcom sell no mobile API

You mentioned applying for "both Ofcom broadband and mobile API keys". **There
is no Ofcom mobile API to apply for**, so do not wait on that key — nothing is
coming.

Their developer portal offers exactly two products, Broadband Coverage (Basic)
and Broadband Coverage (Premium). This was checked against the portal's own
Products page, and I got it wrong once in the other direction before that
screenshot settled it. Mobile coverage is published only as Connected Nations
open data files, which need no key at all.

So:

- **Broadband key** — real, worth having, `OFCOM_BROADBAND_API_KEY`.
- **Mobile key** — does not exist. Mobile coverage comes from the CSV you have
  already placed on the server. See item 2 below, which is a one-line change.

If Ofcom ever do publish a mobile API, the provider is structured to take it:
`server/src/providers/signal/ofcom.ts` reads a dataset today and a
postcode-keyed source would drop straight in.

---

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
| `RESEND_API_KEY` | Email two-factor, and the escalation email when a provider stays down |

**Admin portal → Service status** lists all 27 probes — 26 integrations plus
the demo-data engine — with exactly what each is waiting for. That is the
authoritative view, not this table.

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

Ordered by what I think buys the most. Estimates are rough.

### Strong candidates

**Zen `indirect-changeservice` — half a day.** The scope is already in your
`ZEN_SCOPES` and no endpoint calls it. This is the regrade job: moving a line
from 80/20 to FTTP 500. Currently a portal task, and the single largest
remaining "why am I logging into Zen" gap.

**Bulk lookup — one day.** Paste a column of postcodes, UPRNs or CLIs, get a
CSV back with availability, best speed and lines for each. The per-premises
report is excellent for one site and useless for a bid across forty. The
export machinery already exists.

**Watch a premises — one to two days.** A "build planned 20 Sept 2027" FTTP
row is worth nothing unless somebody remembers to look again. Save a premises,
and get told when a planned build becomes orderable or an RFS date moves. The
supervisor already runs on a schedule and Resend is wired for email.

**Nearest masts, per operator — one day.** OpenCelliD is free and gives cell
sites by location. Ofcom's area-level prediction says a constituency is fine;
"the nearest EE site is 4.2 km away across a hill" explains why this customer
is not. Genuinely useful on a mobile complaint, and it is the honest
counterweight to a figure published per constituency.

### Nice to have

**Disqualified officers — half a day.** Companies House publish a
disqualified-officers API, free on the same key. A director you are about to
give credit to being disqualified is exactly the kind of thing this panel
exists to surface.

**Other companies at this premises, and elsewhere.** The officer records
already carry an appointments count and a link. Following it would show the
other companies a director runs — useful when a customer dissolves one company
and reappears as another at the same address.

**Fault SLA countdown.** Fault records carry `slaTarget` and `committedAt` and
neither is shown as time remaining. A "4h 20m left on this SLA" chip on the
faults board is small and would get looked at every day.

**Print a site report to PDF.** There is a Print button and browser print
styling, but no proper one-page PDF for attaching to a quote.

### Cool, lower value

**A command palette.** Ctrl-K to jump to a premises, a line, a fault. For
someone living in this all day it would be faster than the mouse.

**Teams or Slack alerts for MSOs that touch your customers.** The network
status board knows about outages and the lines table knows whose they are;
crossing the two and posting to a channel would mean nobody finds out from the
customer first.

**A dark theme.** Cosmetic, and this is a tool people stare at for hours.

---

## Part 4 — State of the thing

- **26 integration probes** on the admin status board (27 including the
  internal demo-data engine), each saying what it is waiting for. Ten vendors:
  Zen, Giacom, BT, Jola, Ofcom, Ordnance Survey, Companies House,
  postcodes.io, thinkbroadband and Resend.
- **184 tests** (51 shared, 133 server), plus a `check:secrets` guard that
  fails the build if a credential ever lands in `.env.example`.
- **A self-test on every boot** — 28 checks, read-only, results on the admin
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
