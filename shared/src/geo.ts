/**
 * Distance between two points on the ground.
 *
 * Needed because a coverage figure published per parliamentary constituency
 * cannot explain why one customer has no signal. "The nearest EE site is
 * 4.2 km away across a hill" can.
 */

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than anything cleverer: over the few kilometres that
 * matter for a mast, the error against a proper ellipsoidal calculation is
 * a couple of metres, and nobody is making a decision on that.
 */
export function distanceMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)));
}

/**
 * A box around a point, for APIs that take one instead of a radius.
 *
 * Longitude degrees shrink towards the poles, so the east-west span is
 * divided by the cosine of the latitude -- without it a box around Shetland
 * is nearly twice as wide on the ground as one around Cornwall.
 */
export function boundingBox(
  centre: { latitude: number; longitude: number },
  radiusMetres: number,
): { south: number; west: number; north: number; east: number } {
  const latDelta = (radiusMetres / EARTH_RADIUS_M) * (180 / Math.PI);
  const cos = Math.cos(toRadians(centre.latitude));
  // Guard the poles, where the correction tends to infinity.
  const lonDelta = latDelta / Math.max(0.01, Math.abs(cos));

  return {
    south: centre.latitude - latDelta,
    west: centre.longitude - lonDelta,
    north: centre.latitude + latDelta,
    east: centre.longitude + lonDelta,
  };
}

/** `4.2 km` or `380 m` — whichever a person would say. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}
