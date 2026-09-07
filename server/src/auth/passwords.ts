import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** promisify() drops the options overload, so scrypt is wrapped by hand. */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Password hashing with scrypt from node:crypto.
 *
 * scrypt is memory-hard and built into Node, so there is no native module to
 * compile — which matters when the target is a Plesk host where `npm rebuild`
 * is not always available. Parameters follow the OWASP scrypt guidance.
 */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const COST = 2 ** 15; // N
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p
/** scrypt needs roughly 128 * N * r bytes; give it headroom over the default. */
const MAX_MEMORY = 128 * COST * BLOCK_SIZE * 2;

/** Serialised as `scrypt$N$r$p$salt$hash`, all base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAX_MEMORY,
  });
  return ['scrypt', COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Constant-time verification. Returns false rather than throwing on junk. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;

    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const N = Number.parseInt(n, 10);
    const blockSize = Number.parseInt(r, 10);
    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r: blockSize,
      p: Number.parseInt(p, 10),
      maxmem: 128 * N * blockSize * 2,
    });

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Password policy. Deliberately length-led rather than
 * character-class-led, which is what current NIST guidance recommends.
 */
export function checkPasswordPolicy(password: string, email?: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Must be at least 12 characters long.');
  if (password.length > 200) problems.push('Must be 200 characters or fewer.');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('Must mix upper and lower case letters.');
  if (!/\d/.test(password)) problems.push('Must contain at least one number.');
  if (/^\s|\s$/.test(password)) problems.push('Must not start or end with a space.');

  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length > 2 && password.toLowerCase().includes(local)) {
    problems.push('Must not contain your email address.');
  }
  // A handful of patterns that show up constantly in breach corpora.
  if (/^(?:password|letmein|welcome|qwerty|admin)/i.test(password)) {
    problems.push('Too predictable — pick something less common.');
  }

  return { ok: problems.length === 0, problems };
}

/** A cryptographically random token, for sessions and invitations. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A numeric one-time code for email 2FA. */
export function numericCode(digits = 6): string {
  const max = 10 ** digits;
  // Rejection sampling keeps the distribution uniform.
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= Math.floor(4294967296 / max) * max);
  return String(value % max).padStart(digits, '0');
}
