import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiResult } from '@sw/shared';
import {
  CALLBACK_PATH,
  callbackRedirect,
  emailFromClaims,
  entraConfigured,
  entraProblem,
  mfaSatisfied,
  nameFromClaims,
  provisioningProblem,
  redirectUri as entraRedirectUri,
} from '@sw/shared';
import { config } from '../config';
import { beginSignIn, exchangeCode, verifyIdToken } from './microsoft';
import { badRequest, HttpError } from '../lib/errors';
import { checkPasswordPolicy, hashPassword, numericCode, verifyPassword } from './passwords';
import { sendEmail, twoFactorAvailable, twoFactorEmail } from './email';
import {
  audit,
  createUser,
  findUserByEmail,
  listUsers,
  toPublicUser,
  updateUser,
  type PublicUser,
  type User,
} from './store';
import {
  clearSession,
  cookieOptions,
  currentUser,
  issuePendingSession,
  issueSession,
  pendingUser,
  readBlob,
  refreshSession,
  signBlob,
} from './sessions';

/**
 * Authentication routes.
 *
 * Sign-in is deliberately uniform in its failure messages and timing: a
 * wrong password and an unknown email produce the same response, so the
 * endpoint cannot be used to enumerate who has an account.
 */

/** Failed-login lockout. Generous enough not to annoy, tight enough to matter. */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Pending 2FA codes
 * ------------------------------------------------------------------ */

interface PendingCode {
  /** SHA-256 of the code — never stored in the clear. */
  hash: string;
  expiresAt: number;
  attempts: number;
  sentTo: string;
}

const pendingCodes = new Map<string, PendingCode>();

const digest = (code: string) => createHash('sha256').update(code).digest();

function storeCode(userId: string, code: string, sentTo: string): void {
  pendingCodes.set(userId, {
    hash: digest(code).toString('base64'),
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
    sentTo,
  });
}

function checkCode(userId: string, code: string): { ok: boolean; reason?: string } {
  const entry = pendingCodes.get(userId);
  if (!entry) return { ok: false, reason: 'No code has been requested. Start again.' };
  if (entry.expiresAt <= Date.now()) {
    pendingCodes.delete(userId);
    return { ok: false, reason: 'That code has expired. Request a new one.' };
  }
  entry.attempts += 1;
  if (entry.attempts > 6) {
    pendingCodes.delete(userId);
    return { ok: false, reason: 'Too many incorrect codes. Start again.' };
  }
  const provided = digest(code.trim());
  const expected = Buffer.from(entry.hash, 'base64');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'That code is not right.' };
  }
  pendingCodes.delete(userId);
  return { ok: true };
}

/** Housekeeping so expired codes don't accumulate. */
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingCodes) if (entry.expiresAt <= now) pendingCodes.delete(id);
}, 60_000).unref();

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by `requireAuth` / `requireAdmin`. */
    user?: User;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: { code: 'bad_request', message: 'Not signed in.' } } satisfies ApiResult<never>);
    return;
  }
  req.user = user;
  // Keep a session that is being used alive, rather than expiring it under
  // someone mid-task.
  refreshSession(req, res, user);
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: { code: 'bad_request', message: 'Not signed in.' } } satisfies ApiResult<never>);
    return;
  }
  if (user.role !== 'admin') {
    audit({ actorId: user.id, actorEmail: user.email, action: 'admin.access_denied', ip: req.ip });
    res
      .status(403)
      .json({ ok: false, error: { code: 'bad_request', message: 'Administrator access required.' } } satisfies ApiResult<never>);
    return;
  }
  req.user = user;
  refreshSession(req, res, user);
  next();
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'rate_limited', message: 'Too many sign-in attempts. Try again shortly.' } },
});

const loginSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(400),
});

const verifySchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(400),
  newPassword: z.string().min(1).max(400),
});

export interface SessionResponse {
  user: PublicUser;
  /** True when the user must set a new password before continuing. */
  mustChangePassword: boolean;
  twoFactorAvailable: boolean;
}

/* ------------------------------------------------------------------ *
 * Microsoft sign-in
 * ------------------------------------------------------------------ */

/**
 * Where the state, nonce and PKCE verifier live between the redirect out to
 * Microsoft and the redirect back.
 *
 * A signed cookie rather than server memory, because Passenger runs several
 * worker processes: state held in one worker's memory is not there when the
 * callback lands on another, which shows up as an intermittent "that sign-in
 * did not match" that only happens under load.
 */
const OIDC_COOKIE = 'sw_netkit_oidc';
const OIDC_TTL_MS = 10 * 60 * 1000;

interface OidcState {
  state: string;
  nonce: string;
  verifier: string;
}

/**
 * The redirect URI, which must match the app registration byte for byte.
 *
 * Derived from PUBLIC_URL when it is set, and from the request otherwise so
 * a development machine works without configuration. Taken from the proxy
 * headers Plesk sets, since the app itself is reached over plain HTTP behind
 * it and would otherwise advertise an http:// redirect that Entra refuses.
 */
function callbackUri(req: Request): string {
  const configured = config().publicUrl;
  if (configured) return entraRedirectUri(configured);
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol;
  return `${proto}://${req.get('host') ?? 'localhost'}${CALLBACK_PATH}`;
}

const sessionBody = (user: User): SessionResponse => ({
  user: toPublicUser(user),
  mustChangePassword: user.mustChangePassword,
  twoFactorAvailable: twoFactorAvailable(),
});

const send = <T>(res: Response, data: T, status = 200): void => {
  res.status(status).json({ ok: true, data } satisfies ApiResult<T>);
};

export function authRouter(): Router {
  const router = Router();

  // ---- Who am I -----------------------------------------------------
  router.get('/session', (req, res) => {
    const user = currentUser(req);
    if (!user) {
      const pending = pendingUser(req);
      send(res, {
        authenticated: false,
        awaitingTwoFactor: Boolean(pending),
        ...(pending ? { email: pending.email } : {}),
        twoFactorAvailable: twoFactorAvailable(),
        microsoftSignIn: entraConfigured(config().microsoft),
      });
      return;
    }
    send(res, { authenticated: true, ...sessionBody(user) });
  });

  // ---- Sign in ------------------------------------------------------
  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Enter your email address and password.');
      const { email, password } = parsed.data;

      const user = findUserByEmail(email);

      // Always do the same amount of work, whether or not the user exists,
      // so response time doesn't reveal which emails are registered.
      const stored = user?.passwordHash ?? (await placeholderHash());
      const passwordOk = await verifyPassword(password, stored);

      const locked = user?.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now();
      if (locked) {
        audit({ actorEmail: email, action: 'auth.login_locked', ip: req.ip });
        throw new HttpError(429, 'rate_limited', 'This account is temporarily locked. Try again in a few minutes.');
      }

      if (!user || !passwordOk || user.disabled) {
        if (user && !user.disabled) {
          const failed = user.failedLoginCount + 1;
          await updateUser(user.id, {
            failedLoginCount: failed,
            ...(failed >= MAX_FAILED_LOGINS ? { lockedUntil: new Date(Date.now() + LOCKOUT_MS).toISOString() } : {}),
          });
        }
        audit({ actorEmail: email, action: 'auth.login_failed', ip: req.ip });
        throw new HttpError(401, 'bad_request', 'Those details are not right.');
      }

      await updateUser(user.id, { failedLoginCount: 0, lockedUntil: undefined });

      // ---- Second factor ---------------------------------------------
      if (user.twoFactorEnabled && twoFactorAvailable()) {
        const code = numericCode(6);
        const mail = twoFactorEmail(code);
        const result = await sendEmail(user.email, mail.subject, mail.html, mail.text);
        if (!result.ok) {
          // Failing closed would lock the user out of their own account
          // because of an email outage, so sign them in and say so loudly.
          audit({ actorId: user.id, actorEmail: user.email, action: 'auth.2fa_send_failed', detail: { error: result.error }, ip: req.ip });
          issueSession(res, user);
          await updateUser(user.id, { lastLoginAt: new Date().toISOString() });
          send(res, {
            authenticated: true,
            ...sessionBody(user),
            warning: `Two-factor code could not be sent (${result.error ?? 'unknown error'}), so it was skipped for this sign-in.`,
          });
          return;
        }
        storeCode(user.id, code, user.email);
        issuePendingSession(res, user);
        audit({ actorId: user.id, actorEmail: user.email, action: 'auth.2fa_sent', ip: req.ip });
        send(res, { authenticated: false, awaitingTwoFactor: true, email: user.email });
        return;
      }

      issueSession(res, user);
      await updateUser(user.id, { lastLoginAt: new Date().toISOString() });
      audit({ actorId: user.id, actorEmail: user.email, action: 'auth.login', ip: req.ip });
      send(res, { authenticated: true, ...sessionBody(user) });
    } catch (err) {
      next(err);
    }
  });

  // ---- Verify the emailed code --------------------------------------
  router.post('/verify', loginLimiter, async (req, res, next) => {
    try {
      const user = pendingUser(req);
      if (!user) throw new HttpError(401, 'bad_request', 'Your sign-in attempt expired. Start again.');

      const parsed = verifySchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Enter the 6-digit code.');

      const result = checkCode(user.id, parsed.data.code);
      if (!result.ok) {
        audit({ actorId: user.id, actorEmail: user.email, action: 'auth.2fa_failed', ip: req.ip });
        throw new HttpError(401, 'bad_request', result.reason ?? 'That code is not right.');
      }

      issueSession(res, user);
      await updateUser(user.id, { lastLoginAt: new Date().toISOString() });
      audit({ actorId: user.id, actorEmail: user.email, action: 'auth.login_2fa', ip: req.ip });
      send(res, { authenticated: true, ...sessionBody(user) });
    } catch (err) {
      next(err);
    }
  });

  // ---- Resend the code ----------------------------------------------
  router.post('/resend', loginLimiter, async (req, res, next) => {
    try {
      const user = pendingUser(req);
      if (!user) throw new HttpError(401, 'bad_request', 'Your sign-in attempt expired. Start again.');
      const code = numericCode(6);
      const mail = twoFactorEmail(code);
      const result = await sendEmail(user.email, mail.subject, mail.html, mail.text);
      if (!result.ok) throw new HttpError(502, 'upstream_error', `Could not send the code: ${result.error}`);
      storeCode(user.id, code, user.email);
      send(res, { sent: true, email: user.email });
    } catch (err) {
      next(err);
    }
  });

  // ---- Sign out -----------------------------------------------------
  router.post('/logout', (req, res) => {
    const user = currentUser(req);
    if (user) audit({ actorId: user.id, actorEmail: user.email, action: 'auth.logout', ip: req.ip });
    clearSession(res);
    send(res, { signedOut: true });
  });

  // ---- Change own password ------------------------------------------
  router.post('/password', requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Provide your current password and a new one.');
      const { currentPassword, newPassword } = parsed.data;

      if (!(await verifyPassword(currentPassword, user.passwordHash))) {
        audit({ actorId: user.id, actorEmail: user.email, action: 'auth.password_change_failed', ip: req.ip });
        throw new HttpError(401, 'bad_request', 'Your current password is not right.');
      }

      const policy = checkPasswordPolicy(newPassword, user.email);
      if (!policy.ok) throw badRequest(`That password won't do. ${policy.problems.join(' ')}`);
      if (await verifyPassword(newPassword, user.passwordHash)) {
        throw badRequest('The new password must be different from the current one.');
      }

      const updated = await updateUser(user.id, {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
      });
      // Changing the password bumps the epoch, so re-issue this session.
      issueSession(res, updated);
      audit({ actorId: user.id, actorEmail: user.email, action: 'auth.password_changed', ip: req.ip });
      send(res, { changed: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- Turn own 2FA on or off ---------------------------------------
  router.post('/two-factor', requireAuth, async (req, res, next) => {
    try {
      const user = req.user!;
      const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);
      if (enabled && !twoFactorAvailable()) {
        throw badRequest(
          'Email two-factor authentication needs a working Resend connection. An administrator can set the API key and run the delivery test in the admin portal.',
        );
      }
      await updateUser(user.id, { twoFactorEnabled: enabled });
      audit({ actorId: user.id, actorEmail: user.email, action: enabled ? 'auth.2fa_enabled' : 'auth.2fa_disabled', ip: req.ip });
      send(res, { twoFactorEnabled: enabled });
    } catch (err) {
      next(err);
    }
  });

  /* ---- Sign in with Microsoft ------------------------------------ */

  /*
   * Both of these are GET, and both answer with a redirect rather than JSON:
   * they are top-level browser navigations, not fetches. Failures land the
   * person back on the sign-in screen with a sentence explaining why, since
   * a JSON error body in the address bar helps nobody.
   */
  router.get('/microsoft/start', loginLimiter, async (req, res) => {
    const settings = config().microsoft;
    const problem = entraProblem(settings);
    if (problem) {
      res.redirect(callbackRedirect(problem));
      return;
    }
    try {
      const hint = typeof req.query.email === 'string' ? req.query.email.trim().slice(0, 320) : undefined;
      const begun = await beginSignIn({
        redirectUri: callbackUri(req),
        ...(hint ? { loginHint: hint } : {}),
      });
      res.cookie(
        OIDC_COOKIE,
        signBlob({ state: begun.state, nonce: begun.nonce, verifier: begun.verifier }, OIDC_TTL_MS),
        cookieOptions(OIDC_TTL_MS),
      );
      res.redirect(begun.url);
    } catch (err) {
      audit({ action: 'auth.sso_start_failed', detail: { error: String(err) }, ip: req.ip });
      res.redirect(callbackRedirect('Microsoft sign-in could not be started. An administrator can check the settings.'));
    }
  });

  router.get('/microsoft/callback', loginLimiter, async (req, res) => {
    const fail = (message: string) => {
      res.clearCookie(OIDC_COOKIE, { path: '/' });
      res.redirect(callbackRedirect(message));
    };

    const settings = config().microsoft;
    if (!entraConfigured(settings)) {
      fail('Microsoft sign-in is not set up.');
      return;
    }

    // Microsoft's own refusal — consent declined, blocked by Conditional
    // Access — arrives as query parameters, not as a failed exchange.
    if (typeof req.query.error === 'string') {
      const description = typeof req.query.error_description === 'string' ? req.query.error_description : '';
      audit({ action: 'auth.sso_denied', detail: { error: req.query.error }, ip: req.ip });
      fail(description.split(/[\r\n]/)[0]?.slice(0, 300) || 'Microsoft declined that sign-in.');
      return;
    }

    const remembered = readBlob<OidcState>(req.cookies?.[OIDC_COOKIE]);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!remembered || !code || !state || state !== remembered.state) {
      fail('That sign-in did not match the one this browser started. Try again.');
      return;
    }

    try {
      const idToken = await exchangeCode({ code, verifier: remembered.verifier, redirectUri: callbackUri(req) });
      const claims = await verifyIdToken(idToken, { nonce: remembered.nonce });
      const email = emailFromClaims(claims);
      const subject = claims.oid ?? claims.sub;

      /*
       * Matched on the Entra object id first and the email second. The
       * second half of that is what makes the first sign-in work at all;
       * the first half is what keeps working after somebody's address
       * changes.
       */
      let user =
        (subject ? listUsers().find((u) => u.ssoSubject === subject) : undefined) ??
        (email ? findUserByEmail(email) : undefined);

      if (!user) {
        const refusal = provisioningProblem(email, settings);
        if (refusal) {
          audit({ action: 'auth.sso_rejected', actorEmail: email, detail: { reason: refusal }, ip: req.ip });
          fail(refusal);
          return;
        }
        /*
         * A password is set to a value nobody knows and nobody can use: the
         * account exists to be signed into with Microsoft, and leaving the
         * hash empty would make `verifyPassword` the only thing standing
         * between an empty password box and an account.
         */
        user = await createUser({
          email: email!,
          name: nameFromClaims(claims, email),
          role: 'user',
          passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
          ssoProvider: 'microsoft',
          ...(subject ? { ssoSubject: subject } : {}),
        });
        audit({ actorId: user.id, actorEmail: user.email, action: 'auth.sso_account_created', ip: req.ip });
      }

      if (user.disabled) {
        audit({ actorId: user.id, actorEmail: user.email, action: 'auth.sso_disabled', ip: req.ip });
        fail('That account is disabled in NetKit. An administrator can re-enable it.');
        return;
      }

      const now = new Date().toISOString();
      user = await updateUser(user.id, {
        lastLoginAt: now,
        lastSsoAt: now,
        failedLoginCount: 0,
        lockedUntil: undefined,
        ssoProvider: 'microsoft',
        // Recorded on the first Microsoft sign-in of an account that was
        // created by hand, so later sign-ins no longer depend on the email.
        ...(subject && user.ssoSubject !== subject ? { ssoSubject: subject } : {}),
        // The name follows the directory: it is the one place somebody
        // actually maintains it.
        ...(claims.name ? { name: nameFromClaims(claims, user.email) } : {}),
      });

      /*
       * The second factor.
       *
       * Where Entra says a second factor was satisfied — which is what
       * Conditional Access enforcing MFA looks like in the token — emailing
       * a six-digit code as well would be theatre: a second factor on the
       * same channel, after a stronger one has already been met.
       *
       * Where it does not, and the account has NetKit's own email 2FA
       * switched on, the code is sent and the browser lands on the code
       * screen. Nothing is skipped silently.
       */
      const mfa = mfaSatisfied(claims);
      if (!mfa && user.twoFactorEnabled && twoFactorAvailable()) {
        const verificationCode = numericCode(6);
        const mail = twoFactorEmail(verificationCode);
        const sent = await sendEmail(user.email, mail.subject, mail.html, mail.text);
        if (sent.ok) {
          storeCode(user.id, verificationCode, user.email);
          issuePendingSession(res, user);
          res.clearCookie(OIDC_COOKIE, { path: '/' });
          audit({ actorId: user.id, actorEmail: user.email, action: 'auth.2fa_sent', ip: req.ip });
          res.redirect('/');
          return;
        }
        audit({
          actorId: user.id,
          actorEmail: user.email,
          action: 'auth.2fa_send_failed',
          detail: { error: sent.error },
          ip: req.ip,
        });
      }

      issueSession(res, user);
      res.clearCookie(OIDC_COOKIE, { path: '/' });
      audit({
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.login_sso',
        detail: { mfa: mfa ? 'satisfied by Microsoft' : 'not asserted by Microsoft' },
        ip: req.ip,
      });
      res.redirect('/');
    } catch (err) {
      audit({ action: 'auth.sso_failed', detail: { error: String(err) }, ip: req.ip });
      fail(err instanceof Error ? err.message : 'That Microsoft sign-in could not be completed.');
    }
  });

  return router;
}

/**
 * A real scrypt hash of a throwaway value, computed once. Verifying against
 * it costs the same as verifying a real password, which is what keeps the
 * unknown-email path indistinguishable from the wrong-password path.
 */
let placeholder: string | null = null;
async function placeholderHash(): Promise<string> {
  if (!placeholder) placeholder = await hashPassword('placeholder-for-constant-time-comparison');
  return placeholder;
}
