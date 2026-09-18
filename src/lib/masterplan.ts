import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { boundingBox, type Projection } from "./geo";
import type { LatLng } from "./types";

/**
 * What the Urban Redevelopment Authority's Master Plan says about the land
 * around a home: what it is for, and how tall anything on it may stand.
 *
 * Two questions this answers that nothing else can. Whether the open ground a
 * window looks over can be built up — a park, a reservoir or a landed housing
 * area cannot, and that is a promise about a view rather than a description of
 * one. And where the industry is, because zoning is the only public inventory
 * of it, and an estate of heavy industry is the loudest thing most homes here
 * will ever sit near.
 *
 * `npm run build-masterplan` writes the file this reads.
 */

/** A parcel of land as the plan zones it, in local ENU metres. */
export interface Zone {
  /** Land use, e.g. "PARK", "BUSINESS 2". */
  use: string;
  /** Gross plot ratio as published: a number, or EVA / SDP where none is. */
  gpr: string;
  ring: [number, number][];
}

/** Ground carrying a published ceiling on how tall a building may be. */
export interface Ceiling {
  /** Metres above ground, including roof furniture. */
  height: number;
  /** What sets it, e.g. "landed housing, 3 storeys". */
  what: string;
  ring: [number, number][];
  /**
   * Set when this is a launched BTO rather than a planning limit. The height
   * is read the same way, but it is a building with a completion date, so it
   * can never be credited as ground that keeps a view open.
   */
  bto?: boolean;
  /**
   * When that building is due, as YYYY-MM, where the launch says. A date is
   * what separates "something could go up here" from "something is going up
   * here, and here is when" — and it is the half of the sentence a reader
   * plans around.
   */
  completion?: string | null;
}

export interface Monument {
  name: string;
  ring: [number, number][];
}

export interface MasterPlanNearby {
  zones: Zone[];
  ceilings: Ceiling[];
  monuments: Monument[];
}

interface Packed {
  parcels: { u: string; g: string; r: [number, number][] }[];
  caps: { h: number; w: string; r: [number, number][] }[];
  monuments: { n: string; r: [number, number][] }[];
}

const DATA_FILE = path.join(process.cwd(), "data", "masterplan.json.gz");
/** Roughly 550 m, so a query of a few hundred metres touches nine cells. */
const CELL_DEG = 0.005;
const cellKey = (lat: number, lng: number) =>
  `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;

interface Indexed<T> {
  item: T;
  ring: [number, number][];
  bbox: { south: number; west: number; north: number; east: number };
}

interface Index {
  grid: Map<string, Indexed<unknown>[]>;
}

let loading: Promise<Index | null> | null = null;

/**
 * A checkout that has not run the build script has no file here, and the app
 * still answers — without the plan, as it did before this existed. A file that
 * is present but unreadable says so, because quietly dropping the one source
 * that knows what may be built is exactly the failure to avoid.
 */
export function loadMasterPlan(): Promise<Index | null> {
  loading ??= readFile(DATA_FILE)
    .then((gz) => index(JSON.parse(gunzipSync(gz).toString("utf8")) as Packed))
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== "ENOENT") {
        console.warn(`Could not read ${DATA_FILE} — answering without the Master Plan.`, err);
      }
      return null;
    });
  return loading;
}

type Tagged =
  | { kind: "zone"; use: string; gpr: string }
  | { kind: "ceiling"; height: number; what: string }
  | { kind: "monument"; name: string };

function index(packed: Packed): Index {
  const grid = new Map<string, Indexed<unknown>[]>();

  const add = (ring: [number, number][], item: Tagged) => {
    if (ring.length < 3) return;
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    for (const [lng, lat] of ring) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
    const entry: Indexed<unknown> = { item, ring, bbox: { south, west, north, east } };
    for (let lat = south; lat <= north + CELL_DEG; lat += CELL_DEG) {
      for (let lng = west; lng <= east + CELL_DEG; lng += CELL_DEG) {
        const key = cellKey(lat, lng);
        const cell = grid.get(key);
        if (cell) {
          if (!cell.includes(entry)) cell.push(entry);
        } else grid.set(key, [entry]);
      }
    }
  };

  for (const p of packed.parcels) add(p.r, { kind: "zone", use: p.u, gpr: p.g });
  for (const c of packed.caps) add(c.r, { kind: "ceiling", height: c.h, what: c.w });
  for (const m of packed.monuments) add(m.r, { kind: "monument", name: m.n });
  return { grid };
}

/** Everything the plan has to say within `radiusM` of a point. */
export async function masterPlanNear(
  origin: LatLng,
  radiusM: number,
  projection: Projection,
): Promise<MasterPlanNearby> {
  const plan = await loadMasterPlan();
  const empty: MasterPlanNearby = { zones: [], ceilings: [], monuments: [] };
  if (!plan) return empty;

  const box = boundingBox(origin, radiusM);
  const found = new Set<Indexed<unknown>>();
  for (let lat = box.south; lat <= box.north + CELL_DEG; lat += CELL_DEG) {
    for (let lng = box.west; lng <= box.east + CELL_DEG; lng += CELL_DEG) {
      for (const e of plan.grid.get(cellKey(lat, lng)) ?? []) {
        if (e.bbox.north < box.south || e.bbox.south > box.north) continue;
        if (e.bbox.east < box.west || e.bbox.west > box.east) continue;
        found.add(e);
      }
    }
  }

  for (const e of found) {
    const ring = e.ring.map(([lng, lat]) => projection.toLocal({ lat, lng }));
    const tagged = e.item as Tagged;
    if (tagged.kind === "zone") empty.zones.push({ use: tagged.use, gpr: tagged.gpr, ring });
    else if (tagged.kind === "ceiling")
      empty.ceilings.push({ height: tagged.height, what: tagged.what, ring });
    else empty.monuments.push({ name: tagged.name, ring });
  }
  return empty;
}
