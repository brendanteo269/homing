/**
 * Establishes the reference numbers that src/lib/score.ts scores against, by
 * running the same engine on a site with nothing around it. Run with:
 *   npm run calibrate
 */
import { computeBlockage } from "../src/lib/blockage";
import { sunPosition } from "../src/lib/solar";
import { computeHorizon } from "../src/lib/horizon";
import { computeSunMetrics } from "../src/lib/sun";
import type { Viewpoint } from "../src/lib/types";

const ORIGIN = { lat: 1.3521, lng: 103.8198 };
const FACINGS = [
  ["N", 0],
  ["E", 90],
  ["S", 180],
  ["W", 270],
  ["SW", 225],
  ["NW", 315],
] as const;

console.log("Unobstructed facade at Singapore's latitude, by orientation:\n");
console.log(
  ["facing", "sun h/day", "after 2pm", "kWh/m2/day", "pm kWh/m2"].map((s) => s.padStart(11)).join(""),
);

for (const [name, facing] of FACINGS) {
  const viewpoint: Viewpoint = { x: 0, y: 0, z: 30, facing, floor: 10, hostId: null, face: null };
  const horizon = computeHorizon(viewpoint, []);
  const sun = computeSunMetrics(viewpoint, horizon, ORIGIN);
  const blockage = computeBlockage(viewpoint, horizon, []);

  console.log(
    [
      name,
      sun.meanFacadeHoursPerDay.toFixed(2),
      `${Math.round(sun.meanAfternoonMinutes)} min`,
      sun.facadeIrradiationKwh.toFixed(2),
      sun.afternoonIrradiationKwh.toFixed(2),
    ]
      .map((s) => String(s).padStart(11))
      .join(""),
  );

  if (facing === 270) {
    console.log(
      `\n  sky view factor with nothing around: ${blockage.skyViewFactor.toFixed(3)} (expect 1.000)`,
    );
    console.log(`  open arc in front: ${blockage.openArcDegrees}° (expect 180)\n`);
  }
}

// Sanity check against a known almanac value: Singapore sunrise on 21 Jun 2026
// is about 07:00 local and the sun peaks near 87 degrees.
for (const [label, utc] of [
  ["21 Jun 13:00 SGT", Date.UTC(2026, 5, 21, 5, 0)],
  ["21 Dec 13:00 SGT", Date.UTC(2026, 11, 21, 5, 0)],
  ["21 Jun 07:00 SGT", Date.UTC(2026, 5, 20, 23, 0)],
] as const) {
  const p = sunPosition(utc, ORIGIN.lat, ORIGIN.lng);
  console.log(`${label}: elevation ${p.elevation.toFixed(2)}°, azimuth ${p.azimuth.toFixed(1)}°`);
}
