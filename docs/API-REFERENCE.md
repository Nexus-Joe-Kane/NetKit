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
