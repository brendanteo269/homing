import type { LatLng } from "./types";

const EARTH_RADIUS_M = 6378137;

/**
 * Local east-north-up projection about an origin. Singapore sits within a
 * degree of the equator and a neighbourhood is under a kilometre across, so a
 * plain equirectangular projection is accurate to a few centimetres here.
 */
export function makeProjection(origin: LatLng) {
  const latRad = (origin.lat * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);

  return {
    origin,
    toLocal(p: LatLng): [number, number] {
      return [(p.lng - origin.lng) * mPerDegLng, (p.lat - origin.lat) * mPerDegLat];
    },
    toLatLng(x: number, y: number): LatLng {
      return { lat: origin.lat + y / mPerDegLat, lng: origin.lng + x / mPerDegLng };
    },
  };
}

export type Projection = ReturnType<typeof makeProjection>;

/** Bounding box in degrees that covers `radiusM` around `origin`. */
export function boundingBox(origin: LatLng, radiusM: number) {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = dLat / Math.cos((origin.lat * Math.PI) / 180);
  return {
    south: origin.lat - dLat,
    west: origin.lng - dLng,
    north: origin.lat + dLat,
    east: origin.lng + dLng,
  };
}

export const deg = (rad: number) => (rad * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

/** Wrap to [0, 360). */
export function wrap360(a: number) {
  return ((a % 360) + 360) % 360;
}

/** Signed smallest difference a - b, in [-180, 180). */
export function angleDelta(a: number, b: number) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/** Compass bearing, degrees clockwise from north, of the vector (x, y). */
export function bearingOf(x: number, y: number) {
  return wrap360(deg(Math.atan2(x, y)));
}

export function polygonArea(ring: [number, number][]) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export function polygonCentroid(ring: [number, number][]): [number, number] {
  const a = polygonArea(ring);
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function pointInPolygon(x: number, y: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface FacadePoint {
  x: number;
  y: number;
  /** Outward normal of the wall, degrees clockwise from north. */
  facing: number;
  /** Distance from the query point to the wall, metres. */
  distance: number;
}

/**
 * Nearest point on a footprint's outline, with the outward normal of that wall.
 * This is how a click on a block becomes "a window on this face, looking that way".
 */
export function nearestFacade(x: number, y: number, ring: [number, number][]): FacadePoint {
  let best: FacadePoint | null = null;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) continue;

    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (best && d >= best.distance) continue;

    // Two candidate normals; take the one pointing away from the interior.
    const nLen = Math.sqrt(lenSq);
    let nx = dy / nLen;
    let ny = -dx / nLen;
    if (pointInPolygon(px + nx * 0.5, py + ny * 0.5, ring)) {
      nx = -nx;
      ny = -ny;
    }
    best = { x: px, y: py, facing: bearingOf(nx, ny), distance: d };
  }

  return best ?? { x, y, facing: 0, distance: 0 };
}

/**
 * Walk `byM` metres around a footprint, starting from the point on it nearest
 * to (x, y). Negative goes the other way, and it wraps at the corner.
 *
 * This is how the window moves under a button instead of under a finger. A
 * window is on a wall, so the only honest way to shift it is along one — and
 * walking the outline keeps it on the building through every corner and every
 * notch, including round the inside of a C-shaped block, where nudging in a
 * compass direction would step it straight out into the courtyard.
 */
export function walkOutline(
  x: number,
  y: number,
  ring: [number, number][],
  byM: number,
): [number, number] {
  const n = ring.length;
  if (n < 2) return [x, y];

  const lengths: number[] = [];
  let perimeter = 0;
  let best = { edge: 0, t: 0, distance: Infinity };

  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % n];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    lengths.push(length);
    perimeter += length;
    if (length < 1e-9) continue;

    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (length * length)));
    const distance = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (distance < best.distance) best = { edge: i, t, distance };
  }
  if (perimeter < 1e-9) return [x, y];

  let along = best.t * lengths[best.edge];
  for (let i = 0; i < best.edge; i++) along += lengths[i];
  along = (((along + byM) % perimeter) + perimeter) % perimeter;

  for (let i = 0; i < n; i++) {
    if (along <= lengths[i] || i === n - 1) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % n];
      const f = lengths[i] < 1e-9 ? 0 : along / lengths[i];
      return [ax + (bx - ax) * f, ay + (by - ay) * f];
    }
    along -= lengths[i];
  }
  return [x, y];
}

export interface Face {
  /** Outward normal of this face, degrees clockwise from north. */
  facing: number;
  /** Length of the wall, metres. */
  length: number;
  /** Middle of the wall, in local metres. */
  x: number;
  y: number;
}

/** Consecutive walls within this many degrees of each other are one face. */
const FACE_MERGE_DEG = 18;
/** Walls shorter than this are corners and returns, not sides of a block. */
const MIN_FACE_M = 6;
/**
 * A wall shorter than this, pointing away from the face it interrupts, is a
 * return rather than a side. Window reveals and ledges run to a metre or two;
 * the shortest genuine side of a point block is several times that.
 */
const RETURN_M = 4;

/**
 * The sides of a building, as somebody standing in it would count them.
 *
 * A window does not face due east because the compass says so — it faces
 * whichever way its wall happens to point, and a block turned 23 degrees off
 * the grid has no east-facing units at all. So the choice offered is the
 * building's own faces, not the eight points of the compass.
 */
export function buildingFaces(ring: [number, number][]): Face[] {
  const edges = ring.map((_, i) => {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    let nx = dy / (length || 1);
    let ny = -dx / (length || 1);
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if (pointInPolygon(mx + nx * 0.4, my + ny * 0.4, ring)) {
      nx = -nx;
      ny = -ny;
    }
    return { a, b, length, facing: bearingOf(nx, ny) };
  });

  type Edge = { a: [number, number]; b: [number, number]; length: number; facing: number };
  type Group = { facing: number; length: number; longest: number; edges: Edge[] };
  const groups: Group[] = [];

  /**
   * Short walls are held back rather than ending a face, because a facade that
   * steps in and out is still one facade.
   *
   * HDB draws its own blocks in far more detail than OpenStreetMap does: every
   * window reveal and service ledge is in the outline, so a 93 m slab front
   * arrives as a dozen stretches of wall separated by half-metre returns.
   * Ending the face at each return broke that front into a dozen sides, none
   * of them wider than 23 m, and offered the reader seventeen sides of a
   * building that has two.
   */
  let held: Edge[] = [];
  const flush = () => {
    for (const e of held) groups.push({ facing: e.facing, length: e.length, longest: e.length, edges: [e] });
    held = [];
  };

  for (const e of edges) {
    if (e.length < 0.2) continue;
    const last = groups[groups.length - 1];

    if (last && Math.abs(angleDelta(e.facing, last.facing)) < FACE_MERGE_DEG) {
      // The wall carries on, so whatever was held between was part of it.
      last.edges.push(...held, e);
      held = [];
      last.length += e.length;
      // Keep the dominant wall's direction rather than drifting round a curve.
      if (e.length > last.longest) {
        last.longest = e.length;
        last.facing = e.facing;
      }
    } else if (e.length < RETURN_M) {
      held.push(e);
    } else {
      // A wall of real length pointing somewhere else: this is a new side, and
      // anything held was a corner detail belonging to neither.
      flush();
      groups.push({ facing: e.facing, length: e.length, longest: e.length, edges: [e] });
    }
  }
  flush();

  // The ring wraps, so the last group may be the same face as the first.
  if (groups.length > 1) {
    const first = groups[0];
    const last = groups[groups.length - 1];
    if (Math.abs(angleDelta(first.facing, last.facing)) < FACE_MERGE_DEG) {
      first.length += last.length;
      if (last.longest > first.longest) {
        first.longest = last.longest;
        first.facing = last.facing;
      }
      first.edges = [...last.edges, ...first.edges];
      groups.pop();
    }
  }

  return mergeCoplanar(groups.filter((g) => g.length >= MIN_FACE_M))
    .map((g) => ({ facing: g.facing, length: g.length, ...midOfWall(g.edges) }))
    .sort((a, b) => b.length - a.length);
}

/** How far out of line two runs of wall can sit and still be one facade. */
const SAME_PLANE_M = 8;

/**
 * Runs of wall that point the same way and stand in the same plane are one
 * side of the building, even with something else between them.
 *
 * A slab block's lift and stair cores project six or eight metres out of the
 * corridor side, and its balconies step in and out along the whole length. In
 * HDB's own outlines all of that is drawn, so the front of Blk 406 Ang Mo Kio
 * Ave 10 arrives as three separate runs of wall interrupted by two cores —
 * and offered as three sides of a building that a resident would say has two.
 * Nobody choosing where their window is means "the bit of the north face left
 * of the lift".
 *
 * Standing in the same plane is what keeps this honest. The two wings of a
 * C-shaped condominium point the same way but are tens of metres apart, and
 * they stay separate, because which of them a unit is on changes the answer.
 */
function mergeCoplanar<T extends { facing: number; length: number; longest: number; edges: { a: [number, number]; b: [number, number]; length: number; facing: number }[] }>(
  groups: T[],
): T[] {
  const merged: T[] = [];

  for (const group of groups) {
    const into = merged.find((m) => {
      if (Math.abs(angleDelta(group.facing, m.facing)) >= FACE_MERGE_DEG) return false;
      const normal = rad(m.facing);
      const offset =
        (wallMid(group)[0] - wallMid(m)[0]) * Math.sin(normal) +
        (wallMid(group)[1] - wallMid(m)[1]) * Math.cos(normal);
      return Math.abs(offset) <= SAME_PLANE_M;
    });

    if (!into) {
      merged.push({ ...group, edges: [...group.edges] });
      continue;
    }
    // The longer run decides where the face points and where its middle is.
    if (group.longest > into.longest) {
      into.longest = group.longest;
      into.facing = group.facing;
    }
    into.length += group.length;
    into.edges.push(...group.edges);
  }

  return merged;
}

/** A run of wall's midpoint, weighted by edge length. */
function wallMid(group: { edges: { a: [number, number]; b: [number, number]; length: number }[] }): [number, number] {
  let x = 0;
  let y = 0;
  let total = 0;
  for (const e of group.edges) {
    x += ((e.a[0] + e.b[0]) / 2) * e.length;
    y += ((e.a[1] + e.b[1]) / 2) * e.length;
    total += e.length;
  }
  return total > 0 ? [x / total, y / total] : [0, 0];
}

/**
 * The middle of a face, on the wall.
 *
 * Halfway between a face's first and last corner is only on the building if
 * the face is straight. On the curved slabs and the dog-legs that a lot of
 * Singapore's private blocks are built as, that halfway point can fall inside
 * the footprint — and a window placed there is walled in on every side, which
 * comes out as a unit that sees no sky at all. So walk the face's own walls and
 * take the point half its length along.
 */
function midOfWall(edges: { a: [number, number]; b: [number, number]; length: number }[]) {
  const half = edges.reduce((sum, e) => sum + e.length, 0) / 2;

  let walked = 0;
  for (const e of edges) {
    if (walked + e.length >= half) {
      const t = e.length < 1e-9 ? 0 : (half - walked) / e.length;
      return { x: e.a[0] + (e.b[0] - e.a[0]) * t, y: e.a[1] + (e.b[1] - e.a[1]) * t };
    }
    walked += e.length;
  }

  const last = edges[edges.length - 1];
  return { x: last.b[0], y: last.b[1] };
}
