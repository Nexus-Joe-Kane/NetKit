#!/usr/bin/env node
/**
 * Refuses to let a credential be committed.
 *
 * `.env.example` is tracked by design, and on the live deployment it had been
 * filled in with a real session secret, the admin password and the Zen, OS
 * Places and Companies House keys. None of them did anything -- the app only
 * ever reads `.env` -- but one `git add -A` on that server would have pushed
 * the lot to GitHub in plaintext, where deleting them later does not help.
 *
 * So this checks the template really is a template. It is deliberately about
 * shape rather than a list of known secrets: any key that looks like a
 * credential must have an empty value.
 *
 *   node scripts/check-secrets.mjs [file...]
 *
 * Exits non-zero and names the offending lines.
 */
import { readFileSync, existsSync } from 'node:fs';

/** Keys whose value must be empty in a committed template. */
const SECRET_KEY = /(SECRET|PASSWORD|PASSWD|_KEY|APIKEY|TOKEN|CREDENTIAL|PRIVATE)/i;

/** ...except these, which name an endpoint rather than hold a credential. */
const NOT_SECRET = /(_URL|_PATH|_BASE|_SCOPES?|_ENDPOINT|_ID_URL)$/i;

const files = process.argv.slice(2);
const targets = files.length > 0 ? files : ['.env.example'];

let failures = 0;

for (const file of targets) {
  if (!existsSync(file)) {
    console.error(`!! ${file} does not exist`);
    failures += 1;
    continue;
  }

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed);
    if (!match) return;

    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, '');
    if (value === '') return;
    if (!SECRET_KEY.test(key) || NOT_SECRET.test(key)) return;
    // A switch is not a credential, however its key is spelled --
    // THINKBROADBAND_KEY_IN_QUERY=false is a flag about where the key goes.
    if (/^(true|false|yes|no|on|off|\d+)$/i.test(value)) return;

    // Report the key and the length only. Printing the value would copy a
    // live credential into CI logs, which is the problem, not the fix.
    console.error(
      `!! ${file}:${index + 1}: ${key} has a value (${value.length} chars). ` +
        'Committed templates must leave credentials empty -- put the real ' +
        'value in .env or the Plesk environment.',
    );
    failures += 1;
  });
}

if (failures > 0) {
  console.error(`\n${failures} credential-shaped value(s) found. Nothing was changed.`);
  process.exit(1);
}

console.log(`check:secrets — ${targets.join(', ')} clean.`);
