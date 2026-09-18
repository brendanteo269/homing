import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { boundingBox } from "./geo";
import type { LatLng } from "./types";

/**
 * Singapore's HDB blocks, from HDB's own two registers rather than inferred.
 *
 * About eight in ten Singaporeans live in one of these 13,436 blocks, and
 * until now the app guessed at half their heights from the size of their
 * neighbours. HDB publishes the footprint of every block and, separately, the
 * highest storey in every block — so for the housing type that matters most
 * here, both the shape and the height are a matter of record. `npm run
 * build-hdb` joins the two and writes the file this reads.
 *
 * Everything else in Singapore — private condominiums, shophouses, offices,
 * the industrial estates — is still OpenStreetMap and still inferred.
 */
export interface HdbBlock {
  /** Postal code. Names exactly one block, and is unique in this set. */
  postal: string;
  blockNo: string;
  street: string;
  /** Highest storey in the block, from HDB's register. Null if unjoined. */
  maxFloorLevel: number | null;
  yearCompleted: number | null;
  /** Dwelling units in the block. */
  units: number | null;
  residential: boolean;
  commercial: boolean;
  marketOrHawker: boolean;
  multistoreyCarpark: boolean;
  precinctPavilion: boolean;
  /** Outline in lng/lat, not closed. */
  ring: [number, number][];
  bbox: { south: number; west: number; north: number; east: number };
}

interface Encoded {
  p: string;
  b: string;
  s: string;
  f: number | null;
  y: number | null;
  t: string;
  u: number | null;
  r: [number, number][];
}

const DATA_FILE = path.join(process.cwd(), "data", "hdb-blocks.json.gz");

/**
 * Floor-to-floor heights and roof furniture, by what the block is for.
 *
 * A residential slab's extra is the taller void-deck storey plus the lift
 * motor room and water tanks on the roof — which really do cast shadow, and
 * on a low block are a tenth of its height. A multi-storey car park has
 * shallower decks and almost nothing on top.
 */
const STOREY: Record<"residential" | "carpark" | "other", { floor: number; roof: number }> = {
  residential: { floor: 2.9, roof: 4.5 },
  carpark: { floor: 2.8, roof: 1.2 },
  other: { floor: 3.5, roof: 2.0 },
};

/** Roof height above ground for a block, or null if its storeys are unknown. */
export function hdbHeight(block: HdbBlock): number | null {
  if (!block.maxFloorLevel) return null;
  const kind = block.residential ? "residential" : block.multistoreyCarpark ? "carpark" : "other";
  const { floor, roof } = STOREY[kind];
  return block.maxFloorLevel * floor + roof;
}

/* ------------------------------------------------------------------ index */

interface HdbIndex {
  blocks: HdbBlock[];
  byPostal: Map<string, HdbBlock>;
  /** Blocks bucketed by a coarse lat/lng grid, so a query reads a few cells. */
  grid: Map<string, HdbBlock[]>;
}

/** Roughly 550 m. A 600 m query touches nine cells. */
const CELL_DEG = 0.005;
const cellKey = (lat: number, lng: number) =>
  `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;

let loading: Promise<HdbIndex | null> | null = null;

/**
 * The dataset is 3.5 MB gzipped and is read once per process.
 *
 * A checkout that has not run `npm run build-hdb` has no file here, and that
 * is not an error — the app falls back to OpenStreetMap alone, which is what
 * it did before this existed. A file that is present but unreadable is a
 * different matter, and says so, because silently answering with inferred
 * heights when real ones were meant to be loaded is the one failure this is
 * supposed to prevent.
 */
export function loadHdb(): Promise<HdbIndex | null> {
  loading ??= readFile(DATA_FILE)
    .then((gz) => index(JSON.parse(gunzipSync(gz).toString("utf8")) as Encoded[]))
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== "ENOENT") {
        console.warn(`Could not read ${DATA_FILE} — falling back to inferred heights.`, err);
      }
      return null;
    });
  return loading;
}

function index(rows: Encoded[]): HdbIndex {
  const blocks: HdbBlock[] = [];
  const byPostal = new Map<string, HdbBlock>();
  const grid = new Map<string, HdbBlock[]>();

  for (const row of rows) {
    if (row.r.length < 3) continue;
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    for (const [lng, lat] of row.r) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }

    const block: HdbBlock = {
      postal: row.p,
      blockNo: row.b,
      street: row.s,
      maxFloorLevel: row.f,
      yearCompleted: row.y,
      units: row.u,
      residential: row.t.includes("r"),
      commercial: row.t.includes("c"),
      marketOrHawker: row.t.includes("m"),
      multistoreyCarpark: row.t.includes("p"),
      precinctPavilion: row.t.includes("v"),
      ring: row.r,
      bbox: { south, west, north, east },
    };

    blocks.push(block);
    byPostal.set(block.postal, block);
    for (let lat = south; lat <= north + CELL_DEG; lat += CELL_DEG) {
      for (let lng = west; lng <= east + CELL_DEG; lng += CELL_DEG) {
        const key = cellKey(lat, lng);
        const cell = grid.get(key);
        if (cell) {
          if (!cell.includes(block)) cell.push(block);
        } else grid.set(key, [block]);
      }
    }
  }

  return { blocks, byPostal, grid };
}

/* ----------------------------------------------------------------- queries */

/** Every HDB block whose footprint falls in the box around `origin`. */
export async function hdbBlocksNear(origin: LatLng, radiusM: number): Promise<HdbBlock[]> {
  const hdb = await loadHdb();
  if (!hdb) return [];

  const box = boundingBox(origin, radiusM);
  const found = new Set<HdbBlock>();
  for (let lat = box.south; lat <= box.north + CELL_DEG; lat += CELL_DEG) {
    for (let lng = box.west; lng <= box.east + CELL_DEG; lng += CELL_DEG) {
      for (const b of hdb.grid.get(cellKey(lat, lng)) ?? []) {
        if (b.bbox.north < box.south || b.bbox.south > box.north) continue;
        if (b.bbox.east < box.west || b.bbox.west > box.east) continue;
        found.add(b);
      }
    }
  }
  return [...found];
}

/** The one block a postal code names, if it is an HDB block. */
export async function hdbBlockByPostal(postal: string | null | undefined): Promise<HdbBlock | null> {
  if (!postal) return null;
  const hdb = await loadHdb();
  return hdb?.byPostal.get(postal.trim()) ?? null;
}
