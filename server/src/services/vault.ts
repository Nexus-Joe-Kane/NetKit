import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { VAULT_KEYS, vaultKey, type SecretStatus } from '@sw/shared';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

/**
 * Credentials, held by the application rather than the environment.
 *
 * The reason to have this at all: adding an integration meant editing
 * environment variables in Plesk and restarting, which is a deploy-shaped
 * task for what is really a settings change. Worse, it means the person with
 * the keys and the person with the server have to be the same person.
 *
 * The reason to be careful about it: a file of API keys is exactly what an
 * attacker who gets a read of the disk is looking for.
 *
 * So: AES-256-GCM, key derived with scrypt from SESSION_SECRET, which is
 * already the one secret that must exist and must not be in the repository.
 * The consequence is deliberate and worth stating plainly — rotating
 * SESSION_SECRET makes the vault unreadable, and the vault says so rather
 * than pretending the keys were never there.
 *
 * Environment variables still work and still win nothing: the vault is read
 * into the environment at boot, so a key set here behaves exactly as if it
 * had been set in Plesk, and anything not in the vault falls back to whatever
 * Plesk has. That is what makes moving over safe rather than a cutover.
 *
 * No native dependencies, same as the rest of this codebase — node:crypto
 * only.
 */

/** The envelope on disk. Nothing in it is readable without the key. */
interface VaultFile {
  version: 1;
  /** name → sealed value. */
  secrets: Record<string, SealedValue>;
}

interface SealedValue {
  /** Base64 AES-256-GCM ciphertext. */
  data: string;
  iv: string;
  tag: string;
  /** Salt for the scrypt derivation, per value. */
  salt: string;
  /** Metadata, safe to read: it is about the secret, not the secret. */
  setAt: string;
  setBy?: string;
  /** Length of the plaintext, so the UI can say "56 characters" and no more. */
  length: number;
}

const ALGORITHM = 'aes-256-gcm';

let dataDirOverride: string | null = null;

/**
 * Where the vault lives.
 *
 * Resolved lazily and independently of `config()`, because the vault is read
 * *before* the first `config()` call — the whole point is that it can supply
 * the values config will go on to read.
 */
function vaultPath(): string {
  const dir = dataDirOverride ?? process.env.DATA_DIR ?? resolvePath(process.cwd(), '.data-dev');
  return join(resolvePath(dir), 'vault.json');
}

/** Test hook: point the vault somewhere disposable. */
export function useVaultDir(dir: string | null): void {
  dataDirOverride = dir;
  cache = null;
}

function masterSecret(): string | null {
  const secret = process.env.SESSION_SECRET ?? '';
  // A short or absent SESSION_SECRET is not a key. Refusing here means the
  // vault stays empty rather than being encrypted with something guessable.
  return secret.length >= 16 ? secret : null;
}

function deriveKey(salt: Buffer): Buffer {
  const secret = masterSecret();
  if (!secret) throw new Error('SESSION_SECRET must be at least 16 characters before the vault can be used.');
  // 2^15 rather than the usual 2^14: this runs on saving and on boot, not per
  // request, so the extra work is free and the margin is not.
  return scryptSync(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function seal(value: string, setBy?: string): SealedValue {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(salt), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    data: data.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    salt: salt.toString('base64'),
    setAt: new Date().toISOString(),
    ...(setBy ? { setBy } : {}),
    length: value.length,
  };
}

function unseal(sealed: SealedValue): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(Buffer.from(sealed.salt, 'base64')), Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
    return out.toString('utf8');
  } catch {
    // Wrong key, or a tampered file. Either way this value is gone, and
    // guessing at it would be worse than saying so.
    return null;
  }
}

let cache: VaultFile | null = null;

function state(): VaultFile {
  if (!cache) {
    try {
      cache = existsSync(vaultPath())
        ? (JSON.parse(readFileSync(vaultPath(), 'utf8')) as VaultFile)
        : { version: 1, secrets: {} };
    } catch {
      cache = { version: 1, secrets: {} };
    }
    if (!cache.secrets || typeof cache.secrets !== 'object') cache.secrets = {};
  }
  return cache;
}

function persist(): void {
  const path = vaultPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  // 0o600, and no swallowed error: unlike a watch or a cached report, a
  // credential the operator believes they saved and did not is a fault that
  // has to surface at the moment they press the button.
  writeFileSync(tmp, JSON.stringify(state(), null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

/** What the admin page shows: which keys exist, where each one came from. */
export function secretStatus(): SecretStatus[] {
  const file = state();
  return VAULT_KEYS.map((def) => {
    const sealed = file.secrets[def.name];
    if (sealed) {
      const readable = masterSecret() ? unseal(sealed) !== null : false;
      return {
        ...def,
        source: 'vault' as const,
        length: sealed.length,
        setAt: sealed.setAt,
        ...(sealed.setBy ? { setBy: sealed.setBy } : {}),
        ...(readable ? {} : { unreadable: true }),
      };
    }
    const fromEnv = process.env[def.name];
    if (fromEnv) return { ...def, source: 'environment' as const, length: fromEnv.length };
    return { ...def, source: 'unset' as const };
  });
}

/** Whether the vault can be used at all. */
export function vaultUsable(): { ok: boolean; reason?: string } {
  if (!masterSecret()) {
    return {
      ok: false,
      reason:
        'SESSION_SECRET must be set to at least 16 characters before credentials can be stored. It is the key the ' +
        'vault is encrypted with, so it cannot be stored in the vault itself.',
    };
  }
  return { ok: true };
}

/**
 * Puts every vault value into the environment.
 *
 * Called once at boot, before the first `config()` read. Doing it this way
 * rather than threading a lookup through every provider means a key set in
 * the portal behaves *identically* to one set in Plesk — there is one code
 * path for reading credentials, not two that can disagree.
 *
 * Returns what it loaded, for the boot log. Names only.
 */
export function loadVaultIntoEnv(): { loaded: string[]; unreadable: string[] } {
  const loaded: string[] = [];
  const unreadable: string[] = [];
  if (!masterSecret()) return { loaded, unreadable };

  for (const [name, sealed] of Object.entries(state().secrets)) {
    if (!vaultKey(name)) continue; // Ignore anything not on the allow-list.
    const value = unseal(sealed);
    if (value === null) {
      unreadable.push(name);
      continue;
    }
    process.env[name] = value;
    loaded.push(name);
  }
  return { loaded, unreadable };
}

/**
 * Stores a credential and makes it live.
 *
 * The environment is updated in the same breath, so the change takes effect
 * without a restart. Whoever calls this is responsible for resetting the
 * config cache and clearing whatever the provider had cached — see the admin
 * route, which does both.
 */
export function setSecret(name: string, value: string, setBy?: string): { ok: true } | { ok: false; error: string } {
  const def = vaultKey(name);
  if (!def) return { ok: false, error: `${name} is not a credential this application uses.` };
  const usable = vaultUsable();
  if (!usable.ok) return { ok: false, error: usable.reason ?? 'The vault is not usable.' };

  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'That value is empty.' };

  try {
    state().secrets[name] = seal(trimmed, setBy);
    persist();
    process.env[name] = trimmed;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'The credential could not be stored.' };
  }
}

/**
 * Forgets a credential.
 *
 * The environment copy goes too, so removing a key in the portal actually
 * disables the integration rather than leaving it running on a value nothing
 * can see any more. Where Plesk also sets it, the next boot brings the Plesk
 * value back — which is the honest behaviour, and the status page says which
 * source is live.
 */
export function clearSecret(name: string): boolean {
  const file = state();
  if (!file.secrets[name]) return false;
  delete file.secrets[name];
  persist();
  delete process.env[name];
  return true;
}

/**
 * Reads a value back for a test, without storing it.
 *
 * Used by the "test before saving" path: the candidate value is put into the
 * environment, the probe runs, and the previous value is put back whatever
 * happens. Nothing is written unless the operator then saves.
 */
export async function withCandidate<T>(
  values: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    if (!vaultKey(name)) continue;
    previous.set(name, process.env[name]);
    process.env[name] = value.trim();
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Constant-time compare, for anywhere a stored value is checked rather than used. */
export function secretMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Test hook. */
export function reloadVault(): void {
  cache = null;
}

/**
 * Boot hook: loads stored credentials into the environment and says so.
 *
 * Must run before the first `config()` read, which is why both entry points
 * call it as their first statement rather than leaving it to whichever one
 * happens to start. Calling it twice is harmless.
 */
let bootstrapped = false;

export function bootstrapCredentials(): void {
  // Both entry points call this, because either one can be the first to read
  // config: bin/serve when run directly, app.ts when Passenger requires it.
  // Loading twice is harmless, but saying so twice in the log is noise.
  if (bootstrapped) return;
  bootstrapped = true;

  const { loaded, unreadable } = loadVaultIntoEnv();
  if (loaded.length) {
    console.log(`[netkit] ${loaded.length} credential${loaded.length === 1 ? '' : 's'} loaded from the vault.`);
  }
  if (unreadable.length) {
    // Loud, because the integration will look unconfigured and the reason
    // will not be obvious from anywhere else.
    console.error(
      `[netkit] ${unreadable.length} stored credential(s) could not be decrypted: ${unreadable.join(', ')}. ` +
        'SESSION_SECRET has changed since they were saved — re-enter them in Admin portal → Credentials.',
    );
  }
}
