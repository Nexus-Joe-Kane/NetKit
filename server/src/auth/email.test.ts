import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { escapeHtml, escalationEmail, watchChangeEmail } from './email';

test('markup in text is escaped, not passed through', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('Smith & Jones "Ltd"'), 'Smith &amp; Jones &quot;Ltd&quot;');
  assert.equal(escapeHtml("O'Brien"), 'O&#39;Brien');
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('ampersands are escaped before the rest, not twice', () => {
  // Escaping < first would turn it into &lt; and then the & pass would
  // mangle that into &amp;lt;.
  assert.equal(escapeHtml('a < b & c'), 'a &lt; b &amp; c');
});

test('an address with an ampersand survives the watch email intact', () => {
  const mail = watchChangeEmail({
    address: 'Megan & Co, 45 Brockley Rise, LONDON, SE23 1JG',
    uprn: '100023253338',
    changes: ['Best available is now FTTP (was SOGEA)'],
  });
  assert.match(mail.html, /Megan &amp; Co/);
  assert.ok(!mail.html.includes('Megan & Co'), 'the raw ampersand must not reach the HTML');
  // The plain text part is not HTML and should be readable as typed.
  assert.match(mail.text, /Megan & Co/);
});

test('the watch email names the premises and lists every change', () => {
  const mail = watchChangeEmail({
    address: '45 Brockley Rise, LONDON, SE23 1JG',
    uprn: '100023253338',
    changes: ['Now offered: FTTP', 'FTTP ready-for-service date is now 2027-03-31'],
  });
  assert.match(mail.subject, /45 Brockley Rise/);
  assert.match(mail.html, /Now offered: FTTP/);
  assert.match(mail.html, /2027-03-31/);
  assert.match(mail.text, /- Now offered: FTTP/);
  // It must not read as an order confirmation.
  assert.match(mail.text, /not an order/);
});

test('a provider error containing markup cannot inject into the escalation email', () => {
  const mail = escalationEmail({
    name: 'Zen — Availability',
    key: 'zen-availability',
    failingSince: new Date(Date.now() - 30 * 60_000).toISOString(),
    lastError: 'responded 500: <img src=x onerror="alert(1)">',
    recoveryAttempts: 2,
    capability: 'Availability & address',
  });
  assert.ok(!mail.html.includes('<img src=x'), 'raw markup must not reach the HTML');
  assert.match(mail.html, /&lt;img src=x/);
});
