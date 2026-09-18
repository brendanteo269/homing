import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { boundingBox } from "./geo";
import type { LatLng } from "./types";

/**
 * Every building outline in Singapore, read from a file instead of asked for.
 *
 * This is the same OpenStreetMap data the app used to fetch from Overpass per
 * request, and it is read the same way afterwards — the tags go through the
 * same `classify` and `resolveHeight`, and heights are still inferred from the
 * neighbours in each request's own radius. Nothing about the answer changes.
 * What changes is that a cold neighbourhood took fifty seconds of somebody
 * else's rate-limited server and now takes a hundred milliseconds of disk,
 * once per process.
 *
 * `npm run build-footprints` writes the file. A checkout that has not run it
 * has no file here, which is not an error: the app falls back to Overpass,
 * which is what it did before this existed.
 */

const DATA_FILE = path.join(process.cwd(), "data", "footprints.json.gz");

/** The same cell size the HDB index uses — roughly 550 m, a little under the default radius. */
const CELL_DEG = 0.005;
const cellKey = (lat: number, lng: number) =>
  `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;

/** A building as the build script wrote it: outline, tags, OSM way id. */
type Row = [number[], Record<string, string>, number];

/** A named place: its name, its outline where it has one, and a point. */
type PlaceRow = [string, number[] | null, number, number];

interface Payload {
  version: number;
  timestamp: string | null;
  rows: Row[];
  places?: PlaceRow[];
}

export interface Footprint {
  id: number;
  /** Outline in degrees, already absolute and with no repeated closing point. */
  ring: { lat: number; lon: number }[];
  tags: Record<string, string>;
  bbox: { south: number; west: number; north: number; east: number };
}

/**
 * A named place as the noise report wants it: the outline in degrees, or null
 * for the ones mapped as a single node, plus the point to file it under.
 */
export interface NamedPlaceRow {
  name: string;
  ring: { lat: number; lon: number }[] | null;
  lat: number;
  lon: number;
}

interface FootprintIndex {
  timestamp: string | null;
  grid: Map<string, Footprint[]>;
  places: NamedPlaceRow[];
}

let loading: Promise<FootprintIndex | null> | null = null;

export function loadFootprints(): Promise<FootprintIndex | null> {
  loading ??= readFile(DATA_FILE)
    .then((gz) => index(JSON.parse(gunzipSync(gz).toString("utf8")) as Payload))
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== "ENOENT") {
        console.warn(`Could not read ${DATA_FILE} — falling back to Overpass.`, err);
      }
      return null;
    });
  return loading;
}

/**
 * The outlines arrive delta-encoded in millionths of a degree, so every one is
 * walked out once here and kept as degrees. Doing it at load rather than per
 * request costs about a tenth of a second on the first call and nothing after,
 * and it means a query does no arithmetic on a building it is about to reject.
 *
 * Each building is filed in every grid cell its bounding box touches, and the
 * box is kept alongside — a cell hit is a rough answer, and the box is what
 * makes it exact. Indexing on one vertex instead would lose the buildings that
 * straddle the edge of the asked-for radius, which are precisely the ones at
 * the far side of a view.
 */
function index(payload: Payload): FootprintIndex {
  const grid = new Map<string, Footprint[]>();

  for (const [encoded, tags, id] of payload.rows) {
    if (encoded.length < 6) continue;

    let lat = encoded[0];
    let lng = encoded[1];
    const ring: { lat: number; lon: number }[] = [{ lat: lat / 1e6, lon: lng / 1e6 }];
    let south = lat;
    let north = lat;
    let west = lng;
    let east = lng;
    for (let i = 2; i < encoded.length; i += 2) {
      lat += encoded[i];
      lng += encoded[i + 1];
      ring.push({ lat: lat / 1e6, lon: lng / 1e6 });
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }

    const footprint: Footprint = {
      id,
      ring,
      tags,
      bbox: { south: south / 1e6, west: west / 1e6, north: north / 1e6, east: east / 1e6 },
    };

    for (let y = footprint.bbox.south; y <= footprint.bbox.north + CELL_DEG; y += CELL_DEG) {
      for (let x = footprint.bbox.west; x <= footprint.bbox.east + CELL_DEG; x += CELL_DEG) {
        const key = cellKey(y, x);
        const cell = grid.get(key);
        if (cell) {
          if (!cell.includes(footprint)) cell.push(footprint);
        } else grid.set(key, [footprint]);
      }
    }
  }

  return { timestamp: payload.timestamp, grid, places: decodePlaces(payload.places ?? []) };
}

function decodePlaces(rows: PlaceRow[]): NamedPlaceRow[] {
  return rows.map(([name, encoded, lat0, lng0]) => {
    if (!encoded) return { name, ring: null, lat: lat0 / 1e6, lon: lng0 / 1e6 };
    let lat = encoded[0];
    let lng = encoded[1];
    const ring = [{ lat: lat / 1e6, lon: lng / 1e6 }];
    for (let i = 2; i < encoded.length; i += 2) {
      lat += encoded[i];
      lng += encoded[i + 1];
      ring.push({ lat: lat / 1e6, lon: lng / 1e6 });
    }
    return { name, ring, lat: lat0 / 1e6, lon: lng0 / 1e6 };
  });
}

/**
 * The named places, all 1,288 of them. There are few enough that filtering by
 * distance here would cost more than handing the lot over — the noise report
 * only looks at the handful of parcels it already decided were loud.
 */
export async function namedPlaceRows(): Promise<NamedPlaceRow[] | null> {
  const loaded = await loadFootprints();
  return loaded ? loaded.places : null;
}

/**
 * Every building whose outline falls in the box around `origin`, or null when
 * no file has been built — which the caller reads as "ask Overpass instead".
 */
export async function footprintsNear(
  origin: LatLng,
  radiusM: number,
): Promise<{ footprints: Footprint[]; timestamp: string | null } | null> {
  const loaded = await loadFootprints();
  if (!loaded) return null;

  const box = boundingBox(origin, radiusM);
  const found = new Set<Footprint>();
  for (let lat = box.south; lat <= box.north + CELL_DEG; lat += CELL_DEG) {
    for (let lng = box.west; lng <= box.east + CELL_DEG; lng += CELL_DEG) {
      for (const f of loaded.grid.get(cellKey(lat, lng)) ?? []) {
        if (f.bbox.north < box.south || f.bbox.south > box.north) continue;
        if (f.bbox.east < box.west || f.bbox.west > box.east) continue;
        found.add(f);
      }
    }
  }
  return { footprints: [...found], timestamp: loaded.timestamp };
}
