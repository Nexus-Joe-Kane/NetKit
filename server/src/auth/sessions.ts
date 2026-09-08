import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config';
import { findUserById, type User } from './store';

/**
 * Stateless signed sessions.
 *
 * The cookie carries the user id, their session epoch and an expiry, signed
 * with HMAC-SHA256. Nothing secret lives in it, and because the epoch is
 * checked against the stored user on every request, changing a password,
 * disabling an account or deleting a user revokes existing sessions
 * immediately — without a session table to keep in step.
 */

export const SESSION_COOKIE = 'sw_netkit_session';
/** Separate cookie for the half-authenticated state between password and 2FA. */
export const PENDING_COOKIE = 'sw_netkit_pending';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * A session in active use is extended rather than expiring underneath the
 * person using it. The cookie is re-issued once it is more than halfway
 * through its life, so an engineer working a long shift is not thrown out
 * mid-fault, while a browser left open overnight still expires.
 *
 * Refreshing on every request would rewrite the cookie hundreds of times an
 * hour for no benefit; halfway is the point where doing it once is enough.
 */
const REFRESH_AFTER_MS = SESSION_TTL_MS / 2;

/**
 * The signing secret. A generated fallback keeps development working, but it
 * changes on restart, so production is required to set SESSION_SECRET.
 */
let ephemeralSecret: string | null = null;

function secret(): string {
  const configured = config().sessionSecret;
  if (configured) return configured;
  if (config().env === 'production') {
    throw new Error('SESSION_SECRET must be set in production. Generate one with: openssl rand -base64 48');
  }
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(48).toString('base64url');
    console.warn('[netkit] SESSION_SECRET is not set — using a temporary secret. Sessions end on restart.');
  }
  return ephemeralSecret;
}

interface TokenPayload {
  /** Subject — the user id. */
  sub: string;
  /** Session epoch, matched against the stored user. */
  epoch: number;
  /** Expiry, epoch milliseconds. */
  exp: number;
  /** `full` for an authenticated session, `pending` while awaiting 2FA. */
  kind: 'full' | 'pending';
}

function sign(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token: string | undefined): TokenPayload | null {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = createHmac('sha256', secret()).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Plesk terminates TLS in front of the app, so trust the proxy's protocol.
    secure: config().env === 'production',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function issueSession(res: Response, user: User): void {
  const token = sign({ sub: user.id, epoch: user.sessionEpoch, exp: Date.now() + SESSION_TTL_MS, kind: 'full' });
  res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS));
  res.clearCookie(PENDING_COOKIE, { path: '/' });
}

/**
 * True when a session is old enough to be worth extending.
 *
 * Exported for the test rather than for callers — `refreshSession` is the
 * thing to use.
 */
export function needsRefresh(issuedExp: number, now = Date.now()): boolean {
  const elapsed = SESSION_TTL_MS - (issuedExp - now);
  return elapsed >= REFRESH_AFTER_MS;
}

/**
 * Slides an in-use session forward. Called from the auth middleware, so any
 * authenticated request keeps the session alive.
 *
 * Deliberately silent about failure: a response that has already started
 * streaming cannot take a new cookie, and losing a refresh is harmless — the
 * next request tries again.
 */
export function refreshSession(req: Request, res: Response, user: User): void {
  const payload = verify(req.cookies?.[SESSION_COOKIE]);
  if (!payload || payload.kind !== 'full' || !needsRefresh(payload.exp)) return;
  if (res.headersSent) return;
  issueSession(res, user);
}

export function issuePendingSession(res: Response, user: User): void {
  const token = sign({ sub: user.id, epoch: user.sessionEpoch, exp: Date.now() + PENDING_TTL_MS, kind: 'pending' });
  res.cookie(PENDING_COOKIE, token, cookieOptions(PENDING_TTL_MS));
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(PENDING_COOKIE, { path: '/' });
}

/** Resolves a cookie to a live, enabled user, or null. */
function resolve(token: string | undefined, kind: 'full' | 'pending'): User | null {
  const payload = verify(token);
  if (!payload || payload.kind !== kind) return null;
  const user = findUserById(payload.sub);
  if (!user || user.disabled) return null;
  // A bumped epoch means the session was revoked.
  if (user.sessionEpoch !== payload.epoch) return null;
  return user;
}

export function currentUser(req: Request): User | null {
  return resolve(req.cookies?.[SESSION_COOKIE], 'full');
}

export function pendingUser(req: Request): User | null {
  return resolve(req.cookies?.[PENDING_COOKIE], 'pending');
}
