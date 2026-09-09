import type { MastSite } from './types';

/**
 * A locked map of what is around a premises.
 *
 * Deliberately a drawing rather than a street map, and worth explaining
 * because it is not what somebody first pictures.
 *
 * The question a mast map answers is "why has this customer no signal when
 * the area is fine" — and the answer is about distance and direction, not
 * about which side of the road they are on. A radial plot at a stated scale
 * shows that at a glance; a street map shows the streets and buries it.
 *
 * It also costs nothing to run. No tile server, no API key, no third-party
 * request from a page an engineer is using to fix an outage, and no
 * dependency that can be having a bad afternoon. A tile background can be
 * layered under this later if one is ever wanted; the geometry does not
 * change.
 *
 * And it is locked because it should be: a map that can be dragged is a map
 * somebody drags, loses, and then cannot get back to the premises on.
 */

export interface Plotted {
  /** Position in the SVG viewbox. */
  x: number;
  y: number;
  /** Metres from the premises. */
  distance: number;
  /** Degrees clockwise from north. */
  bearing: number;
  mast: MastSite;
  /** True where the mast is beyond the plotted radius and pinned to the edge. */
  clamped: boolean;
}

export interface MastPlot {
  size: number;
  centre: { x: number; y: number };
  /** Metres from the centre to the edge of the plot. */
  radiusMetres: number;
  /** Rings to draw, with the distance each represents. */
  rings: Array<{ radius: number; metres: number }>;
  masts: Plotted[];
  /** True where at least one mast sat beyond the radius. */
  anyClamped: boolean;
}

/**
 * Where to draw the outer ring.
 *
 * Rounded up to something a person can read off — 250m, 500m, 1km — rather
 * than to the exact furthest mast, because "the ring is 1km" is a fact
 * somebody can use and "the ring is 837m" is one they have to think about.
 */
export function plotRadius(distances: readonly number[]): number {
  const furthest = Math.max(0, ...distances.filter((d) => Number.isFinite(d)));
  const steps = [250, 500, 1000, 2000, 5000, 10_000, 20_000];
  return steps.find((step) => furthest <= step) ?? steps[steps.length - 1]!;
}

/**
 * Bearing from one point to another, in degrees clockwise from north.
 *
 * Great-circle rather than flat trigonometry. At UK latitudes over a
 * kilometre the difference is under a degree, so this is not about accuracy
 * — it is that the flat version is wrong in a way that grows, and there is
 * no reason to leave that in the code for somebody to find later.
 */
export function bearingBetween(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const φ1 = toRad(from.latitude);
  const φ2 = toRad(to.latitude);
  const Δλ = toRad(to.longitude - from.longitude);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Metres between two points, on a sphere. */
export function metresBetween(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const φ1 = toRad(from.latitude);
  const φ2 = toRad(to.latitude);
  const Δφ = φ2 - φ1;
  const Δλ = toRad(to.longitude - from.longitude);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Compass point for a bearing, because "NE" reads faster than "43°". */
export function compassPoint(bearing: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(((bearing % 360) / 22.5)) % 16]!;
}

/**
 * The plot.
 *
 * Masts beyond the radius are clamped to the edge rather than dropped,
 * because "the nearest mast is off this plot" is the single most useful
 * thing the drawing can say about a customer with no signal, and dropping it
 * would leave an empty circle that reads as no data.
 */
export function plotMasts(input: {
  premises: { latitude?: number; longitude?: number };
  masts: readonly MastSite[];
  /** SVG viewbox side. */
  size?: number;
  radiusMetres?: number;
}): MastPlot | null {
  const { latitude, longitude } = input.premises;
  if (latitude === undefined || longitude === undefined) return null;

  const size = input.size ?? 240;
  const centre = { x: size / 2, y: size / 2 };
  // Leave room for the mast marks so one at the edge is not half outside.
  const drawable = size / 2 - 14;

  const measured = input.masts
    .filter((m) => Number.isFinite(m.latitude) && Number.isFinite(m.longitude))
    .map((mast) => {
      const from = { latitude, longitude };
      const to = { latitude: mast.latitude, longitude: mast.longitude };
      return {
        mast,
        // The provider's own distance where it gave one; ours otherwise, so
        // the two never disagree on screen.
        distance: Number.isFinite(mast.distanceMetres) ? mast.distanceMetres : metresBetween(from, to),
        bearing: bearingBetween(from, to),
      };
    });

  const radiusMetres = input.radiusMetres ?? plotRadius(measured.map((m) => m.distance));

  const masts: Plotted[] = measured
    .sort((a, b) => a.distance - b.distance)
    .map(({ mast, distance, bearing }) => {
      const clamped = distance > radiusMetres;
      const ratio = clamped ? 1 : distance / radiusMetres;
      // Screen y grows downwards, so north is negative.
      const radians = (bearing * Math.PI) / 180;
      return {
        x: Math.round((centre.x + Math.sin(radians) * ratio * drawable) * 10) / 10,
        y: Math.round((centre.y - Math.cos(radians) * ratio * drawable) * 10) / 10,
        distance,
        bearing,
        mast,
        clamped,
      };
    });

  return {
    size,
    centre,
    radiusMetres,
    // Three rings: a third, two thirds, and the edge. More is clutter at
    // this size and fewer gives nothing to judge distance against.
    rings: [1 / 3, 2 / 3, 1].map((fraction) => ({
      radius: Math.round(drawable * fraction * 10) / 10,
      metres: Math.round(radiusMetres * fraction),
    })),
    masts,
    anyClamped: masts.some((m) => m.clamped),
  };
}

/**
 * How the plot reads underneath, in a sentence.
 *
 * A drawing without a number next to it makes somebody estimate from pixels.
 */
export function plotCaption(plot: MastPlot | null, exchangeMetres?: number): string {
  if (!plot) return 'No coordinates for this premises, so nothing can be plotted.';
  if (!plot.masts.length) {
    return `No masts reported within ${formatMetres(plot.radiusMetres)}. OpenCelliD is crowdsourced, so an empty plot means nobody has reported one, not that there is none.`;
  }

  const nearest = plot.masts[0]!;
  const parts = [
    `Nearest reported mast ${formatMetres(nearest.distance)} to the ${compassPoint(nearest.bearing)}` +
      (nearest.mast.operator ? ` (${nearest.mast.operator})` : ''),
  ];
  if (exchangeMetres !== undefined) parts.push(`exchange ${formatMetres(exchangeMetres)} away`);
  if (plot.anyClamped) parts.push('masts on the edge are further than the outer ring');
  parts.push('positions are crowdsourced and approximate');
  return `${parts.join(' · ')}.`;
}

export function formatMetres(metres: number): string {
  if (!Number.isFinite(metres)) return 'an unknown distance';
  if (metres >= 1000) return `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km`;
  return `${Math.round(metres)} m`;
}
