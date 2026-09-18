/**
 * What each entry in data/bto-sites.json actually picked up.
 *
 * A site is a point, and the outline comes from whatever Master Plan parcel
 * that point lands in — which is the whole reason adding a launch is cheap, and
 * the whole reason it can go quietly wrong. A coordinate a hundred metres out
 * lands in the neighbouring parcel and marks the wrong ground as built on, and
 * nothing downstream would ever say so. So this prints what was matched: the
 * zoning, the plot ratio, the size, and how much is already standing on it.
 *
 * Read it as evidence, not as a pass mark. A launched site should be zoned
 * residential, should be about the size the unit count implies, and should be
 * empty — anything else is worth a second look at the coordinate.
 *
 *   npm run check-bto
 */
import { loadBtoSites, btoHeight } from "../src/lib/bto";
import { fetchBuildings } from "../src/lib/buildings";
import { makeProjection, pointInPolygon, polygonArea, polygonCentroid } from "../src/lib/geo";
import { masterPlanNear } from "../src/lib/masterplan";

/** Big enough to hold any parcel the point might be in, small enough to be quick. */
const REACH_M = 600;

async function main() {
  const sites = await loadBtoSites();
  if (sites.length === 0) {
    console.error("No sites in data/bto-sites.json.");
    process.exit(1);
  }

  console.log(`\n${sites.length} launched BTO site${sites.length === 1 ? "" : "s"}\n`);
  let bad = 0;

  for (const site of sites) {
    const projection = makeProjection(site.at);
    const [plan, { buildings }] = await Promise.all([
      masterPlanNear(site.at, REACH_M, projection),
      fetchBuildings(site.at, REACH_M, projection),
    ]);

    const parcel = plan.zones.find((z) => z.use !== "ROAD" && pointInPolygon(0, 0, z.ring));
    console.log(`${site.name} — ${site.town}, launched ${site.launch}`);
    console.log(`  ${site.storeys} storeys -> ${btoHeight(site.storeys).toFixed(1)} m roof${site.units ? `, ${site.units} units` : ""}`);

    if (!parcel) {
      bad++;
      console.log("  ✗ no Master Plan parcel under this point — the coordinate is off, or on a road\n");
      continue;
    }

    const area = Math.abs(polygonArea(parcel.ring));
    const standing = buildings.filter((b) => {
      const [x, y] = polygonCentroid(b.ring);
      return pointInPolygon(x, y, parcel.ring);
    });
    // A plot ratio times a site area is the floor area permitted on it. It is
    // not a height — which is why this file exists — but it is a good check on
    // whether the parcel is the right size for the flats that were sold.
    const gpr = Number.parseFloat(parcel.gpr);
    const implied = Number.isFinite(gpr) ? ` (${Math.round((area * gpr) / 1000)}k m² permitted)` : "";

    console.log(`  parcel: ${parcel.use}, plot ratio ${parcel.gpr}, ${Math.round(area).toLocaleString()} m²${implied}`);

    // Which block the pin lands in, because landing in the bin centre beside a
    // forty-storey tower is the failure this file is most likely to have, and
    // it looks exactly like success from every other angle.
    const under = buildings.find((b) => pointInPolygon(0, 0, b.ring));
    const homes = standing.filter((b) => b.kind === "hdb" || b.kind === "residential");
    const tallest = homes.sort((a, b) => b.height - a.height)[0];
    if (standing.length === 0) {
      console.log("  ✓ nothing drawn on it yet — the reader gets a bare site");
    } else {
      console.log(`  ${homes.length} block(s) drawn, tallest ${tallest ? `${tallest.height.toFixed(0)} m (${tallest.levels ?? "?"} storeys)` : "—"}`);
      if (!under) {
        bad++;
        console.log("  ✗ the point is in none of them — a reader choosing this launch lands outside the blocks");
      } else if (tallest && under.height < tallest.height * 0.6) {
        bad++;
        console.log(`  ✗ the point is in a ${under.height.toFixed(0)} m building, well short of the tallest — check it is not an outbuilding`);
      } else {
        console.log(`  ✓ the point is in a ${under.height.toFixed(0)} m block`);
      }
      if (site.blocks && homes.length !== site.blocks) {
        console.log(`  note: ${homes.length} blocks drawn, ${site.blocks} published — the rest may not be mapped yet`);
      }
    }
    if (parcel.use !== "RESIDENTIAL") {
      bad++;
      console.log(`  ✗ zoned ${parcel.use}, not RESIDENTIAL — check the coordinate`);
    }
    if (site.note) console.log(`  note: ${site.note}`);
    console.log();
  }

  if (bad > 0) {
    console.error(`${bad} site${bad === 1 ? "" : "s"} need a closer look.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
