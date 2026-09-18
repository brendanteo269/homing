import { NextResponse } from "next/server";
import { loadBtoSites } from "@/lib/bto";

/**
 * The launched BTOs, for the list in the sidebar.
 *
 * They cannot be searched for the way an address can — no gazetteer carries a
 * project until it is built — so the only way to reach one is to be shown it.
 */
export async function GET() {
  return NextResponse.json({ launches: await loadBtoSites() });
}
