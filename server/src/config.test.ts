import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isAbsolute } from 'node:path';
import { config, resetConfig } from './config';

/**
 * DATA_DIR holds the only state that cannot be rebuilt from Git, so the rules
 * about it are worth pinning: never relative, never silently defaulted in
 * production.
 */

const withEnv = <T>(vars: Record<string, string | undefined>, run: () => T): T => {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  }
};

test('a relative DATA_DIR is refused outright', () => {
  withEnv({ DATA_DIR: 'data', NODE_ENV: 'production' }, () => {
    assert.throws(() => config(), /absolute path/i);
  });
});

test('a relative DATA_DIR is refused in development too', () => {
  // The danger is the path, not the environment.
  withEnv({ DATA_DIR: './data', NODE_ENV: 'development' }, () => {
    assert.throws(() => config(), /absolute path/i);
  });
});

test('production refuses to start with DATA_DIR unset', () => {
  withEnv({ DATA_DIR: undefined, NODE_ENV: 'production' }, () => {
    assert.throws(() => config(), /DATA_DIR is not set/);
  });
});

test('development falls back to an absolute path', () => {
  withEnv({ DATA_DIR: undefined, NODE_ENV: 'development' }, () => {
    const dir = config().dataDir;
    assert.ok(isAbsolute(dir), `expected an absolute path, got ${dir}`);
  });
});

test('an absolute DATA_DIR is used as given', () => {
  withEnv({ DATA_DIR: '/var/www/vhosts/example.net/netkit-data', NODE_ENV: 'production' }, () => {
    assert.equal(config().dataDir, '/var/www/vhosts/example.net/netkit-data');
  });
});
