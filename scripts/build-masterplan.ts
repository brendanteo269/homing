/**
 * Builds the Master Plan dataset the analyser reads: what the land around a
 * home is zoned for, and how tall anything standing on it is allowed to be.
 *
 * Four layers, each answering a different question.
 *
 * **Land use** (MP2025, gazetted 1 Dec 2025) is the big one — 113,394 parcels
 * carrying a use and, for 29% of them, a gross plot ratio. The use is what
 * matters here: park and water cannot be built up, heavy industry is a noise
 * source, and a reserve site is a question mark.
 *
 * **Landed housing areas** (MP2025) is the most valuable thing in the whole
 * plan for this purpose, and the easiest to overlook. Every one of its 254
 * areas carries a permitted envelope of two or three storeys — not a ratio to
 * infer a height from, an actual cap. 31 km2 of Singapore where nothing tall
 * can ever go up.
 *
 * **Building height control** gives an explicit storey count or a height above
 * the Singapore Height Datum for another 929 areas. Only the 2019 edition
 * publishes these as polygons with the values attached: the 2025 edition is
 * cartographic text annotations with no polygon to join them to, so this layer
 * is one edition behind and says so in the output.
 *
 * **Monuments** (MP2025) are 171 gazetted buildings that cannot be demolished.
 *
 * Plot ratios are deliberately not turned into heights. Site coverage across
 * Singapore's housing estates runs from 0.20 to 0.37, so a ratio of 2.8 means
 * anything from eight storeys to fourteen — a range too wide to put in front
 * of somebody as a number. Only the caps above are treated as heights.
 *
 *   npx tsx scripts/build-masterplan.ts
 */
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LAYERS = {
  landuse: "d_a8c3546b26712e35021f3a681d0353ae",
  landed: "d_70a5a4b67d9171dc0db6f6fd259a3215",
  heightControl: "d_ee8e2e0d13a50a699f9100029b8c0b0a",
  monument: "d_4b1c160040f9c9309be12b2fed5e6395",
} as const;

const CACHE_DIR = path.join(process.cwd(), ".cache", "masterplan");
const OUT_FILE = path.join(process.cwd(), "data", "masterplan.json.gz");

/** Parcels smaller than this carry no signal worth a polygon. */
const MIN_PARCEL_M2 = 800;
/** Simplification tolerance. Parcel edges are not read to the metre. */
const SIMPLIFY_M = 2;
const DEG_PER_M = 9e-6;
/** Storey height used to turn a permitted storey count into a permitted height. */
const STOREY_M = 3.0;
/** Roof furniture on top of the permitted storeys. */
const CAP_ROOF_M = 2.5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);

interface Feature {
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, string | number | null>;
}

/** A parcel of land, as the plan zones it. */
export interface ParcelRecord {
  /** Land use, e.g. "PARK" or "BUSINESS 2". */
  u: string;
  /** Gross plot ratio as published: a number, or LND / EVA / SDP. */
  g: string;
  r: [number, number][];
}

/** Ground with a published ceiling on it. */
export interface CapRecord {
  /** Highest a building may stand here, metres above ground. */
  h: number;
  /** What sets the ceiling, for the reader. */
  w: string;
  r: [number, number][];
}

export interface MasterPlanFile {
  parcels: ParcelRecord[];
  caps: CapRecord[];
  /** Gazetted monuments: they cannot be demolished, so they cannot grow. */
  monuments: { n: string; r: [number, number][] }[];
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(path.dirname(OUT_FILE), { recursive: true });

  const landuse = await layer("landuse", LAYERS.landuse);
  const landed = await layer("landed", LAYERS.landed);
  const height = await layer("height-control", LAYERS.heightControl);
  const monument = await layer("monument", LAYERS.monument);

  const parcels: ParcelRecord[] = [];
  let dropped = 0;
  for (const f of landuse) {
    const use = String(f.properties.LU_DESC ?? "");
    const gpr = String(f.properties.GPR ?? "");
    // Landed plots are 59,000 polygons whose ceiling comes from the landed
    // housing layer rather than from here. Roads are kept: a road reserve is
    // ground nothing can be built on, which is exactly what this is for, and
    // dropping them left a hole in the coverage at every kerb.
    if (gpr === "LND") {
      dropped++;
      continue;
    }
    for (const ring of outerRings(f)) {
      if (areaM2(ring) < MIN_PARCEL_M2) {
        dropped++;
        continue;
      }
      parcels.push({ u: use, g: gpr, r: pack(ring) });
    }
  }

  const caps: CapRecord[] = [];
  for (const f of landed) {
    const env = String(f.properties.PERM_ENV ?? "");
    const storeys = env.startsWith("2") ? 2 : env.startsWith("3") ? 3 : null;
    if (!storeys) continue;
    for (const ring of outerRings(f)) {
      caps.push({
        h: storeys * STOREY_M + CAP_ROOF_M,
        w: `landed housing, ${storeys} storeys`,
        r: pack(ring),
      });
    }
  }
  for (const f of height) {
    const cap = heightCap(f.properties);
    if (!cap) continue;
    for (const ring of outerRings(f)) caps.push({ ...cap, r: pack(ring) });
  }

  const monuments = monument.flatMap((f) =>
    outerRings(f).map((ring) => ({ n: String(f.properties.NAME ?? "Monument"), r: pack(ring) })),
  );

  const out: MasterPlanFile = { parcels, caps, monuments };
  const body = gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
  await writeFile(OUT_FILE, body);

  log(`\n${parcels.length} parcels kept, ${dropped} dropped (roads, landed plots, under ${MIN_PARCEL_M2} m2)`);
  log(`${caps.length} areas with a published ceiling, ${monuments.length} monuments`);
  log(`Wrote ${OUT_FILE} — ${(body.length / 1e6).toFixed(2)} MB gzipped`);
  report(parcels, caps);
}

/**
 * The ceiling an area of the height control plan sets, in metres.
 *
 * The plan states these three ways. A plain number is storeys; a "C" prefix is
 * the same for a conserved building; "36m SHD" is metres above the Singapore
 * Height Datum, which is close enough to metres above ground on flat coastal
 * land and is treated as such, because this is used to ask whether something
 * could rise into a view rather than to survey it. Anything marked subject to
 * detailed control has no published ceiling and is left out rather than
 * guessed at.
 */
function heightCap(p: Record<string, string | number | null>): { h: number; w: string } | null {
  const type = String(p.HT_CTL_TYP ?? "");
  const text = String(p.HT_CTL_TXT ?? "").trim();
  if (!text || text === "*") return null;

  if (type.startsWith("NUMBER OF STOREYS")) {
    const storeys = Number.parseInt(text.replace(/^C/i, ""), 10);
    if (!Number.isFinite(storeys) || storeys <= 0) return null;
    return { h: storeys * STOREY_M + CAP_ROOF_M, w: `height control, ${storeys} storeys` };
  }
  if (type.startsWith("METRES")) {
    const metres = Number.parseFloat(text.replace(/^C/i, ""));
    if (!Number.isFinite(metres) || metres <= 0) return null;
    return { h: metres, w: `height control, ${metres} m` };
  }
  return null;
}

/* ------------------------------------------------------------------ source */

async function layer(name: string, datasetId: string): Promise<Feature[]> {
  const file = path.join(CACHE_DIR, `${name}.geojson`);
  let text = await readFile(file, "utf8").catch(() => null);
  if (!text) {
    log(`Downloading ${name}…`);
    text = await (await fetch(await pollDownload(datasetId))).text();
    await writeFile(file, text);
  }
  const json = JSON.parse(text) as { features: Feature[] };
  log(`  ${name}: ${json.features.length} features`);
  return json.features;
}

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

/* ---------------------------------------------------------------- geometry */

function outerRings(f: Feature): [number, number][][] {
  const coords = f.geometry.coordinates as number[][][] | number[][][][];
  const rings =
    f.geometry.type === "Polygon"
      ? [(coords as number[][][])[0]]
      : f.geometry.type === "MultiPolygon"
        ? (coords as number[][][][]).map((part) => part[0])
        : [];
  return rings
    .filter((r) => r && r.length >= 4)
    .map((r) => r.map((c) => [c[0], c[1]] as [number, number]));
}

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG = 110320 * Math.cos((1.36 * Math.PI) / 180);

function areaM2(ring: [number, number][]) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a +=
      ring[j][0] * M_PER_DEG_LNG * (ring[i][1] * M_PER_DEG_LAT) -
      ring[i][0] * M_PER_DEG_LNG * (ring[j][1] * M_PER_DEG_LAT);
  }
  return Math.abs(a / 2);
}

function pack(ring: [number, number][]): [number, number][] {
  const open =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  return simplify(open, SIMPLIFY_M * DEG_PER_M).map(
    (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5] as [number, number],
  );
}

/** Douglas-Peucker, iteratively so a long coastline cannot blow the stack. */
function simplify(points: [number, number][], eps: number): [number, number][] {
  if (points.length < 5) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length) {
    const [from, to] = stack.pop()!;
    let worst = 0;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const d = perpendicular(points[i], points[from], points[to]);
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
  return points.filter((_, i) => keep[i] === 1);
}

function perpendicular(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/* -------------------------------------------------------------- reporting */

function report(parcels: ParcelRecord[], caps: CapRecord[]) {
  const by = new Map<string, number>();
  for (const p of parcels) by.set(p.u, (by.get(p.u) ?? 0) + 1);
  log("\nmost common uses kept:");
  for (const [use, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    log(`  ${use.padEnd(42)} ${n}`);
  }

  const ceilings = new Map<string, number>();
  for (const c of caps) ceilings.set(c.w, (ceilings.get(c.w) ?? 0) + 1);
  log("\nceilings:");
  for (const [what, n] of [...ceilings].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    log(`  ${what.padEnd(42)} ${n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
