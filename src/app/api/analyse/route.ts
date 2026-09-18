import { NextResponse } from "next/server";
import { analyse } from "@/lib/analyse";
import { lookupPostal, parsePostal } from "@/lib/onemap";

export const maxDuration = 120;

export async function POST(request: Request) {
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
  const windowAt =
    win && Number.isFinite(win.lat) && Number.isFinite(win.lng)
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
