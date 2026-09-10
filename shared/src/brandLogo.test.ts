import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  logoCacheName,
  logoCandidates,
  logoExtension,
  logoUrl,
  looksLikeImage,
} from './index';

test('the browser asks the portal for a logo, never the supplier', () => {
  assert.equal(logoUrl('zen'), '/api/brand/logo/zen');
  // A key from an unrecognised provider name still produces one safe path.
  assert.equal(logoUrl('g network/london'), '/api/brand/logo/g%20network%2Flondon');
});

test('candidates prefer the touch icon over the favicon, and try www both ways', () => {
  const list = logoCandidates('bt.com');
  assert.ok(list[0]?.endsWith('/apple-touch-icon.png'), String(list[0]));
  assert.ok(list.some((u) => u === 'https://www.bt.com/apple-touch-icon.png'));
  assert.ok(list.some((u) => u === 'https://bt.com/favicon.ico'));
  assert.ok(list.every((u) => u.startsWith('https://')), 'never plain http');
});

test('a domain given with a scheme or a path is tidied rather than refused', () => {
  const list = logoCandidates('https://www.zen.co.uk/business/');
  assert.ok(list.includes('https://www.zen.co.uk/favicon.ico'), list.join(' '));
  assert.ok(list.includes('https://zen.co.uk/favicon.ico'));
});

test('something that is not a domain produces no candidates at all', () => {
  assert.deepEqual(logoCandidates(''), []);
  assert.deepEqual(logoCandidates('localhost'), []);
  assert.deepEqual(logoCandidates('   '), []);
});

test('only real image types are kept, and SVG is deliberately not one', () => {
  assert.equal(logoExtension('image/png'), 'png');
  assert.equal(logoExtension('image/x-icon; charset=binary'), 'ico');
  assert.equal(logoExtension('IMAGE/PNG'), 'png');
  assert.equal(logoExtension('text/html'), undefined);
  // An SVG is a document that can carry script, and this endpoint serves
  // from our own origin.
  assert.equal(logoExtension('image/svg+xml'), undefined);
  assert.equal(logoExtension(null), undefined);
  assert.equal(logoExtension(undefined), undefined);
  assert.ok(!Object.keys(LOGO_TYPES).some((t) => t.includes('svg')));
});

test('the bytes are checked, not just the header a stranger sent', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]);
  const ico = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 0, 0, 0, 0]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45]);
  for (const [name, bytes] of Object.entries({ png, jpeg, ico, gif, webp })) {
    assert.equal(looksLikeImage(bytes), true, name);
  }
  // A login page served as image/png is a thing that happens.
  assert.equal(looksLikeImage(new TextEncoder().encode('<!doctype html><html>')), false);
  assert.equal(looksLikeImage(new Uint8Array([1, 2, 3])), false, 'too short to judge');
});

test('the cache name can never escape its directory', () => {
  assert.equal(logoCacheName('zen'), 'zen');
  assert.equal(logoCacheName('../../etc/passwd'), 'etc-passwd');
  assert.equal(logoCacheName('G.Network London'), 'g.network-london');
  assert.equal(logoCacheName('..'), 'unknown');
  assert.equal(logoCacheName(''), 'unknown');
  assert.ok(!logoCacheName('a/b/c').includes('/'));
  assert.ok(logoCacheName('x'.repeat(200)).length <= 60);
});

test('the size cap is small enough to be a cap and large enough for a real icon', () => {
  assert.ok(LOGO_MAX_BYTES >= 64 * 1024 && LOGO_MAX_BYTES <= 512 * 1024);
});
