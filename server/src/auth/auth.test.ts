import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPasswordPolicy, hashPassword, numericCode, randomToken, verifyPassword } from './passwords';

test('a password round-trips through scrypt', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('each hash uses a fresh salt', async () => {
  const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
  assert.notEqual(a, b, 'identical passwords must not produce identical hashes');
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('malformed stored hashes are rejected rather than throwing', async () => {
  for (const bad of ['', 'nonsense', 'scrypt$bad', 'bcrypt$1$2$3$4$5', 'scrypt$16384$8$1$only-salt']) {
    assert.equal(await verifyPassword('anything', bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('the password policy is length-led and rejects the obvious', () => {
  assert.equal(checkPasswordPolicy('Str0ngEnoughPassphrase').ok, true);
  assert.equal(checkPasswordPolicy('short1A').ok, false);
  assert.equal(checkPasswordPolicy('alllowercase123').ok, false, 'needs mixed case');
  assert.equal(checkPasswordPolicy('NoDigitsInHere').ok, false, 'needs a digit');
  assert.equal(checkPasswordPolicy('password123ABC').ok, false, 'too predictable');
  // A password containing the account name is a common weak choice.
  assert.equal(checkPasswordPolicy('JoeKane12345A', 'joekane@supportwizard.net').ok, false);
  assert.ok(checkPasswordPolicy('short').problems.length >= 2);
});

test('one-time codes are six digits and reasonably distributed', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const code = numericCode(6);
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  // Collisions are possible but 500 draws from a million should be near-unique.
  assert.ok(codes.size > 480, `expected near-unique codes, got ${codes.size}`);
});

test('tokens are url-safe and unique', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => randomToken(32)));
  assert.equal(tokens.size, 200);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]+$/);
});
