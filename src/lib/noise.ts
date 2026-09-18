import type { NamedPlace } from "./buildings";
import { angleDelta, bearingOf, nearestFacade, pointInPolygon, polygonCentroid } from "./geo";
import type { MasterPlanNearby, Zone } from "./masterplan";
import type { Horizon, Viewpoint } from "./types";

/**
 * How much industry a window sits in front of.
 *
 * This is deliberately not called a noise level, because it is not one and
 * nothing open would let it be. Singapore publishes no noise map: the National
 * Environment Agency publishes assessment *guidelines*, there is no open
 * per-road traffic count, and the one dataset that does say where the loud
 * things are is the Master Plan, which zones them. So this measures what can be
 * measured — how much zoned industry and infrastructure stands near a window,
 * how far off it is, whether the window faces it, and whether anything is in
 * the way — and reports it as an exposure index rather than decibels it cannot
 * know.
 *
 * What it does have that a noise map would not is the shielding. A works
 * estate 300 m off matters far less with a block of flats between, and the
 * ray cast that already worked out what shades this window knows exactly
 * where that block is. That is the same argument that made sun and blockage
 * worth computing: the geometry is per-unit, so the answer is too.
 *
 * What is missing is larger than what is here, and it is roads, rail and
 * aircraft. Those are the three loudest things in most Singaporean homes, none
 * of them are in this layer, and until they are this number is a partial
 * answer and is scored on its own rather than folded into the headline.
 */
export interface NoiseMetrics {
  /** 0-100, higher is quieter. Relative, not decibels. */
  quiet: number;
  /** Sum of weighted source exposure, the raw index behind the score. */
  exposure: number;
  /** How far out sources were looked for. */
  reachM: number;
  sources: {
    use: string;
    /**
     * What is actually standing there, where OpenStreetMap names it. Null is
     * the ordinary case for a substation and the rare one for a depot, and it
     * means nobody has named it rather than that nothing is there.
     */
    name: string | null;
    distance: number;
    bearing: number;
    /** In front of the window rather than behind it. */
    ahead: boolean;
    /** Something stands between the window and it. */
    shielded: boolean;
    /** What this one contributes to the index. */
    share: number;
  }[];
}

/**
 * How loud each zoning class runs, relative to each other.
 *
 * Heavy industry and the port are the top of the scale. Light industry is a
 * business park or a workshop estate. Utilities are substations, water works
 * and incinerators; transport facilities are mostly bus and rail depots, which
 * run before dawn.
 *
 * Places of worship are left out on purpose. They are a real and frequently
 * reported source here, but the only evidence available is that one is zoned
 * nearby, the disturbance is episodic rather than constant, and marking them as
 * a nuisance on that basis is an opinion this has no data to support.
 */
const SOURCE_WEIGHT: Record<string, number> = {
  "BUSINESS 2": 1,
  "PORT / AIRPORT": 1,
  "BUSINESS 2 - WHITE": 0.9,
  "BUSINESS 1": 0.55,
  "BUSINESS 1 - WHITE": 0.5,
  "BUSINESS PARK": 0.35,
  UTILITY: 0.5,
  "TRANSPORT FACILITIES": 0.45,
  "MASS RAPID TRANSIT": 0.4,
};

/** How far out sources are looked for; the name lookup has to cover the same. */
export const REACH_M = 800;
/** Distance at which a source counts at its full weight. */
const REFERENCE_M = 100;
/** What is left of a source once a building stands between it and the window. */
const SHIELDED = 0.4;
/** What is left of one behind the window rather than in front of it. */
const BEHIND = 0.45;
/**
 * The exposure index that scores zero. Set from the worst case this can
 * produce: a window facing an unshielded heavy-industry estate across the road.
 */
const EXPOSURE_FLOOR = 2.5;
/**
 * How far an outline may reach past itself to claim a parcel.
 *
 * The two datasets do not share an edge. A Master Plan parcel runs to the road
 * centreline and an OpenStreetMap estate stops at its fence, so the same ground
 * is drawn tens of metres apart in the two, and a name that had to contain the
 * parcel outright would often miss. One road width of slack closes that gap
 * without letting the estate over the road lend its name.
 */
const NAME_REACH_M = 50;

export function computeNoise(
  viewpoint: Viewpoint,
  horizon: Horizon,
  plan: MasterPlanNearby,
  places: NamedPlace[] = [],
): NoiseMetrics {
  const sources: NoiseMetrics["sources"] = [];
  let exposure = 0;

  for (const zone of plan.zones) {
    const weight = SOURCE_WEIGHT[zone.use];
    if (!weight) continue;

    const { distance, bearing } = approach(viewpoint, zone);
    if (distance > REACH_M) continue;

    // A window looks out of one side of a block. Its own block is between it
    // and anything behind, which is shielding of the most reliable kind.
    const ahead = Math.abs(angleDelta(bearing, viewpoint.facing)) <= 90;
    // Anything the skyline cuts off before the source is standing in the way.
    const shielded = horizon.distance[Math.round(bearing) % 360] < distance;

    const falloff = REFERENCE_M / Math.max(distance, REFERENCE_M);
    const share = weight * falloff * (ahead ? 1 : BEHIND) * (shielded ? SHIELDED : 1);

    exposure += share;
    sources.push({
      use: zone.use,
      // Asked about the parcel's middle and about the corner facing the window.
      // A works estate is best described by its middle; a rail corridor is a
      // ribbon whose middle can be several hundred metres up the line from the
      // end this window actually looks at.
      name: nameOf(zone, viewpoint, places),
      share,
      distance: Math.round(distance),
      bearing,
      ahead,
      shielded,
    });
  }

  sources.sort((a, b) => b.share - a.share);
  return {
    quiet: Math.round(100 * (1 - Math.min(1, exposure / EXPOSURE_FLOOR) ** 0.7)),
    exposure,
    reachM: REACH_M,
    sources: sources.slice(0, 6).map((s) => ({ ...s, share: Math.round(s.share * 100) / 100 })),
  };
}

/** How near a parcel comes to the window, and from which way. */
function approach(viewpoint: Viewpoint, zone: Zone) {
  const { x, y } = viewpoint;
  if (pointInPolygon(x, y, zone.ring)) return { distance: 0, bearing: viewpoint.facing };
  const wall = nearestFacade(x, y, zone.ring);
  return { distance: wall.distance, bearing: bearingOf(wall.x - x, wall.y - y) };
}

/**
 * What is standing on a parcel, if anything open has named it.
 *
 * The rule under both tests is that a name has to be about this ground, not
 * merely near it. An outline that covers the parcel names it, whatever its
 * size, because an estate polygon laid over a dozen parcels is exactly the
 * thing worth naming; a point names only the parcel it stands in. Anything
 * short of that leaves the reader with the zoning, which is all that is
 * actually known — and a category they can go and check beats a place they
 * will go and look for in the wrong spot.
 */
function nameOf(zone: Zone, viewpoint: Viewpoint, places: NamedPlace[]) {
  // Two probes, because a parcel is not a point. The middle describes a works
  // estate; the corner facing the window is what matters for a rail corridor,
  // whose middle can be several hundred metres up the line from this window.
  const wall = nearestFacade(viewpoint.x, viewpoint.y, zone.ring);
  const probes: [number, number][] = [polygonCentroid(zone.ring), [wall.x, wall.y]];

  let best: { name: string; rank: number } | null = null;
  for (const place of places) {
    if (!place.ring) {
      // A point: it names the parcel it stands in, and nothing else.
      if (pointInPolygon(place.x, place.y, zone.ring)) return place.name;
      continue;
    }

    for (const [px, py] of probes) {
      if (pointInPolygon(px, py, place.ring)) return place.name;
      const gap = nearestFacade(px, py, place.ring).distance;
      if (gap > NAME_REACH_M) continue;
      if (!best || gap < best.rank) best = { name: place.name, rank: gap };
    }
  }

  return best?.name ?? null;
}
