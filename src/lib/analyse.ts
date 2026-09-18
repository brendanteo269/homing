import { FLOOR_HEIGHT_M, fetchBuildings, fetchNamedPlaces } from "./buildings";
import { computeBlockage, describeBuilding } from "./blockage";
import { angleDelta, buildingFaces, makeProjection, nearestFacade, pointInPolygon, polygonArea, polygonCentroid, rad, wrap360, type Face } from "./geo";
import { computeHorizon } from "./horizon";
import { computeScores } from "./score";
import { computeSunMetrics } from "./sun";
import { hdbBlockByPostal } from "./hdb";
import { btoCeilings, btoSiteAt } from "./bto";
import { masterPlanNear } from "./masterplan";
import { REACH_M as NOISE_REACH_M, computeNoise } from "./noise";
import { computeOutlook, groundKind } from "./outlook";
import { normaliseStreet } from "./street";
import type { AnalysisResult, Building, Confidence, LatLng, Viewpoint } from "./types";

export interface AnalyseInput extends LatLng {
  /** Storey the unit is on, 1 = ground. */
  floor: number;
  /**
   * The address the pin came from, when there is one. A postal code's point is
   * the building's registered location, which for a large development is the
   * gate or the management office rather than the block itself — so the block
   * number is better evidence of which footprint is meant than the coordinate.
   */
  address?: { blockNo?: string | null; street?: string | null; postal?: string | null };
  /** Which side of the block the window is on, as an index into its faces. */
  face?: number;
  /**
   * Where on the block the window actually is, when somebody knows. Snapped to
   * the nearest point on the host's outline, so it always lands on a wall.
   *
   * A side is a coarse answer, and on a C-shaped condo a coarse answer is the
   * wrong one: the courtyard units, the two wings and the back all see
   * different things, and no rule can guess which one is yours.
   */
  window?: LatLng;
  /** How far out to pull building data. */
  radiusM?: number;
}

const DEFAULT_RADIUS_M = 600;
/** How far out to read the Master Plan, whatever the building radius is. */
const PLAN_RADIUS_M = 900;
/**
 * How far out the plan drawing is sent. The map culls past its own frame
 * anyway, and a parcel averages a dozen points, so this is a few hundred
 * polygons at worst — cheaper than one of the building footprints beside it.
 */
const GROUND_DRAW_M = 350;
/** How far the eye sits outside the wall, and how high above the floor slab. */
const STANDOFF_M = 0.6;
const EYE_ABOVE_FLOOR_M = 1.5;
/**
 * How far an address point may sit from the footprint carrying its block
 * number and still be the same building. Condo address points are routinely
 * a hundred metres from the nearest tower, at the entrance off the main road.
 */
const ADDRESS_MATCH_M = 200;
/**
 * The tallest storey worth answering about. Singapore's tallest residential
 * block is 64 storeys; past this the number is not a storey somebody lives on,
 * it is an unchecked number that has reached the eye height and taken the
 * window with it — at a million, the window sits above the atmosphere and the
 * report comes back with every neighbour cleared and the industry unshielded.
 */
const MAX_FLOOR = 120;

/**
 * With no address to go on, a pin that lands on a car park or a road still has
 * to mean something. Beyond the click radius the nearest block is a guess, and
 * the result says which of the two it was.
 */
const HOST_REACH_M = 90;

export async function analyse(input: AnalyseInput): Promise<AnalysisResult> {
  const started = Date.now();
  const origin: LatLng = { lat: input.lat, lng: input.lng };
  const projection = makeProjection(origin);
  const radiusM = input.radiusM ?? DEFAULT_RADIUS_M;

  // Started here and awaited at the end: the names have nothing to do with the
  // geometry, so there is no reason for the reader to wait for them in series.
  // fetchNamedPlaces swallows its own failures, so this never rejects unhandled.
  const named = fetchNamedPlaces(origin, Math.max(radiusM, NOISE_REACH_M), projection);

  const { buildings, dataTimestamp } = await fetchBuildings(origin, radiusM, projection);
  const match = findHost(buildings, input.address);
  const host = match?.building ?? null;
  const hdb = await hdbBlockByPostal(host?.postal);
  const faces = host ? buildingFaces(host.ring) : [];
  const viewpoint = placeViewpoint(
    input,
    host,
    faces,
    input.window ? projection.toLocal(input.window) : undefined,
  );

  const horizon = computeHorizon(viewpoint, buildings);
  const sun = computeSunMetrics(viewpoint, horizon, origin);
  const blockage = computeBlockage(viewpoint, horizon, buildings);

  // The plan is asked about further out than the buildings are: a works estate
  // half a kilometre off is still audible, long after it has stopped being
  // visible.
  const plan = await masterPlanNear(origin, Math.max(radiusM, PLAN_RADIUS_M), projection);
  // A BTO that has been launched is a height the plan does not carry: the site
  // is zoned by plot ratio, and a plot ratio is not a storey count. Folding the
  // launches in as ceilings lets the outlook engine read them with everything
  // else rather than learning a second kind of answer.
  plan.ceilings.push(...(await btoCeilings(plan, projection)));
  // Which launch this window belongs to, if any — asked whether or not a block
  // was found. Most launched sites turn out to be drawn in OpenStreetMap within
  // months of the launch, so the usual case is a real footprint standing on a
  // site whose flats will not be handed over for years, and the reader needs
  // both facts: the block they are standing in, and that nobody lives in it yet.
  const bto = await btoSiteAt(plan, projection, viewpoint.x, viewpoint.y);
  const known = plan.zones.length > 0 || plan.ceilings.length > 0;
  const outlook = known
    ? computeOutlook(viewpoint, plan, (azimuth) => horizon.elevation[((Math.round(azimuth) % 360) + 360) % 360])
    : null;
  // Names come only from features tagged as the thing that makes the noise, not
  // from whatever footprint happens to stand on the parcel. Falling back to any
  // named building nearby raises the hit rate and captions a bus depot "Church
  // of Christ the King", which is worse than saying nothing: a reader can work
  // with an unnamed category and cannot work with a confident wrong answer.
  const places = await named;
  const noise = known ? computeNoise(viewpoint, horizon, plan, places) : null;

  const ground = plan.zones.flatMap((zn) => {
    const kind = groundKind(zn.use);
    if (!kind) return [];
    const near = zn.ring.some(
      ([px, py]) => Math.hypot(px - viewpoint.x, py - viewpoint.y) < GROUND_DRAW_M,
    );
    return near ? [{ kind, ring: zn.ring }] : [];
  });

  const scores = computeScores(sun, blockage, viewpoint, outlook);

  return {
    origin,
    viewpoint,
    host: host
      ? {
          label: describeBuilding(host),
          levels: host.levels,
          hdb: hdb
            ? {
                blockNo: hdb.blockNo,
                street: hdb.street,
                postal: hdb.postal,
                maxFloorLevel: hdb.maxFloorLevel,
                yearCompleted: hdb.yearCompleted,
                units: hdb.units,
              }
            : null,
          height: host.height,
          heightSource: host.heightSource,
          matchedBy: match!.matchedBy,
          distanceFromPin: Math.round(match!.distance),
          faces: faces.map((f) => ({ facing: f.facing, length: f.length })),
        }
      : null,
    bto: bto
      ? {
          name: bto.name,
          town: bto.town,
          launch: bto.launch,
          completion: bto.completion ?? null,
          blocks: bto.blocks ?? null,
          storeys: bto.storeys,
          storeysLow: bto.storeysLow ?? null,
          units: bto.units ?? null,
        }
      : null,
    buildings,
    horizon: { elevation: Array.from(horizon.elevation), distance: Array.from(horizon.distance) },
    sun,
    blockage,
    outlook,
    ground,
    noise,
    confidence: summariseConfidence(buildings, blockage, dataTimestamp),
    scores,
    tookMs: Date.now() - started,
  };
}

export type HostMatch = "postal" | "address" | "pin-inside" | "nearest";

/**
 * Which block the answer is about.
 *
 * In order of how much the evidence is worth: the footprint HDB files under
 * this exact postal code, then the one carrying the same block number and
 * street as the address, then the one the pin is standing in, then whatever is
 * nearest. Getting this wrong is not a rounding error — it answers for the
 * building next door — so which rule fired is reported.
 *
 * The postal code is the strongest of the four by a distance. A Singapore
 * postal code names one building, and HDB's register holds the code for every
 * block it has ever built, so for an HDB address there is nothing to infer:
 * the footprint is simply looked up. That is the whole of the guardhouse
 * problem solved for four in five homes here.
 */
function findHost(
  buildings: Building[],
  address?: AnalyseInput["address"],
): { building: Building; matchedBy: HostMatch; distance: number } | null {
  const blockNo = address?.blockNo?.trim().toLowerCase();
  const street = normaliseStreet(address?.street);
  const postal = address?.postal?.trim();

  if (postal) {
    const exact = buildings.find((b) => b.postal === postal);
    if (exact) {
      return {
        building: exact,
        matchedBy: "postal",
        distance: pointInPolygon(0, 0, exact.ring) ? 0 : nearestFacade(0, 0, exact.ring).distance,
      };
    }
  }

  if (blockNo && street) {
    const candidates = buildings
      .filter((b) => b.blockNo?.trim().toLowerCase() === blockNo && normaliseStreet(b.street) === street)
      .map((b) => ({
        building: b,
        distance: pointInPolygon(0, 0, b.ring) ? 0 : nearestFacade(0, 0, b.ring).distance,
      }))
      .filter((c) => c.distance <= ADDRESS_MATCH_M);

    // One address is often several footprints: the tower, and the guardhouse,
    // lobby or bin centre beside it, all tagged with the same block number. The
    // home is the big one, and taking the nearest instead puts the window in a
    // pavilion with a thirty-storey neighbour a metre away.
    const best = candidates.sort((a, b) => rank(b.building) - rank(a.building))[0];
    if (best) return { ...best, matchedBy: "address" };
  }

  for (const b of buildings) {
    if (pointInPolygon(0, 0, b.ring)) return { building: b, matchedBy: "pin-inside", distance: 0 };
  }

  let best: { building: Building; distance: number } | null = null;
  for (const b of buildings) {
    const d = nearestFacade(0, 0, b.ring).distance;
    if (d <= HOST_REACH_M && (!best || d < best.distance)) best = { building: b, distance: d };
  }
  return best ? { ...best, matchedBy: "nearest" } : null;
}

/**
 * How much a footprint looks like the building somebody lives in: floor area
 * first, then a bonus for the two things that mark a block rather than an
 * outbuilding — being tagged residential, and carrying a real storey count.
 */
function rank(b: Building) {
  const area = Math.abs(polygonArea(b.ring));
  const residential = b.kind === "hdb" || b.kind === "residential" ? 2 : 1;
  const known = b.heightSource === "inferred" ? 1 : 1.5;
  return area * residential * known;
}

function placeViewpoint(
  input: AnalyseInput,
  host: Building | null,
  faces: Face[],
  windowAt: [number, number] | undefined,
): Viewpoint {
  const floor = Math.min(MAX_FLOOR, Math.max(1, Math.round(input.floor)));

  if (!host) {
    // Nothing to attach to — treat the pin as a free-standing window.
    return {
      x: 0,
      y: 0,
      z: (floor - 1) * FLOOR_HEIGHT_M.residential + EYE_ABOVE_FLOOR_M,
      facing: 0,
      floor,
      hostId: null,
      face: null,
    };
  }

  // A window sits on one side of a block. Either the caller picked a side, or
  // we work out which side a unit here is most likely to be on.
  const nearest = nearestFacade(0, 0, host.ring);
  const floorHeight = host.levels ? host.height / (host.levels + 1.4) : FLOOR_HEIGHT_M[host.kind];
  const z = (floor - 1) * floorHeight + EYE_ABOVE_FLOOR_M;
  // A window placed by hand beats any rule about sides, so it is checked first.
  const placed = windowAt ? nearestFacade(windowAt[0], windowAt[1], host.ring) : null;
  const index =
    placed || (input.face !== undefined && faces[input.face])
      ? (input.face ?? -1)
      : defaultFace(faces, host, nearest.facing, z);
  const face = placed ? null : faces[index];

  const spot = placed ?? face ?? { x: nearest.x, y: nearest.y, facing: nearest.facing };
  const bearing = rad(spot.facing);

  return {
    // Push the eye just clear of the wall so the ray cast does not start inside it.
    x: spot.x + Math.sin(bearing) * STANDOFF_M,
    y: spot.y + Math.cos(bearing) * STANDOFF_M,
    z,
    facing: spot.facing,
    floor,
    hostId: host.id,
    // A hand-placed window is not one of the block's sides, and saying so is
    // what lets the interface stop pretending a side button is selected.
    face: placed ? null : face ? index : null,
  };
}

/** Only the biggest handful of walls are candidates; the rest are returns. */
const SIDE_CANDIDATES = 6;
/** Horizon above this reads as something in the way rather than open sky. */
const ENCLOSED_DEG = 10;
/** Sides whose usable frontage is within this of the best count as equals. */
const TIE_BAND = 0.9;

/**
 * Which side of the block to assume when the caller has not said.
 *
 * This used to be the wall pointing nearest the address pin, which is wrong in
 * a way that showed up on roughly one Singapore block in five. An HDB point
 * block is mapped as twenty or thirty short walls, and the one nearest the pin
 * is routinely a slot end or a lift lobby return — so the window went into a
 * notch, walled in on three sides, and the whole block was reported as dark and
 * hemmed in on the strength of a position almost nobody lives at. The units out
 * on the open face, where nearly everyone on that side actually lives, never got
 * a look in.
 *
 * So rank the sides by the frontage that faces outward: how long the wall is,
 * discounted by how much of the view ahead is taken up by the block itself. A
 * long wall looking at open ground wins; a long wall staring across a notch at
 * its own back does not.
 */
function defaultFace(faces: Face[], host: Building, pinFacing: number, z: number) {
  if (faces.length === 0) return -1;

  const scored = faces.slice(0, SIDE_CANDIDATES).map((face, index) => ({
    index,
    facing: face.facing,
    frontage: face.length * (1 - enclosedShare(host, face, z)),
  }));

  const best = scored.reduce((a, b) => (b.frontage > a.frontage ? b : a));
  // A slab has two long faces that are each as good as the other. That is the
  // one case where the address still knows something: take the side it points at.
  return scored
    .filter((s) => s.frontage >= best.frontage * TIE_BAND)
    .reduce((a, b) =>
      Math.abs(angleDelta(b.facing, pinFacing)) < Math.abs(angleDelta(a.facing, pinFacing)) ? b : a,
    ).index;
}

/**
 * How much of the view straight ahead of a wall is its own block. Cast against
 * the host alone — the neighbours are the answer we are trying to measure, not
 * part of deciding where to stand to measure it.
 */
function enclosedShare(host: Building, face: Face, z: number) {
  const bearing = rad(face.facing);
  const horizon = computeHorizon(
    {
      x: face.x + Math.sin(bearing) * STANDOFF_M,
      y: face.y + Math.cos(bearing) * STANDOFF_M,
      z,
      facing: face.facing,
      floor: 1,
      hostId: host.id,
      face: null,
    },
    [host],
  );

  const centre = Math.round(wrap360(face.facing));
  let blocked = 0;
  for (let k = 0; k < 180; k++) {
    if (horizon.elevation[(centre - 90 + k + 360) % 360] > ENCLOSED_DEG) blocked++;
  }
  return blocked / 180;
}

function summariseConfidence(
  buildings: Building[],
  blockage: ReturnType<typeof computeBlockage>,
  dataTimestamp: string | null,
): Confidence {
  const fromHdbRegister = buildings.filter((b) => b.heightSource === "hdb-register").length;
  const withMeasuredHeight = buildings.filter((b) => b.heightSource === "height-tag").length;
  const withLevels = buildings.filter((b) => b.heightSource === "levels-tag").length;

  // Weight by how much of the view each blocker actually occupies: a guessed
  // height on a shed behind you matters far less than one on the block ahead.
  let weighted = 0;
  let known = 0;
  for (const b of blockage.blockers) {
    weighted += b.arcDegrees;
    if (b.heightSource !== "inferred") known += b.arcDegrees;
  }

  return {
    buildingsConsidered: buildings.length,
    fromHdbRegister,
    withMeasuredHeight,
    withLevels,
    inferred: buildings.length - fromHdbRegister - withMeasuredHeight - withLevels,
    blockerHeightConfidence: weighted === 0 ? 1 : known / weighted,
    dataTimestamp,
  };
}

/** Convenience for callers that only have an address. */
export function centroidOf(building: Building) {
  return polygonCentroid(building.ring);
}
