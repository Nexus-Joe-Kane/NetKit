/**
 * Which credentials the application uses, as data.
 *
 * Shared because the admin form needs the list and the labels, and because
 * the alternative — the form hard-coding its own copy — is how a key ends up
 * with a field nothing reads.
 *
 * An allow-list, not a free-form store, for two reasons. A typo in a name
 * would otherwise store a value nothing ever looks at, and look saved. And an
 * open store of arbitrary environment variables is a way to set NODE_OPTIONS
 * or PATH from a web form, which is remote code execution with extra steps.
 *
 * Nothing here is a secret: these are the names of the boxes, not what goes
 * in them.
 */

export interface VaultKeyDef {
  /** The environment variable name, which is also the vault key. */
  name: string;
  /** Which integration it belongs to, matching the service-status key. */
  service: string;
  label: string;
  /** True where the value is a secret rather than an identifier. */
  secret: boolean;
  hint?: string;
}

export const VAULT_KEYS: readonly VaultKeyDef[] = [
  { name: 'ZEN_CLIENT_ID', service: 'zen', label: 'Zen client ID', secret: false },
  { name: 'ZEN_CLIENT_SECRET', service: 'zen', label: 'Zen client secret', secret: true },
  { name: 'OS_PLACES_API_KEY', service: 'os-places', label: 'OS Places API key', secret: true },
  {
    name: 'COMPANIES_HOUSE_API_KEY',
    service: 'companies-house',
    label: 'Companies House key',
    secret: true,
    hint: 'The Primary key on your Companies House profile page.',
  },
  { name: 'GIACOM_CLIENT_ID', service: 'giacom', label: 'Giacom client ID', secret: false },
  { name: 'GIACOM_CLIENT_SECRET', service: 'giacom', label: 'Giacom client secret', secret: true },
  /*
   * Jola. Named for what the code reads, which is not what these were
   * called: the vault offered `JOLA_USERNAME` and `JOLA_PASSWORD` while
   * `config()` read `JOLA_API_KEY` and `JOLA_SECRET_KEY`, so the portal had
   * two boxes that stored a value nothing ever looked at and reported them
   * as saved. Exactly the failure this allow-list exists to prevent.
   */
  {
    name: 'JOLA_API_KEY',
    service: 'jola',
    label: 'Jola API key',
    secret: true,
    hint: 'Both halves are needed: the API uses HTTP Basic, so a key without its secret is not configured.',
  },
  { name: 'JOLA_SECRET_KEY', service: 'jola', label: 'Jola secret key', secret: true },
  {
    name: 'ZENDESK_SUBDOMAIN',
    service: 'zendesk',
    label: 'Zendesk subdomain',
    secret: false,
    hint: 'A bare subdomain or a full host; both work.',
  },
  { name: 'ZENDESK_EMAIL', service: 'zendesk', label: 'Zendesk agent email', secret: false },
  {
    name: 'ZENDESK_API_TOKEN',
    service: 'zendesk',
    label: 'Zendesk API token',
    secret: true,
    hint: 'Admin Centre → Apps and integrations → APIs → Zendesk API.',
  },
  {
    name: 'ITGLUE_API_KEY',
    service: 'itglue',
    label: 'IT Glue API key',
    secret: true,
    hint: 'Account → Settings → API Keys. Password access does not need enabling — NetKit never asks for values.',
  },
  {
    name: 'ITGLUE_BASE_URL',
    service: 'itglue',
    label: 'IT Glue data centre',
    secret: false,
    hint: 'https://api.itglue.com, or api.eu.itglue.com / api.au.itglue.com. The wrong one answers as though the data is not there.',
  },
  {
    name: 'UNIFI_API_KEY',
    service: 'unifi',
    label: 'UniFi Site Manager key',
    secret: true,
    hint: 'unifi.ui.com → Settings → API Keys. Shown once. Read-only, which is all this needs.',
  },
  {
    name: 'UNIFI_INTEGRATION_KEY',
    service: 'unifi',
    label: 'UniFi Network Integration key',
    secret: true,
    hint:
      'A different key from the one above, and the only one that can restart anything — the Site Manager key ' +
      'is read-only. UniFi Network → Settings → Control Plane → Integrations. Needs console firmware 5.0.3+.',
  },
  { name: 'OPENCELLID', service: 'opencellid', label: 'OpenCelliD token', secret: true },
  { name: 'THINKBROADBAND_API_KEY', service: 'thinkbroadband', label: 'thinkbroadband key', secret: true },
  { name: 'OFCOM_BROADBAND_API_KEY', service: 'ofcom-broadband', label: 'Ofcom broadband key', secret: true },
  {
    name: 'OFCOM_MOBILE_API_KEY',
    service: 'ofcom-mobile',
    label: 'Ofcom Mobile Checker key',
    secret: true,
    hint:
      'A separate subscription from the broadband one, on a different host. This is the only per-address, ' +
      'per-operator mobile source — everything else is constituency-level.',
  },
  {
    name: 'RESEND_API_KEY',
    service: 'resend',
    label: 'Resend API key',
    secret: true,
    hint: 'Only needed for sign-in codes and account invites. Everything else goes to Zendesk.',
  },
  { name: 'RESEND_FROM_EMAIL', service: 'resend', label: 'Resend from address', secret: false },
  {
    name: 'DOWNDETECTOR_CLIENT_ID',
    service: 'downdetector',
    label: 'Downdetector client ID',
    secret: false,
    hint: 'Log in at Downdetector, API in the left menu, then + to create a token. Both halves are needed.',
  },
  { name: 'DOWNDETECTOR_CLIENT_SECRET', service: 'downdetector', label: 'Downdetector client secret', secret: true },
  { name: 'BT_HOME_NETWORK_KEY', service: 'bt-home-network', label: 'BT Home Network key', secret: true },
  { name: 'BT_IMEI_LOOKUP_KEY', service: 'bt-imei', label: 'BT IMEI lookup key', secret: true },
  { name: 'BT_LOCATION_INSIGHTS_KEY', service: 'bt-location', label: 'BT Location Insights key', secret: true },
  {
    name: 'PUBLIC_URL',
    service: 'portal',
    label: 'Portal address',
    secret: false,
    hint: 'Used for links inside Zendesk notes, e.g. https://comms.supportwizard.net',
  },
] as const;

/**
 * What has to stay in the environment, and why.
 *
 * The question this answers is a dangerous one to get wrong: once every
 * credential is in the vault, can the `.env` file go? Mostly yes — and two
 * of these would take the whole installation with them.
 *
 * `SESSION_SECRET` is the key the vault is encrypted with, so it cannot be
 * stored in the vault; deleting it makes every saved credential unreadable.
 * `DATA_DIR` is where the vault, the accounts and the audit log live, and
 * production refuses to boot without it rather than guess.
 */
export interface EnvironmentRequirement {
  name: string;
  label: string;
  /** `critical` means deleting it loses data or stops the app booting. */
  severity: 'critical' | 'recommended';
  why: string;
}

export const ENVIRONMENT_REQUIREMENTS: readonly EnvironmentRequirement[] = [
  {
    name: 'SESSION_SECRET',
    label: 'Session secret',
    severity: 'critical',
    why:
      'The key the credential vault is encrypted with, so it cannot be kept in the vault itself. ' +
      'Remove or change it and every stored credential becomes unreadable and has to be entered again.',
  },
  {
    name: 'DATA_DIR',
    label: 'Data directory',
    severity: 'critical',
    why:
      'Where the vault, the user accounts and the audit log are kept. It must be an absolute path outside ' +
      'the deployment directory, and in production the application refuses to start without it rather than ' +
      'guess at somewhere a deploy would wipe.',
  },
  {
    name: 'NODE_ENV',
    label: 'Environment',
    severity: 'recommended',
    why: 'Set to production on the live host. It turns on secure cookies and the stricter defaults.',
  },
];

/**
 * Environment variables that are only read once and can then be removed.
 *
 * The admin password is the one worth being explicit about: it seeds the
 * first account and is never read again, because what is stored is a scrypt
 * hash of it in the accounts file. Leaving it in a file on the server is a
 * plaintext password sitting somewhere it does not need to be.
 */
export const ENVIRONMENT_ONCE_ONLY: readonly EnvironmentRequirement[] = [
  {
    name: 'ADMIN_PASSWORD',
    label: 'Initial admin password',
    severity: 'recommended',
    why:
      'Only used to create the first administrator. The account already exists and stores a hash, never the ' +
      'password, so this line can be deleted — and should be, rather than left in plain text on the server.',
  },
  {
    name: 'ADMIN_EMAIL',
    label: 'Initial admin email',
    severity: 'recommended',
    why: 'Only used to create the first administrator. Safe to remove once the account exists.',
  },
  {
    name: 'ADMIN_NAME',
    label: 'Initial admin name',
    severity: 'recommended',
    why: 'Only used to create the first administrator. Safe to remove once the account exists.',
  },
];

const byName = new Map(VAULT_KEYS.map((k) => [k.name, k]));

export const vaultKey = (name: string): VaultKeyDef | undefined => byName.get(name);

/** The integrations that have at least one credential, in list order. */
export function credentialServices(): string[] {
  return [...new Set(VAULT_KEYS.map((k) => k.service))];
}

/**
 * What the admin page is told about a credential.
 *
 * Deliberately never the value, and not even a prefix of it: four characters
 * of an API key is four characters an attacker does not have to guess, and
 * there is nothing a masked value tells an operator that "set, 56 characters,
 * by Joe on Tuesday" does not tell them better.
 */
export interface SecretStatus extends VaultKeyDef {
  /** Where the live value comes from. */
  source: 'vault' | 'environment' | 'unset';
  /** Length only. */
  length?: number;
  setAt?: string;
  setBy?: string;
  /** True when the vault holds a value it can no longer decrypt. */
  unreadable?: boolean;
}
