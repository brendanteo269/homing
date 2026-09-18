import { readFile } from "node:fs/promises";
import path from "node:path";
import { pointInPolygon, type Projection } from "./geo";
import { RESIDENTIAL_STOREY } from "./hdb";
import type { Ceiling, MasterPlanNearby } from "./masterplan";

/**
 * BTO sites that are sold but not yet standing.
 *
 * This is the one gap the Master Plan cannot close. A launched BTO site is
 * zoned RESIDENTIAL with a plot ratio, and a plot ratio is not a height — so
 * outlook.ts finds no ceiling over it and answers "nobody has published a
 * limit either way". That is true of the plan and false of the world: HDB has
 * announced the storeys, drawn the blocks and sold the flats. A window looking
 * over a launched site is looking at a building, and the one place the app
 * says whether a view will last is the one place that ought to say so.
 *
 * Nothing here is traced by hand. A site is a point and a storey count; the
 * outline is the Master Plan parcel the point lands in, which is already in
 * `data/masterplan.json.gz`, is drawn by URA rather than by us, and is still
 * right after the next `npm run build-masterplan`. Adding a launch is finding
 * the site on a map, pasting a coordinate, and running `npm run check-bto`.
 */

const DATA_FILE = path.join(process.cwd(), "data", "bto-sites.json");

export interface BtoSite {
  name: string;
  town: string;
  /** Sales exercise, as YYYY-MM. */
  launch: string;
  /** Storeys in the tallest block on the site. */
  storeys: number;
  /** Storeys in the shortest, where the launch gives a range. */
  storeysLow?: number;
  /** Estimated completion, as YYYY-MM. */
  completion?: string;
  blocks?: number;
  units?: number;
  at: { lat: number; lng: number };
  sources?: string[];
  note?: string;
}

let loading: Promise<BtoSite[]> | null = null;

/**
 * A checkout with no file here still answers, without the launches — the same
 * bargain the HDB and Master Plan files strike. A file that is present but
 * unreadable says so, because silently dropping the launches would put the app
 * back to calling a sold site "unknown" with no sign that it knew better.
 */
export function loadBtoSites(): Promise<BtoSite[]> {
  loading ??= readFile(DATA_FILE, "utf8")
    .then((text) => (JSON.parse(text) as { sites?: BtoSite[] }).sites ?? [])
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== "ENOENT") {
        console.warn(`Could not read ${DATA_FILE} — answering without the launched BTOs.`, err);
      }
      return [];
    });
  return loading;
}

/** Roof height of a block of this many storeys, at HDB's own residential rates. */
export const btoHeight = (storeys: number) =>
  storeys * RESIDENTIAL_STOREY.floor + RESIDENTIAL_STOREY.roof;

/**
 * Launched sites matching what somebody typed.
 *
 * OneMap has never heard of "Lakeview Cascadia" and will not until the blocks
 * are standing and addressed, which is five years after the flats were sold.
 * Until then this is the only way to reach the one page in the app that is
 * about them, so the search has to answer for it.
 */
export async function btoMatches(query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  return (await loadBtoSites())
    .filter((site) => site.name.toLowerCase().includes(q) || site.town.toLowerCase() === q)
    .map((site) => ({
      lat: site.at.lat,
      lng: site.at.lng,
      // What the reader sees in the list, and then as the name of the unit.
      building: site.name,
      address: `BTO, ${site.town} · launched ${site.launch}`,
      blockNo: null,
      road: null,
      postal: null,
    }));
}

/**
 * The launched site a point is standing on, if it is standing on one.
 *
 * This is what lets the app say [BTO] over a pin dropped on bare ground, and
 * what gives the storey slider a real ceiling instead of the 25 it falls back
 * to when it has no building to measure.
 */
export async function btoSiteAt(
  plan: MasterPlanNearby,
  projection: Projection,
  x = 0,
  y = 0,
): Promise<BtoSite | null> {
  for (const site of await loadBtoSites()) {
    const [sx, sy] = projection.toLocal(site.at);
    const parcel = plan.zones.find(
      (zone) => zone.use !== "ROAD" && pointInPolygon(sx, sy, zone.ring),
    );
    if (parcel && pointInPolygon(x, y, parcel.ring)) return site;
  }
  return null;
}

/**
 * The launched sites near this window, as ceilings the outlook engine already
 * knows how to read.
 *
 * The parcel is looked up in the plan that has just been fetched rather than in
 * an index of its own: a site outside this window's reach is in no parcel here
 * and drops out for free. Road reserve is skipped when matching, so a
 * coordinate that lands a few metres off the kerb still finds its site.
 */
export async function btoCeilings(
  plan: MasterPlanNearby,
  projection: Projection,
): Promise<Ceiling[]> {
  const sites = await loadBtoSites();
  if (sites.length === 0) return [];

  const ceilings: Ceiling[] = [];
  for (const site of sites) {
    const [x, y] = projection.toLocal(site.at);
    const parcel = plan.zones.find(
      (zone) => zone.use !== "ROAD" && pointInPolygon(x, y, zone.ring),
    );
    if (!parcel) continue;
    ceilings.push({
      height: btoHeight(site.storeys),
      // Reads as the subject of a sentence, because that is where it ends up.
      what: `${site.name} (${site.storeys} storeys)`,
      ring: parcel.ring,
      // Not a promise about a view — a building with a completion date. The
      // outlook engine reads this to rule the direction out, never to credit it.
      bto: true,
    });
  }
  return ceilings;
}
