import { pointInPolygon, rad, wrap360 } from "./geo";
import type { Ceiling, MasterPlanNearby, Monument, Zone } from "./masterplan";
import type { Viewpoint } from "./types";

/**
 * Whether the view out of a window can be taken away.
 *
 * Openness says what a window sees today. This says whether it will still see
 * it, which is a different question and the one nobody answers: the open ground
 * a flat looks over is worth nothing if it is a plot waiting for a tower.
 *
 * The Master Plan answers it directly for some land and not at all for the
 * rest, so the arc in front of the window is sorted into three: ground that
 * carries a published ceiling low enough that nothing on it could rise into
 * this view, ground that carries a ceiling high enough that it could, and
 * ground the plan puts no number on. The third is not a failure to report —
 * most of Singapore is zoned by plot ratio, and a plot ratio is not a height —
 * so it is counted and named rather than quietly folded into either of the
 * others.
 */
export interface OutlookMetrics {
  /** Degrees of the window's 180 that look over ground which cannot rise into view. */
  protectedDegrees: number;
  /** Degrees where the plan publishes a ceiling at all. */
  knownDegrees: number;
  /** How far out the question was asked, metres. */
  reachM: number;
  /** What is doing the protecting, widest first. */
  protectors: { label: string; arcDegrees: number; distance: number; bearing: number }[];
  /** What the land in front is zoned for, nearest first. */
  zones: { use: string; gpr: string; arcDegrees: number; distance: number; bearing: number }[];
}

/** How far out it is worth asking. Past this a new building is somebody else's view. */
/**
 * How far out the question is asked.
 *
 * Further would be more rigorous and less useful. A direction counts as
 * protected only if every metre of it is capped, and beyond a couple of
 * hundred metres some parcel almost always has an unpublished ceiling, so a
 * longer reach answers "not protected" everywhere and tells the reader nothing.
 * This is a claim about the ground a window actually looks down on.
 */
const REACH_M = 200;
const STEP_M = 10;
/**
 * A permitted building that would stand less than this far above the window's
 * eye line cannot meaningfully close the view down. Level with the eye is not
 * the test: something exactly at eye height 300 m away is a distant smudge.
 */
const CLEAR_DEG = 5;

/**
 * Open land that the plan will not let a building rise on, with what can still
 * stand there. A park has pavilions and toilet blocks; a reservoir has nothing.
 * These are ceilings, not descriptions of what is there now.
 */
const OPEN_LAND_CEILING_M: Record<string, number> = {
  // A road reserve is the commonest protected ground there is, and the reason
  // a flat facing a main road keeps its outlook when its neighbours lose theirs.
  ROAD: 0,
  WATERBODY: 0,
  "BEACH AREA": 0,
  "OPEN SPACE": 8,
  PARK: 12,
  CEMETERY: 8,
  AGRICULTURE: 12,
};

/** A grid over the local metres, so a ray does not test every polygon it passes. */
const GRID_M = 60;

interface Cell {
  zones: Zone[];
  ceilings: Ceiling[];
  monuments: Monument[];
}

export function computeOutlook(
  viewpoint: Viewpoint,
  plan: MasterPlanNearby,
  builtHorizonAt: (azimuth: number) => number,
): OutlookMetrics {
  const grid = buildGrid(plan);
  const { x, y, z, facing } = viewpoint;

  // The parcel the window itself stands on is not evidence about anything. It
  // is the home's own land — for an HDB flat a precinct-wide superlot several
  // hundred metres across, zoned residential with no published ceiling — so
  // counting it would answer "unknown" for every direction before the ray had
  // left the estate. What is asked about is the ground beyond it.
  const home = plan.zones.filter((zn) => pointInPolygon(x, y, zn.ring));
  const onHomeLand = (px: number, py: number) => home.some((zn) => pointInPolygon(px, py, zn.ring));

  let protectedDegrees = 0;
  let knownDegrees = 0;
  const protectors = new Map<string, { arcDegrees: number; distance: number; bearing: number }>();
  const zones = new Map<string, { arcDegrees: number; distance: number; bearing: number }>();

  for (let a = -90; a <= 90; a++) {
    const azimuth = facing + a;
    const sin = Math.sin(rad(azimuth));
    const cos = Math.cos(rad(azimuth));

    let known = false;
    let breached = false;
    let credit: { label: string; distance: number } | null = null;
    let firstZone: { use: string; gpr: string; distance: number } | null = null;

    for (let d = STEP_M; d <= REACH_M; d += STEP_M) {
      const px = x + sin * d;
      const py = y + cos * d;
      if (onHomeLand(px, py)) continue;

      const cell = grid.get(cellKey(px, py));
      if (!firstZone && cell) {
        // Roads count for protection — nothing can be built on one — but they
        // are useless in a list of what the outlook faces. Nearly every window
        // in Singapore looks over a road first, so reporting it crowds out the
        // park or the works yard behind it, which is what the reader is after.
        const zone = cell.zones.find((zn) => zn.use !== "ROAD" && pointInPolygon(px, py, zn.ring));
        if (zone) firstZone = { use: zone.use, gpr: zone.gpr, distance: d };
      }

      const ceiling = cell ? ceilingAt(px, py, cell) : null;
      if (!ceiling) {
        // Ground with no published ceiling could hold anything, so the
        // question stops being answerable here.
        breached = true;
        break;
      }

      known = true;
      const elevation = (Math.atan2(ceiling.height - z, d) * 180) / Math.PI;
      if (elevation >= CLEAR_DEG) {
        breached = true;
        break;
      }
      if (!credit || d < credit.distance) credit = { label: ceiling.what, distance: d };
    }

    if (firstZone) {
      const key = `${firstZone.use}|${firstZone.gpr}`;
      const seen = zones.get(key);
      if (seen) {
        seen.arcDegrees++;
        // The bearing worth reporting is the one it comes nearest from.
        if (firstZone.distance < seen.distance) seen.bearing = azimuth;
        seen.distance = Math.min(seen.distance, firstZone.distance);
      } else zones.set(key, { arcDegrees: 1, distance: firstZone.distance, bearing: azimuth });
    }

    if (!known) continue;
    knownDegrees++;
    if (breached) continue;
    // Something already standing in the way makes the question moot: that
    // direction is closed, and whether it could close further is not what
    // protection means.
    if (builtHorizonAt(azimuth) >= CLEAR_DEG) continue;

    protectedDegrees++;
    if (credit) {
      const seen = protectors.get(credit.label);
      if (seen) {
        seen.arcDegrees++;
        if (credit.distance < seen.distance) seen.bearing = azimuth;
        seen.distance = Math.min(seen.distance, credit.distance);
      } else protectors.set(credit.label, { arcDegrees: 1, distance: credit.distance, bearing: azimuth });
    }
  }

  return {
    protectedDegrees,
    knownDegrees,
    reachM: REACH_M,
    protectors: [...protectors]
      .map(([label, v]) => ({ label, ...v, distance: Math.round(v.distance) }))
      .sort((p, q) => q.arcDegrees - p.arcDegrees),
    zones: [...zones]
      .map(([key, v]) => ({
        use: key.slice(0, key.indexOf("|")),
        gpr: key.slice(key.indexOf("|") + 1),
        ...v,
        distance: Math.round(v.distance),
      }))
      .sort((p, q) => p.distance - q.distance),
  };
}

/**
 * The ceiling over a point, or null where the plan publishes none.
 *
 * Lowest wins. A landed housing envelope inside a residential zone is the
 * binding number, and a monument cannot be replaced by anything at all.
 */
function ceilingAt(x: number, y: number, cell: Cell): { height: number; what: string } | null {
  let best: { height: number; what: string } | null = null;
  const take = (height: number, what: string) => {
    if (!best || height < best.height) best = { height, what };
  };

  for (const m of cell.monuments) if (pointInPolygon(x, y, m.ring)) take(0, `${m.name} (monument)`);
  for (const c of cell.ceilings) if (pointInPolygon(x, y, c.ring)) take(c.height, c.what);
  for (const zn of cell.zones) {
    const open = OPEN_LAND_CEILING_M[zn.use];
    if (open !== undefined && pointInPolygon(x, y, zn.ring)) take(open, zn.use.toLowerCase());
  }
  return best;
}

const cellKey = (x: number, y: number) => `${Math.floor(x / GRID_M)}:${Math.floor(y / GRID_M)}`;

function buildGrid(plan: MasterPlanNearby): Map<string, Cell> {
  const grid = new Map<string, Cell>();
  const put = (ring: [number, number][], add: (c: Cell) => void) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of ring) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    for (let gx = Math.floor(minX / GRID_M); gx <= Math.floor(maxX / GRID_M); gx++) {
      for (let gy = Math.floor(minY / GRID_M); gy <= Math.floor(maxY / GRID_M); gy++) {
        const key = `${gx}:${gy}`;
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = { zones: [], ceilings: [], monuments: [] }));
        add(cell);
      }
    }
  };

  for (const z of plan.zones) put(z.ring, (c) => c.zones.push(z));
  for (const c of plan.ceilings) put(c.ring, (cell) => cell.ceilings.push(c));
  for (const m of plan.monuments) put(m.ring, (c) => c.monuments.push(m));
  return grid;
}

/** Degrees of arc as a share of the window's outlook, for the reader. */
export const outlookShare = (degrees: number) => Math.round((degrees / 181) * 100);

export { wrap360 };
