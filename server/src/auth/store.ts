import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config';

/**
 * Flat-file persistence.
 *
 * An internal tool for a handful of engineers does not need a database
 * server, and avoiding one removes the single biggest deployment risk on a
 * Plesk host. Writes are atomic (write to a temp file, then rename), and the
 * repository interface below is narrow enough to swap for MySQL later
 * without touching callers.
 */

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  /** Email 2FA opt-in. Only honoured when Resend is verified working. */
  twoFactorEnabled: boolean;
  disabled: boolean;
  /** Forces a password change on next login. */
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  /** Bumped to invalidate every existing session for this user. */
  sessionEpoch: number;
  failedLoginCount: number;
  lockedUntil?: string;
  /**
   * Set where the account signs in with Microsoft.
   *
   * `ssoSubject` is Entra's immutable object id for the person, and is what
   * the account is really matched on once it has been seen once. Email is
   * how the first match is made and is not stable — people marry, change
   * name and get a new address, and their old one is often handed to
   * somebody else. Matching on the address alone would eventually sign the
   * wrong person into the right account.
   */
  ssoProvider?: 'microsoft';
  ssoSubject?: string;
  lastSsoAt?: string;
}

export interface ProviderToggle {
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
}

export interface Settings {
  /** Provider name → toggle. Absent means "enabled". */
  providers: Record<string, ProviderToggle>;
  /** Set once a Resend test email has actually been delivered. */
  resend: { verified: boolean; verifiedAt?: string; lastError?: string; lastTestTo?: string };
  /**
   * Placing orders needs two independent locks: `ZEN_ALLOW_ORDERING` in the
   * environment and this switch. Off by default, and off is the value a
   * missing settings file gives you.
   */
  ordering: {
    enabled: boolean;
    /** Orders per user per day. `0` means unlimited. */
    dailyCapPerUser: number;
    updatedAt?: string;
    updatedBy?: string;
  };
  updatedAt: string;
}

export interface AuditEntry {
  at: string;
  actorId?: string;
  actorEmail?: string;
  action: string;
  detail?: Record<string, unknown>;
  ip?: string;
  /**
   * True where nothing human triggered this.
   *
   * Stated rather than inferred. "No `actorId`" looks like the same signal
   * and is not: the watch sweep audits under the watch owner's id while
   * running unattended at three in the morning, and a seeding step has no id
   * while being something a person ran. Both readings of an inferred flag are
   * wrong, and the wrong one credits a person with a decision nothing made.
   */
  automatic?: boolean;
}

interface Database {
  users: User[];
  settings: Settings;
}

const EMPTY_SETTINGS: Settings = {
  providers: {},
  resend: { verified: false },
  ordering: { enabled: false, dailyCapPerUser: 3 },
  updatedAt: new Date().toISOString(),
};

function dataDir(): string {
  return resolve(config().dataDir);
}

const usersPath = () => join(dataDir(), 'users.json');
const settingsPath = () => join(dataDir(), 'settings.json');
const auditPath = () => join(dataDir(), 'audit.log');

/** Atomic write: a crash mid-write can never leave a truncated file. */
function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

let cache: Database | null = null;

function db(): Database {
  if (cache) return cache;
  cache = {
    users: readJson<User[]>(usersPath(), []),
    settings: { ...EMPTY_SETTINGS, ...readJson<Partial<Settings>>(settingsPath(), {}) } as Settings,
  };
  return cache;
}

/**
 * Serialises writes. Node is single-threaded per process, but an `await`
 * between read and write would still interleave, so mutations queue.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => undefined);
  return run;
}

function persistUsers(): void {
  writeAtomic(usersPath(), JSON.stringify(db().users, null, 2));
}

function persistSettings(): void {
  writeAtomic(settingsPath(), JSON.stringify(db().settings, null, 2));
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** The stored user, without anything secret. Safe to send to the browser. */
export type PublicUser = Omit<User, 'passwordHash' | 'sessionEpoch' | 'failedLoginCount'>;

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _p, sessionEpoch: _s, failedLoginCount: _f, ...rest } = user;
  return rest;
}

export function listUsers(): User[] {
  return [...db().users].sort((a, b) => a.email.localeCompare(b.email));
}

export function findUserByEmail(email: string): User | undefined {
  const target = normaliseEmail(email);
  return db().users.find((u) => u.email === target);
}

export function findUserById(id: string): User | undefined {
  return db().users.find((u) => u.id === id);
}

export function countAdmins(): number {
  return db().users.filter((u) => u.role === 'admin' && !u.disabled).length;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  mustChangePassword?: boolean;
  twoFactorEnabled?: boolean;
  ssoProvider?: 'microsoft';
  ssoSubject?: string;
}

export function createUser(input: CreateUserInput): Promise<User> {
  return enqueue(() => {
    const email = normaliseEmail(input.email);
    if (db().users.some((u) => u.email === email)) {
      throw new Error(`A user with the email ${email} already exists.`);
    }
    const now = new Date().toISOString();
    const user: User = {
      id: randomUUID(),
      email,
      name: input.name.trim() || email,
      role: input.role,
      passwordHash: input.passwordHash,
      twoFactorEnabled: input.twoFactorEnabled ?? false,
      disabled: false,
      mustChangePassword: input.mustChangePassword ?? false,
      createdAt: now,
      updatedAt: now,
      sessionEpoch: 1,
      failedLoginCount: 0,
      ...(input.ssoProvider ? { ssoProvider: input.ssoProvider } : {}),
      ...(input.ssoSubject ? { ssoSubject: input.ssoSubject } : {}),
    };
    db().users.push(user);
    persistUsers();
    return user;
  });
}

export type UserPatch = Partial<
  Pick<
    User,
    | 'name'
    | 'role'
    | 'disabled'
    | 'twoFactorEnabled'
    | 'mustChangePassword'
    | 'passwordHash'
    | 'lastLoginAt'
    | 'failedLoginCount'
    | 'lockedUntil'
    | 'ssoProvider'
    | 'ssoSubject'
    | 'lastSsoAt'
  >
> & { bumpSessionEpoch?: boolean };

export function updateUser(id: string, patch: UserPatch): Promise<User> {
  return enqueue(() => {
    const user = db().users.find((u) => u.id === id);
    if (!user) throw new Error('User not found.');

    const { bumpSessionEpoch, ...fields } = patch;
    Object.assign(user, fields);
    // Changing a password, disabling an account or demoting an admin must
    // invalidate any session already issued.
    if (bumpSessionEpoch || fields.passwordHash || fields.disabled === true || fields.role) {
      user.sessionEpoch += 1;
    }
    if (fields.lockedUntil === undefined && patch.failedLoginCount === 0) delete user.lockedUntil;
    user.updatedAt = new Date().toISOString();
    persistUsers();
    return user;
  });
}

export function deleteUser(id: string): Promise<void> {
  return enqueue(() => {
    const index = db().users.findIndex((u) => u.id === id);
    if (index < 0) throw new Error('User not found.');
    const user = db().users[index]!;
    if (user.role === 'admin' && countAdmins() <= 1) {
      throw new Error('Cannot remove the last remaining administrator.');
    }
    db().users.splice(index, 1);
    persistUsers();
  });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function settings(): Settings {
  return db().settings;
}

/** A provider is enabled unless it has been explicitly switched off. */
export function isProviderEnabled(name: string): boolean {
  return db().settings.providers[name]?.enabled !== false;
}

export function setProviderEnabled(name: string, enabled: boolean, actor?: string): Promise<Settings> {
  return enqueue(() => {
    db().settings.providers[name] = {
      enabled,
      updatedAt: new Date().toISOString(),
      ...(actor ? { updatedBy: actor } : {}),
    };
    db().settings.updatedAt = new Date().toISOString();
    persistSettings();
    return db().settings;
  });
}

/**
 * The ordering switch and its daily cap. Both are audited by the caller;
 * this only persists.
 */
export function setOrdering(
  patch: { enabled?: boolean; dailyCapPerUser?: number },
  actor?: string,
): Promise<Settings> {
  return enqueue(() => {
    const current = db().settings.ordering ?? EMPTY_SETTINGS.ordering;
    db().settings.ordering = {
      enabled: patch.enabled ?? current.enabled,
      dailyCapPerUser:
        patch.dailyCapPerUser != null ? Math.max(0, Math.min(50, Math.trunc(patch.dailyCapPerUser))) : current.dailyCapPerUser,
      updatedAt: new Date().toISOString(),
      ...(actor ? { updatedBy: actor } : {}),
    };
    db().settings.updatedAt = new Date().toISOString();
    persistSettings();
    return db().settings;
  });
}

export function setResendStatus(status: Settings['resend']): Promise<Settings> {
  return enqueue(() => {
    db().settings.resend = status;
    db().settings.updatedAt = new Date().toISOString();
    persistSettings();
    return db().settings;
  });
}

/* ------------------------------------------------------------------ *
 * Audit log
 * ------------------------------------------------------------------ */

/** Append-only JSON lines. Never rewritten, so it cannot be edited in place. */
export function audit(entry: Omit<AuditEntry, 'at'>): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(auditPath(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // An audit failure must never break the request it is recording.
  }
}

export function readAudit(limit = 200): AuditEntry[] {
  try {
    if (!existsSync(auditPath())) return [];
    const lines = readFileSync(auditPath(), 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEntry => e !== null);
  } catch {
    return [];
  }
}

/** Test hook — drops the in-memory cache so files are re-read. */
export function resetStore(): void {
  cache = null;
}
