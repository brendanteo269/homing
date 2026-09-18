import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { boundingBox, pointInPolygon, polygonArea, polygonCentroid, type Projection } from "./geo";
import { hdbBlocksNear, hdbHeight, type HdbBlock } from "./hdb";
import type { Building, HeightSource, LatLng } from "./types";

const MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const USER_AGENT =
  "homing/0.1 (Singapore sun and blockage prototype; https://github.com/homing-sg)";

const CACHE_DIR = path.join(process.cwd(), ".cache", "overpass");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;

interface OverpassWay {
  type: string;
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassWay[];
  osm3s?: { timestamp_osm_base?: string };
}

export interface BuildingSet {
  buildings: Building[];
  dataTimestamp: string | null;
}

/**
 * Every building around a point, from the best source available for each.
 *
 * HDB publishes the footprint and the highest storey of all 13,436 of its
 * blocks, so for the four in five homes that are one of those, neither the
 * shape nor the height has to be guessed at or taken on a volunteer's word.
 * OpenStreetMap covers everything else — the condominiums, the shophouses,
 * the offices and the sheds — and those are still tagged where somebody has
 * tagged them and inferred where nobody has.
 *
 * The two overlap, because OSM maps HDB blocks too. Where they describe the
 * same block, HDB's record wins and the OSM copy is dropped.
 */
export async function fetchBuildings(
  origin: LatLng,
  radiusM: number,
  projection: Projection,
): Promise<BuildingSet> {
  const [osm, hdb] = await Promise.all([
    fetchOsmBuildings(origin, radiusM, projection),
    hdbBlocksNear(origin, radiusM),
  ]);

  const official = hdb.map((block) => toBuilding(block, projection));
  const buildings = [...official, ...dropDuplicatesOf(official, osm.buildings)];

  // Inference runs last and over the merged set, so the blocks that still need
  // a guessed height are sized against HDB's real ones rather than against
  // whatever their neighbours happen to be tagged with.
  fillInferredHeights(buildings);
  return { buildings, dataTimestamp: osm.dataTimestamp };
}

/** HDB's record of one block, as the engine's geometry. */
function toBuilding(block: HdbBlock, projection: Projection): Building {
  const height = hdbHeight(block);
  return {
    id: `hdb/${block.postal}`,
    ring: block.ring.map(([lng, lat]) => projection.toLocal({ lat, lng })),
    height: height ?? 0,
    heightSource: height === null ? "inferred" : "hdb-register",
    levels: block.maxFloorLevel,
    name: null,
    blockNo: block.blockNo,
    street: block.street || null,
    postal: block.postal,
    // A block of flats is a home; the estate's multi-storey car parks, markets
    // and pavilions are in this register too, and they block sun just the same.
    kind: block.residential ? "hdb" : "other",
  };
}

/**
 * OSM's copies of blocks HDB has already described.
 *
 * Two drawings of one building sit on the same spot and cover the same ground,
 * so that is what is tested: how far apart their centres are, and how close
 * their areas are. Testing whether one centre falls inside the other outline
 * looks more rigorous and is worse — a U-shaped point block or a car park
 * built round a courtyard has its centre in the courtyard, outside its own
 * footprint, so the test fails for exactly the shapes it most needs to catch.
 * Around one Ang Mo Kio address it left six blocks in the model twice.
 *
 * A shared block number widens the reach, because when both sources agree on
 * which block this is, a drawing that sits some way off is still that block.
 */
function dropDuplicatesOf(official: Building[], osm: Building[]): Building[] {
  if (official.length === 0) return osm;

  const centres = official.map((b) => ({
    blockNo: b.blockNo?.trim().toUpperCase() ?? null,
    centre: polygonCentroid(b.ring),
    area: Math.abs(polygonArea(b.ring)),
  }));

  return osm.filter((candidate) => {
    const centre = polygonCentroid(candidate.ring);
    const area = Math.abs(polygonArea(candidate.ring));
    const blockNo = candidate.blockNo?.trim().toUpperCase() ?? null;

    return !centres.some((o) => {
      const ratio = area / o.area;
      if (ratio < AREA_RATIO_MIN || ratio > AREA_RATIO_MAX) return false;
      const gap = Math.hypot(centre[0] - o.centre[0], centre[1] - o.centre[1]);
      const reach = blockNo && blockNo === o.blockNo ? SAME_BLOCK_REACH_M : SAME_BUILDING_M;
      return gap <= reach;
    });
  });
}

/** How far two drawings of one building's centre can fall apart. */
const SAME_BUILDING_M = 15;
/** The same, once both sources agree on the block number. */
const SAME_BLOCK_REACH_M = 40;
/** How different their areas may be. Two outlines of one block are close. */
const AREA_RATIO_MIN = 0.4;
const AREA_RATIO_MAX = 2.5;

/**
 * Footprints from OpenStreetMap, for everything HDB does not publish.
 */
async function fetchOsmBuildings(
  origin: LatLng,
  radiusM: number,
  projection: Projection,
): Promise<BuildingSet> {
  const bbox = boundingBox(origin, radiusM);
  const query = `[out:json][timeout:60];way["building"](${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)});out geom;`;
  const raw = await runQuery(query);

  const buildings: Building[] = [];
  for (const el of raw.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
    const tags = el.tags ?? {};
    if (tags.building === "roof" || tags.location === "underground") continue;

    const ring = el.geometry.map((p: { lat: number; lon: number }) =>
      projection.toLocal({ lat: p.lat, lng: p.lon }),
    );
    // Overpass closes the ring by repeating the first node; drop the duplicate.
    if (
      ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1]
    ) {
      ring.pop();
    }
    if (ring.length < 3) continue;
    if (Math.abs(polygonArea(ring)) < 12) continue;

    const kind = classify(tags, Math.abs(polygonArea(ring)));

    buildings.push({
      id: `way/${el.id}`,
      ring,
      ...resolveHeight(tags, kind),
      name: tags.name ?? null,
      blockNo: tags["addr:housenumber"] ?? null,
      street: tags["addr:street"] ?? null,
      postal: tags["addr:postcode"] ?? null,
      kind,
    });
  }

  return { buildings, dataTimestamp: raw.osm3s?.timestamp_osm_base ?? null };
}

const RESIDENTIAL_BUILDINGS = [
  "residential", "apartments", "house", "detached", "terrace", "semidetached_house", "dormitory",
];
/** Tags that rule a footprint out of being somebody's home. */
const NON_RESIDENTIAL_HINTS = ["amenity", "shop", "office", "tourism", "leisure", "aeroway", "parking"];
const NON_RESIDENTIAL_BUILDINGS = [
  "retail", "commercial", "industrial", "warehouse", "school", "hospital", "church", "mosque",
  "temple", "civic", "public", "carport", "garage", "garages", "parking", "train_station",
  "transportation", "hangar", "service", "shed", "hut", "kiosk", "toilets", "construction",
];

/**
 * Many Singapore residential blocks are mapped only as `building=yes`. A large
 * footprint carrying a block number, with nothing saying otherwise, is a block —
 * getting this wrong leaves a twelve-storey slab modelled as a shed.
 */
function classify(tags: Record<string, string>, area: number): Building["kind"] {
  if (tags.residential === "HDB") return "hdb";
  const building = tags.building ?? "";
  if (RESIDENTIAL_BUILDINGS.includes(building)) return "residential";
  if (NON_RESIDENTIAL_BUILDINGS.includes(building)) return "other";
  if (NON_RESIDENTIAL_HINTS.some((k) => k in tags)) return "other";

  // A block number on a footprint this size, in Singapore, is a residential
  // block. Many are mapped with nothing else at all: `building=yes` and a number.
  const addressed = Boolean(tags["addr:housenumber"] || tags["addr:street"]);
  if ((building === "yes" || building === "") && addressed && area >= 400) return "residential";
  return "other";
}

/**
 * Floor-to-floor heights in Singapore residential stock. HDB slab blocks run
 * about 2.9 m; private apartments are a little more generous. The extra is the
 * void deck's taller ground storey plus roof plant, lift motor room and tanks —
 * all of which really do cast shadow.
 */
export const FLOOR_HEIGHT_M: Record<Building["kind"], number> = { hdb: 2.9, residential: 3.15, other: 3.8 };
const ROOF_PLANT_M: Record<Building["kind"], number> = { hdb: 4.5, residential: 4.0, other: 2.0 };

function resolveHeight(
  tags: Record<string, string>,
  kind: Building["kind"],
): { height: number; heightSource: HeightSource; levels: number | null } {
  const explicit = Number.parseFloat(tags.height ?? tags["building:height"] ?? "");
  if (Number.isFinite(explicit) && explicit > 1) {
    return { height: explicit, heightSource: "height-tag", levels: parseLevels(tags) };
  }

  const levels = parseLevels(tags);
  if (levels) {
    return {
      height: levels * FLOOR_HEIGHT_M[kind] + ROOF_PLANT_M[kind],
      heightSource: "levels-tag",
      levels,
    };
  }

  return { height: 0, heightSource: "inferred", levels: null };
}

function parseLevels(tags: Record<string, string>): number | null {
  const n = Number.parseFloat(tags["building:levels"] ?? "");
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Anything still without a height borrows one from the tagged buildings nearby
 * with a comparable footprint — a 1,300 m2 slab is sized against the slab next
 * door, not against the estate's bin centres. It stays flagged as a guess.
 */
function fillInferredHeights(buildings: Building[]) {
  const tagged = buildings
    .filter((b) => b.heightSource !== "inferred")
    .map((b) => ({ area: Math.abs(polygonArea(b.ring)), height: b.height, kind: b.kind }));

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const heightsOf = (pool: typeof tagged) => pool.map((t) => t.height);

  for (const b of buildings) {
    if (b.heightSource !== "inferred") continue;
    const area = Math.abs(polygonArea(b.ring));
    const comparable = (t: (typeof tagged)[number]) => t.area >= area / 2 && t.area <= area * 2;

    let pool = tagged.filter((t) => t.kind === b.kind && comparable(t));
    if (pool.length < 3) pool = tagged.filter(comparable);
    if (pool.length < 3) pool = tagged.filter((t) => t.kind === b.kind);

    b.height = pool.length >= 3 ? median(heightsOf(pool)) : fallbackHeight(area, b.kind);
  }
}

/** Last resort when the extract has nothing comparable to learn from. */
function fallbackHeight(area: number, kind: Building["kind"]) {
  if (area < 120) return 4;
  if (area < 400) return 9;
  return { hdb: 38, residential: 30, other: 12 }[kind];
}

/** Concurrent requests for the same extract should wait on one fetch, not race. */
const inFlight = new Map<string, Promise<OverpassResponse>>();

function runQuery(query: string): Promise<OverpassResponse> {
  const pending = inFlight.get(query);
  if (pending) return pending;

  const job = fetchQuery(query).finally(() => inFlight.delete(query));
  inFlight.set(query, job);
  return job;
}

/**
 * Overpass is run by volunteers and is busy: under load a mirror answers 429 or
 * 504 within seconds, and all three can be busy at once. Trying each once means
 * a neighbourhood nobody has looked at yet simply fails, which is the whole
 * answer for that address. So go round the mirrors more than once, backing off
 * between rounds — a cold area is worth waiting half a minute for.
 */
const ROUNDS = 3;
const BACKOFF_MS = [0, 4000, 12000];

async function fetchQuery(query: string): Promise<OverpassResponse> {
  const cached = await readCache(query);
  if (cached) return cached;

  let lastError: unknown = null;
  for (let round = 0; round < ROUNDS; round++) {
    if (BACKOFF_MS[round]) await sleep(BACKOFF_MS[round]);

    for (const mirror of MIRRORS) {
      try {
        const res = await fetch(mirror, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // Overpass rate-limits anonymous clients; identify ourselves properly.
            "User-Agent": USER_AGENT,
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(75000),
        });
        if (!res.ok) throw new Error(`${mirror} returned ${res.status}`);
        const json = (await res.json()) as OverpassResponse;
        if (!Array.isArray(json.elements)) throw new Error(`${mirror} returned no elements`);
        await writeCache(query, json);
        return json;
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw new Error(
    `OpenStreetMap's Overpass mirrors are all busy — this usually clears in a minute. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cachePath(query: string) {
  return path.join(CACHE_DIR, `${createHash("sha1").update(query).digest("hex")}.json`);
}

async function readCache(query: string): Promise<OverpassResponse | null> {
  try {
    const file = await readFile(cachePath(query), "utf8");
    const { at, body } = JSON.parse(file) as { at: number; body: OverpassResponse };
    if (Date.now() - at > CACHE_TTL_MS) return null;
    return body;
  } catch {
    return null;
  }
}

async function writeCache(query: string, body: OverpassResponse) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(query), JSON.stringify({ at: Date.now(), body }));
  } catch {
    // A cold cache costs a few seconds; it is never worth failing the request.
  }
}
