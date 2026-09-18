import { NextResponse } from "next/server";
import { analyse } from "@/lib/analyse";
import { callerOf, take } from "@/lib/limit";
import { inSingapore, lookupPostal, parsePostal } from "@/lib/onemap";

export const maxDuration = 120;

/**
 * An answer costs a second of real work — a horizon cast over every azimuth,
 * a year of sun sampled against it — and every distinct coordinate misses
 * every cache, so there is nothing between a loop and the bill but this.
 * Twenty a minute is far more than dragging the window marker ever asks for.
 */
const LIMIT = { perMinute: 20, burst: 10 };

export async function POST(request: Request) {
  const limit = take(`analyse:${callerOf(request)}`, LIMIT);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests — give it a moment." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: {
    lat?: number;
    lng?: number;
    postal?: string;
    address?: { blockNo?: string | null; street?: string | null; postal?: string | null };
    floor?: number;
    face?: number;
    window?: { lat?: number; lng?: number };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  let { lat, lng } = body;
  let address = body.address;
  const { floor, face } = body;
  const win = body.window;
  // Held to the same bounds as the pin. Only the origin was checked, so a
  // window dropped in the Pacific reached the engine and came back confidently
  // scored from the nothing that is out there — the exact failure the comment
  // below describes, through the one door that was left open.
  const windowAt =
    win && inSingapore({ lat: win.lat as number, lng: win.lng as number })
      ? { lat: win.lat as number, lng: win.lng as number }
      : undefined;

  // A postal code names one building in Singapore, so it is enough on its own.
  if (body.postal !== undefined) {
    const postal = parsePostal(body.postal);
    if (!postal) {
      return NextResponse.json({ error: `"${body.postal}" is not a Singapore postal code` }, { status: 400 });
    }
    try {
      const hit = await lookupPostal(postal);
      if (!hit) {
        return NextResponse.json({ error: `No Singapore address at postal code ${postal}` }, { status: 404 });
      }
      lat = hit.lat;
      lng = hit.lng;
      address = { blockNo: hit.blockNo, street: hit.road, postal: hit.postal };
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Postal code lookup failed" },
        { status: 502 },
      );
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng, or a postal code, are required" }, { status: 400 });
  }
  // Every dataset behind this — HDB's register, the Master Plan, the footprint
  // extract — stops at the coastline. Outside it the engine still answers, and
  // answers confidently, from nothing at all: a point in the middle of the sea
  // comes back scored in the nineties because there is no building near it.
  if (!inSingapore({ lat: lat as number, lng: lng as number })) {
    return NextResponse.json({ error: "This only covers Singapore" }, { status: 400 });
  }

  try {
    const result = await analyse({
      lat: lat as number,
      lng: lng as number,
      address,
      floor: Number.isFinite(floor) ? (floor as number) : 8,
      face: Number.isFinite(face) ? (face as number) : undefined,
      window: windowAt,
    });

    // Footprints only need centimetre precision, and rounding roughly halves
    // the payload for a neighbourhood of two hundred buildings.
    return NextResponse.json({
      ...result,
      buildings: result.buildings.map((b) => ({
        ...b,
        height: Math.round(b.height * 10) / 10,
        ring: b.ring.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
      })),
      horizon: {
        elevation: result.horizon.elevation.map((v) => Math.round(v * 100) / 100),
        distance: result.horizon.distance.map((v) => (Number.isFinite(v) ? Math.round(v) : null)),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Analysis failed" },
      { status: 502 },
    );
  }
}
