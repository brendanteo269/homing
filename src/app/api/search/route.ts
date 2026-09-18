import { NextResponse } from "next/server";
import { btoMatches } from "@/lib/bto";
import { callerOf, take } from "@/lib/limit";
import { looksLikePostalPrefix, parsePostal, searchAddress } from "@/lib/onemap";

/**
 * This forwards what is typed to OneMap, so being loud here is being loud at
 * the Land Authority under this deployment's address — and their throttle
 * answers by refusing everybody, not just whoever earned it. The allowance is
 * generous because a search fires as somebody types.
 */
const LIMIT = { perMinute: 60, burst: 20 };
/** Longer than anything a person means to type, and short enough to bound the key. */
const MAX_QUERY = 120;

export async function GET(request: Request) {
  const limit = take(`search:${callerOf(request)}`, LIMIT);
  if (!limit.ok) {
    return NextResponse.json(
      { results: [], error: "Too many searches — give it a moment." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const q = new URL(request.url).searchParams.get("q")?.trim().slice(0, MAX_QUERY);
  if (!q) return NextResponse.json({ results: [] });

  // A postal code is worth looking up the moment it is complete, and worth
  // nothing before that — "5604" is a prefix, not an address.
  const postalish = looksLikePostalPrefix(q);
  if (postalish && !parsePostal(q)) return NextResponse.json({ results: [] });
  if (!postalish && q.length < 3) return NextResponse.json({ results: [] });

  // A launched BTO is in no gazetteer, so it is matched here and listed first:
  // somebody typing its name has named it exactly, which beats anything a fuzzy
  // address match will rank above it.
  const launches = await btoMatches(q);

  try {
    return NextResponse.json({ results: [...launches, ...(await searchAddress(q))] });
  } catch (err) {
    // A name we hold ourselves should not be lost because OneMap is refusing.
    if (launches.length > 0) return NextResponse.json({ results: launches });
    return NextResponse.json(
      { results: [], error: err instanceof Error ? err.message : "Search failed" },
      { status: 502 },
    );
  }
}
