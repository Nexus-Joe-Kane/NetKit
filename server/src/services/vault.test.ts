import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VAULT_KEYS, vaultKey } from '@sw/shared';
import {
  clearSecret,
  loadVaultIntoEnv,
  reloadVault,
  secretStatus,
  setSecret,
  useVaultDir,
  vaultUsable,
  withCandidate,
} from './vault';

const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'netkit-vault-'));
  useVaultDir(d);
  return d;
};

const withSecret = (secret: string, run: () => void): void => {
  const before = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = secret;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = before;
  }
};

const KEY = 'ZENDESK_API_TOKEN';
const clean = (): void => {
  delete process.env[KEY];
};

test('a stored credential comes back, and never in plaintext on disk', () => {
  const d = dir();
  withSecret('a-long-enough-session-secret', () => {
    clean();
    assert.deepEqual(setSecret(KEY, 'sk-live-abcdef123456', 'joe@supportwizard.net'), { ok: true });

    const raw = readFileSync(join(d, 'vault.json'), 'utf8');
    assert.ok(!raw.includes('sk-live-abcdef123456'), 'the value must not be readable from the file');
    assert.ok(raw.includes(KEY), 'the name is not a secret');

    // Setting it also makes it live, so there is no restart in the loop.
    assert.equal(process.env[KEY], 'sk-live-abcdef123456');

    clean();
    reloadVault();
    const { loaded } = loadVaultIntoEnv();
    assert.deepEqual(loaded, [KEY]);
    assert.equal(process.env[KEY], 'sk-live-abcdef123456');
    clean();
  });
});

test('a changed SESSION_SECRET makes the vault unreadable, and it says so', () => {
  // Stated rather than hidden: the alternative is an integration that looks
  // unconfigured for a reason nothing on the screen explains.
  dir();
  withSecret('first-session-secret-long', () => {
    clean();
    setSecret(KEY, 'sk-live-abcdef123456');
  });
  withSecret('second-session-secret-long', () => {
    clean();
    reloadVault();
    const { loaded, unreadable } = loadVaultIntoEnv();
    assert.deepEqual(loaded, []);
    assert.deepEqual(unreadable, [KEY]);

    const status = secretStatus().find((k) => k.name === KEY);
    assert.equal(status?.unreadable, true);
    assert.equal(status?.source, 'vault');
    clean();
  });
});

test('the status list says where each live value comes from, and never what it is', () => {
  dir();
  withSecret('a-long-enough-session-secret', () => {
    clean();
    process.env.OS_PLACES_API_KEY = 'from-plesk';
    setSecret(KEY, 'sk-live-abcdef123456', 'joe@supportwizard.net');

    const status = secretStatus();
    const vaulted = status.find((k) => k.name === KEY)!;
    assert.equal(vaulted.source, 'vault');
    assert.equal(vaulted.length, 20);
    assert.equal(vaulted.setBy, 'joe@supportwizard.net');

    const fromEnv = status.find((k) => k.name === 'OS_PLACES_API_KEY')!;
    assert.equal(fromEnv.source, 'environment');

    const unset = status.find((k) => k.name === 'BT_IMEI_LOOKUP_KEY')!;
    assert.equal(unset.source, 'unset');
    assert.equal(unset.length, undefined);

    // Nothing anywhere in the payload resembles the value or a prefix of it.
    const serialised = JSON.stringify(status);
    assert.ok(!serialised.includes('sk-live'), 'not even a prefix leaves the server');
    assert.ok(!serialised.includes('from-plesk'));

    delete process.env.OS_PLACES_API_KEY;
    clean();
  });
});

test('only known credentials can be stored', () => {
  // An open store of environment variables is a way to set NODE_OPTIONS from
  // a web form, which is remote code execution with extra steps.
  dir();
  withSecret('a-long-enough-session-secret', () => {
    const before = process.env.NODE_OPTIONS;
    const result = setSecret('NODE_OPTIONS', '--require /tmp/evil.js');
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /not a credential/);
    assert.equal(process.env.NODE_OPTIONS, before, 'the environment must be untouched');
  });
});

test('a weak or absent SESSION_SECRET refuses the vault rather than using it', () => {
  dir();
  withSecret('short', () => {
    assert.equal(vaultUsable().ok, false);
    const result = setSecret(KEY, 'anything');
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /SESSION_SECRET/);
  });
});

test('clearing a credential takes it out of the environment too', () => {
  // Otherwise removing a key in the portal leaves the integration running on
  // a value nothing can see any more.
  const d = dir();
  withSecret('a-long-enough-session-secret', () => {
    clean();
    setSecret(KEY, 'sk-live-abcdef123456');
    assert.equal(clearSecret(KEY), true);
    assert.equal(process.env[KEY], undefined);
    assert.equal(clearSecret(KEY), false, 'clearing twice is not an error');
    assert.ok(existsSync(join(d, 'vault.json')));
  });
});

test('a candidate is restored afterwards, even when the probe throws', () => {
  dir();
  process.env[KEY] = 'the-old-value';
  const run = async (): Promise<void> => {
    await withCandidate({ [KEY]: 'the-candidate' }, async () => {
      assert.equal(process.env[KEY], 'the-candidate');
      throw new Error('probe failed');
    });
  };
  return run().then(
    () => assert.fail('should have rethrown'),
    () => {
      assert.equal(process.env[KEY], 'the-old-value', 'the previous value must come back');
      clean();
    },
  );
});

test('a candidate for a previously unset key leaves it unset', () => {
  dir();
  clean();
  return withCandidate({ [KEY]: 'the-candidate' }, async () => process.env[KEY]).then((seen) => {
    assert.equal(seen, 'the-candidate');
    assert.equal(process.env[KEY], undefined, 'not left behind as an empty string');
  });
});

test('every key belongs to a service, so the test button has something to probe', () => {
  for (const def of VAULT_KEYS) {
    assert.ok(def.service, `${def.name} has no service`);
    assert.equal(vaultKey(def.name), def);
  }
  // Passwords and tokens are marked, so the form knows to mask them.
  const secrets = VAULT_KEYS.filter((k) => k.secret).map((k) => k.name);
  assert.ok(secrets.includes('ZEN_CLIENT_SECRET'));
  assert.ok(secrets.includes('ZENDESK_API_TOKEN'));
  assert.ok(!secrets.includes('ZENDESK_SUBDOMAIN'), 'a subdomain is not a secret');
});
