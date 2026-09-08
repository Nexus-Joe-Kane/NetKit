# Upstream API reference

Distilled from the official docs. This is the contract the adapters in
`server/src/providers/` are written against.

---

## Zen Internet — Indirect Self Service + Assurance API

**Auth — OAuth 2.0 client credentials**

| Item | Value |
| --- | --- |
| Token endpoint | `https://id.zen.co.uk/connect/token` |
| Method | `POST` |
| `Authorization` header | `Basic base64(client_id + ":" + client_secret)` |
| `Content-Type` | `application/x-www-form-urlencoded;charset=UTF-8` |
| Body | `grant_type=client_credentials&scope=<scope>` |
| Response | `{ access_token, token_type, expires_in, refresh_token: null }` |

Credentials come from your Zen account manager. **Scope is requested at token
time**, so tokens are cached per scope, not globally.

**Base URLs**

| API | Base URL |
| --- | --- |
| Self Service | `https://gateway.api.indirect.zen.co.uk/self-service` |
| Assurance | `https://gateway.api.indirect.zen.co.uk/assurance` |

**Scopes**

`indirect-availability`, `indirect-service`, `indirect-order`,
`indirect-placeorder`, `indirect-changeservice`, `indirect-customerengagement`,
`indirect-broadbandconnection`, `indirect-cdr`, `indirect-diagnostics`,
`indirect-faults`, `indirect-quote`

### Endpoints this portal uses

**Address & availability** (`indirect-availability`)

- `GET /api/address/search?request.postCode=` — every premises at a postcode.
  Returns `address`, `addressReference{qualifier, addressReferenceNumber,
  districtCode, uprn, parentUPRN}`, `coordinates{easting, northing}`,
  `addressClassification{classificationCode, classificationDescription,
  premiseType, historicSite}`.
  **`addressReferenceNumber` is the Gold Address Key** — required for orders.
- `GET /api/address/match?request.postCode=&request.postTown=&request.premiseName=&request.thoroughFareNumber=`
  — resolves a ROBT address, returning both `btoAddressReference` (Openreach)
  and `btwAddressReference` (BT Wholesale).
- `POST /api/bto/addaddress` — creates an Openreach NAD address key for an
  address not already in the database. Returns `technologyRestrictions[]`.
  Surfaced as a second step inside the address-reference tool: it only appears
  once a match has failed, and it is audited as a write against the national
  address database.
- `POST /api/availability/check` —
  body `{ phoneNumber, goldAddressKeyAvailabilityRequest: { addressReferenceNumber, districtCode }, uprn }`.
  If both CLI and address are supplied, **the CLI check wins** (it is more accurate).

  Response carries:
  - `availabilityReference` — **required to place an order or fetch appointments**
  - `broadbandGroups[].products[]` — `productCode`, `productName`, `isOrderable`,
    `isOrderableDescription`, `provisionType`, `minimumActivationDate`,
    `installationLines[]` (with `accessLine{accessLineId, lineNumber, lineType}`
    and `ontDetail{serialNumber, reference, location{floor,room,position}, ports[]}`),
    `requirements[]`, `allowedAppointmentTypes[]`
  - `lineDetails.fttc / sogea / fttp / gFast / adsl2Plus / adsl2PlusAnnexM / ipStreamMax`
    — each with `rag`, `ragDescription`, `mdfSiteId`, `mdfSiteName`,
    exchange name/code, `readyDate`, and Range A / Range B top+bottom
    up/down speeds (both string and `…Value` numeric forms)
  - `lineDetails.lineCharacteristics` — `btOpenreachPostCode`,
    `btWholesalePostCode`, **`pcpId`** (cabinet), **`lineLength`**,
    **`cpName` / `spName`** (the communications/service provider currently on the line)
  - `ontDetails[]`, `accessLines[]`, `addressReference`
  - `availabilityInformation.messages[]` — `severity`, `category`, `description`, `errorCode`
  - `remainingAvailabilityChecks` — **fair-use quota**

  > Zen's fair-use policy: this endpoint is **not** for bulk checking. The
  > portal therefore caches aggressively and surfaces the remaining quota in
  > the admin portal. Bulk checks must be arranged with your account manager.

- `GET /api/appointments?request.availabilityReference=&request.productCode=&request.goldAddressKey=&request.districtCode=&request.appointmentType=`

**Services** (`indirect-service`)

- `GET /api/services/search?searchCriteria.searchTerm=` — **matches on
  ZenReference, Postcode, ServiceId and PhoneNumber.** This is the primary
  "find an existing line" endpoint.
- `GET /api/service/{zenReference}` — full service record:
  `serviceStatus`, `serviceId`, `phoneNumber`, `productCode`,
  `connectionTechnology`, `faultState`, `careLevel`, `trafficWeighting`,
  `exchangeCode`, `installationAddress` (incl. `uprn`,
  `addressReferenceNumber`, `districtCode`), `contractEndDate`,
  `accessLineId`, `ontReference`, `port`, `supplier`,
  `cellularDetails{iccId, phoneNumber, boltOns[]}`, `events[]`
- `GET /api/service/{zenReference}/history`
- `GET /api/ceases/search?searchCriteria.searchTerm=` — matches ZenReference,
  Postcode, ServiceId, PhoneNumber. Finds **ceased** lines.

**Broadband connection** (`indirect-broadbandconnection`)

- `GET /api/broadbandconnections/{zenReference}` — `username`, `password`,
  `iPv4AddressRange`, `numberOfIps`, `startAddress`, `endAddress`,
  `subnetMask`, `routerIpAddress`, `supplier`
- `GET /api/connectionstatus/{zenReference}` — `connectionStatus{connected,
  uptime, gateway}` plus credentials
- `GET /api/connectionstatuses` — bulk: `{zenReference, username, connected, lastdisconnection}`
- `GET /api/cellular/usages` — SIM + pool usage. **Backed by Jola** — returns
  `503` with "Jola ID or pool ID is not assigned yet" when unlinked.
- `GET /api/cellular/sims?status=`
- `GET /api/cellular/{zenReference}/connection-details`

**Diagnostics / line testing** (`indirect-diagnostics`) — Assurance API

- `GET /api/copper/services/{zenReference}/linetest/latest` — `mainFaultLocation`, `testOutcome`, `state`
- `GET /api/copper/services/{zenReference}/tamtest/latest` — `modem`, `dsl`, `atm`, `ppp`, `testOutcome`, `additionalText`
- `GET /api/copper/services/{zenReference}/xdsltest/latest`
- `GET /api/copper/services/{zenReference}/kbdtest/latest`
- `POST /api/copper/services/{zenReference}/{testType}` — run a test
- `GET /api/copper/services/check-available-test-types/{zenReference}`
- `GET /api/copper/services/profileoptions`, `POST /api/copper/services/requestprofilechange`
- `GET /api/fttp|sogea|fibre|altnet/services/{zenReference}/latest` and `/{testType}`
- `GET /api/drops-over-time/{zenReference}`, `GET /api/radius-proxy-logs/{zenReference}`
- `GET /api/authentication-attempts/{zenReference}`

**Faults** (`indirect-faults`) — Assurance API

- `GET /api/fault/{zenReference}`, `GET /api/faults/open`, `GET /api/faults/recentlyclosed`
- `POST /api/fault/{synchronisation|performance|authentication}/{intermittent|permanent}`
- `POST /api/fault/{faultReference}/update`

**Outages** — Assurance API

- `GET /api/major-service-outages`, `/past`, `/{reference}`, `/zenreference/{zenReference}`
- `GET /api/planned-engineering-work`, `/past`, `/{reference}`

**Ordering** (`indirect-placeorder` / `indirect-order`)

- `POST /api/order` — needs `availabilityReference`, `productCode`,
  `installationDetails{goldAddressKey, districtCode, uprn, address, phoneNumber}`,
  optional `appointment`, `broadbandCredentials`, `ontDetails`, `accessLineId`,
  `workingLineTakeover`, `contractTerm`
- `GET /api/pricingDetails`, `GET /api/orders/search`, `GET /api/orders/status`, `GET /api/orders/WipReport`
- `POST /api/orders/{zenReference}/Cancel`

> `POST /api/order` is wired and reachable, but behind five guards:
> `ZEN_ALLOW_ORDERING` in the environment, the admin-portal switch, a per-user
> daily cap, the installation address retyped by hand, and an audit line
> written *before* the call as well as after. A failed call is never reported
> as "nothing was sent" — a request that timed out may well have reached Zen,
> so the wording sends the operator to the order book rather than to the
> button again.

**Service changes and history** (`indirect-service`)

- `GET /api/service/{ref}/history` — every recorded change to a service.
  Surfaced as the **What changed** tab on a line.
- `GET /api/monthlyusage/report`, `GET /api/monthlyusage/reports` — usage
  across the whole base, and the periods available. Surfaced under Tools.

**Network management** (`indirect-broadbandconnection`)

- `GET /api/networkmanagement/serviceselectionnames` — the realms on offer.
- `GET /api/networkmanagement/networkdetails?request.zenReference=` — how one
  service is actually configured. The detail payload is a flat bag whose keys
  differ by product, so it is rendered as label/value pairs rather than being
  forced into a shape.

**Notifications** (`indirect-customerengagement`)

- `GET /api/notifications/search` — price changes, product withdrawals,
  stop-sell and migration notices. Surfaced as **Provider notices** on the
  network status page. Severity is documented as a bare integer, so it is read
  as string-or-integer and falls back to `unknown`.

**Number porting** (`indirect-availability`)

- `POST /api/numberPort/availability` — `{phoneNumber, exchangePrefix, cupid}` → `{reference, canBePorted}`
- `GET /api/numberPort/availability/{reference}` — `202` while in progress, `200` when done

**Other**

- `GET /api/calls/cdrs?query.fromDateCreated=&query.toDateCreated=` (`indirect-cdr`) — max **2-day** window
- `GET /api/quotes/ethernet` (`indirect-quote`)
- `GET /api/rdns`, `GET /api/rdns/{zenReference}`
- `GET /api/usage/{zenReference}`, `/api/dailyusage/{zenReference}`, `/api/monthlyusage/current/{zenReference}`
- `GET /api/networkmanagement/rids/default`, `/serviceselectionnames`, `/networkdetails`

**Supplier enum:** `All=0, Openreach=1, BTWholesale=2, CityFibre=3`

---

## BT — developer.bt.com

Products actually listed on the portal today:

| Product | Category | What it does | Wanted for |
| --- | --- | --- | --- |
| **Home Network** | Digital Identity | Verifies a customer phone's connection to EE's network | "is this phone connected to the network" |
| **IMEI Lookup** | Digital Identity | Retrieves the IMEI for an associated MSISDN | IMEI lookup |
| **Location Insights for London** | Location Data | Footfall activity and visitor catchments, London only | footfall / location insights |
| **Rail Insights** | Location Data | Demand on the UK rail network | — |
| **Broadband One** | Data Services | Places Broadband One orders into The Hub | — |
| **Global Voice Services** | Global Voice | Orders phone numbers for Global Voice | — |

`developer.bt.com/api-documentation` additionally indexes **BT Wholesale**
APIs (Broadband, Voice, Ethernet, Messaging — including Address Management and
Appointment Management). Those sit behind a BT Wholesale account rather than
the public developer portal.

Auth scheme is not published without an account, so the BT adapters here are
config-driven in exactly the same way as Zen's: set the base URL, token URL
and credentials and they come alive.

---

## Jola — Mobile Manager

`https://developers.mobilemanager.co.uk/Help` — business SIM estate
management. Note that **Zen's `/api/cellular/*` endpoints are Jola-backed**,
so SIM data may be reachable through the existing Zen credentials without a
separate Jola integration.

---

## Companies House

`https://developer.company-information.service.gov.uk/` — free with a
registration key.

- `GET /advanced-search/companies?location=<postcode>&size=40` — every company
  registered at a postcode.
- `GET /company/{number}` — one company. Used by the health probe, against
  Companies House's own company number (`00000006`), which will always exist.

Auth is **HTTP Basic with the API key as the username and an empty password**,
which is unusual enough to be worth stating plainly.

Statuses treated as concerning — flagged red and sorted to the top —
are `liquidation`, `receivership`, `administration`, `voluntary-arrangement`,
`insolvency-proceedings`, `dissolved`, `converted-closed`, `closed` and
`removed`. Overdue accounts and confirmation statements are surfaced
separately: they are a warning, not a reason to stop.

Companies are indexed by postcode rather than premises, so the ones whose
registered office postcode matches the premises being looked at are marked
**This address**.

---

## thinkbroadband — alt-net and cable coverage

`https://www.thinkbroadband.com/broadband-availability-api` — commercial data
licence, priced on enquiry.

**Why it is here.** Zen answers authoritatively for Openreach and for nothing
else. No wholesale account we hold knows about CityFibre, Virgin Media,
Community Fibre and G.Network at once. thinkbroadband aggregate availability
across the alt-nets and cable, keyed by **postcode and UPRN**, and licence the
data to the price-comparison sites. It is the one commercially obtainable
source that covers all of those networks without a separate wholesale
agreement per network.

It is a **data licence, not a carrier contract**: it tells you who *could*
serve a premises. Ordering an alt-net circuit still needs a commercial
relationship with that network, or with an aggregator.

**The response specification is not public.** The API page is behind bot
protection and thinkbroadband publish field definitions to licensees only. So
`server/src/providers/altnet/thinkbroadband.ts` is written the same way as the
Zen and BT mappers:

- Both a keyed-object shape (`{ virginmedia: {...} }`) and an array shape
  (`{ networks: [...] }`) are read, under any of several envelope names.
- Field names are matched case- and separator-insensitively, so
  `maxDownload`, `max_download` and `maxdownload` are the same field.
- An operator with no slot in `NetworkOperator` is surfaced as `other` with
  its real name kept — a new alt-net appearing is the normal case, not an error.
- Openreach rows are **skipped**, because Zen already answers for them with
  engineering detail a coverage feed cannot match.
- Anything unrecognised is ignored rather than guessed at.

`__thinkbroadbandTesting.mapPayload` is the single function to adjust once a
real response is in hand; `thinkbroadband.test.ts` pins the current tolerance,
including the traps (`BT` inside `GIGABIT`, `false` meaning not-available,
envelope fields being mistaken for operators).

### Serviceability is not availability

Every offer carries `serviceability`:

| Value | Meaning |
| --- | --- |
| `confirmed` | A provider API answered for **this address** |
| `footprint` | The network builds in this area; this address is **unchecked** |
| `unknown` | No serviceability signal at all |

A postcode-keyed aggregate is `footprint` unless the feed explicitly confirms
the premises. Footprint rows sit in their own **Other networks nearby** tab,
carry a "Not checked" chip, are excluded from the orderable count, can never
be ordered, and appear in "Copy as text" under a heading that says so. The
self-test fails if any unchecked row claims `available`.

### Other routes considered

| Route | What it gives you | Why not this first |
| --- | --- | --- |
| **Flexgrid** aggregator | 24 networks including Virgin, CityFibre, Community Fibre — and the ability to *order* | Needs partner onboarding; G.Network is not on their list |
| **CityFibre** direct | TM Forum Open APIs, well documented at `docs.cityfibre.com` | One network, needs a partner agreement |
| **G.Network** direct | Availability-checker API via their reseller programme | One network, needs a partner agreement. The only route that covers G.Network |
| **Ofcom Connected Nations** | Free, no account | Publishes gigabit-capable coverage only, with the per-operator split withheld for commercial confidentiality. Cannot name a network |

---

## Giacom (formerly Digital Wholesale Solutions) — the second wholesale supplier

`https://docs.integrations.giacom.com/` — TM Forum Open APIs, OAuth 2.0
client credentials.

**Why it is here.** Zen answers authoritatively for Openreach and nothing
else. Giacom carry **BT Wholesale, CityFibre, TalkTalk Business, Virgin Media
Business and Sky Business**, so the same premises can be sellable through two
accounts at different prices. Their answers are *merged* into the site report
as separate rows tagged by supplier, rather than one replacing the other.

### Endpoints (from their published OpenAPI document — 25 paths in total)

| Method | Path | Used for |
| --- | --- | --- |
| `GET` | `/service`, `/service/{id}` | **Service inventory** — live *and* ceased lines. This is how a Giacom-supplied line appears at a premises at all |
| `POST` | `/geographicAddressValidation` | Address matching against BT Wholesale, returning the Openreach **ALK** |
| `POST` | `/geographicAddress` | Address search |
| `GET` | `/serviceSpecification`, `/serviceSpecification/{id}` | Product catalogue |
| `GET` | `/resource`, `/resourceSpecification` | CPE and resource inventory |
| `POST`/`GET`/`PATCH` | `/serviceOrder`, `/serviceOrder/{id}` | Ordering — **deliberately not wired** |
| `GET`/`POST` | `/cancelServiceOrder` | Order cancellation — not wired |
| `POST` | `/appointment`, `/searchTimeSlot` | Appointment booking |
| `POST` | `/topic/default/hub`, `/listener/*` | Webhook subscriptions and event listeners |

### Environments

| | Base URL | Token URL |
| --- | --- | --- |
| Production | `https://api.integrations.giacom.com/v2` | `https://auth.integrations.giacom.com/oauth2/token` |
| UAT | `https://api.uat.integrations.giacom.com/v2` | `https://auth.uat.integrations.giacom.com/oauth2/token` |

`GIACOM_ENVIRONMENT=uat` switches both.

### Scopes

Giacom define 21 scopes and grant them **individually**, so a credential that
works for the service inventory can still be refused serviceability. Tokens
cache per scope, and the admin board probes each capability separately rather
than reporting "Giacom" as one thing.

Used here: `serviceInventory.read`, `serviceCatalogue.read`,
`resourceInventory.read`, `address.manage`, `serviceQualification.read`,
`serviceQualification.submit`.

### Two gaps, established by reading their spec

**1. There is no fault or diagnostics API.** No TMF621 trouble ticket, no
service test, no line test — confirmed by parsing their OpenAPI document
(`troubleTicket`: 0 mentions, `diagnostic`: 0, `serviceTest`: 0). A
Giacom-supplied line can be listed and inspected, but raising a fault and
testing a line stay Zen-only. Every Giacom line carries a note saying so,
because someone will go looking for the test button.

**2. ServiceQualification exists as an entity but has no published path.**
`integrations/serviceQualification.read` and `.submit` are both in their OAuth
scope list, yet no `/serviceQualification` path appears in the public
document — so it is granted and documented per tenant.

> **Action for whoever holds the Giacom relationship:** ask them to enable
> `serviceQualification` and send the endpoint path. Set
> `GIACOM_QUALIFICATION_PATH` and per-address availability across all five of
> their networks goes live immediately. Until then the adapter reads inventory
> and catalogue only and **never claims availability** — the path is not
> guessed, because a confident 404 would read as "no coverage".

### Mapping notes

TM Forum puts the interesting fields inside
`serviceCharacteristic: [{name, value}]` rather than at the top level, and
nests `{value: {value: …}}` often enough to matter — both are handled. Enum
mappings are conservative: an unrecognised lifecycle state becomes `unknown`
rather than being optimistically called active, and an unrecognised
qualification result is `unknown` rather than available.

The supplier decides the *operator*, not the brand selling it: BT Wholesale,
TalkTalk and Sky all ride Openreach, so those come through as Openreach with
the supplier named separately. CityFibre and Virgin Media Business are their
own networks.

Product-name matching is ordered specific-first, because several names
contain the others — `EoFTTC` contains `FTTC`, and matching the general one
first mislabels every Ethernet first-mile circuit as a broadband line. The
tests pin that.
