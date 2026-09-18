import { NextResponse } from "next/server";
import { looksLikePostalPrefix, parsePostal, searchAddress } from "@/lib/onemap";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ results: [] });

  // A postal code is worth looking up the moment it is complete, and worth
  // nothing before that — "5604" is a prefix, not an address.
  const postalish = looksLikePostalPrefix(q);
  if (postalish && !parsePostal(q)) return NextResponse.json({ results: [] });
  if (!postalish && q.length < 3) return NextResponse.json({ results: [] });

  try {
    return NextResponse.json({ results: await searchAddress(q) });
  } catch (err) {
    return NextResponse.json(
      { results: [], error: err instanceof Error ? err.message : "Search failed" },
      { status: 502 },
    );
  }
}
