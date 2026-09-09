#!/usr/bin/env node
/**
 * The list of environment variables, generated from the code that reads them.
 *
 * `.env.example` used to be this, and it had two problems. It lived in the
 * repository next to the real `.env`, which is how a live session secret and
 * the admin password ended up filled into the tracked template on the
 * server. And it was maintained by hand, so it drifted: variables the code
 * read were missing, and variables nothing read were still listed.
 *
 * So this generates the list by reading the source instead, and the check
 * mode fails the build when the two disagree. A variable added to the code
 * and not documented is now a test failure rather than a surprise on a
 * Sunday.
 *
 *   node scripts/env-inventory.mjs          # rewrite the txt file
 *   node scripts/env-inventory.mjs --check  # fail if it is out of date
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(root, 'PLESK-ENVIRONMENT-VARIABLES.txt');

/* ---- What the code reads -------------------------------------------- */

function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('dist-')) continue;
      sources(path, out);
    } else if (path.endsWith('.ts') && !path.includes('.test.')) {
      out.push(path);
    }
  }
  return out;
}

/** Every variable the server actually looks at, and its default if any. */
function discover() {
  const found = new Map(); // name -> { default?: string }
  for (const file of sources(join(root, 'server', 'src'))) {
    const text = readFileSync(file, 'utf8');
    // config.ts's typed readers, which carry the defaults.
    for (const m of text.matchAll(/\b(?:str|num|bool)\(\s*'([A-Z0-9_]+)'\s*(?:,\s*([^)]*?)\s*)?\)/g)) {
      const existing = found.get(m[1]) ?? {};
      if (m[2] !== undefined && existing.default === undefined) existing.default = m[2].trim();
      found.set(m[1], existing);
    }
    // Anything read straight off process.env.
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], {});
    }
    for (const m of text.matchAll(/process\.env\[\s*'([A-Z0-9_]+)'\s*\]/g)) {
      if (!found.has(m[1])) found.set(m[1], {});
    }
  }
  // Names the vault sets into the environment count as read even where only
  // the allow-list mentions them.
  const creds = readFileSync(join(root, 'shared', 'src', 'credentials.ts'), 'utf8');
  for (const m of creds.matchAll(/name:\s*'([A-Z0-9_]+)'/g)) {
    if (!found.has(m[1])) found.set(m[1], {});
  }
  return found;
}

/* ---- What each one is for ------------------------------------------- */

const GROUPS = [
  {
    shortTitle: 'REQUIRED',
    keys: {
      DATA_DIR:
        'Absolute path, OUTSIDE the deployment directory, where user accounts, the credential vault, the\n' +
        'audit log and the event history live. Production refuses to start without it rather than guess at\n' +
        'somewhere a deploy would wipe. Example: /var/www/vhosts/supportwizard.net/netkit-data',
      SESSION_SECRET:
        'At least 32 random characters. Signs sessions AND is the key the credential vault is encrypted\n' +
        'with, so it CANNOT be stored in the vault. If this changes, every credential saved in the portal\n' +
        'becomes unreadable and has to be entered again. Generate with: openssl rand -base64 48',
      NODE_ENV: 'Set to: production. Turns on secure cookies and the stricter defaults.',
    },
  },
  {
    shortTitle: 'RECOMMENDED',
    keys: {
      PUBLIC_URL:
        'The address the portal is reached on, e.g. https://comms.supportwizard.net — used to build the\n' +
        'links to events that go on helpdesk tickets. Without it, tickets say the event exists but cannot\n' +
        'link to it. Settable in the portal instead.',
      PORT: 'Only if Passenger does not set it. Default 3000.',
      PUBLIC_DIR: 'Where the built front end is. Leave unset unless the layout is non-standard.',
    },
  },
  {
    shortTitle: 'FIRST RUN ONLY',
    keys: {
      ADMIN_EMAIL: 'The first administrator. Defaults to joe@supportwizard.net.',
      ADMIN_PASSWORD:
        'The first administrator’s password. If unset, a strong one is generated and printed to the\n' +
        'application log once, and must be changed at first sign-in.',
      ADMIN_NAME: 'Display name for the first administrator.',
    },
  },
  {
    shortTitle: 'CREDENTIALS (settable in the portal instead)',
    keys: {
      ZEN_CLIENT_ID: 'Zen API client id.',
      ZEN_CLIENT_SECRET: 'Zen API client secret.',
      OS_PLACES_API_KEY: 'Ordnance Survey Places. The address and UPRN lookup depends on it.',
      COMPANIES_HOUSE_API_KEY: 'Companies House. The Primary key on your profile page.',
      GIACOM_CLIENT_ID: 'Giacom / Cloud Market client id.',
      GIACOM_CLIENT_SECRET: 'Giacom / Cloud Market client secret.',
      JOLA_API_KEY: 'Jola. Both halves are needed — the API uses HTTP Basic.',
      JOLA_SECRET_KEY: 'Jola secret key.',
      ZENDESK_SUBDOMAIN: 'Bare subdomain or a full host; both work.',
      ZENDESK_EMAIL: 'The agent account the API acts as.',
      ZENDESK_API_TOKEN: 'Admin Centre → Apps and integrations → APIs → Zendesk API.',
      ITGLUE_API_KEY: 'IT Glue. Account → Settings → API Keys. Password access does NOT need enabling.',
      ITGLUE_BASE_URL:
        'The right data centre: https://api.itglue.com, or api.eu.itglue.com / api.au.itglue.com. The\n' +
        'wrong one answers as though the data is simply not there.',
      UNIFI_API_KEY: 'UniFi Site Manager. Read-only by Ubiquiti’s design. unifi.ui.com → Settings → API Keys.',
      UNIFI_INTEGRATION_KEY:
        'A DIFFERENT key, and the only one that can restart anything. UniFi Network → Settings →\n' +
        'Control Plane → Integrations. Needs console firmware 5.0.3 or newer.',
      OFCOM_BROADBAND_API_KEY: 'Ofcom Connected Nations broadband. Sent as Ocp-Apim-Subscription-Key.',
      OFCOM_MOBILE_API_KEY: 'Ofcom Mobile Checker UPRN coverage. A separate subscription from the broadband one.',
      THINKBROADBAND_API_KEY: 'thinkbroadband availability.',
      OPENCELLID: 'OpenCelliD token, for the nearest-mast lookup.',
      OPENCELLID_API_KEY: 'Accepted as an alias for OPENCELLID. Set either, not both.',
      OPENCELLID_TOKEN: 'Accepted as an alias for OPENCELLID. Set either, not both.',
      RESEND_API_KEY: 'Only needed for sign-in codes and account invites. Everything else goes to Zendesk.',
      RESEND_FROM_EMAIL: 'The address those emails come from.',
      BT_HOME_NETWORK_KEY: 'BT Home Network API.',
      BT_IMEI_LOOKUP_KEY: 'BT IMEI lookup API.',
      BT_LOCATION_INSIGHTS_KEY: 'BT Location Insights API.',
      DOWNDETECTOR_CLIENT_ID: 'Downdetector enterprise client id.',
      DOWNDETECTOR_CLIENT_SECRET: 'Downdetector enterprise client secret.',
    },
  },
  {
    shortTitle: 'BEHAVIOUR (all have defaults)',
    keys: {
      ZEN_ALLOW_ORDERING:
        'true to permit real orders. Off by default, and the portal has a second switch that must also be\n' +
        'on — two independent locks, because ordering spends money.',
      SUPERVISOR_ENABLED: 'true by default. The five-minute health sweep and the outage watcher ride this.',
      SUPERVISOR_INTERVAL_SECONDS: 'Default 300. The outage check paces itself to five minutes regardless.',
      SUPERVISOR_ESCALATE_AFTER_MINUTES: 'How long an integration must keep failing before a person is emailed.',
      SELFTEST_ON_BOOT: 'Run the self-test at start-up.',
      AVAILABILITY_DAILY_BUDGET: 'Per-user daily cap on paid availability lookups.',
      CACHE_TTL_SECONDS: 'How long provider answers are held.',
      REQUEST_TIMEOUT_MS: 'Upstream request timeout.',
      RATE_LIMIT_MAX: 'Requests per window, per IP.',
      RATE_LIMIT_WINDOW_MS: 'The window for the above.',
      CORS_ORIGINS: 'Comma-separated. Only needed if the front end is served from another host.',
      APP_VERSION: 'Shown in the footer and on the status page.',
      POSTCODES_IO_ENABLED: 'The free postcode fallback. On by default.',
    },
  },
  {
    shortTitle: 'ENDPOINTS (all have defaults)',
    keys: {},
  },
];

/* ---- Rendering ------------------------------------------------------- */

/**
 * A list of names, and almost nothing else.
 *
 * The file's job is one thing: letting somebody check that what they typed
 * into Plesk matches what the code reads. Prose gets in the way of that —
 * the explanations live in the portal, on the Credentials page, where they
 * are next to the boxes they describe.
 *
 * The two markers are worth the four characters. Removing SESSION_SECRET
 * does not break anything visibly, it makes every credential stored in the
 * portal undecryptable, and they still look present until an integration
 * says it is not connected.
 */
function render(found) {
  const documented = new Set();
  for (const group of GROUPS) for (const key of Object.keys(group.keys)) documented.add(key);
  const endpoints = [...found.keys()].filter((name) => !documented.has(name)).sort();

  const lines = [];
  lines.push('SUPPORTWIZARD NETKIT — ENVIRONMENT VARIABLE NAMES');
  lines.push('');
  lines.push('Generated from the source by `npm run env:list`. `npm run check:env` fails');
  lines.push('the build if the code reads a name this file does not list, so it cannot');
  lines.push('drift. Nothing here is a secret — these are the names of the boxes.');
  lines.push('');
  lines.push('  (!)  removing this loses data or stops the app booting');
  lines.push('  (1)  read only when the first admin account is created — safe to delete');
  lines.push('  (-)  documented but nothing reads it yet — setting it now does nothing');
  lines.push('');

  const CRITICAL = new Set(['DATA_DIR', 'SESSION_SECRET']);
  const FIRST_RUN = new Set(['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NAME']);

  // A key pasted into Plesk for an integration that is not built yet does
  // nothing, and somebody who set one deserves to know that rather than
  // wondering why the integration never appears.
  const mark = (name) =>
    !found.has(name) ? '(-) ' : CRITICAL.has(name) ? '(!) ' : FIRST_RUN.has(name) ? '(1) ' : '    ';

  for (const group of GROUPS) {
    const keys = group.keys === GROUPS[GROUPS.length - 1].keys ? endpoints : Object.keys(group.keys);
    if (!keys.length) continue;
    lines.push(`--- ${group.shortTitle} ${'-'.repeat(Math.max(0, 66 - group.shortTitle.length))}`);
    lines.push('');
    for (const name of keys.slice().sort()) {
      lines.push(`${mark(name)}${name}`);
    }
    lines.push('');
  }

  lines.push(`${found.size} variables.`);
  lines.push('');
  lines.push('OPENCELLID, OPENCELLID_API_KEY and OPENCELLID_TOKEN are three names for');
  lines.push('the same key. Set one. If more than one is set, the first of those three');
  lines.push('wins and the others are ignored.');
  lines.push('');
  return lines.join('\n');
}

/* ---- Main ------------------------------------------------------------ */

const found = discover();

// The completeness check is the point: it is what stops the list drifting.
const documented = new Set();
for (const group of GROUPS) for (const key of Object.keys(group.keys)) documented.add(key);

const check = process.argv.includes('--check');
const body = render(found);

if (check) {
  if (!existsSync(OUTPUT)) {
    console.error('env:check — PLESK-ENVIRONMENT-VARIABLES.txt is missing. Run: npm run env:list');
    process.exit(1);
  }
  // Compare everything but the generated-on date, which changes daily and is
  // not worth failing a build over.
  const strip = (t) => t.replace(/Generated \d{4}-\d{2}-\d{2}/, 'Generated <date>');
  if (strip(readFileSync(OUTPUT, 'utf8')) !== strip(body)) {
    console.error(
      'env:check — PLESK-ENVIRONMENT-VARIABLES.txt is out of date with the code.\n' +
        '            A variable was added, removed or renamed. Run: npm run env:list',
    );
    process.exit(1);
  }
  console.log(`env:check — ${found.size} variables, list is current.`);
} else {
  writeFileSync(OUTPUT, body, 'utf8');
  console.log(`env:list — wrote ${OUTPUT} (${found.size} variables).`);
}
