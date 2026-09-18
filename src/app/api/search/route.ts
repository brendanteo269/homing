import { NextResponse } from "next/server";
import { btoMatches } from "@/lib/bto";
import { looksLikePostalPrefix, parsePostal, searchAddress } from "@/lib/onemap";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
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
