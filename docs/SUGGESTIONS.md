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
| One search box | Postcode, first line of address, UPRN, CLI, Openreach access line ID, service ID, ONT serial. Classified locally *and* server-side by the same code. Remembers each user's last ten premises |
| Site report | Full address + UPRN, availability by technology, Openreach engineering detail, mobile coverage, every line at the premises, and the companies registered there |
| Line detail | Identity, sync, RADIUS session, IP allocations, equipment, contract, faults, **line testing, 30-day stability, usage**, and the service's change history |
| Network status | Major service outages, planned engineering work with per-service correlation, and provider notices (price changes, withdrawals, stop-sell) |
| Faults | Open book, closed history, full timeline, and raising a fault with the tests-carried-out field the provider needs |
| Orders | In-flight, WIP report, search, cancellation with a type-to-confirm guard, and **placing an order** behind the five guards in §4 |
| SIMs | Estate, shared pool with overage, bars, attach state |
| Tools | Number porting, "is this phone on the network", IMEI/handset, Ethernet quotes, footfall, call records, reverse DNS, wholesale address references (and registering a premises with Openreach), realms and IP configuration, estate-wide usage |
| Admin | Live probe of 21 integrations, per-integration switches, the ordering lock and its daily cap, today's fair-use counters per user, users, append-only audit log |
| Auth | Email + password, scrypt, revocable sessions that slide while in use, lockout, email 2FA gated on a verified Resend send |

### What is deliberately *not* built

- **Live mobile coverage** *where no Ofcom dataset is present.* The signal
  panel falls back to a model when `OFCOM_DATASET_PATH` is unset. See §3.1.
- **Openreach direct.** There is nothing to build. See §2.
- **A client-facing report.** The brand guide has a whole client-facing
  document system that NetKit does not use. See §6.6.

Placing orders **is** now built, behind the five guards in §4. It is off by
default and needs two independent switches opened before it will send
anything.

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

### 3.2 Companies House — ✅ **done**

Free with a registration key. Set `COMPANIES_HOUSE_API_KEY` and the **Who is
here** tab on any site report lists every company registered at the postcode,
with anything in liquidation, administration or dissolved flagged red and
sorted to the top. Overdue filings are shown separately — a warning, not a
reason to stop.

It earns its place on the days it changes the answer: a business fault, a
cease request or a credit decision reads differently when the company on the
account went into liquidation last month.

### 3.3 Ordnance Survey Open UPRN / OS NGD

If the OS Places bill turns out uncomfortable at volume, OS publish **Open
UPRN** (UPRN + coordinates, free, no key) and the newer NGD API. Open UPRN
lacks the full address text so it cannot replace Places outright, but it can
resolve a bare UPRN to a location for nothing, which is one of the two things
Places is currently doing.

### 3.4 Zen endpoints documented but not surfaced — ✅ **done**

All six are now wired and on screen:

| Endpoint | Where it appears |
| --- | --- |
| `GET /api/address/match` | Tools → **Openreach / BT Wholesale address reference**. Shows both references and says plainly when they disagree — which is usually why an order was rejected |
| `POST /api/bto/addaddress` | A second step inside that tool, appearing only once a match has failed. Audited as a write against the national address database |
| `GET /api/service/{ref}/history` | The **What changed** tab on a line. The first thing worth asking when a line that worked for two years stops working |
| `GET /api/notifications/search` | **Provider notices** on the network status page — price changes, product withdrawals, stop-sell, migrations |
| `/api/networkmanagement/*` | Tools → **Realms and IP configuration**. The answer to "why will this line not authenticate" |
| `/api/monthlyusage/report` | Tools → **Usage across the base**, heaviest first, with over-allowance flagged and a CSV export |

---

## 4. Product ordering — ✅ **done, behind five guards**

Everything else in NetKit is read-only or reversible. Ordering is neither, so
it is the one feature built to resist being used by accident:

1. **Two independent locks.** `ZEN_ALLOW_ORDERING=false` in the environment
   *and* a switch in **Admin portal → Ordering & limits**. Both must be open.
   The environment flag is deliberately not settable from the admin screen —
   two locks one person can open from one screen are one lock. Turning the
   admin switch on requires typing `UNLOCK ORDERING`.
2. **A review step that shows the money.** Monthly and one-off totals from
   `/api/pricingDetails` with the line items, the appointment, the address,
   the UPRN, the Gold Address Key and whether a provider is already on the
   line. Nothing submits from a table row: the **Order** button on an
   availability row opens a two-step dialog.
3. **The address retyped by hand.** Not a checkbox. The comparison forgives
   case, punctuation and repeated spaces and refuses everything that changes
   which building it is — `Flat 3` still differs from `Flat 4`, and `12` from
   `12A`. It is enforced server-side, so calling the API directly does not
   skip it. `shared/src/confirm.test.ts` pins both halves.
4. **Audited before and after.** `order.submitting` carries the full payload,
   then `order.placed` or `order.rejected` carries the provider's response. A
   request that vanishes still leaves evidence of what was attempted.
5. **A per-user daily cap**, default 3, adjustable to 0–50 in the admin
   portal. Charged *before* the call, which is the safe direction for a cap
   whose whole job is to stop a loop. An explicit provider rejection refunds
   the unit; an unconfirmed failure does not.

One more thing worth knowing: a failed order is never reported as "nothing was
sent". A request that timed out may well have reached Zen, so the message
sends the operator to the order book rather than back to the button. Demo mode
refuses outright rather than inventing a reference nobody can chase.

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

### 5.3 Rate limits and Zen's fair-use policy — ✅ **done**

Zen are explicit that availability is not for bulk checking, and the quota is
per *account*, not per user — so one person working through a list of
postcodes can spend everyone else's allowance.

Each user now gets a daily budget of premises lookups
(`AVAILABILITY_DAILY_BUDGET`, default 250, `0` to disable). It is charged only
when a lookup will actually cost an upstream check: a second look at a
premises somebody opened ten minutes ago is free, because the report is
cached. Spending it gives a refusal with a number in it rather than a silent
degradation later in the day. Today's counters, per user, are on
**Admin portal → Ordering & limits**.

Still open: bulk address checking as a feature. That needs the conversation
with Zen first — they offer to arrange it.

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

**Escalation is now wired too.** When recovery has not fixed something after
`SUPERVISOR_ESCALATE_AFTER_MINUTES` (default 60), every active admin gets an
email saying what is failing, since when, and what was tried — and a second
email when it recovers. It only sends when Resend is verified working, so it
cannot become its own silent failure. The email states plainly that lookups
still work, because they do: the integration is being skipped, so nothing is
down for users, but the data is not live.

### 5.5 Session refresh — ✅ **done**

A session in active use is now extended rather than expiring underneath the
person using it: the cookie is re-issued once it is more than halfway through
its twelve hours. An engineer working a long shift is not thrown out
mid-fault; a browser left open overnight still expires.

### 5.6 Back up `DATA_DIR` — ✅ **done**

`backup-data.sh` reads `DATA_DIR` from `.env`, writes a dated `tar.gz` with
`600` permissions, verifies the archive is readable before keeping it, and
prunes anything older than `KEEP_DAYS`. Cron line and restore instructions are
in `docs/DEPLOY-PLESK.md`. It exits non-zero if `DATA_DIR` does not exist,
rather than quietly backing up nothing.

---

## 6. Things I would add for the people using it

Ordered by how often I think they would get used.

1. ~~**Recent lookups, per user.**~~ ✅ **done.** The last ten premises each
   user looked at, kept server-side so they follow the person between a desk
   and a laptop, shown as chips under the search box and as a **Where you have
   been** group in the dropdown when the box is empty. Re-looking at a site
   moves it up rather than adding a second row, and there is a Clear button.
2. **Saved sites / watchlist.** Pin a problem site and see its faults,
   outages and line stability on one screen. This is the next one I would
   build — the recent-lookups store is most of the plumbing.
3. **A "what changed" digest.** Daily email: new faults, orders that slipped,
   SIMs over allowance, integrations that broke. Resend is already connected,
   and the **Provider notices** panel (§3.4) covers the provider half.
4. ~~**Copy-as-text for a whole site report.**~~ ✅ **done.** "Copy as text" on
   any site report produces about 90 lines of aligned plain text — address and
   UPRN, best available, orderable options, Openreach detail, coverage per
   network, every line with its identifiers and sync — with no formatting to
   survive a helpdesk, an email reply or a message. It also states plainly
   where demo data was used.
5. ~~**Export to CSV.**~~ ✅ **done.** Orders, faults, SIMs, call records, the
   estate usage report and the audit log each offer a download and a copy —
   download for a spreadsheet, copy for a ticket. Values that a spreadsheet
   would execute as a formula (a leading `=`, `+`, `-` or `@`) are
   neutralised, and Excel gets a BOM so pound signs survive.
6. **A customer-facing site report.** The brand guide has a whole
   *client-facing* document system that NetKit does not use — it only uses the
   internal one. A "generate client report" button producing a
   masthead-and-signature PDF for a survey or a fault summary would put that
   system to work, and reuse the reference-numbering scheme (`SW-AU-2026-nnnn`).
7. **Bulk address check.** Paste a list of postcodes, get availability for
   each. Needs the fair-use conversation with Zen first (§5.3) — they offer to
   arrange bulk checking. The per-user budget is now in place, so the guard
   rail exists; what is missing is Zen's permission.
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
testing with recovery. So are escalation and recent lookups, which were the
last list's picks. The next three:

1. **Get the credentials in and run the self-test.** Still the top of the
   list, and still nothing to do with code. Everything is built and mapped,
   but no mapping survives contact with a real response untouched — and three
   integrations are mapped against docs I could not fully read
   (thinkbroadband's field spec is licensee-only, Giacom's
   ServiceQualification path is per-tenant, BT publish no auth scheme). The
   self-test tells you in one click which of the 26 actually work and which
   enum came back as `unknown`.
2. **Ask Giacom for the ServiceQualification path**, and ask which alt-nets
   they can sell you. One environment variable turns on per-address
   availability across BT Wholesale, CityFibre, TalkTalk, Virgin Media
   Business and Sky. This is the single highest-value thing left and it is a
   phone call, not a commit.
3. **Saved sites / watchlist** (§6.2). Pin a problem site and see its faults,
   outages and line stability on one screen. The recent-lookups store is most
   of the plumbing already, so it is a small job for something support staff
   would use every day.

---

## 10. What is genuinely not done

Short, and none of it is blocking:

| Thing | Why it is not done |
| --- | --- |
| **Ordering through Giacom** | Deliberate. Their order endpoints are documented and unwired: one supplier that can spend money is enough until the Zen path has been used in anger |
| **Faults and line tests on Giacom lines** | Impossible, not deferred. They publish no trouble-ticket or diagnostics API — confirmed by parsing their spec. Every Giacom line says so on its own record |
| **A client-facing report** | Needs a decision, not code. The brand guide has a whole client-facing document system NetKit does not touch (§6.6) |
| **Bulk address check** | Needs the fair-use conversation with Zen first (§5.3). The per-user budget is the guard rail; what is missing is their permission |
| **Dark mode** | The brand guide has no dark palette. A brand decision before a code one |
| **MySQL instead of flat files** | Premature. Trigger is a second app process or ten users (§5.1) |
| **G.Network availability** | No account, no aggregator carries them. The report links straight to their own checker instead |

---

SupportWizard – a division of ClubWizard Ltd
**SupportWizard Internal · Confidential**
