import { angleDelta, bearingOf, deg, rad } from "./geo";
import type { Building, Horizon, Viewpoint } from "./types";

export const AZIMUTH_STEPS = 360;

/**
 * The skyline as seen from one window: for every degree of the compass, how
 * high the built-up world rises, and what is doing the rising.
 *
 * Terrain is treated as flat. Singapore's residential plateaus are, mostly, and
 * the alternative needs a licensed elevation model.
 */
export function computeHorizon(viewpoint: Viewpoint, buildings: Building[]): Horizon {
  const elevation = new Float64Array(AZIMUTH_STEPS);
  const distance = new Float64Array(AZIMUTH_STEPS).fill(Infinity);
  const blockedBy: (string | null)[] = new Array(AZIMUTH_STEPS).fill(null);

  const dirX = new Float64Array(AZIMUTH_STEPS);
  const dirY = new Float64Array(AZIMUTH_STEPS);
  for (let a = 0; a < AZIMUTH_STEPS; a++) {
    dirX[a] = Math.sin(rad(a));
    dirY[a] = Math.cos(rad(a));
  }

  for (const b of buildings) {
    const rise = b.height - viewpoint.z;
    if (rise <= 0.05) continue; // Nothing at or below eye level can block the sky.

    const ring = b.ring;
    const n = ring.length;

    // Only sweep the arc the building actually occupies. A building we are
    // standing against can wrap past a half-turn, in which case we sweep all.
    const arc = angularArc(ring, viewpoint.x, viewpoint.y);
    const azimuths = arc ? arcIndices(arc.start, arc.end) : allIndices();

    for (const a of azimuths) {
      const dx = dirX[a];
      const dy = dirY[a];
      let nearest = Infinity;

      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = ring[j][0] - viewpoint.x;
        const ay = ring[j][1] - viewpoint.y;
        const ex = ring[i][0] - ring[j][0];
        const ey = ring[i][1] - ring[j][1];

        const det = dx * ey - dy * ex;
        if (Math.abs(det) < 1e-12) continue;

        const t = (ax * ey - ay * ex) / det;
        if (t <= 0.01 || t >= nearest) continue;
        const u = (ax * dy - ay * dx) / det;
        if (u < 0 || u > 1) continue;

        nearest = t;
      }

      if (nearest === Infinity) continue;
      const el = deg(Math.atan2(rise, nearest));
      if (el > elevation[a]) {
        elevation[a] = el;
        distance[a] = nearest;
        blockedBy[a] = b.id;
      }
    }
  }

  return { elevation, distance, blockedBy };
}

function allIndices() {
  return Array.from({ length: AZIMUTH_STEPS }, (_, i) => i);
}

/** Smallest compass arc containing every vertex, or null if it exceeds 170 degrees. */
function angularArc(ring: [number, number][], px: number, py: number) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x;
    cy += y;
  }
  const reference = bearingOf(cx / ring.length - px, cy / ring.length - py);

  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of ring) {
    const d = angleDelta(bearingOf(x - px, y - py), reference);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  if (max - min > 170) return null;
  // A degree of slack either side so a grazing edge is never missed.
  return { start: reference + min - 1, end: reference + max + 1 };
}

function arcIndices(startDeg: number, endDeg: number) {
  const out: number[] = [];
  const from = Math.floor(startDeg);
  const to = Math.ceil(endDeg);
  for (let a = from; a <= to; a++) out.push(((a % 360) + 360) % 360);
  return out;
}

/** Horizon elevation at any azimuth, linearly interpolated between whole degrees. */
export function horizonAt(horizon: Horizon, azimuth: number) {
  const a = ((azimuth % 360) + 360) % 360;
  const i = Math.floor(a);
  const f = a - i;
  const lo = horizon.elevation[i];
  const hi = horizon.elevation[(i + 1) % AZIMUTH_STEPS];
  return lo + (hi - lo) * f;
}
