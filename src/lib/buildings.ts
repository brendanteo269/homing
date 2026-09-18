import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { boundingBox, pointInPolygon, polygonArea, polygonCentroid, type Projection } from "./geo";
import { footprintsNear, namedPlaceRows, type NamedPlaceRow } from "./footprints";
import { hdbBlocksNear, hdbHeight, type HdbBlock } from "./hdb";
import type { Building, HeightSource, LatLng } from "./types";

const MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const USER_AGENT =
  "homing/0.1 (Singapore sun and blockage prototype; https://github.com/homing-sg)";

/*
 * On a serverless host the working directory is read-only, so a cache written
 * beside the source is silently dropped and every request pays Overpass again —
 * which is invisible in development, where the repo cache is warm and hides the
 * cost entirely. /tmp is the one writable path there, and it survives between
 * warm invocations of the same instance, which is most of them.
 */
const CACHE_DIR = process.env.VERCEL
  ? path.join("/tmp", "overpass")
  : path.join(process.cwd(), ".cache", "overpass");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;

interface OverpassWay {
  type: string;
  id: number;
  geometry?: { lat: number; lon: number }[];
  /** A node's own position. */
  lat?: number;
  lon?: number;
  /** Under `out geom`, the extent of a way or relation. */
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
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
  // The built file is the same OpenStreetMap data Overpass would have sent, so
  // it is turned into the same elements and read by the same code below. The
  // live query stays as the fallback for a checkout that has not built one.
  const local = await footprintsNear(origin, radiusM);
  const raw: OverpassResponse = local
    ? {
        elements: local.footprints.map((f) => ({
          type: "way",
          id: f.id,
          geometry: f.ring,
          tags: f.tags,
        })),
        osm3s: { timestamp_osm_base: local.timestamp ?? undefined },
      }
    : await runQuery(overpassQuery(origin, radiusM));

  const buildings: Building[] = [];
  for (const el of raw.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
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

function overpassQuery(origin: LatLng, radiusM: number) {
  const bbox = boundingBox(origin, radiusM);
  return `[out:json][timeout:60];way["building"](${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)});out geom;`;
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
/*
 * The ladder has to finish inside the host's function limit, with room left to
 * do the geometry and send the answer. Run past it and the host kills the
 * invocation mid-response: the browser reports an aborted connection and the
 * reader is told nothing at all. Giving up a little early is worth a great
 * deal, because it comes back as a sentence explaining that the mirrors are
 * busy rather than as a dead request.
 */
const BUDGET_MS = 85000;
/** No single mirror may eat the budget while the others sit untried. */
const ATTEMPT_MS = 25000;

async function fetchQuery(query: string): Promise<OverpassResponse> {
  const cached = await readCache(query);
  if (cached) return cached;

  const deadline = Date.now() + BUDGET_MS;
  let lastError: unknown = null;
  for (let round = 0; round < ROUNDS; round++) {
    // Backing off is only worth it if there is time left to use the result.
    if (BACKOFF_MS[round]) {
      if (Date.now() + BACKOFF_MS[round] >= deadline) break;
      await sleep(BACKOFF_MS[round]);
    }

    for (const mirror of MIRRORS) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        const res = await fetch(mirror, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // Overpass rate-limits anonymous clients; identify ourselves properly.
            "User-Agent": USER_AGENT,
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(Math.min(ATTEMPT_MS, left)),
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


/**
 * A named thing on the ground: an industrial estate, a depot, a substation.
 *
 * The Master Plan says a parcel is zoned Business 1, which is what the noise
 * index is computed from and is also nothing a reader recognises. "Light
 * industry, 263 m to your right" is a category; "Techplace I" is a place they
 * can picture, look up, or remember driving past. OpenStreetMap is the only
 * open source that names these, and it names them unevenly — a depot usually,
 * a substation rarely — so this supplies a name where there is one and says
 * nothing where there is not. The zoning is still what the score is made of;
 * the name only says what is standing there.
 */
export interface NamedPlace {
  name: string;
  /** Outline in local metres. Null for the ones mapped as a single point. */
  ring: [number, number][] | null;
  x: number;
  y: number;
}

/**
 * Only the tags that name the things this app calls loud. Querying every named
 * feature in the bbox would return every shop and bus stop in the estate and
 * leave the matching to guess which of them was the works yard.
 */
const NAMED_PLACE_FILTERS = [
  '["landuse"~"^(industrial|depot|port|railway|quarry)$"]',
  '["power"~"^(substation|plant|generator)$"]',
  '["man_made"~"^(water_works|wastewater_plant|works|pumping_station)$"]',
  '["amenity"~"^(bus_station|waste_transfer_station)$"]',
  '["railway"~"^(depot|yard)$"]',
  '["building"~"^(industrial|warehouse|factory|depot|train_station)$"]',
  '["industrial"]',
];

/**
 * Whether what OpenStreetMap calls a name is one.
 *
 * Inside an industrial estate the individual units are mapped as buildings and
 * named for their unit number — "16", "30", "1079". Passing those through
 * produces "30, 240 m to your right", which reads as a confident answer and
 * says nothing; the estate's own name, or the bare zoning, is more use than a
 * number the reader cannot place. Two letters together is enough to keep the
 * real ones, including "1-Net North Data Center" and "60 SKM Industrial
 * Building", and enough to drop every bare unit number.
 */
function usableName(name: string | undefined | null): name is string {
  return !!name && /\p{L}{2}/u.test(name);
}

export async function fetchNamedPlaces(
  origin: LatLng,
  radiusM: number,
  projection: Projection,
): Promise<NamedPlace[]> {
  // The built file carries these too, matched on the same tags. Only when
  // there is no file does this fall back to asking Overpass live.
  const local = await namedPlaceRows();
  if (local) return toNamedPlaces(local, projection);

  const bbox = boundingBox(origin, radiusM);
  const box = `(${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)})`;
  // `out geom`, not `out center`: an industrial estate has to be matched by what
  // it covers, and a railway by where its track runs. Asking for both modes at
  // once quietly returns only the centre, which makes every estate a point
  // somewhere in its own middle and every match a coincidence.
  const query = `[out:json][timeout:60];(${NAMED_PLACE_FILTERS.map(
    (f) => `nwr["name"]${f}${box};`,
  ).join("")});out geom;`;

  // A missing name is a smaller failure than a missing answer. Overpass being
  // busy must not cost the reader their sun and blockage report as well.
  let raw;
  try {
    raw = await runQuery(query);
  } catch (err) {
    console.warn("Could not read named places from Overpass — reporting zoning only.", err);
    return [];
  }

  const places: NamedPlace[] = [];
  for (const el of raw.elements) {
    const name = el.tags?.name;
    if (!usableName(name)) continue;

    // Overpass marks an area by repeating its first node at the end. Anything
    // that does not close is a line, and a line is not ground: it names nothing
    // here, so it is dropped rather than quietly treated as a polygon.
    const points = el.geometry?.map((pt) => projection.toLocal({ lat: pt.lat, lng: pt.lon })) ?? null;
    const closed =
      !!points &&
      points.length >= 4 &&
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1];
    if (points && !closed) continue;
    if (closed) points!.pop();

    // A centre is only the fallback for shapes with no outline: a node, or a
    // relation, whose members Overpass returns separately.
    const middle =
      el.lat !== undefined && el.lon !== undefined
        ? { lat: el.lat, lng: el.lon }
        : el.bounds
          ? {
              lat: (el.bounds.minlat + el.bounds.maxlat) / 2,
              lng: (el.bounds.minlon + el.bounds.maxlon) / 2,
            }
          : null;
    const centre = points ? polygonCentroid(points) : middle ? projection.toLocal(middle) : null;
    if (!centre) continue;

    places.push({ name, ring: points, x: centre[0], y: centre[1] });
  }
  return places;
}


/**
 * The built rows, projected into this request's local metres. The centre is
 * computed from the outline rather than stored, so it stays the centroid the
 * live query produced and not whichever vertex happened to be written first.
 */
function toNamedPlaces(rows: NamedPlaceRow[], projection: Projection): NamedPlace[] {
  const places: NamedPlace[] = [];
  for (const row of rows) {
    if (!usableName(row.name)) continue;
    if (!row.ring) {
      const [x, y] = projection.toLocal({ lat: row.lat, lng: row.lon });
      places.push({ name: row.name, ring: null, x, y });
      continue;
    }
    const ring = row.ring.map((pt) => projection.toLocal({ lat: pt.lat, lng: pt.lon }));
    if (ring.length < 3) continue;
    const centre = polygonCentroid(ring);
    places.push({ name: row.name, ring, x: centre[0], y: centre[1] });
  }
  return places;
}
