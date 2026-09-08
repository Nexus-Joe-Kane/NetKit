import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { boundingBox, distanceMetres, formatDistance } from './geo';

const MANCHESTER = { latitude: 53.4808, longitude: -2.2426 };
const LEEDS = { latitude: 53.8008, longitude: -1.5491 };
const LONDON = { latitude: 51.5074, longitude: -0.1278 };

test('a known distance comes out right', () => {
  // Manchester to Leeds is about 58 km as the crow flies.
  const d = distanceMetres(MANCHESTER, LEEDS);
  assert.ok(d > 56_000 && d < 60_000, `expected ~58 km, got ${d} m`);
});

test('Manchester to London is about 262 km', () => {
  const d = distanceMetres(MANCHESTER, LONDON);
  assert.ok(d > 255_000 && d < 270_000, `got ${d} m`);
});

test('a point is no distance from itself', () => {
  assert.equal(distanceMetres(MANCHESTER, MANCHESTER), 0);
});

test('distance is the same in both directions', () => {
  assert.equal(distanceMetres(MANCHESTER, LEEDS), distanceMetres(LEEDS, MANCHESTER));
});

test('a short distance is accurate to the metre', () => {
  // A tenth of a degree of latitude is about 11.1 km.
  const d = distanceMetres({ latitude: 53.0, longitude: -2.0 }, { latitude: 53.1, longitude: -2.0 });
  assert.ok(d > 11_000 && d < 11_200, `got ${d} m`);
});

test('a bounding box is wider in longitude than in latitude', () => {
  // Longitude degrees shrink towards the poles, so a box on the ground needs
  // a wider span in degrees east-west than north-south.
  const box = boundingBox(MANCHESTER, 5_000);
  const latSpan = box.north - box.south;
  const lonSpan = box.east - box.west;
  assert.ok(lonSpan > latSpan, 'longitude span should be wider in degrees');
});

test('the box actually contains the requested radius', () => {
  const box = boundingBox(MANCHESTER, 5_000);
  const northEdge = { latitude: box.north, longitude: MANCHESTER.longitude };
  const eastEdge = { latitude: MANCHESTER.latitude, longitude: box.east };
  assert.ok(distanceMetres(MANCHESTER, northEdge) >= 4_900);
  assert.ok(distanceMetres(MANCHESTER, eastEdge) >= 4_900);
});

test('a box near the pole does not blow up', () => {
  const box = boundingBox({ latitude: 89.99, longitude: 0 }, 5_000);
  assert.ok(Number.isFinite(box.east) && Number.isFinite(box.west));
});

test('distances read the way a person would say them', () => {
  assert.equal(formatDistance(380), '380 m');
  assert.equal(formatDistance(999), '999 m');
  assert.equal(formatDistance(1000), '1.0 km');
  assert.equal(formatDistance(4237), '4.2 km');
  assert.equal(formatDistance(58_000), '58 km');
});
