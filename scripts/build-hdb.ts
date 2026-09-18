/**
 * Builds the HDB block dataset the analyser reads: authoritative footprints
 * with authoritative storey counts, for every HDB block in Singapore.
 *
 * Two open datasets hold half the answer each. HDB Existing Building has the
 * footprint polygon, the block number and the postal code, but no height.
 * HDB Property Information has `max_floor_lvl` — the real storey count — but
 * no geometry, and it is addressed by block number and street name.
 *
 * They do not share a key. The footprints carry a six-character street *code*
 * ("TAS40G"), the register carries a street *name* ("TAMPINES ST 33"), and no
 * published table maps one to the other. The code is not decodable either: it
 * is two letters of the estate and one of the road type, so CHOA CHU KANG AVE
 * and CHAI CHEE AVE both come out "CHA".
 *
 * So the codes are resolved rather than guessed. Every footprint has a postal
 * code, and OneMap turns a postal code into a block and a road name — which
 * means one lookup per street code, about 660 of them, is enough to learn the
 * whole table from the Land Authority's own gazetteer. Blocks that still fail
 * to join are then resolved one at a time, and whatever is left over is
 * printed rather than quietly filled in with a guess.
 *
 * The crawl is the slow part and it is cached block by block, so a second run
 * costs nothing and an interrupted run resumes where it stopped.
 *
 *   npx tsx scripts/build-hdb.ts
 */
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { blockKey, normaliseBlock, normaliseStreet } from "../src/lib/street";

const BUILDING_DATASET = "d_16b157c52ed637edd6ba1232e026258d";
const PROPERTY_RESOURCE = "d_17f5382f26140b1fdae0ba2ef6239d2f";

const CACHE_DIR = path.join(process.cwd(), ".cache", "hdb");
const OUT_FILE = path.join(process.cwd(), "data", "hdb-blocks.json.gz");

/** OneMap answers about one request a second before it starts refusing. */
const ONEMAP_DELAY_MS = 1500;
/** Simplification tolerance. Half a metre is well under the error in anything
 *  downstream, and it halves a file that is mapped to every window reveal. */
const SIMPLIFY_M = 0.5;
const DEG_PER_M = 9e-6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);

interface FootprintProps {
  BLK_NO: string;
  ST_COD: string;
  POSTAL_COD: string;
}
interface PropertyRow {
  blk_no: string;
  street: string;
  max_floor_lvl: string;
  year_completed: string;
  residential: string;
  commercial: string;
  market_hawker: string;
  multistorey_carpark: string;
  precinct_pavilion: string;
  total_dwelling_units: string;
}

/** What one HDB block comes out as. Keys are short because there are 13,436. */
export interface HdbBlockRecord {
  /** Postal code — unique per footprint, and the app's exact match key. */
  p: string;
  /** Block number, including any letter suffix. */
  b: string;
  /** Road name as HDB's register writes it. */
  s: string;
  /** Highest storey. Null where the block could not be joined to the register. */
  f: number | null;
  /** Year completed. */
  y: number | null;
  /** residential, commercial, market/hawker, carpark, pavilion. */
  t: string;
  /** Dwelling units. */
  u: number | null;
  /** Outline, [lng, lat] pairs, not closed. */
  r: [number, number][];
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(path.dirname(OUT_FILE), { recursive: true });

  const features = await loadFootprints();
  const property = await loadProperty();
  log(`  ${features.length} footprints, ${property.length} register rows`);

  const register = new Map<string, PropertyRow>();
  for (const row of property) {
    const key = blockKey(row.blk_no, row.street);
    if (key) register.set(key, row);
  }

  const streets = await resolveStreets(features, register);
  const records = assemble(features, register, streets);

  const joined = records.filter((r) => r.f !== null).length;
  log(`\nJoined ${joined} of ${records.length} blocks to a storey count (${((joined / records.length) * 100).toFixed(1)}%)`);

  const body = gzipSync(Buffer.from(JSON.stringify(records)), { level: 9 });
  await writeFile(OUT_FILE, body);
  log(`Wrote ${OUT_FILE} — ${(body.length / 1e6).toFixed(2)} MB gzipped`);

  report(records, register);
  verify(records);
}

/* ---------------------------------------------------------------- sources */

async function loadFootprints() {
  const file = path.join(CACHE_DIR, "existing-building.geojson");
  let text = await readFile(file, "utf8").catch(() => null);
  if (!text) {
    log("Downloading HDB Existing Building…");
    const url = await pollDownload(BUILDING_DATASET);
    text = await (await fetch(url)).text();
    await writeFile(file, text);
  }

  const json = JSON.parse(text) as {
    features: {
      geometry: { type: string; coordinates: number[][][] | number[][][][] };
      properties: FootprintProps;
    }[];
  };

  return json.features.map((f) => ({
    props: f.properties,
    // A handful of blocks are mapped as multipolygons — a linked pair sharing
    // one address. The largest part is the block; the rest are its outbuildings.
    ring: outerRing(f.geometry),
  }));
}

function outerRing(geometry: { type: string; coordinates: unknown }): [number, number][] {
  const coords = geometry.coordinates as number[][][] | number[][][][];
  const rings =
    geometry.type === "Polygon"
      ? [(coords as number[][][])[0]]
      : (coords as number[][][][]).map((part) => part[0]);
  const largest = rings.reduce((a, b) => (b.length > a.length ? b : a));
  return largest.map((c) => [c[0], c[1]] as [number, number]);
}

/** data.gov.sg hands out a signed S3 link rather than the file itself. */
async function pollDownload(datasetId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(
      `https://api-open.data.gov.sg/v1/public/api/datasets/${datasetId}/poll-download`,
    );
    const json = (await res.json()) as { data?: { url?: string } };
    if (json.data?.url) return json.data.url;
    await sleep(3000);
  }
  throw new Error(`data.gov.sg would not produce a download link for ${datasetId}`);
}

async function loadProperty(): Promise<PropertyRow[]> {
  const file = path.join(CACHE_DIR, "property.json");
  const cached = await readFile(file, "utf8").catch(() => null);
  if (cached) return JSON.parse(cached) as PropertyRow[];

  log("Downloading HDB Property Information…");
  const rows: PropertyRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await datastorePage(offset);
    rows.push(...(page.records as PropertyRow[]));
    if (rows.length >= page.total) break;
    // The portal rate-limits anonymous callers at a few pages a second.
    await sleep(1200);
  }
  await writeFile(file, JSON.stringify(rows));
  return rows;
}

async function datastorePage(offset: number) {
  const url = `https://data.gov.sg/api/action/datastore_search?resource_id=${PROPERTY_RESOURCE}&limit=1000&offset=${offset}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url);
    const json = (await res.json()) as {
      success?: boolean;
      result?: { records: unknown[]; total: number };
    };
    if (json.success && json.result) return json.result;
    await sleep(11000);
  }
  throw new Error(`data.gov.sg kept refusing rows at offset ${offset}`);
}

/* -------------------------------------------------------- street resolution */

type StreetCache = Record<string, string | null>;

/**
 * Learns the road name behind every street code, and then behind every block
 * that the street code alone did not place.
 *
 * The first pass asks OneMap about one block per street code, which is enough
 * for the roughly 500 codes that cover exactly one road. The second pass picks
 * up the rest: a code like PAT06T spans two roads, so its other blocks fail to
 * join and get asked about individually.
 */
async function resolveStreets(
  features: { props: FootprintProps }[],
  register: Map<string, PropertyRow>,
): Promise<StreetCache> {
  const file = path.join(CACHE_DIR, "streets.json");
  const cache: StreetCache = JSON.parse((await readFile(file, "utf8").catch(() => "{}")) as string);
  const save = () => writeFile(file, JSON.stringify(cache, null, 1));

  const byCode = new Map<string, FootprintProps[]>();
  for (const f of features) {
    const list = byCode.get(f.props.ST_COD);
    if (list) list.push(f.props);
    else byCode.set(f.props.ST_COD, [f.props]);
  }

  const pending = [...byCode.values()].map((g) => g[0]).filter((p) => !(p.POSTAL_COD in cache));
  log(`\nResolving ${byCode.size} street codes (${pending.length} not cached)…`);
  await crawl(pending, cache, save);

  // Whatever the codes placed, plus whatever they did not.
  const codeStreet = new Map<string, string>();
  for (const [code, group] of byCode) {
    const road = cache[group[0].POSTAL_COD];
    if (road) codeStreet.set(code, road);
  }

  const stragglers = features
    .map((f) => f.props)
    .filter((p) => !(p.POSTAL_COD in cache))
    .filter((p) => {
      const road = codeStreet.get(p.ST_COD);
      return !road || !register.has(blockKey(p.BLK_NO, road)!);
    });

  if (stragglers.length) {
    log(`\n${stragglers.length} blocks their street code did not place — asking about each…`);
    await crawl(stragglers, cache, save);
  }

  await save();
  return cache;
}

async function crawl(targets: FootprintProps[], cache: StreetCache, save: () => Promise<void>) {
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    if (p.POSTAL_COD in cache) continue;
    cache[p.POSTAL_COD] = await onemapRoad(p.POSTAL_COD);
    // Checkpoint often. The crawl runs for the better part of an hour and is
    // worth nothing if it has to start over, so the cost of rewriting a small
    // file every few lookups buys back every interruption.
    await save();
    if (i % 25 === 0) {
      const done = i + 1;
      const left = Math.round(((targets.length - done) * ONEMAP_DELAY_MS) / 60000);
      log(`  ${done}/${targets.length}  ${p.POSTAL_COD} -> ${cache[p.POSTAL_COD] ?? "(unknown)"}  ~${left} min left`);
    }
    await sleep(ONEMAP_DELAY_MS);
  }
  await save();
}

/** The road name OneMap holds for a postal code, or null if it has none. */
async function onemapRoad(postal: string): Promise<string | null> {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${postal}&returnGeom=N&getAddrDetails=Y`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429) {
        await sleep(8000 * (attempt + 1));
        continue;
      }
      const json = (await res.json()) as { results?: { POSTAL?: string; ROAD_NAME?: string }[] };
      const hit = json.results?.find((r) => r.POSTAL === postal);
      return hit?.ROAD_NAME ?? null;
    } catch {
      await sleep(4000 * (attempt + 1));
    }
  }
  return null;
}

/* ------------------------------------------------------------- assembly */

function assemble(
  features: { props: FootprintProps; ring: [number, number][] }[],
  register: Map<string, PropertyRow>,
  streets: StreetCache,
): HdbBlockRecord[] {
  const byCode = new Map<string, string>();
  for (const f of features) {
    const road = streets[f.props.POSTAL_COD];
    if (road && !byCode.has(f.props.ST_COD)) byCode.set(f.props.ST_COD, road);
  }

  return features.map(({ props, ring }) => {
    // A block's own postal code is the best evidence; its street code is the
    // fallback for the blocks that were never asked about individually.
    const road = streets[props.POSTAL_COD] ?? byCode.get(props.ST_COD) ?? null;
    const row = road ? register.get(blockKey(props.BLK_NO, road)!) : undefined;
    const simplified = simplify(ring, SIMPLIFY_M * DEG_PER_M);

    return {
      p: props.POSTAL_COD,
      b: normaliseBlock(props.BLK_NO)!,
      s: titleCase(row?.street ?? road ?? ""),
      f: row ? int(row.max_floor_lvl) : null,
      y: row ? int(row.year_completed) : null,
      t: row ? flags(row) : "",
      u: row ? int(row.total_dwelling_units) : null,
      r: simplified.map((c) => [round6(c[0]), round6(c[1])] as [number, number]),
    };
  });
}

/** The register's Y/N columns, as the letters the app tests for. */
function flags(row: PropertyRow) {
  return (
    (row.residential === "Y" ? "r" : "") +
    (row.commercial === "Y" ? "c" : "") +
    (row.market_hawker === "Y" ? "m" : "") +
    (row.multistorey_carpark === "Y" ? "p" : "") +
    (row.precinct_pavilion === "Y" ? "v" : "")
  );
}

/**
 * HDB's register and OneMap both write road names in capitals. The app prints
 * them beside OpenStreetMap's, which are not, and a blocker table shouting
 * "BLK 408 ANG MO KIO AVE 10" at one row and murmuring the next reads badly.
 * The abbreviations are left as HDB writes them.
 */
function titleCase(street: string) {
  return street
    .toLowerCase()
    .replace(/(^|[\s\-/])([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
}

const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Douglas-Peucker, iteratively so a 900-vertex ring cannot blow the stack. */
function simplify(points: [number, number][], eps: number): [number, number][] {
  const ring = points.length > 1 && same(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
  if (ring.length < 5) return ring;

  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];

  while (stack.length) {
    const [from, to] = stack.pop()!;
    let worst = 0;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const d = perpendicular(ring[i], ring[from], ring[to]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > eps) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }

  return ring.filter((_, i) => keep[i] === 1);
}

const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

function perpendicular(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/* -------------------------------------------------------------- reporting */

/**
 * What did not join, and why — because a gap nobody prints is a gap nobody
 * fixes, and a list of 223 block numbers tells you nothing about which it is.
 *
 * Almost all of them turn out to be roads the property register has never
 * heard of, which is not a failure of the join: the register covers blocks of
 * flats, so HDB's landed terraces at Pasir Ris are absent by design, and the
 * estates cleared under SERS have left their footprints behind in the building
 * layer after their entries went. Those blocks keep the height the analyser
 * infers for them, flagged as a guess, exactly as before any of this existed.
 *
 * A block on a road the register *does* list is the interesting case, and the
 * one worth looking at by hand.
 */
function report(records: HdbBlockRecord[], register: Map<string, PropertyRow>) {
  const missing = records.filter((r) => r.f === null);
  if (missing.length === 0) {
    log("Every block joined.");
    return;
  }

  const knownRoads = new Set<string>();
  for (const key of register.keys()) knownRoads.add(key.slice(key.indexOf("|") + 1));

  const unknownRoad = new Map<string, number>();
  const unknownBlock: HdbBlockRecord[] = [];
  for (const r of missing) {
    const road = normaliseStreet(r.s);
    if (road && knownRoads.has(road)) unknownBlock.push(r);
    else unknownRoad.set(r.s || "(no road name)", (unknownRoad.get(r.s || "(no road name)") ?? 0) + 1);
  }

  const onUnknownRoads = missing.length - unknownBlock.length;
  log(`\n${missing.length} blocks without a storey count.`);
  log(`  ${onUnknownRoads} stand on ${unknownRoad.size} roads the register does not list at all:`);
  for (const [road, n] of [...unknownRoad].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    log(`    ${road.padEnd(30)} ${n}`);
  }
  if (unknownRoad.size > 10) log(`    … and ${unknownRoad.size - 10} more roads`);

  log(`  ${unknownBlock.length} stand on a road it does list, but under a block number it does not:`);
  for (const r of unknownBlock.slice(0, 10)) log(`    ${r.p}  blk ${r.b.padEnd(6)} ${r.s}`);
  if (unknownBlock.length > 10) log(`    … and ${unknownBlock.length - 10} more`);

  const residential = records.filter((r) => r.t.includes("r"));
  const storeys = residential.map((r) => r.f!).filter(Boolean).sort((a, b) => a - b);
  log(
    `\n${residential.length} residential blocks; storeys median ${storeys[Math.floor(storeys.length / 2)]}, max ${storeys[storeys.length - 1]}`,
  );
}

/**
 * A tripwire under the join, in case the way it is made ever changes.
 *
 * As built, a block cannot join to the wrong row: the key is its own block
 * number from HDB's footprint register and a road name from OneMap, and block
 * number and road are together unique in the property register, so a join is
 * either right or absent. That argument is only as good as the method, though,
 * and the method would quietly stop holding if road names were ever guessed at
 * instead of resolved — which is what the first draft of this script did.
 *
 * So geometry is kept as an independent witness. Divide a block's dwelling
 * units by its storeys for the units on a floor, divide its footprint by that,
 * and a flat with its share of the corridor lands between 40 and 250 m2. Rows
 * belonging to some other block have no reason to.
 *
 * The blocks that fall outside are worth reading rather than fixing. They are
 * mostly real: the ones carrying a market or a row of shops, where most of the
 * footprint is not flats at all, and the handful with four dwellings above
 * eight storeys of something else.
 */
function verify(records: HdbBlockRecord[]) {
  const testable = records.filter((r) => r.t.includes("r") && r.f && r.u && r.u > 0);
  const odd: { r: HdbBlockRecord; perUnit: number }[] = [];

  for (const r of testable) {
    const unitsPerFloor = r.u! / r.f!;
    const perUnit = Math.abs(shoelace(r.r)) / unitsPerFloor;
    if (perUnit < 40 || perUnit > 250) odd.push({ r, perUnit });
  }

  const rate = ((testable.length - odd.length) / testable.length) * 100;
  log(`\nPlausibility: ${testable.length - odd.length} of ${testable.length} residential blocks give a sane floor area per flat (${rate.toFixed(1)}%)`);
  if (odd.length) {
    log(`  ${odd.length} outside 40-250 m2 per flat — mostly blocks that are not all flats:`);
    for (const { r, perUnit } of odd.slice(0, 12)) {
      log(`    ${r.p}  blk ${r.b.padEnd(6)} ${r.s.padEnd(26)} ${r.f} storeys, ${r.u} units -> ${perUnit.toFixed(0)} m2/flat`);
    }
    if (odd.length > 12) log(`    … and ${odd.length - 12} more`);
  }
}

/** Footprint area in square metres, from a lng/lat ring at Singapore's latitude. */
function shoelace(ring: [number, number][]) {
  const mPerDegLat = 110574;
  const mPerDegLng = 110320;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xj = ring[j][0] * mPerDegLng;
    const yj = ring[j][1] * mPerDegLat;
    const xi = ring[i][0] * mPerDegLng;
    const yi = ring[i][1] * mPerDegLat;
    a += xj * yi - xi * yj;
  }
  return a / 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
