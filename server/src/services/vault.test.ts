import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VAULT_KEYS, vaultKey } from '@sw/shared';
import {
  clearSecret,
  loadVaultIntoEnv,
  refreshVaultIfChanged,
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

/* ------------------------------------------------------------------ *
 * Several workers, one file
 *
 * Passenger runs a handful of worker processes, each with its own copy of
 * this module. Both bugs below were live: credentials that vanished, and
 * credentials the Credentials page said were stored while the Integrations
 * page said "not connected".
 * ------------------------------------------------------------------ */

/** A worker that has not looked at the file since it booted. */
const staleWorker = (): void => {
  reloadVault();
  loadVaultIntoEnv();
};

test('a save through one worker does not delete what another worker saved', () => {
  // The reported bug, exactly. Worker A boots with an empty vault and saves
  // IT Glue. Worker B, which also booted empty and never re-read, saves
  // UniFi — and wrote a file with only UniFi in it. Both saves said "saved".
  const d = dir();
  withSecret('a-stable-session-secret-value-32ch', () => {
    staleWorker(); // worker A boots
    assert.equal(setSecret('ITGLUE_API_KEY', 'itglue-aaaaaaaaaaaaaaaaaaaaaaaa').ok, true);

    staleWorker(); // worker B, whose memory predates the line above
    assert.equal(setSecret('UNIFI_API_KEY', 'unifi-bbbbbbbbbbbbbbbbbbbbbbbbb').ok, true);

    const onDisk = JSON.parse(readFileSync(join(d, 'vault.json'), 'utf8')) as {
      secrets: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(onDisk.secrets).sort(), ['ITGLUE_API_KEY', 'UNIFI_API_KEY']);
  });
});

test('removing one credential leaves every other one alone', () => {
  const d = dir();
  withSecret('a-stable-session-secret-value-32ch', () => {
    setSecret('ITGLUE_API_KEY', 'itglue-aaaaaaaaaaaaaaaaaaaaaaaa');
    setSecret('UNIFI_API_KEY', 'unifi-bbbbbbbbbbbbbbbbbbbbbbbbb');
    setSecret('JOLA_USERNAME', 'joe@supportwizard.net');

    staleWorker();
    assert.equal(clearSecret('UNIFI_API_KEY'), true);

    const onDisk = JSON.parse(readFileSync(join(d, 'vault.json'), 'utf8')) as {
      secrets: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(onDisk.secrets).sort(), ['ITGLUE_API_KEY', 'JOLA_USERNAME']);
  });
});

test('a worker picks up a credential another worker saved', () => {
  // The other half: `setSecret` puts the value into the environment of the
  // one process that handled the request, so the others went on answering
  // "not connected" for a key that was plainly stored.
  dir();
  withSecret('a-stable-session-secret-value-32ch', () => {
    staleWorker();
    assert.equal(refreshVaultIfChanged().changed, false, 'nothing has changed yet');

    setSecret('UNIFI_API_KEY', 'unifi-bbbbbbbbbbbbbbbbbbbbbbbbb');

    // Stand in for a different worker: forget everything, boot, then let the
    // per-request refresh do its job.
    delete process.env.UNIFI_API_KEY;
    reloadVault();

    const refresh = refreshVaultIfChanged();
    assert.equal(refresh.changed, true);
    assert.deepEqual(refresh.loaded, ['UNIFI_API_KEY']);
    assert.equal(process.env.UNIFI_API_KEY, 'unifi-bbbbbbbbbbbbbbbbbbbbbbbbb');
  });
});

test('the refresh is a no-op when nothing has moved', () => {
  // It runs on every request, so it has to be free when there is nothing to do.
  dir();
  withSecret('a-stable-session-secret-value-32ch', () => {
    setSecret('UNIFI_API_KEY', 'unifi-bbbbbbbbbbbbbbbbbbbbbbbbb');
    staleWorker();
    assert.equal(refreshVaultIfChanged().changed, false);
    assert.equal(refreshVaultIfChanged().changed, false);
  });
});

test('a stored credential still reads back after a stale worker writes', () => {
  // Not just present in the file — actually decryptable, since each value
  // carries its own salt and a botched merge could pair the wrong ones.
  dir();
  withSecret('a-stable-session-secret-value-32ch', () => {
    setSecret('ITGLUE_API_KEY', 'itglue-aaaaaaaaaaaaaaaaaaaaaaaa');
    staleWorker();
    setSecret('UNIFI_API_KEY', 'unifi-bbbbbbbbbbbbbbbbbbbbbbbbb');

    delete process.env.ITGLUE_API_KEY;
    delete process.env.UNIFI_API_KEY;
    reloadVault();
    loadVaultIntoEnv();

    assert.equal(process.env.ITGLUE_API_KEY, 'itglue-aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(process.env.UNIFI_API_KEY, 'unifi-bbbbbbbbbbbbbbbbbbbbbbbbb');
    for (const row of secretStatus()) {
      if (row.name === 'ITGLUE_API_KEY' || row.name === 'UNIFI_API_KEY') {
        assert.equal(row.source, 'vault');
        assert.notEqual(row.unreadable, true, `${row.name} sealed but unreadable`);
      }
    }
  });
});

test('a leftover lock from a crashed worker does not block a save for ever', () => {
  const d = dir();
  withSecret('a-stable-session-secret-value-32ch', () => {
    setSecret('JOLA_USERNAME', 'joe@supportwizard.net');
    // A lock nobody is holding, old enough to be stale.
    writeFileSync(join(d, 'vault.json.lock'), '', { encoding: 'utf8', mode: 0o600 });
    utimesSync(join(d, 'vault.json.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    assert.equal(setSecret('JOLA_PASSWORD', 'something-long-enough').ok, true);
    assert.equal(existsSync(join(d, 'vault.json.lock')), false, 'and the lock is released');
  });
});
