import { angleDelta, rad, wrap360 } from "./geo";
import { AZIMUTH_STEPS } from "./horizon";
import type { BlockageMetrics, Building, Horizon, Viewpoint } from "./types";

/** Horizon above this is read as "a wall in the way" rather than "a low skyline". */
const HEAVY_BLOCK_DEG = 20;
/** Below this the view reads as open sky. */
const OPEN_VIEW_DEG = 10;

export function computeBlockage(
  viewpoint: Viewpoint,
  horizon: Horizon,
  buildings: Building[],
): BlockageMetrics {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const front = frontBearings(viewpoint.facing);

  const openness = (azimuths: number[]) =>
    azimuths.reduce((acc, a) => acc + (1 - Math.sin(rad(horizon.elevation[a])) ** 2), 0) /
    azimuths.length;

  const ahead = Math.round(wrap360(viewpoint.facing)) % AZIMUTH_STEPS;
  const heavy = front.filter((a) => horizon.elevation[a] > HEAVY_BLOCK_DEG).length;

  return {
    skyViewFactor: openness(Array.from({ length: AZIMUTH_STEPS }, (_, i) => i)),
    facadeSkyViewFactor: openness(front),
    elevationAhead: horizon.elevation[ahead],
    distanceAhead: horizon.distance[ahead],
    ...widestOpenArc(front, horizon),
    heavilyBlockedShare: heavy / front.length,
    blockers: rankBlockers(front, horizon, byId, viewpoint),
  };
}

/**
 * The 180 one-degree bearings in front of the window, in the order the eye
 * sweeps them: ninety degrees left of the facing, round to ninety right.
 *
 * The order is the point. Collecting these by walking 0..359 and keeping
 * whatever falls within ninety degrees of the facing puts the seam in the wrong
 * place for any window facing near north: the array comes out 0..90 then
 * 270..359, so the two halves of an open view straight ahead sit at opposite
 * ends of it, while the two far edges of the view — a half-turn apart in the
 * sky — end up neighbours. Anything that reads runs along this array then
 * splits one open arc in two and welds two unrelated ones together.
 */
export function frontBearings(facing: number): number[] {
  const left = Math.round(wrap360(facing)) - 90;
  return Array.from({ length: 180 }, (_, k) => (((left + k) % 360) + 360) % 360);
}

/** The longest unbroken stretch of open sky in front of the window. */
function widestOpenArc(front: number[], horizon: Horizon) {
  let best = 0;
  let bestStart = 0;
  let run = 0;
  let runStart = 0;

  for (let i = 0; i < front.length; i++) {
    if (horizon.elevation[front[i]] < OPEN_VIEW_DEG) {
      if (run === 0) runStart = i;
      run += 1;
      if (run > best) {
        best = run;
        bestStart = runStart;
      }
    } else {
      run = 0;
    }
  }

  const bearing = best === 0 ? 0 : front[bestStart + Math.floor(best / 2)];
  return { openArcDegrees: best, openArcBearing: bearing };
}

function rankBlockers(
  front: number[],
  horizon: Horizon,
  byId: Map<string, Building>,
  viewpoint: Viewpoint,
) {
  interface Acc {
    arc: number;
    minDistance: number;
    maxElevation: number;
    bearingSum: number;
  }
  const acc = new Map<string, Acc>();

  for (const a of front) {
    const id = horizon.blockedBy[a];
    if (!id || horizon.elevation[a] < OPEN_VIEW_DEG) continue;
    if (id === viewpoint.hostId) continue; // Your own block is not a view blocker in front of you.
    const entry = acc.get(id) ?? { arc: 0, minDistance: Infinity, maxElevation: 0, bearingSum: 0 };
    entry.arc += 1;
    entry.minDistance = Math.min(entry.minDistance, horizon.distance[a]);
    entry.maxElevation = Math.max(entry.maxElevation, horizon.elevation[a]);
    entry.bearingSum += angleDelta(a, viewpoint.facing);
    acc.set(id, entry);
  }

  return [...acc.entries()]
    .map(([id, v]) => {
      const b = byId.get(id);
      return {
        id,
        label: describeBuilding(b),
        height: b?.height ?? 0,
        heightSource: b?.heightSource ?? ("inferred" as const),
        distance: v.minDistance,
        bearing: wrap360(viewpoint.facing + v.bearingSum / v.arc),
        elevation: v.maxElevation,
        arcDegrees: v.arc,
      };
    })
    .sort((a, b) => b.elevation * b.arcDegrees - a.elevation * a.arcDegrees)
    .slice(0, 6);
}

export function describeBuilding(b: Building | undefined) {
  if (!b) return "Unmapped structure";
  if (b.blockNo && b.street) return `Blk ${b.blockNo} ${b.street}`;
  if (b.name) return b.name;
  if (b.blockNo) return `Blk ${b.blockNo}`;
  return b.kind === "hdb" ? "HDB block" : b.kind === "residential" ? "Residential building" : "Building";
}

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compassName(bearing: number) {
  return POINTS[Math.round(wrap360(bearing) / 22.5) % 16];
}
