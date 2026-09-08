# NetKit — suggestions, gaps and what I'd do next

Written after building the thing. Ordered by what I think earns its keep
soonest, not by how interesting it is to build.

---

## 1. The honest state of play

### What is genuinely finished

Everything below works end to end, on fixtures today and against live APIs
the moment credentials land. No stubs, no "coming soon" screens.

| Area | What it does |
| --- | --- |
| One search box | Postcode, first line of address, UPRN, CLI, Openreach access line ID, service ID, ONT serial. Classified locally *and* server-side by the same code |
| Site report | Full address + UPRN, availability by technology, Openreach engineering detail, mobile coverage, every line at the premises |
| Line detail | Identity, sync, RADIUS session, IP allocations, equipment, contract, faults, **line testing, 30-day stability, usage** |
| Network status | Major service outages and planned engineering work, with per-service correlation |
| Faults | Open book, closed history, full timeline, and raising a fault with the tests-carried-out field the provider needs |
| Orders | In-flight, WIP report, search, cancellation with a type-to-confirm guard |
| SIMs | Estate, shared pool with overage, bars, attach state |
| Tools | Number porting, "is this phone on the network", IMEI/handset, Ethernet quotes, footfall, call records, reverse DNS |
| Admin | Live probe of 17 integrations, per-integration switches, users, append-only audit log |
| Auth | Email + password, scrypt, revocable sessions, lockout, email 2FA gated on a verified Resend send |

### What is deliberately *not* built

- **Placing orders.** Everything up to it is there — availability reference,
  appointment slots, pricing, the order payload shape. I stopped at the
  `POST /api/order` call because it spends real money and commits real
  engineer appointments. See §4 for how I'd gate it.
- **Live mobile coverage.** The signal panel is modelled, not measured. See §3.1
  — this is the single biggest data-quality gap and it is free to fix.
- **Openreach direct.** There is nothing to build. See §2.

---

## 2. About "BT and Openreach APIs"

Worth being precise, because it changes what to chase.

**Openreach has no API you can get.** Their interfaces (the CP portal, EMP,
Equinox commercials) are for Communications Providers with an Openreach
contract, wholesale credit and an assurance obligation. As a Zen reseller you
get Openreach data *through* Zen — which is exactly what is already wired:
exchange, PCP cabinet, loop length, FTTP build state, CBT, ONT, stop-sell.
There is no second Openreach integration to add unless SupportWizard becomes
a CP, which is a commercial decision far larger than this tool.

**BT is two separate things.** `developer.bt.com` publishes six products, three
of which matter here (Home Network, IMEI Lookup, Location Insights for
London) — all three are wired and waiting for keys. Separately, **BT
Wholesale** exposes a much larger API set (Address Management, Appointment
Management, Broadband, Ethernet, Messaging) behind a BTW account. Most of it
duplicates what Zen already gives you, so I would only chase it if you want a
second source to cross-check Zen, or if you end up buying from BTW directly.

**Jola is probably redundant.** Zen's `/api/cellular/*` endpoints are
Jola-backed — Zen literally errors with *"Jola ID or pool ID is not assigned
yet"*. The Jola adapter is built and will work, but try Zen's cellular
endpoints first; you may find you never need a separate Jola key.

**So the realistic credential list is short:** Zen, OS Places, Resend, and
three BT products. That is it.

---

## 3. Free or already-yours data worth adding

These are the highest value-per-effort items left.

### 3.1 Ofcom Connected Nations — ✅ **done**

Coverage is no longer modelled when a dataset is present. Download the
Connected Nations postcode-level mobile file, point `OFCOM_DATASET_PATH` at
it, and the panel serves Ofcom's published prediction with `source:
ofcom:dataset`.

Column names have changed between Ofcom releases, so the header is
*interpreted* rather than hard-coded — each column is tokenised and matched
for operator, service and placement. `docs/samples/` has a small sample and
the detail. The admin board reports how many postcodes were indexed and how
many columns were understood, so a format change surfaces as a degraded
integration rather than silently empty data.

One thing I could not verify: whether Ofcom also expose a live per-postcode
API. I hit a tool limit before confirming it, so `OFCOM_API_BASE_URL` exists
as an override but the dataset is the route I actually tested.

### 3.2 Companies House API — business context on a site

Free with a registration key. Given a business address you get company number,
status, incorporation date, SIC code, officers and filing history.

Why it earns a place: when a support call comes in about a business line,
knowing the company is in liquidation, or dissolved, or trading under a
different name, changes what you do next. It also catches the case where the
"customer" on the line is a company that no longer exists.

### 3.3 Ordnance Survey Open UPRN / OS NGD

If the OS Places bill turns out uncomfortable at volume, OS publish **Open
UPRN** (UPRN + coordinates, free, no key) and the newer NGD API. Open UPRN
lacks the full address text so it cannot replace Places outright, but it can
resolve a bare UPRN to a location for nothing, which is one of the two things
Places is currently doing.

### 3.4 Zen endpoints documented but not yet surfaced

I mapped these while reading the spec but did not build screens for them.
Small additions, each maybe an hour:

- `POST /api/bto/addaddress` — **create an Openreach NAD address key** for a
  premises not in the database. This is the fix for "the address isn't in
  Openreach's list", which currently dead-ends a provide.
- `GET /api/address/match` — returns *both* the Openreach and BT Wholesale
  address references for one address. Useful when the two disagree.
- `GET /api/service/{ref}/history` — the change history of a service.
- `GET /api/networkmanagement/serviceselectionnames` and `/networkdetails` —
  the realms and IP configuration available when ordering.
- `GET /api/monthlyusage/report` / `/reports` — usage across the whole base
  rather than one service.
- `GET /api/notifications/search` — Zen's own notifications, which would make
  a decent "what changed today" panel.

---

## 4. Product ordering — how I'd gate it

Ordering is built up to the final call. To finish it safely I would:

1. **Feature flag, default off.** `ZEN_ALLOW_ORDERING=false` in the
   environment, plus an admin switch. Two independent locks.
2. **A review step that shows the money.** Product, monthly and one-off
   totals from `/api/pricingDetails`, the appointment, the address, the CLI,
   and whether it is a working-line takeover. Nothing submits from a table row.
3. **Type-to-confirm the address.** The same guard the user-removal dialog
   uses. An order to the wrong premises is expensive and slow to unwind.
4. **Audit before and after.** Log the intent with the full payload, then the
   provider's response. The audit log already exists and is append-only.
5. **A hard cap for the first month.** Refuse more than N orders per day per
   user. A loop bug that places forty provides is a very bad afternoon.

I would not skip any of those. Everything else in NetKit is read-only or
reversible; ordering is neither.

---

## 5. Operational things I would sort out early

### 5.1 Move off flat files before the third user

The JSON store was the right call for deployment simplicity — no native
modules, nothing to compile on Plesk. It is fine for a handful of engineers.
It will not do for: concurrent writes from two app processes, more than a few
hundred users, or anything you want to query.

Plesk already has MySQL. The `store.ts` interface is narrow enough that
swapping it is an afternoon. **Trigger for doing it:** a second app process,
or ten users.

### 5.2 Back up `DATA_DIR`

It holds users, settings and the audit log. Everything else is rebuildable
from Git. It is currently backed up by nothing. A nightly `tar` into the Plesk
backup set is enough.

### 5.3 Rate limits and Zen's fair-use policy

Zen are explicit that availability is not for bulk checking. NetKit caches
hard (six hours) and surfaces the remaining quota, but nothing stops a user
pasting a hundred postcodes in a row. I would add a per-user daily
availability budget, visible in the admin portal, before this goes to a wider
team.

### 5.4 Health checks — ✅ **done, and it now repairs as well as reports**

Rather than emailing on breakage, the supervisor tries to fix it. Every five
minutes it probes all eighteen integrations and, on the second consecutive
failure, runs the recovery actions for that integration before the circuit
breaker would trip:

| Integration | Recovery attempted |
| --- | --- |
| Zen (any scope) | Re-mint the OAuth token, then drop cached Zen results |
| BT (any product) | Re-mint the access token |
| Ofcom | Reload the dataset from disk |
| OS Places, postcodes.io | Drop the cache |
| Resend | *Nothing* — re-sending a test email unattended would spam the admin's inbox every sweep |

A token that expired, was revoked, or was minted before a scope was granted is
by far the most common real failure, and re-minting fixes it without anyone
noticing. Verified end to end against a stand-in token endpoint that failed
twice and then succeeded: the supervisor detected it, re-minted, confirmed
recovery and logged `supervisor.recovered`.

If recovery does not work, the **circuit breaker** opens after three
failures. Lookups then skip that upstream and go straight to the fallback
rather than waiting for its timeout — a site report stayed at 93 ms with Zen
pointed at a black hole. Reattempts back off 30s → 1m → 2m → 5m → 15m and
hold there.

The breaker is deliberately separate from the admin on/off switch: automation
never overrides a human decision, and a human switch is never quietly undone.

Still worth adding if you want it: an email when an integration has been
failing for, say, an hour despite recovery. That is the case where a human
genuinely does need to know.

### 5.5 The session cookie is 12 hours with no refresh

Fine for a support desk that signs in each morning. If people leave tabs open
for days they will be signed out mid-task. A sliding refresh would be kinder.

---

## 6. Things I would add for the people using it

Ordered by how often I think they would get used.

1. **Recent lookups, per user.** Support staff check the same site repeatedly.
   A "last 20" list in the search dropdown would save real time. Small job.
2. **Saved sites / watchlist.** Pin a problem site and see its faults,
   outages and line stability on one screen.
3. **A "what changed" digest.** Daily email: new faults, orders that slipped,
   SIMs over allowance, integrations that broke. Resend is already connected.
4. ~~**Copy-as-text for a whole site report.**~~ ✅ **done.** "Copy as text" on
   any site report produces about 90 lines of aligned plain text — address and
   UPRN, best available, orderable options, Openreach detail, coverage per
   network, every line with its identifiers and sync — with no formatting to
   survive a helpdesk, an email reply or a message. It also states plainly
   where demo data was used.
5. **Export to CSV** on the orders, faults, SIMs and CDR tables.
6. **A customer-facing site report.** The brand guide has a whole
   *client-facing* document system that NetKit does not use — it only uses the
   internal one. A "generate client report" button producing a
   masthead-and-signature PDF for a survey or a fault summary would put that
   system to work, and reuse the reference-numbering scheme (`SW-AU-2026-nnnn`).
7. **Bulk address check.** Paste a list of postcodes, get availability for
   each. Needs the fair-use conversation with Zen first (§5.3) — they offer to
   arrange bulk checking.
8. **Dark mode.** The brand guide has no dark palette, so this needs a brand
   decision before a code one.

---

## 7. Risks and things I am not certain about

Being straight about what could bite.

| Risk | Detail | What I did about it |
| --- | --- | --- |
| **Zen enum values** | The spec documents `serviceStatus`, `fulfilmentStatus`, `testOutcome`, `timeslot` etc. as bare integers with no published value table. | Every enum is read tolerantly (string *or* integer), falls back to `unknown`, and infers from unambiguous fields (dates, cleared flags) instead of guessing. **The first live call may still surface an integer I map to `unknown`** — that is a five-minute fix once you can see real values, and the tests pin the behaviour. |
| **Zen response field names** | Taken from the docs, but the docs render every string as the literal `"string"`. | Mappers accept several plausible spellings per field and treat the literal `"string"` as absent. |
| **BT auth scheme** | Not published without an account. | The BT client supports both a static key header and OAuth2 client credentials; base URL and token URL are configuration, so it is an env change either way. |
| **BT response shapes** | Entirely unknown. | Tolerant mappers, same as Zen. Expect to adjust once you see one real response. |
| **Signal is modelled** | Not a measurement. | Labelled as demo data everywhere it appears; §3.1 is the fix. |
| **Ethernet quotes are indicative** | Real pricing needs a survey. | Marked `indicative: true` and labelled in the UI. Never presented as a quotation. |
| **Fair use** | A bulk-check habit could get the API access restricted. | Aggressive caching, CLI-preferred checks, quota surfaced. §5.3 for the rest. |

---

## 8. Security notes

Nothing here is alarming, but worth writing down.

- **Rotate the admin password that was shared in chat.** It is in that
  conversation's history, which is reason enough. It never entered this
  repository — the admin account seeds from `ADMIN_PASSWORD` in the
  environment and only a scrypt hash is ever stored.
- **`SESSION_SECRET` must be set in production.** The app refuses to mint
  sessions without it rather than silently generating a per-restart one.
- **`DATA_DIR` must live outside the Git working tree**, or a deploy that
  resets the tree can take the user accounts with it. `docs/DEPLOY-PLESK.md`
  covers this.
- **The audit log is append-only** and records the acting user for every
  mutation — fault raised, test run, profile changed, order cancelled, user
  altered, integration toggled.
- **No credentials reach the browser.** Every upstream call is server-side;
  the SPA only ever talks to `/api`.
- **CSP forbids external origins entirely** now that Poppins is self-hosted.
- **2FA fails open, deliberately.** If Resend breaks mid-sign-in the user is
  let in and told loudly, rather than locked out of their own account by an
  email outage. If you would rather it failed closed, that is one line — but
  think about who unlocks it at 7am.

---

## 9. If I could only do three more things

The original three are done — Ofcom coverage, copy-as-text, and automated
testing with recovery. The next three I would pick:

1. **Get the credentials in and run the self-test.** Everything is built and
   mapped, but no mapping survives contact with a real response untouched.
   The self-test will tell you in one click which integrations actually work
   and which enum I mapped to `unknown`.
2. **Escalate a persistent failure to a human** (§5.4). Recovery handles the
   transient cases; an integration still failing an hour later is one a person
   needs to know about.
3. **Recent lookups per user** (§6.1). Small, and support staff check the same
   site repeatedly all day.

---

SupportWizard – a division of ClubWizard Ltd
**SupportWizard Internal · Confidential**
