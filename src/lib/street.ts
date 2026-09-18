/**
 * Street names as three different gazetteers write them.
 *
 * OneMap says "ANG MO KIO AVENUE 10", HDB's property register says
 * "ANG MO KIO AVE 10", OSM says "Ang Mo Kio Ave 10". All three mean the same
 * road, and a block number on its own is not unique across Singapore — there
 * are 36 different streets with a Block 1 — so joining HDB's records to a
 * footprint needs the road name, and needs it to survive the abbreviations.
 */
const STREET_WORDS: Record<string, string> = {
  ave: "avenue", av: "avenue", rd: "road", st: "street", str: "street", dr: "drive",
  cres: "crescent", cl: "close", ctrl: "central", ctr: "centre", pl: "place", ter: "terrace",
  blvd: "boulevard", jln: "jalan", lor: "lorong", bt: "bukit", upp: "upper", tg: "tanjong",
  nth: "north", sth: "south", n: "north", s: "south", e: "east", w: "west", pk: "park",
  // HDB's register abbreviates harder than OneMap does, and every pair missing
  // from this table is a block that silently keeps an inferred height instead
  // of its real storey count. `npm run build-hdb` prints the ones that failed.
  gdns: "gardens", gdn: "garden", hts: "heights", sq: "square", lk: "link",
  mkt: "market", kg: "kampong", kamp: "kampong", cmwlth: "commonwealth",
  ind: "industrial", est: "estate", cp: "car park", stn: "station",
  bth: "bath", bdr: "bandar", tj: "tanjong", tk: "telok", jl: "jalan",
};

/** A road name reduced to something two gazetteers can be compared on. */
export function normaliseStreet(street?: string | null): string | null {
  if (!street) return null;
  const words = street
    .toLowerCase()
    .replace(/[.,']/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w);
  return words.length > 0 ? words.join(" ") : null;
}

/** Block numbers carry letter suffixes — 340A and 340B are different blocks. */
export function normaliseBlock(blk?: string | null): string | null {
  const b = blk?.trim().toUpperCase();
  return b ? b : null;
}

/** The join key HDB's property register is addressed by. */
export function blockKey(blk?: string | null, street?: string | null): string | null {
  const b = normaliseBlock(blk);
  const s = normaliseStreet(street);
  return b && s ? `${b}|${s}` : null;
}
