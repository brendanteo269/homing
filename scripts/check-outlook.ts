/**
 * The one thing the outlook accounting must never get wrong: every direction
 * ends in exactly one bucket.
 *
 *   npm run check-outlook
 *
 * The card divides by protected + at-risk + unknown and calls the result a
 * score out of 100, so a direction that falls into two buckets, or into none,
 * is a wrong number on the page rather than a crash anywhere. Hand-built
 * parcels, no data files and no network.
 */
import assert from "node:assert/strict";
import { computeOutlook, groundKind } from "../src/lib/outlook";
import type { Ceiling, MasterPlanNearby } from "../src/lib/masterplan";
import type { Viewpoint } from "../src/lib/types";

/**
 * Ground of one use all round the window, laid as four rectangles with a small
 * hole where the window stands. The hole matters: a parcel containing the
 * viewpoint is the home's own land, which the engine skips, so a single big
 * square centred on the window reads as no data at all.
 */
const R = 600;
const GAP = 5;
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const surround = (): [number, number][][] => [
  rect(-R, GAP, R, R),
  rect(-R, -R, R, -GAP),
  rect(GAP, -GAP, R, GAP),
  rect(-R, -GAP, -GAP, GAP),
];
const zonesOf = (use: string, gpr = "EVA") => surround().map((ring) => ({ use, gpr, ring }));
const ceilingsOf = (height: number, what: string): Ceiling[] =>
  surround().map((ring) => ({ height, what, ring }));

const viewpoint: Viewpoint = { x: 0, y: 0, z: 24, floor: 9, facing: 0, hostId: null, face: null };
const openSky = () => 0;

function look(plan: Partial<MasterPlanNearby>, builtHorizonAt = openSky, z = viewpoint.z) {
  return computeOutlook(
    { ...viewpoint, z },
    { zones: [], ceilings: [], monuments: [], ...plan },
    builtHorizonAt,
  );
}

type Outlook = ReturnType<typeof look>;

/** The invariant the score depends on: one bucket per direction, all 181 of them. */
function addsUp(label: string, o: Outlook) {
  const total = o.protectedDegrees + o.atRiskDegrees + o.unknownDegrees + o.closedDegrees;
  assert.equal(total, 181, `${label}: ${total} directions accounted for, not 181`);
}

function verdict(o: Outlook) {
  const buckets = [
    ["protected", o.protectedDegrees],
    ["at-risk", o.atRiskDegrees],
    ["unknown", o.unknownDegrees],
    ["closed", o.closedDegrees],
  ] as const;
  return buckets.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

// Water to the horizon is capped at nothing, so the view holds.
const water = look({ zones: zonesOf("WATERBODY") });
addsUp("water", water);
assert.equal(verdict(water), "protected");
assert.equal(water.durableForegroundDegrees, water.protectedDegrees, "open water is durable");

// Ordinary zoned land is unknown, never at risk: a plot ratio is not a height,
// and reporting it as a threat is the dishonesty this accounting exists to fix.
const zoned = look({ zones: zonesOf("RESIDENTIAL", "3.0") });
addsUp("zoned", zoned);
assert.equal(verdict(zoned), "unknown");
assert.equal(zoned.atRiskDegrees, 0);

// Silence is not a promise either.
const empty = look({});
addsUp("empty plan", empty);
assert.equal(empty.unknownDegrees, 181);

// A published ceiling is at risk only when it clears the window. Same parcel,
// two storeys: this is the branch the whole score turns on.
const plan = { zones: zonesOf("RESIDENTIAL", "1.4"), ceilings: ceilingsOf(60, "height control") };
const below = look(plan);
addsUp("under a 60 m ceiling", below);
assert.equal(verdict(below), "at-risk");
const over = look(plan, openSky, 300);
addsUp("over a 60 m ceiling", over);
assert.equal(verdict(over), "protected", "the same ceiling is harmless from above it");

// A view already walled in is set aside, not counted against the future.
const walled = look({ zones: zonesOf("WATERBODY") }, () => 40);
addsUp("walled in", walled);
assert.equal(walled.closedDegrees, 181);
assert.equal(walled.protectedDegrees, 0, "a closed direction cannot also be protected");
assert.equal(walled.durableForegroundDegrees, 0, "nor can it show off its water");

// The drawing shades exactly the ground the count credits.
assert.equal(groundKind("WATERBODY"), "water");
assert.equal(groundKind("ROAD"), "road");
assert.equal(groundKind("PARK"), "open");
assert.equal(groundKind("BUSINESS 2"), null);

console.log("outlook accounting ok");
