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
  { name: 'JOLA_USERNAME', service: 'jola', label: 'Jola username', secret: false },
  { name: 'JOLA_PASSWORD', service: 'jola', label: 'Jola password', secret: true },
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
  { name: 'OPENCELLID', service: 'opencellid', label: 'OpenCelliD token', secret: true },
  { name: 'THINKBROADBAND_API_KEY', service: 'thinkbroadband', label: 'thinkbroadband key', secret: true },
  { name: 'OFCOM_BROADBAND_API_KEY', service: 'ofcom-broadband', label: 'Ofcom broadband key', secret: true },
  {
    name: 'RESEND_API_KEY',
    service: 'resend',
    label: 'Resend API key',
    secret: true,
    hint: 'Only needed for sign-in codes and account invites. Everything else goes to Zendesk.',
  },
  { name: 'RESEND_FROM_EMAIL', service: 'resend', label: 'Resend from address', secret: false },
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
