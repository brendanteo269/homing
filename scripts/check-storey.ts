/**
 * Asserts for reading a storey back off the drawing.
 *
 * Pressing the block is how a unit is chosen, so the sum that turns a pixel
 * back into a wall and a storey is the one piece of the plan that has to be
 * exactly right — and it is invisible when it is wrong, because a window on
 * the wrong floor still produces a confident answer about a flat nobody asked
 * about. So every storey of a slab is projected to the pixel it draws at and
 * read straight back, from several angles, and has to come back as itself.
 *
 *   npm run check-storey
 */
import { HOME, spotAt, view } from "../src/components/PlanMap";

/** A slab 60 m long, 12 m deep, centred on the origin. Twelve storeys of 2.9 m. */
const RING: [number, number][] = [
  [-30, -6],
  [30, -6],
  [30, 6],
  [-30, 6],
];
const STOREYS = 12;
const eyeOf = (floor: number) => (floor - 1) * 2.9 + 1.5;

let failed = 0;
function check(what: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

/** Every storey of whichever long wall the camera can see, drawn and read back. */
for (const azimuth of [0, 45, 135, 250]) {
  const v = view({ ...HOME, azimuth, pivot: [0, 0] });
  // Turn the camera far enough and the south wall goes round the back, where a
  // press on it would rightly land on the north wall standing in front.
  const wall = v.direction(0, -1)[1] < 0 ? -6 : 6;
  let wrong = 0;
  let worst = 0;

  for (let floor = 1; floor <= STOREYS; floor++) {
    // A point out on the visible long wall, away from both corners.
    const [x, y, z] = [12, wall, eyeOf(floor)];
    const spot = spotAt(v, RING, v.sx(x, y), v.sy(x, y, z), STOREYS, eyeOf);
    if (spot.floor !== floor) wrong++;
    worst = Math.max(worst, Math.hypot(spot.at[0] - x, spot.at[1] - y));
  }

  check(`every storey reads back as itself, seen from ${azimuth}°`, wrong === 0, `${wrong} wrong`);
  // Within half a storey of where it was drawn is the same window; a wall
  // picked off the far side of the block would be twelve metres out.
  check(`the wall comes back too, seen from ${azimuth}°`, worst < 2, `${worst.toFixed(1)} m out`);
}

// The far wall is behind the near one. A press on the middle of the block is a
// press on what stands in front, not on what it hides.
const v = view({ ...HOME, azimuth: 0, pivot: [0, 0] });
const front = spotAt(v, RING, v.sx(12, -6), v.sy(12, -6, eyeOf(6)), STOREYS, eyeOf);
check("a press lands on the wall facing you", front.at[1] < 0, JSON.stringify(front));

// Well clear of the block, nothing was pressed.
const off = spotAt(v, RING, v.sx(160, -160), v.sy(160, -160, 0), STOREYS, eyeOf);
check("a press on open ground misses the block", off.miss > 20, JSON.stringify(off));

console.log(failed === 0 ? "\nall good\n" : `\n${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
