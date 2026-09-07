# SupportWizard NetKit

**Everything about a site or a line, from one search box.**

Type a postcode, the first line of an address, a UPRN, a phone number, an
Openreach access line ID, a service ID or an ONT serial. NetKit works out
what you typed, resolves it to a premises, and returns the full address and
UPRN alongside what can be ordered there, what mobile signal to expect, and
every line already in place.

![Type anything](docs/screenshots/broadband.png)

---

## What it does

| | |
| --- | --- |
| **One search box** | Classifies what you typed locally as you type — postcode, address, UPRN, CLI, access line ID, service ID or ONT serial — and routes the lookup accordingly. A postcode always gives you the full premises list to pick the exact address from. |
| **Address + UPRN, always** | Every screen leads with the identity box: full formatted address and UPRN, both one click to copy. Everything is searchable by all three. |
| **Broadband availability** | Every access technology at the premises — FTTP, SOGEA, G.fast, FTTC, ADSL2+, Annex M, IPStream — with RAG status, Range A and Range B speed estimates, product codes and orderability, plus alt-net and cable coverage for completeness. |
| **Openreach engineering detail** | Exchange and TLC, MDF site, PCP cabinet, copper loop length and attenuation, spare pairs, distribution point, FTTP build state, CBT, ONT serial and spare ports, FTTP-on-Demand excess construction charges, and All-IP stop-sell posture. |
| **Mobile signal** | EE, Vodafone, O2 and Three, indoor *and* outdoor, for voice, 4G and 5G, with bands, nearest mast distance and the MVNOs riding each network. |
| **Lines** | CLI, access line ID, service ID, ONT serial, RADIUS state and session, IP allocations, sync and SNR, DLM profile, CPE, contract dates, open faults and appointments. Ceased lines included, so an archived service still turns up. |
| **Admin portal** | Live status probe of all 17 integrations, per-integration on/off switches, user management, and an append-only audit log. |

Sign-in is email and password, with optional email two-factor authentication
that only becomes available once a Resend delivery test has actually passed.

---

## Quick start

```bash
npm install
cp .env.example .env        # fill in what you have; it works with nothing set
npm run build
npm start                   # http://localhost:3000
```

With no credentials at all it runs on deterministic demo data, so the whole
portal is usable and demonstrable immediately. Real postcode geography still
comes from postcodes.io, which needs no key.

For development with hot reload:

```bash
npm run dev:server          # API on :3000
npm run dev:web             # SPA on :5173, proxying /api
```

### Data modes

`DATA_MODE` controls how missing credentials are handled:

- **`auto`** (default) — live providers where credentials exist, demo data elsewhere. Each panel shows which it used.
- **`live`** — never fall back; surface the upstream error instead.
- **`mock`** — always demo data. Useful for training and screenshots.

---

## Architecture

```
shared/     Domain model + identifier classification, shared by both sides
server/     Express API, provider adapters, auth, admin
web/        React SPA (no framework beyond React; hand-written brand CSS)
public/     Build output — what Plesk serves
data/       Users, settings, audit log (gitignored, must persist)
```

The important idea is the **provider chain**. Each capability — addresses,
availability, signal, lines — is an ordered list of providers. The first one
to return a usable answer wins, and a failure falls through to the next, with
fixtures at the end of every chain. One dead upstream degrades a single panel
instead of blanking the page, and every panel reports whether it came from a
live API or a fixture.

Adding an integration means writing one adapter against the interfaces in
`server/src/providers/types.ts` and adding one probe in
`server/src/admin/health.ts`. Nothing else changes.

### Identifier classification

`shared/src/identify.ts` is the front door. It is deliberately conservative:
a UPRN never starts with `0`, which is exactly what distinguishes it from a
UK telephone number, and an outcode on its own is treated as too broad to
resolve a premises. It runs identically in the browser (for the live chip
next to the search box) and on the server (for routing the lookup).

### Zen fair use

Zen's documentation is explicit that the availability endpoint is not for
bulk checking. NetKit therefore caches availability hard (six hours by
default), prefers a CLI-based check where a line is known because Zen says it
is more accurate, and surfaces the `remainingAvailabilityChecks` quota Zen
returns on the admin status board.

---

## Deploying to Plesk

See **[docs/DEPLOY-PLESK.md](docs/DEPLOY-PLESK.md)** for the full walkthrough.
In short: add the domain with **Deploy using Git**, enable **Node.js** on it,
point the startup file at `app.js`, set the environment variables, and run
`plesk-deploy.sh` as the deployment action.

The server is compiled to CommonJS specifically so Phusion Passenger loads it
without ESM friction, and there are no native dependencies to rebuild.

---

## Integrations

| Vendor | Integration | Status |
| --- | --- | --- |
| Zen | Availability & address, services & ceases, diagnostics, faults & outages, connection & SIMs, orders, product ordering, call records, Ethernet quotes | Adapters written against the published API; needs client credentials |
| Ordnance Survey | OS Places — the only source that resolves a bare UPRN | Adapter written; needs an API key |
| postcodes.io | Postcode geography | **Live, no key needed** |
| Resend | Transactional email, gating email 2FA | Adapter written; needs an API key |
| BT | Home Network, IMEI Lookup, Location Insights for London | Config-driven; needs access requesting per product |
| Jola | Mobile Manager | Config-driven; likely redundant since Zen's cellular endpoints are Jola-backed |

`docs/API-REFERENCE.md` holds the distilled upstream contracts the adapters
are written against, including exact endpoint paths, scopes and field names.

---

## Testing

```bash
npm test          # 29 tests: identifier classification, address formatting,
                  # Zen response mapping, password hashing and policy
npm run typecheck # strict TypeScript across all three packages
```

---

## Branding

Every colour, font and radius lives in `web/src/styles/brand.css`, taken
verbatim from **SW-BRAND-2026 v1.0**. NetKit uses the guide's
*internal / engineer* system: full-page brand gradient, white rounded cards,
navy footer band, crimson strictly as an accent. Changing the brand means
editing that one file.

---

SupportWizard – a division of ClubWizard Ltd · 26 Fitzroy Square, London W1T 6ES
**SupportWizard Internal · Confidential**
