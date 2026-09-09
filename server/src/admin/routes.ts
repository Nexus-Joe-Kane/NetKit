import { Router, type Response } from 'express';
import { z } from 'zod';
import type { ApiResult } from '@sw/shared';
import { vaultKey } from '@sw/shared';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { checkPasswordPolicy, hashPassword, randomToken } from '../auth/passwords';
import { EMAIL_FONT, emailLayout, sendEmail, verifyResend } from '../auth/email';
import { notifyChannel, notifyChannelDetail } from '../services/notify';
import { clearSecret, secretStatus, setSecret, vaultUsable, withCandidate } from '../services/vault';
import { clearAllProviderCaches } from './supervisor';
import { requireAdmin } from '../auth/routes';
import {
  audit,
  countAdmins,
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  listUsers,
  readAudit,
  setOrdering,
  setProviderEnabled,
  settings,
  toPublicUser,
  updateUser,
} from '../auth/store';
import { probeService, serviceStatuses } from './health';
import { runSelfTest } from './selftest';
import { sweep, supervisorState } from './supervisor';
import { config, resetConfig } from '../config';
import { quotaSummary } from '../services/quota';

/**
 * Admin portal API.
 *
 * Every route is behind `requireAdmin`, and every mutation is written to the
 * append-only audit log with the acting administrator's identity.
 */

const send = <T>(res: Response, data: T, status = 200): void => {
  res.status(status).json({ ok: true, data } satisfies ApiResult<T>);
};

const createUserSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(320),
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  role: z.enum(['admin', 'user']),
  /** Omit to have one generated and emailed. */
  password: z.string().min(1).max(400).optional(),
  sendInvite: z.boolean().optional(),
});

const patchUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['admin', 'user']).optional(),
  disabled: z.boolean().optional(),
  twoFactorEnabled: z.boolean().optional(),
  /** Sets a new password directly. */
  password: z.string().min(1).max(400).optional(),
  /** Forces a change at next sign-in. */
  mustChangePassword: z.boolean().optional(),
});

const toggleSchema = z.object({ enabled: z.boolean() });

const orderingSchema = z.object({
  enabled: z.boolean().optional(),
  /** Kept deliberately small. Fifty provides in a day is not a support tool. */
  dailyCapPerUser: z.coerce.number().int().min(0).max(50).optional(),
});

export function adminRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  /* ---- Service status ---------------------------------------------- */

  router.get('/status', async (_req, res, next) => {
    try {
      const services = await serviceStatuses();
      const cfg = config();
      send(res, {
        services,
        summary: {
          total: services.length,
          ok: services.filter((s) => s.state === 'ok').length,
          degraded: services.filter((s) => s.state === 'degraded').length,
          down: services.filter((s) => s.state === 'down').length,
          notConfigured: services.filter((s) => s.state === 'not_configured').length,
          disabled: services.filter((s) => s.state === 'disabled').length,
        },
        environment: {
          version: cfg.version,
          nodeEnv: cfg.env,
          cacheTtlSeconds: cfg.cacheTtlSeconds,
          sessionSecretSet: Boolean(cfg.sessionSecret),
        },
        resend: settings().resend,
        notifications: { channel: notifyChannel(), detail: notifyChannelDetail() },
        ordering: {
          ...settings().ordering,
          /** Read-only here: only a deploy can change the environment flag. */
          environmentAllows: cfg.allowOrdering,
        },
        quotas: quotaSummary(),
      });
    } catch (err) {
      next(err);
    }
  });

  /* ---- Supervisor and self-test ------------------------------------ */

  router.get('/supervisor', (_req, res) => {
    send(res, supervisorState());
  });

  /** Forces a sweep now rather than waiting for the interval. */
  router.post('/supervisor/sweep', async (req, res, next) => {
    try {
      const result = await sweep();
      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'supervisor.manual_sweep',
        detail: result.skipped
          ? { skipped: true, reason: 'a sweep was already in flight' }
          : {
              checked: result.checked,
              healthy: result.healthy,
              failing: result.failing,
              recovered: result.recovered,
              circuitsOpened: result.circuitsOpened,
              circuitsClosed: result.circuitsClosed,
            },
        ip: req.ip,
      });
      send(res, { sweep: result, state: supervisorState() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/selftest', async (req, res, next) => {
    try {
      const report = await runSelfTest();
      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'selftest.manual_run',
        detail: { outcome: report.outcome, ...report.counts },
        ip: req.ip,
      });
      send(res, report);
    } catch (err) {
      next(err);
    }
  });

  /* ---- Credentials -------------------------------------------------- */

  /**
   * Which credentials exist and where each one comes from.
   *
   * Never the values. Not even a prefix: four characters of an API key is
   * four characters an attacker does not have to guess, and there is nothing
   * a masked value tells an operator that "set, 56 characters, by Joe on
   * Tuesday" does not tell them better.
   */
  router.get('/credentials', (_req, res) => {
    send(res, { vault: vaultUsable(), keys: secretStatus() });
  });

  const credentialSchema = z.object({
    values: z.record(z.string(), z.string().max(4000)),
  });

  /**
   * Tries a credential without storing it.
   *
   * The order matters: an operator who pastes a key, presses Test, gets a
   * green light and then saves has proved the thing works. One who saves
   * first has changed the running system to find out.
   *
   * The candidate goes into the environment only for the duration of the
   * probe, and the previous value is restored whatever happens — including
   * when the probe throws.
   */
  router.post('/credentials/test', async (req, res, next) => {
    try {
      const parsed = credentialSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Provide { "values": { "NAME": "value" } }.');

      const names = Object.keys(parsed.data.values);
      const unknown = names.filter((n) => !vaultKey(n));
      if (unknown.length) throw badRequest(`Not a credential this application uses: ${unknown.join(', ')}`);
      if (!names.length) throw badRequest('Nothing to test.');

      // Every named key belongs to one service, or the test has no single
      // thing to probe.
      const services = [...new Set(names.map((n) => vaultKey(n)!.service))];
      if (services.length !== 1) {
        throw badRequest('Test one integration at a time — these keys belong to different ones.');
      }
      const service = services[0]!;

      const result = await withCandidate(parsed.data.values, async () => {
        // The candidate is only visible to code that re-reads config, so the
        // cache has to go both before the probe and after it.
        resetConfig();
        clearAllProviderCaches();
        try {
          return await probeService(service);
        } finally {
          resetConfig();
          clearAllProviderCaches();
        }
      });

      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.credential_tested',
        // Names only. The point of the vault is that values do not end up in
        // places like this.
        detail: { service, keys: names, state: result?.state ?? 'no_probe' },
        ip: req.ip,
      });

      if (!result) {
        send(res, {
          service,
          state: 'unknown',
          detail: 'There is no probe for that integration, so the key was stored-shape-checked only.',
        });
        return;
      }
      send(res, { service, state: result.state, detail: result.detail, ...(result.meta ? { meta: result.meta } : {}) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Stores credentials and makes them live.
   *
   * No restart: the vault writes each value into the environment, the config
   * cache is dropped so the next read sees it, and every provider cache goes
   * with it — a token or a "not configured" answer taken under the old key
   * would otherwise outlive the change and make the new key look broken.
   */
  router.post('/credentials', async (req, res, next) => {
    try {
      const parsed = credentialSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Provide { "values": { "NAME": "value" } }.');

      const saved: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const [name, value] of Object.entries(parsed.data.values)) {
        const result = setSecret(name, value, req.user!.email);
        if (result.ok) saved.push(name);
        else failed.push({ name, error: result.error });
      }

      resetConfig();
      clearAllProviderCaches();

      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.credentials_saved',
        detail: { saved, ...(failed.length ? { failed: failed.map((f) => f.name) } : {}) },
        ip: req.ip,
      });

      if (!saved.length && failed.length) throw badRequest(failed[0]!.error);
      send(res, { saved, failed, keys: secretStatus() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Forgets a credential.
   *
   * Where Plesk also sets it, the next boot brings the Plesk value back. That
   * is the honest behaviour rather than a surprise, and the status list says
   * which source is live either way.
   */
  router.delete('/credentials/:name', async (req, res, next) => {
    try {
      const name = String(req.params.name);
      if (!vaultKey(name)) throw notFound(`No such credential: ${name}`);

      const removed = clearSecret(name);
      resetConfig();
      clearAllProviderCaches();

      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.credential_cleared',
        detail: { name, removed },
        ip: req.ip,
      });

      send(res, { name, removed, keys: secretStatus() });
    } catch (err) {
      next(err);
    }
  });

  /* ---- Provider toggles -------------------------------------------- */

  router.post('/services/:key/toggle', async (req, res, next) => {
    try {
      const parsed = toggleSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Provide { "enabled": true | false }.');

      const key = String(req.params.key);
      const known = (await serviceStatuses()).some((s) => s.key === key);
      if (!known) throw notFound(`No such service: ${key}`);

      await setProviderEnabled(key, parsed.data.enabled, req.user!.email);
      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: parsed.data.enabled ? 'admin.service_enabled' : 'admin.service_disabled',
        detail: { key },
        ip: req.ip,
      });
      send(res, { key, enabled: parsed.data.enabled });
    } catch (err) {
      next(err);
    }
  });

  /* ---- Ordering ----------------------------------------------------- */

  /**
   * The admin half of the ordering lock, and the daily cap.
   *
   * The environment flag is not settable from here by design — two locks that
   * the same person can open from the same screen are one lock.
   */
  router.post('/ordering', async (req, res, next) => {
    try {
      const parsed = orderingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? 'Provide { enabled } and/or { dailyCapPerUser }.');
      }
      if (parsed.data.enabled === undefined && parsed.data.dailyCapPerUser === undefined) {
        throw badRequest('Nothing to change — provide "enabled" or "dailyCapPerUser".');
      }

      const updated = await setOrdering(parsed.data, req.user!.email);
      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.ordering_changed',
        detail: { ...parsed.data, environmentAllows: config().allowOrdering },
        ip: req.ip,
      });
      send(res, {
        ordering: { ...updated.ordering, environmentAllows: config().allowOrdering },
        // Worth saying plainly: switching this on does nothing on its own if
        // the deploy has not also set ZEN_ALLOW_ORDERING.
        ...(parsed.data.enabled && !config().allowOrdering
          ? { note: 'Ordering stays blocked until ZEN_ALLOW_ORDERING=true is set in the server environment.' }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Today's fair-use and ordering counters, per user. */
  router.get('/quotas', (_req, res) => {
    const summary = quotaSummary();
    send(res, {
      ...summary,
      rows: summary.rows.map((r) => ({
        ...r,
        email: findUserById(r.userId)?.email ?? 'unknown user',
      })),
    });
  });

  /* ---- Resend delivery test ---------------------------------------- */

  router.post('/resend/test', async (req, res, next) => {
    try {
      if (!config().resend.configured) {
        throw badRequest('RESEND_API_KEY is not set on the server, so there is nothing to test.');
      }
      const to = String((req.body as { to?: unknown })?.to ?? req.user!.email).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw badRequest('Provide a valid email address to send the test to.');

      const result = await verifyResend(to);
      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: result.ok ? 'admin.resend_verified' : 'admin.resend_test_failed',
        detail: { to, ...(result.error ? { error: result.error } : {}) },
        ip: req.ip,
      });

      if (!result.ok) {
        throw new HttpError(502, 'upstream_error', `Resend rejected the test: ${result.error}`);
      }
      send(res, { sent: true, to, twoFactorNowAvailable: true });
    } catch (err) {
      next(err);
    }
  });

  /* ---- Users -------------------------------------------------------- */

  router.get('/users', (_req, res) => {
    send(res, { users: listUsers().map(toPublicUser), adminCount: countAdmins() });
  });

  router.post('/users', async (req, res, next) => {
    try {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid user details.');
      const { email, name, role, sendInvite } = parsed.data;

      if (findUserByEmail(email)) throw badRequest(`${email} already has an account.`);

      // A generated password is used when none is supplied, so an admin never
      // has to invent one — and it is only ever sent to the new user's inbox.
      const generated = !parsed.data.password;
      const password = parsed.data.password ?? `${randomToken(9)}Aa1`;

      if (!generated) {
        const policy = checkPasswordPolicy(password, email);
        if (!policy.ok) throw badRequest(`That password won't do. ${policy.problems.join(' ')}`);
      }

      const user = await createUser({
        email,
        name,
        role,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      });

      let invited = false;
      let inviteError: string | undefined;
      if (sendInvite !== false && config().resend.configured) {
        const result = await sendEmail(
          email,
          'Your SupportWizard NetKit account',
          emailLayout(
            'Your NetKit account is ready',
            `<p>An account has been created for you on SupportWizard NetKit.</p>
             <p style="margin:18px 0;padding:14px 16px;background:#F6F7F8;border:1px solid #E4E6E8;border-radius:8px;">
               <strong style="color:#101317;">Email</strong><br>${email}<br><br>
               <strong style="color:#101317;">Temporary password</strong><br>
               <span style="font-family:${EMAIL_FONT};font-size:15px;letter-spacing:0.06em;font-weight:600;">${password}</span>
             </p>
             <p>You will be asked to set your own password the first time you sign in.</p>`,
          ),
        );
        invited = result.ok;
        if (!result.ok) inviteError = result.error;
      }

      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.user_created',
        detail: { email, role, invited },
        ip: req.ip,
      });

      send(
        res,
        {
          user: toPublicUser(user),
          invited,
          ...(inviteError ? { inviteError } : {}),
          // Only returned when we could not email it — so the admin can pass
          // it on by another route rather than being stuck.
          ...(generated && !invited ? { temporaryPassword: password } : {}),
        },
        201,
      );
    } catch (err) {
      next(err);
    }
  });

  router.patch('/users/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const target = findUserById(id);
      if (!target) throw notFound('User not found.');

      const parsed = patchUserSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid changes.');
      const patch = parsed.data;

      // Guard rails: never leave the portal without an administrator, and
      // never let an admin lock themselves out by accident.
      const losingAdmin =
        (patch.role === 'user' && target.role === 'admin') || (patch.disabled === true && target.role === 'admin');
      if (losingAdmin && countAdmins() <= 1) {
        throw badRequest('This is the last active administrator — promote someone else first.');
      }
      if (target.id === req.user!.id && patch.disabled === true) {
        throw badRequest('You cannot disable your own account.');
      }

      if (patch.password) {
        const policy = checkPasswordPolicy(patch.password, target.email);
        if (!policy.ok) throw badRequest(`That password won't do. ${policy.problems.join(' ')}`);
      }

      const updated = await updateUser(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
        ...(patch.twoFactorEnabled !== undefined ? { twoFactorEnabled: patch.twoFactorEnabled } : {}),
        ...(patch.mustChangePassword !== undefined ? { mustChangePassword: patch.mustChangePassword } : {}),
        ...(patch.password ? { passwordHash: await hashPassword(patch.password), mustChangePassword: true } : {}),
      });

      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.user_updated',
        detail: { email: target.email, changed: Object.keys(patch).filter((k) => k !== 'password') },
        ip: req.ip,
      });
      send(res, { user: toPublicUser(updated) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/users/:id/revoke-sessions', async (req, res, next) => {
    try {
      const target = findUserById(String(req.params.id));
      if (!target) throw notFound('User not found.');
      await updateUser(target.id, { bumpSessionEpoch: true });
      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.sessions_revoked',
        detail: { email: target.email },
        ip: req.ip,
      });
      send(res, { revoked: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/users/:id', async (req, res, next) => {
    try {
      const target = findUserById(String(req.params.id));
      if (!target) throw notFound('User not found.');
      if (target.id === req.user!.id) throw badRequest('You cannot remove your own account.');

      await deleteUser(target.id);
      audit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: 'admin.user_deleted',
        detail: { email: target.email },
        ip: req.ip,
      });
      send(res, { deleted: true });
    } catch (err) {
      next(err);
    }
  });

  /* ---- Audit log ---------------------------------------------------- */

  router.get('/audit', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number.parseInt(String(req.query.limit ?? '200'), 10) || 200));
    send(res, { entries: readAudit(limit) });
  });

  return router;
}
