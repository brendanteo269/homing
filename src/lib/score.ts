import { compassName } from "./blockage";
import type { OutlookMetrics } from "./outlook";
import type { BlockageMetrics, Scores, SunMetrics, Viewpoint } from "./types";

/**
 * Reference points, all measured by this engine on an unobstructed site at
 * Singapore's latitude (see scripts/calibrate.ts). Scores are stated against
 * these openly so that a reader can disagree with the weighting rather than
 * having to take a number on trust.
 */
const REF = {
  /** Hours per day of direct sun on a wholly unobstructed facade. */
  openFacadeHours: 6.05,
  /** kWh/m2/day landing on an unobstructed due-west facade after 2pm. */
  westAfternoonKwh: 2.37,
  /** Minutes per day of post-2pm sun on an unobstructed due-west facade. */
  westAfternoonMinutes: 310,
};

const WEIGHTS = { daylight: 0.35, afternoonHeat: 0.3, openness: 0.35 };

/**
 * Degrees of protected outlook worth saying out loud. A tenth of what a window
 * looks across is a whole corner of the view that cannot be taken away, which
 * is worth a sentence even when the rest of the outlook is ordinary.
 */
const NOTABLE_PROTECTED_DEG = 18;
const NOTABLE_DURABLE_FOREGROUND_DEG = 18;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const pct = (v: number) => Math.round(clamp01(v) * 100);

export function computeScores(
  sun: SunMetrics,
  blockage: BlockageMetrics,
  viewpoint: Viewpoint,
  outlook?: OutlookMetrics | null,
): Scores {
  // Daylight leans on how much sky the window can see, because in a cloudy
  // tropical climate most of the light in a room is diffuse, not direct beam.
  const skyShare = clamp01(blockage.facadeSkyViewFactor);
  const directShare = clamp01(sun.meanFacadeHoursPerDay / REF.openFacadeHours);
  const daylight = pct(0.6 * skyShare + 0.4 * directShare);

  // Heat is the afternoon beam load, not the hour count: 4pm sun on a wall
  // carries several times the energy of the same minutes at 8am.
  const afternoonHeat = pct(1 - clamp01(sun.afternoonIrradiationKwh / REF.westAfternoonKwh) ** 0.8);

  const arcShare = clamp01(blockage.openArcDegrees / 120);
  const distanceShare = clamp01(Math.log10(Math.max(blockage.distanceAhead, 5) / 5) / Math.log10(20));
  const openness = pct(
    0.4 * arcShare + 0.3 * distanceShare + 0.3 * (1 - clamp01(blockage.heavilyBlockedShare)),
  );

  const overall = Math.round(
    daylight * WEIGHTS.daylight + afternoonHeat * WEIGHTS.afternoonHeat + openness * WEIGHTS.openness,
  );

  return {
    daylight,
    afternoonHeat,
    openness,
    overall,
    notes: buildNotes(sun, blockage, viewpoint, outlook),
  };
}

function buildNotes(
  sun: SunMetrics,
  blockage: BlockageMetrics,
  viewpoint: Viewpoint,
  outlook?: OutlookMetrics | null,
) {
  const notes: string[] = [];
  const facing = compassName(viewpoint.facing);

  const afternoon = Math.round(sun.meanAfternoonMinutes);
  const daily = formatMinutes(Math.round(sun.meanFacadeHoursPerDay * 60));
  if (afternoon >= 150) {
    notes.push(
      `This ${facing}-facing wall averages ${daily} of direct sun a day, including ${formatMinutes(afternoon)} after 2pm. Expect the room to warm up through the afternoon and stay warm into the evening.`,
    );
  } else if (afternoon >= 45) {
    notes.push(
      `This ${facing}-facing wall averages ${daily} of direct sun a day, with ${formatMinutes(afternoon)} after 2pm. Expect some late-day warmth, but not the full west-sun effect.`,
    );
  } else if (afternoon > 5) {
    notes.push(
      `This ${facing}-facing wall averages ${daily} of direct sun a day, with only ${formatMinutes(afternoon)} after 2pm. Expect it to stay comparatively cool later on.`,
    );
  } else {
    notes.push(`This ${facing}-facing wall averages ${daily} of direct sun a day and gets no meaningful sun after 2pm. Expect a cooler room in the late afternoon.`);
  }

  if (sun.meanFacadeHoursPerDay < 1) {
    notes.push(
      `Only ${formatMinutes(Math.round(sun.meanFacadeHoursPerDay * 60))} of direct sun a day reaches this window. Rooms stay cool and even, but laundry will be slow to dry.`,
    );
  }

  const worst = blockage.blockers[0];
  if (worst) {
    notes.push(
      `${worst.label} stands ${Math.round(worst.distance)} m away to the ${compassName(worst.bearing)}, rising ${Math.round(worst.elevation)}° above your window.`,
    );
  }

  if (blockage.openArcDegrees >= 90) {
    notes.push(`Open sky across ${blockage.openArcDegrees}° of the view ahead, centred ${compassName(blockage.openArcBearing)}.`);
  } else if (blockage.openArcDegrees < 25) {
    notes.push(`Hemmed in: the widest clear gap in front is only ${blockage.openArcDegrees}° wide.`);
  }

  if (Number.isFinite(blockage.distanceAhead) && blockage.distanceAhead < 30) {
    notes.push(
      `A wall stands ${Math.round(blockage.distanceAhead)} m straight ahead — close enough to look into each other's windows.`,
    );
  }

  // What the view is worth in ten years, which is a different question from
  // what it is worth now and the one a buyer cannot look up anywhere.
  const water = outlook?.durableForegrounds.find((foreground) => foreground.label === "Water");
  if (water && water.arcDegrees >= NOTABLE_DURABLE_FOREGROUND_DEG) {
    notes.push(
      `Water starts about ${water.distance} m out across a meaningful part of this outlook. The foreground will stay open, though buildings on the far shore could still change the skyline.`,
    );
  } else if (outlook && outlook.protectedDegrees >= NOTABLE_PROTECTED_DEG) {
    const widest = outlook.protectors[0];
    notes.push(
      `${outlook.protectedDegrees}° of this outlook is over land the Master Plan will not let a building rise on${widest ? ` — ${widest.label}, ${widest.distance} m out` : ""}. That part of the view is not going to be built out.`,
    );
  }

  return notes;
}

export function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
