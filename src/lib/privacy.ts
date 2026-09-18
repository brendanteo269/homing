import { describeBuilding, frontBearings } from "./blockage";
import { angleDelta, wrap360 } from "./geo";
import type { Building, Horizon, Viewpoint } from "./types";

/**
 * How overlooked a window is.
 *
 * Openness asks how much sky a window can see. This asks the opposite question
 * about the same geometry — how much of what it sees is somebody else's home,
 * and how close. The two come apart constantly: a flat can look across a wide
 * open podium and still have forty kitchens twenty metres away on the far side
 * of it, and nothing in the openness score would say so.
 *
 * The cast is already done. `horizon.blockedBy` names the building standing in
 * every direction, and a building only appears there at all if its roof rises
 * above this window's eye line — which is exactly the filter this question
 * needs. A block shorter than you holds nobody at your level; whoever is in it
 * looks up at your ceiling, not in at your sofa. So the horizon's own
 * eye-height test does the work that would otherwise need a storey model.
 *
 * What this is not is a sightline. It does not know where the windows are in
 * the wall opposite, which way the rooms behind them face, or whether anything
 * is screened. It measures how much residential wall stands in front of this
 * one and how far off — which is the thing a viewing cannot tell you, because
 * a viewing happens with the neighbours' curtains in whatever state they
 * happen to be in.
 */
export interface PrivacyMetrics {
  /**
   * 0-100, higher is more private. It is a share of the whole view, weighted
   * by how close the home is — so one block close in front of an otherwise
   * open window still scores high, because most of that window is still
   * looking at nothing. Read it with `nearestM` beside it, never alone.
   */
  privacy: number;
  /** Degrees of the window's 180 filled by another home within reach. */
  facingDegrees: number;
  /** Degrees of it filled by one close enough to see into the room. */
  closeDegrees: number;
  /** Distance to the nearest home facing this window, metres. Infinity if none. */
  nearestM: number;
  /** How far out the question was asked. */
  reachM: number;
  /** The homes looking back, nearest first. */
  neighbours: {
    id: string;
    label: string;
    distance: number;
    bearing: number;
    arcDegrees: number;
  }[];
}

/**
 * Closer than this and a window opposite is looking into the room rather than
 * at the block. Twenty metres is about the width of the gap HDB leaves between
 * facing blocks in a mature estate, and it is the distance at which a face is
 * legible rather than a shape.
 */
const INTIMATE_M = 20;
/**
 * Past this a home opposite is scenery. It is roughly where a window stops
 * being a window and becomes a pattern on a facade, and it is deliberately
 * shorter than the blockage reach: a block 200 m away can still take your
 * light, but nobody in it is watching you eat.
 */
const REACH_M = 80;

/** How much a home at this distance overlooks: 1 on top of you, 0 at reach. */
function overlook(distance: number) {
  if (distance >= REACH_M) return 0;
  if (distance <= INTIMATE_M) return 1;
  return (REACH_M - distance) / (REACH_M - INTIMATE_M);
}

export function computePrivacy(
  viewpoint: Viewpoint,
  horizon: Horizon,
  buildings: Building[],
): PrivacyMetrics {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const front = frontBearings(viewpoint.facing);

  let weighted = 0;
  let facingDegrees = 0;
  let closeDegrees = 0;
  let nearestM = Infinity;
  const acc = new Map<string, { arc: number; minDistance: number; bearingSum: number }>();

  for (const a of front) {
    const id = horizon.blockedBy[a];
    if (!id || id === viewpoint.hostId) continue;
    const building = byId.get(id);
    // Only homes. An office tower opposite overlooks a flat just as thoroughly,
    // but "other" is mostly car parks, substations and sheds, and counting
    // those would charge a window for privacy it never lost. The floor this
    // leaves is named in the README rather than papered over.
    if (building?.kind !== "hdb" && building?.kind !== "residential") continue;

    const distance = horizon.distance[a];
    const w = overlook(distance);
    if (w === 0) continue;

    weighted += w;
    facingDegrees += 1;
    if (distance <= INTIMATE_M) closeDegrees += 1;
    if (distance < nearestM) nearestM = distance;

    const entry = acc.get(id) ?? { arc: 0, minDistance: Infinity, bearingSum: 0 };
    entry.arc += 1;
    entry.minDistance = Math.min(entry.minDistance, distance);
    // Summed as an offset from the facing rather than as a raw bearing, so a
    // neighbour spread either side of due north averages to north and not to
    // south. Same seam that frontBearings exists to avoid.
    entry.bearingSum += angleDelta(a, viewpoint.facing);
    acc.set(id, entry);
  }

  return {
    privacy: Math.round(100 - (weighted / front.length) * 100),
    facingDegrees,
    closeDegrees,
    nearestM,
    reachM: REACH_M,
    neighbours: [...acc.entries()]
      .map(([id, v]) => ({
        id,
        label: describeBuilding(byId.get(id)),
        distance: Math.round(v.minDistance),
        bearing: wrap360(viewpoint.facing + v.bearingSum / v.arc),
        arcDegrees: v.arc,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6),
  };
}
