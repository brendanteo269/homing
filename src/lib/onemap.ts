import { readCache, writeCache } from "./cache";
import { parsePostal } from "./postal";
import type { LatLng } from "./types";

export { looksLikePostalPrefix, parsePostal } from "./postal";

export interface AddressHit extends LatLng {
  address: string;
  blockNo: string | null;
  road: string | null;
  postal: string | null;
  building: string | null;
}

/** Singapore, generously bounded — enough to catch a geocoder pointing abroad. */
const SG_BOUNDS = { south: 1.13, north: 1.51, west: 103.55, east: 104.13 };

/** Postal codes do not move, so a resolved one is worth keeping for a long time. */
const POSTAL_TTL_MS = 1000 * 60 * 60 * 24 * 180;
const SEARCH_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * OneMap is the Singapore Land Authority's own gazetteer. Its search endpoint
 * is public and unauthenticated, and it resolves HDB block numbers exactly,
 * which no general geocoder does reliably.
 */
export async function searchAddress(query: string, limit = 8): Promise<AddressHit[]> {
  const q = query.trim();
  if (!q) return [];

  // A postal code identifies exactly one building, so it deserves an exact
  // answer rather than whatever a fuzzy text match ranks first.
  const postal = parsePostal(q);
  if (postal) {
    const hit = await lookupPostal(postal);
    return hit ? [hit] : [];
  }

  // "Blk 101 Yishun Ave 5" is how the block is written on the block, but OneMap
  // matches nothing at all with the prefix in front of it.
  const text = q.replace(/^(?:blk|block)\s+/i, "");

  const key = `q:${text.toLowerCase()}`;
  const cached = await readCache<AddressHit[]>("onemap", key, SEARCH_TTL_MS);
  const hits = cached ?? (await fetchSearch(text));
  if (!cached) await writeCache("onemap", key, hits);
  return hits.slice(0, limit);
}

/** The one building a postal code names, or null if OneMap does not know it. */
export async function lookupPostal(postal: string): Promise<AddressHit | null> {
  const key = `postal:${postal}`;
  const cached = await readCache<{ hit: AddressHit | null }>("onemap", key, POSTAL_TTL_MS);
  if (cached) return cached.hit;

  const hits = await fetchSearch(postal);
  // OneMap will happily return near-misses for an unknown code; only an exact
  // match is the building the caller asked about. A code with no match is worth
  // remembering too — there are unissued codes in every sector.
  const exact = hits.find((h) => h.postal === postal) ?? null;
  await writeCache("onemap", key, { hit: exact });
  return exact;
}

/**
 * Lookups already on the wire, by query.
 *
 * Fifty readers arriving at once and typing the same thing used to be fifty
 * requests to OneMap, all of them for the same answer, and OneMap's limit is a
 * burst one — so a crowd refused itself. They wait on the first request now.
 * The entry is dropped as soon as it settles, so this is a coalescing window a
 * few hundred milliseconds wide and never a cache: the disk cache is the cache,
 * and it is what holds the answer afterwards.
 */
const inFlight = new Map<string, Promise<AddressHit[]>>();

function fetchSearch(query: string): Promise<AddressHit[]> {
  const waiting = inFlight.get(query);
  if (waiting) return waiting;

  const request = fetchSearchNow(query).finally(() => inFlight.delete(query));
  inFlight.set(query, request);
  return request;
}

async function fetchSearchNow(query: string): Promise<AddressHit[]> {
  const url = new URL("https://www.onemap.gov.sg/api/common/elastic/search");
  url.searchParams.set("searchVal", query);
  url.searchParams.set("returnGeom", "Y");
  url.searchParams.set("getAddrDetails", "Y");

  const json = await getJson(url);
  return (json.results ?? [])
    .map((r) => ({
      lat: Number(r.LATITUDE),
      lng: Number(r.LONGITUDE),
      address: titleCase(r.ADDRESS ?? r.SEARCHVAL ?? ""),
      blockNo: nilToNull(r.BLK_NO),
      road: nilToNull(r.ROAD_NAME) && titleCase(r.ROAD_NAME),
      postal: nilToNull(r.POSTAL),
      building: nilToNull(r.BUILDING) && titleCase(r.BUILDING),
    }))
    .filter(inSingapore);
}

interface OneMapResponse {
  results?: Record<string, string>[];
  found?: number;
  /** OneMap sometimes returns this alongside perfectly good results. */
  error?: string;
}

/**
 * OneMap rate-limits anonymous callers and answers with an HTML 429 page when
 * it does. That is a wait-and-retry, not a failure: a postal code the user
 * typed should not come back "no such address" because a robot was noisy.
 *
 * The limit is a burst one — two requests in quick succession is enough to trip
 * it — and it clears after a few seconds, so the backoff has to outlast that
 * window rather than give up inside it. The jitter keeps two searches that were
 * refused together from retrying in lockstep and tripping it again.
 */
async function getJson(url: URL, attempts = 4): Promise<OneMapResponse> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt + Math.random() * 250);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`OneMap returned ${res.status}`);
      if (!res.ok) throw new Error(`OneMap search failed with ${res.status}`);

      const text = await res.text();
      let json: OneMapResponse;
      try {
        json = JSON.parse(text) as OneMapResponse;
      } catch {
        // A throttling proxy in front of the API serves an HTML page.
        throw new Error("OneMap returned a non-JSON response");
      }
      // The error field rides along with valid results when the anonymous tier
      // is being deprecated in the background; results present means results.
      if (!json.results && json.error) throw new Error(json.error);
      return json;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `OneMap is not answering. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Whether a point is in the country this app knows anything about. */
export function inSingapore(p: LatLng) {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= SG_BOUNDS.south &&
    p.lat <= SG_BOUNDS.north &&
    p.lng >= SG_BOUNDS.west &&
    p.lng <= SG_BOUNDS.east
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nilToNull = (v: string | undefined) => (!v || v === "NIL" ? null : v);

function titleCase(s: string) {
  return s.replace(/\b[A-Z]+\b/g, (w) =>
    w.length <= 1 || /^\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase(),
  );
}
