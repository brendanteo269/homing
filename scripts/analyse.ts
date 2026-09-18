/**
 * Command-line sun and blockage report for one unit.
 *
 *   npm run analyse -- 560406 --floor 8
 *   npm run analyse -- "406 Ang Mo Kio Ave 10" --floor 12 --face 1
 *   npm run analyse -- 1.362004,103.85388
 *
 * Any Singapore postal code will do; it names one building exactly.
 *
 * --face picks which side of the block the window is on; the sides are listed
 * in the report, longest first.
 */
import { analyse } from "../src/lib/analyse";
import { compassName } from "../src/lib/blockage";
import { lookupPostal, parsePostal, searchAddress } from "../src/lib/onemap";
import { formatMinutes } from "../src/lib/score";
import type { LatLng } from "../src/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const n = Number(argv[i + 1]);
    // `--floor` with nothing after it used to reach the engine as NaN, and NaN
    // does not fail loudly here: every comparison against it is false, so every
    // building drops out of the horizon and the unit comes back scored as open
    // country. Fall back to the default rather than answer for a storey that
    // was never given.
    if (!Number.isFinite(n)) {
      console.error(`Ignoring --${name}: "${argv[i + 1] ?? ""}" is not a number.`);
      return undefined;
    }
    return n;
  };
  const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const target = positional.join(" ").trim();

  if (!target) {
    console.error('Usage: npm run analyse -- "<postal code, address or lat,lng>" [--floor N] [--face N]');
    process.exit(1);
  }

  let point: LatLng;
  let label = target;
  let address: { blockNo: string | null; street: string | null; postal: string | null } | undefined;
  const coords = target.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
  const postal = parsePostal(target);
  if (coords) {
    point = { lat: Number(coords[1]), lng: Number(coords[2]) };
  } else if (postal) {
    const hit = await lookupPostal(postal);
    if (!hit) {
      console.error(`No Singapore address at postal code ${postal}.`);
      process.exit(1);
    }
    point = { lat: hit.lat, lng: hit.lng };
    label = hit.address;
    address = { blockNo: hit.blockNo, street: hit.road, postal: hit.postal };
  } else {
    const hits = await searchAddress(target, 1);
    if (hits.length === 0) {
      console.error(`No Singapore address matched "${target}".`);
      process.exit(1);
    }
    point = { lat: hits[0].lat, lng: hits[0].lng };
    label = hits[0].address;
    address = { blockNo: hits[0].blockNo, street: hits[0].road, postal: hits[0].postal };
  }

  const floor = flag("floor") ?? 8;
  const result = await analyse({ ...point, address, floor, face: flag("face") });

  const { sun, blockage, scores, confidence, viewpoint, outlook, noise, privacy } = result;
  const line = (k: string, v: string) => console.log(`  ${k.padEnd(26)}${v}`);

  console.log(`\n${label}`);
  const hostNote =
    result.host?.matchedBy === "nearest" && result.host.distanceFromPin > 25
      ? ` (nearest footprint, ${result.host.distanceFromPin} m from the address point)`
      : "";
  console.log(`${result.host ? result.host.label + hostNote : "no building mapped near this address"} · floor ${floor} · window faces ${compassName(viewpoint.facing)} (${Math.round(viewpoint.facing)}°) · eye at ${viewpoint.z.toFixed(1)} m\n`);

  console.log(`Overall ${scores.overall}/100   daylight ${scores.daylight}   afternoon heat ${scores.afternoonHeat}   openness ${scores.openness}\n`);

  console.log("Sun");
  line("direct sun on facade", `${sun.meanFacadeHoursPerDay.toFixed(1)} h/day`);
  line("of which after 2pm", formatMinutes(Math.round(sun.meanAfternoonMinutes)));
  line("facade beam load", `${sun.facadeIrradiationKwh.toFixed(2)} kWh/m²/day (${sun.afternoonIrradiationKwh.toFixed(2)} after 2pm)`);
  line("sky visible from window", `${sun.meanDirectHoursPerDay.toFixed(1)} h/day of unblocked sun`);

  if (result.host?.faces.length) {
    console.log("\nSides of this block");
    result.host.faces.forEach((f, i) => {
      const mark = i === viewpoint.face ? "→" : " ";
      console.log(`  ${mark} --face ${i}  ${compassName(f.facing).padEnd(4)} ${String(Math.round(f.facing)).padStart(3)}°  ${Math.round(f.length)} m wide`);
    });
  }

  console.log("\nBlockage");
  line("sky view, all round", blockage.skyViewFactor.toFixed(2));
  line("sky view, ahead", blockage.facadeSkyViewFactor.toFixed(2));
  line("horizon straight ahead", `${blockage.elevationAhead.toFixed(1)}° at ${fmtDistance(blockage.distanceAhead)}`);
  line("widest open arc", `${blockage.openArcDegrees}° centred ${compassName(blockage.openArcBearing)}`);
  line("view blocked above 20°", `${Math.round(blockage.heavilyBlockedShare * 100)}% of the front`);

  if (blockage.blockers.length) {
    console.log("\nWhat is in the way");
    for (const b of blockage.blockers) {
      console.log(
        `  ${b.label.padEnd(30)} ${String(Math.round(b.distance)).padStart(4)} m  ${compassName(b.bearing).padEnd(4)} ${b.elevation.toFixed(0).padStart(3)}° high  ${String(b.arcDegrees).padStart(3)}° of view  [${b.heightSource}]`,
      );
    }
  }

  console.log("\nSun on the facade by month");
  for (let m = 0; m < 12; m++) {
    const hours = sun.monthlyFacadeHours[m];
    const bar = "█".repeat(Math.round(hours * 6));
    console.log(`  ${MONTHS[m]}  ${hours.toFixed(1)} h  ${bar}`);
  }

  console.log("\nNotes");
  for (const n of scores.notes) console.log(`  · ${n}`);

  console.log("\nConfidence");
  line("buildings considered", String(confidence.buildingsConsidered));
  if (outlook) {
    console.log("\nWill the view last");
    line(
      "cannot be built on",
      `${outlook.protectedDegrees}° of 181  (the plan puts a ceiling on ${outlook.knownDegrees}°, within ${outlook.reachM} m)`,
    );
    for (const p of outlook.protectors.slice(0, 4)) {
      console.log(`  ${p.label.padEnd(34)} ${String(p.arcDegrees).padStart(3)}° of view, from ${p.distance} m`);
    }
    if (outlook.launches.length) {
      console.log("\nGoing up in this view");
      for (const l of outlook.launches) {
        const due = l.completion ? `keys ${l.completion}` : "completion not announced";
        console.log(`  ${l.label.slice(0, 40).padEnd(40)} ${String(l.distance).padStart(4)} m ${compassName(l.bearing).padEnd(3)} ${String(l.arcDegrees).padStart(3)}° of view, ${due}`);
      }
    }
    if (outlook.zones.length) {
      console.log("\nWhat the land in front is zoned for");
      for (const z of outlook.zones.slice(0, 6)) {
        const ratio = /^[\d.]+$/.test(z.gpr) ? `plot ratio ${z.gpr}` : z.gpr === "EVA" ? "no published ratio" : z.gpr;
        console.log(`  ${z.use.slice(0, 40).padEnd(40)} ${String(z.distance).padStart(4)} m ${String(z.arcDegrees).padStart(3)}° ${ratio}`);
      }
    }
  }

  if (noise) {
    console.log(`\nIndustry nearby (exposure index, not decibels)`);
    line("quieter than industry", `${noise.quiet}/100`);
    for (const s2 of noise.sources.slice(0, 5)) {
      const how = `${s2.ahead ? "ahead" : "behind"}${s2.shielded ? ", shielded" : ""}`;
      console.log(`  ${s2.use.slice(0, 34).padEnd(34)} ${String(s2.distance).padStart(4)} m  ${compassName(s2.bearing).padEnd(3)}  ${how}`);
    }
    if (!noise.sources.length) console.log("  nothing zoned industrial within " + noise.reachM + " m");
  }

  console.log(`\nOverlooked (homes only, within ${privacy.reachM} m)`);
  line("privacy", `${privacy.privacy}/100`);
  line("homes in front", `${privacy.facingDegrees}° of 180${privacy.closeDegrees ? `, ${privacy.closeDegrees}° of it close in` : ""}`);
  line("nearest home facing you", fmtDistance(privacy.nearestM));
  for (const n of privacy.neighbours.slice(0, 4)) {
    console.log(`  ${n.label.slice(0, 34).padEnd(34)} ${String(n.distance).padStart(4)} m  ${compassName(n.bearing).padEnd(3)}  ${String(n.arcDegrees).padStart(3)}° of view`);
  }

  line("storeys from HDB", `${confidence.fromHdbRegister} blocks`);
  line("heights from a real tag", `${confidence.withMeasuredHeight + confidence.withLevels} (${confidence.inferred} guessed)`);
  line("blocker heights known", `${Math.round(confidence.blockerHeightConfidence * 100)}% of the blocked view`);
  line("OSM extract", confidence.dataTimestamp ?? "unknown");
  console.log(`\n  computed in ${result.tookMs} ms\n`);
}

const fmtDistance = (d: number) => (Number.isFinite(d) ? `${Math.round(d)} m` : "nothing in the way");

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
