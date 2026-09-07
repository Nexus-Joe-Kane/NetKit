import { config } from '../config';
import { checkPasswordPolicy, hashPassword, randomToken } from './passwords';
import { audit, countAdmins, createUser, findUserByEmail, listUsers, normaliseEmail, updateUser } from './store';

/**
 * First-run administrator seeding.
 *
 * The credentials come from the environment, never from source control — a
 * password committed to a repository is a password that has leaked. On a
 * fresh install with no ADMIN_PASSWORD set, a random one is generated and
 * printed to the application log once, and the account is flagged to force a
 * change at first sign-in.
 */
export async function ensureAdminSeed(): Promise<void> {
  const email = normaliseEmail(process.env.ADMIN_EMAIL ?? 'joe@supportwizard.net');
  const existing = findUserByEmail(email);

  if (existing) {
    // Repair the one state that would lock everyone out: no active admin.
    if (countAdmins() === 0) {
      await updateUser(existing.id, { role: 'admin', disabled: false });
      console.warn(`[netkit] no active administrator found — restored admin rights for ${email}`);
    }
    return;
  }

  // Somebody else is already an admin, so don't silently add another.
  if (listUsers().length > 0 && countAdmins() > 0) return;

  const supplied = (process.env.ADMIN_PASSWORD ?? '').trim();
  const generated = !supplied;
  const password = supplied || `${randomToken(9)}Aa1`;

  if (supplied) {
    const policy = checkPasswordPolicy(supplied, email);
    if (!policy.ok) {
      console.warn(`[netkit] ADMIN_PASSWORD is weak: ${policy.problems.join(' ')} It has been accepted, but change it.`);
    }
  }

  const user = await createUser({
    email,
    name: process.env.ADMIN_NAME ?? 'Joe Kane',
    role: 'admin',
    passwordHash: await hashPassword(password),
    // A generated password must be replaced; a chosen one need not be.
    mustChangePassword: generated,
  });

  audit({ actorEmail: email, action: 'admin.seeded', detail: { generated } });

  console.log('');
  console.log('  ┌─ SupportWizard NetKit — administrator account created ─────────');
  console.log(`  │  Email:    ${user.email}`);
  if (generated) {
    console.log(`  │  Password: ${password}`);
    console.log('  │  This was generated because ADMIN_PASSWORD was not set.');
    console.log('  │  It is shown once only, and must be changed at first sign-in.');
  } else {
    console.log('  │  Password: taken from ADMIN_PASSWORD.');
  }
  console.log('  └────────────────────────────────────────────────────────────────');
  console.log('');

  if (config().env === 'production' && !config().sessionSecret) {
    console.warn('[netkit] SESSION_SECRET is not set — set it before going live, or sessions break on restart.');
  }
}
