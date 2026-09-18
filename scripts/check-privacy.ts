/**
 * Asserts for the overlooking metric, on geometry made up here rather than
 * read from a data file.
 *
 * The four things that can quietly go wrong are all filters: counting the
 * block the window is in, counting a car park as a neighbour, counting a
 * building too far off to see into, and counting one whose roof is below the
 * eye line — which is the case a storey model would need and the horizon cast
 * handles for free. Each gets a case, and each fails loudly.
 *
 *   npm run check-privacy
 */
import { computeHorizon } from "../src/lib/horizon";
import { computePrivacy } from "../src/lib/privacy";
import type { Building, Viewpoint } from "../src/lib/types";

/** A square block `size` across, centred `north` metres due north of the window. */
function blockAt(id: string, north: number, height: number, kind: Building["kind"], size = 40): Building {
  const h = size / 2;
  return {
    id,
    ring: [
      [-h, north - h],
      [h, north - h],
      [h, north + h],
      [-h, north + h],
    ],
    height,
    heightSource: "height-tag",
    levels: null,
    name: null,
    blockNo: null,
    street: null,
    postal: null,
    kind,
  };
}

/** A window 30 m up, looking due north. */
const window: Viewpoint = { x: 0, y: 0, z: 30, facing: 0, floor: 10, hostId: "home", face: null };

function privacyWith(buildings: Building[]) {
  return computePrivacy(window, computeHorizon(window, buildings), buildings);
}

let failed = 0;
function check(what: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

// A tall block of flats 40 m away, filling part of the view.
const near = privacyWith([blockAt("them", 40, 60, "hdb")]);
check(
  "a block of flats in front is counted",
  near.privacy < 100 && near.facingDegrees > 0 && Math.round(near.nearestM) <= 40,
  JSON.stringify({ privacy: near.privacy, facingDegrees: near.facingDegrees, nearestM: near.nearestM }),
);

// The same shape, closer, must read as more overlooked — never less.
const closer = privacyWith([blockAt("them", 25, 60, "hdb")]);
check(
  "closer is less private",
  closer.privacy < near.privacy && closer.nearestM < near.nearestM,
  `${closer.privacy} vs ${near.privacy}`,
);

// A car park is not a neighbour.
const other = privacyWith([blockAt("them", 40, 60, "other")]);
check("a non-home in front is ignored", other.privacy === 100 && other.facingDegrees === 0, JSON.stringify(other));

// Past the reach, a home opposite is scenery.
const far = privacyWith([blockAt("them", 200, 60, "hdb")]);
check("a home beyond the reach is ignored", far.privacy === 100 && far.neighbours.length === 0, JSON.stringify(far));

// Below the eye line there is nobody at this window's level to look in.
const low = privacyWith([blockAt("them", 40, 12, "hdb")]);
check("a block shorter than the window is ignored", low.privacy === 100, JSON.stringify(low));

// The block the window is in is not a neighbour, however close its own walls are.
const self = privacyWith([blockAt("home", 20, 60, "hdb")]);
check("your own block is not counted", self.privacy === 100 && self.facingDegrees === 0, JSON.stringify(self));

// Behind the window is not in front of it.
const behind = privacyWith([blockAt("them", -40, 60, "hdb")]);
check("a home behind the window is ignored", behind.privacy === 100, JSON.stringify(behind));

console.log(failed === 0 ? "\nall good\n" : `\n${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
