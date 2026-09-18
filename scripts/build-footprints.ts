/**
 * Every building in Singapore, once, as a file the app can read instead of
 * asking Overpass at request time.
 *
 * Overpass is a query service run by volunteers, and it was answering one
 * neighbourhood in fifty seconds when it answered at all — the whole analysis
 * waited on it, and on a serverless host the invocation was killed before it
 * finished. None of that is Overpass being broken; it is the wrong tool for
 * reading a whole country. A planet extract is the right one, and Geofabrik
 * rebuilds theirs nightly.
 *
 *   npm run build-footprints
 *
 * Needs `osmium` on the PATH (`brew install osmium-tool`). The download is
 * cached, so a second run costs about ten seconds and no bandwidth.
 *
 * What comes out is deliberately dumb: the same tags Overpass would have
 * returned, trimmed to the ones the engine reads, with the geometry in
 * millionths of a degree. Classification and height inference stay in
 * src/lib/buildings.ts and run per request, so this file cannot drift from
 * the rules — it holds no verdicts, only what OpenStreetMap says.
 */
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const SOURCE = "https://download.geofabrik.de/asia/malaysia-singapore-brunei-latest.osm.pbf";

/**
 * A rectangle round Singapore, which necessarily takes in some of Johor and
 * the top of Batam. That is wanted, not tolerated: a window in Woodlands looks
 * across the strait at Johor Bahru, and leaving it out would draw that view as
 * empty sky. The cost is some buildings the app will never be asked about,
 * which compress to nothing.
 */
const BBOX = { west: 103.59, south: 1.15, east: 104.09, north: 1.48 };

const CACHE_DIR = path.join(process.cwd(), ".cache", "osm");
const OUT_FILE = path.join(process.cwd(), "data", "footprints.json.gz");

/**
 * The only tags the engine reads — `classify` and `resolveHeight` in
 * src/lib/buildings.ts, and nothing else. Keeping this list in step with those
 * two functions is the one maintenance burden this file carries, so it names
 * them rather than describing them.
 */
const KEEP_TAGS = [
  "building",
  "building:levels",
  "building:height",
  "height",
  "location",
  "residential",
  "name",
  "addr:housenumber",
  "addr:street",
  "addr:postcode",
  // The hints classify() tests for presence rather than value.
  "amenity",
  "shop",
  "office",
  "tourism",
  "leisure",
  "aeroway",
  "parking",
];

/**
 * The things this app calls loud, in osmium's filter syntax — the same set as
 * NAMED_PLACE_FILTERS in src/lib/buildings.ts, and for the same reason: asking
 * for every named feature would return every shop and bus stop in the estate
 * and leave the matching to guess which of them was the works yard.
 *
 * Only named ones are kept, which osmium cannot express, so the name test
 * happens during encoding instead.
 */
const PLACE_FILTERS = [
  "nwr/landuse=industrial,depot,port,railway,quarry",
  "nwr/power=substation,plant,generator",
  "nwr/man_made=water_works,wastewater_plant,works,pumping_station",
  "nwr/amenity=bus_station,waste_transfer_station",
  "nwr/railway=depot,yard",
  "nwr/building=industrial,warehouse,factory,depot,train_station",
  "nwr/industrial",
];

/**
 * The grounds a building can stand in without being named itself.
 *
 * A hospital or a school is mapped as a site polygon carrying the name, with
 * the wards and blocks inside it tagged `building=yes` and nothing else — so
 * Changi General Hospital reached the drawing as six anonymous masses called
 * "Building". These outlines carry no building tag, so the buildings filter
 * drops them; kept separately, they can lend their name to what stands inside.
 *
 * Narrow on purpose. A site only earns this if it is the thing a reader would
 * name when pointing at the block: the campus, not the car park it shares a
 * fence with.
 */
const SITE_FILTERS = [
  "nwr/amenity=hospital,clinic,school,college,university",
];

/** A tag whose value is never read, only its presence, need not carry one. */
const PRESENCE_ONLY = new Set(["amenity", "shop", "office", "tourism", "leisure", "aeroway", "parking"]);

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  requireOsmium();

  const pbf = path.join(CACHE_DIR, "msb-latest.osm.pbf");
  await download(pbf);

  const clipped = path.join(CACHE_DIR, "sg.osm.pbf");
  const onlyBuildings = path.join(CACHE_DIR, "sg-buildings.osm.pbf");
  const exported = path.join(CACHE_DIR, "sg-buildings.geojsonseq");

  step("clipping to Singapore", () =>
    osmium([
      "extract",
      "--bbox",
      `${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`,
      "--set-bounds",
      "-o",
      clipped,
      "--overwrite",
      pbf,
    ]),
  );

  step("keeping buildings", () =>
    osmium(["tags-filter", "-o", onlyBuildings, "--overwrite", clipped, "w/building", "a/building"]),
  );

  // `-a id` keeps the OSM way id, so a building has the same name here as it
  // had when it came from Overpass and nothing downstream has to change. Some
  // multipolygons cannot be closed at all; osmium reports them and moves on,
  // which is the right outcome — an unclosable outline is not a footprint.
  step("assembling geometry", () =>
    osmium(["export", "-f", "geojsonseq", "-a", "id", "-o", exported, "--overwrite", "-e", onlyBuildings]),
  );

  const onlySites = path.join(CACHE_DIR, "sg-sites.osm.pbf");
  const sitesExported = path.join(CACHE_DIR, "sg-sites.geojsonseq");

  step("keeping named sites", () =>
    osmium(["tags-filter", "-o", onlySites, "--overwrite", clipped, ...SITE_FILTERS]),
  );
  step("assembling site geometry", () =>
    osmium(["export", "-f", "geojsonseq", "-o", sitesExported, "--overwrite", "-e", onlySites]),
  );

  const onlyPlaces = path.join(CACHE_DIR, "sg-places.osm.pbf");
  const placesExported = path.join(CACHE_DIR, "sg-places.geojsonseq");

  step("keeping named places", () =>
    osmium(["tags-filter", "-o", onlyPlaces, "--overwrite", clipped, ...PLACE_FILTERS]),
  );
  step("assembling place geometry", () =>
    osmium(["export", "-f", "geojsonseq", "-o", placesExported, "--overwrite", "-e", onlyPlaces]),
  );

  const { rows, skipped } = await encode(exported);
  const places = await encodePlaces(placesExported);
  // A site is the same shape as a place — a name and the ground it covers — so
  // it is encoded and read back by the same code. They are kept apart because
  // they answer different questions: a place names a noise source, a site names
  // a building. Letting a hospital into the noise list would have it reported
  // as something loud on the strength of standing nearby.
  const sites = await encodePlaces(sitesExported);
  // The replication stamp lives on Geofabrik's own header; osmium's derived
  // files do not carry it forward, so it is read from the extract itself.
  const timestamp = await sourceTimestamp(pbf);

  const payload = { version: 2, builtAt: new Date().toISOString(), timestamp, count: rows.length, rows, places, sites };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  await writeFile(OUT_FILE, gz);
  await rm(exported, { force: true });
  await rm(placesExported, { force: true });
  await rm(sitesExported, { force: true });

  const tagged = rows.filter((r) => r[1]["height"] || r[1]["building:levels"]).length;
  console.log(`\n  ${rows.length.toLocaleString()} buildings -> ${(gz.length / 1e6).toFixed(2)} MB gzipped`);
  console.log(`  ${(tagged / rows.length * 100).toFixed(1)}% carry a height or storey count; the rest are inferred per request`);
  // osmium exports the nodes a building's outline is made of alongside the
  // building, so most of what is passed over here is vertices, not failures.
  console.log(`  passed over ${skipped.toLocaleString()} features that are not building outlines`);
  console.log(`  ${places.length.toLocaleString()} named places (estates, depots, substations)`);
  console.log(`  ${sites.length.toLocaleString()} named sites (hospitals, schools, campuses)`);
  console.log(`  OpenStreetMap data as of ${timestamp ?? "unknown"}`);
  console.log(`\n  wrote ${path.relative(process.cwd(), OUT_FILE)}`);
}

/** A building, as the engine will read it back: outline first, then its tags. */
type Row = [number[], Record<string, string>, number];

/**
 * Coordinates go in as whole millionths of a degree — about 11 cm, far finer
 * than the outlines themselves are surveyed — and every vertex after the first
 * as its step from the one before. Neighbouring vertices are metres apart, so
 * the steps are small numbers where the absolutes would be nine digits each,
 * and the file gzips to a fifth of what the raw geometry costs.
 */
async function encode(file: string) {
  const rows: Row[] = [];
  let skipped = 0;

  const fh = await open(file, "r");
  const stream = fh.createReadStream({ encoding: "utf8" });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/^\x1e/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const row = encodeOne(line);
      if (row) rows.push(row);
      else skipped++;
    }
  }
  await fh.close();
  return { rows, skipped };
}

function encodeOne(line: string): Row | null {
  let feature: {
    geometry?: { type?: string; coordinates?: unknown };
    properties?: Record<string, string>;
  };
  try {
    feature = JSON.parse(line);
  } catch {
    return null;
  }

  const geometry = feature.geometry;
  const props = feature.properties ?? {};
  if (!props.building) return null;

  // Only the outer ring is kept. A courtyard changes nothing about what a
  // building blocks from outside it, which is the only question asked here.
  let outer: [number, number][] | null = null;
  if (geometry?.type === "Polygon") outer = (geometry.coordinates as [number, number][][])[0];
  else if (geometry?.type === "MultiPolygon") outer = (geometry.coordinates as [number, number][][][])[0]?.[0];
  if (!outer || outer.length < 4) return null;

  const pts = outer.map(([lng, lat]) => [Math.round(lat * 1e6), Math.round(lng * 1e6)] as const);
  // GeoJSON closes a ring by repeating the first point; the engine does not
  // want the duplicate and drops it anyway.
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
    pts.pop();
  }
  if (pts.length < 3) return null;

  let [lat, lng] = pts[0];
  const ring: number[] = [lat, lng];
  for (let i = 1; i < pts.length; i++) {
    ring.push(pts[i][0] - lat, pts[i][1] - lng);
    [lat, lng] = pts[i];
  }

  const tags: Record<string, string> = {};
  for (const key of KEEP_TAGS) {
    const value = props[key];
    if (value === undefined || value === "") continue;
    tags[key] = PRESENCE_ONLY.has(key) ? "" : value;
  }

  const id = Number.parseInt(String(props["@id"] ?? props.id ?? "0"), 10);
  return [ring, tags, Number.isFinite(id) ? id : 0];
}

/** A named place: an outline where it has one, a single point where it does not. */
type PlaceRow = [string, number[] | null, number, number];

/**
 * The same two-shape rule the live query used. An estate or a depot is matched
 * by what it covers, so its outline is kept; a substation mapped as a single
 * node has no outline and is kept as the point it is. Anything that does not
 * close is a line, and a line is not ground — it names nothing here.
 */
async function encodePlaces(file: string): Promise<PlaceRow[]> {
  const rows: PlaceRow[] = [];
  const fh = await open(file, "r");
  const stream = fh.createReadStream({ encoding: "utf8" });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/^\x1e/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const row = encodePlace(line);
      if (row) rows.push(row);
    }
  }
  await fh.close();
  return rows;
}

function encodePlace(line: string): PlaceRow | null {
  let feature: { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, string> };
  try {
    feature = JSON.parse(line);
  } catch {
    return null;
  }
  const name = feature.properties?.name;
  if (!name) return null;

  const geometry = feature.geometry;
  if (geometry?.type === "Point") {
    const [lng, lat] = geometry.coordinates as [number, number];
    return [name, null, Math.round(lat * 1e6), Math.round(lng * 1e6)];
  }

  let outer: [number, number][] | null = null;
  if (geometry?.type === "Polygon") outer = (geometry.coordinates as [number, number][][])[0];
  else if (geometry?.type === "MultiPolygon") outer = (geometry.coordinates as [number, number][][][])[0]?.[0];
  if (!outer || outer.length < 4) return null;

  const pts = outer.map(([lng, lat]) => [Math.round(lat * 1e6), Math.round(lng * 1e6)] as const);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return null;

  let [lat, lng] = pts[0];
  const ring: number[] = [lat, lng];
  for (let i = 1; i < pts.length; i++) {
    ring.push(pts[i][0] - lat, pts[i][1] - lng);
    [lat, lng] = pts[i];
  }
  return [name, ring, pts[0][0], pts[0][1]];
}

function requireOsmium() {
  try {
    execFileSync("osmium", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("This needs osmium on the PATH. On macOS: brew install osmium-tool");
    process.exit(1);
  }
}

function osmium(args: string[]) {
  execFileSync("osmium", args, { stdio: ["ignore", "ignore", "inherit"] });
}

/** What OpenStreetMap itself says the data is as of, rather than today's date. */
async function sourceTimestamp(file: string): Promise<string | null> {
  try {
    const out = execFileSync("osmium", ["fileinfo", "-e", "-g", "header.option.osmosis_replication_timestamp", file], {
      encoding: "utf8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Geofabrik rebuilds nightly and the extract is a quarter of a gigabyte, so it
 * is kept. A rebuild that only wants fresher tags can delete it; a rebuild that
 * is re-running the encoding should not pay for it twice.
 */
async function download(to: string) {
  const have = await stat(to).catch(() => null);
  if (have) {
    console.log(`  using cached extract (${(have.size / 1e6).toFixed(0)} MB, ${have.mtime.toISOString().slice(0, 10)})`);
    return;
  }
  process.stdout.write(`  downloading ${SOURCE} ... `);
  const res = await fetch(SOURCE);
  if (!res.ok || !res.body) throw new Error(`Geofabrik returned ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(to));
  const got = await stat(to);
  console.log(`${(got.size / 1e6).toFixed(0)} MB`);
}

function step<T>(label: string, run: () => T): T {
  const started = Date.now();
  process.stdout.write(`  ${label} ... `);
  const out = run();
  console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
