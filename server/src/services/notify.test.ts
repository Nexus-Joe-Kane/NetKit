import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { channelDetail, pickChannel, textToHtml } from './notify';

test('Zendesk wins when it is configured, email is the fallback', () => {
  assert.equal(pickChannel(true, true), 'zendesk');
  assert.equal(pickChannel(true, false), 'zendesk');
  assert.equal(pickChannel(false, true), 'email');
  assert.equal(pickChannel(false, false), 'none');
});

test('the status sentence says whether there is a fallback', () => {
  assert.match(channelDetail('zendesk', true), /fallback/i);
  assert.match(channelDetail('zendesk', false), /no email fallback/i);
  assert.match(channelDetail('email', true), /Resend/);
  assert.match(channelDetail('none', false), /audit log only/);
});

test('the plain-text body becomes paragraphs and bullets', () => {
  const html = textToHtml('Something changed.\n\n- Now offered: FTTP\n- RFS date moved');
  assert.match(html, /<p[^>]*>Something changed\.<\/p>/);
  assert.match(html, /<ul/);
  assert.match(html, /<li>Now offered: FTTP<\/li>/);
  assert.match(html, /<li>RFS date moved<\/li>/);
});

test('single newlines stay inside one paragraph', () => {
  const html = textToHtml('First line\nSecond line');
  assert.equal((html.match(/<p/g) ?? []).length, 1);
  assert.match(html, /First line<br>Second line/);
});

test('markup in a notice cannot reach the inbox raw', () => {
  // These bodies carry provider error strings and AddressBase names, so the
  // conversion has to escape rather than trust.
  const html = textToHtml('Provider said: <script>alert(1)</script> at Smith & Jones "Ltd"');
  assert.ok(!html.includes('<script>'), 'the script tag must not survive');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Smith &amp; Jones &quot;Ltd&quot;/);
});
