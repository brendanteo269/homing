import { angleDelta, rad } from "./geo";
import { horizonAt } from "./horizon";
import { beamIrradiance, sunPosition } from "./solar";
import type { DayProfile, Horizon, LatLng, SunMetrics, Viewpoint } from "./types";

/** Singapore keeps UTC+8 all year, so there is no daylight saving to model. */
const TZ_OFFSET_HOURS = 8;
const STEP_MINUTES = 5;
const REFERENCE_YEAR = 2026;
/** "Afternoon sun" in the Singaporean sense: the west sun, from 2pm on. */
const AFTERNOON_FROM_MINUTES = 14 * 60;

const PROFILE_DAYS: { month: number; day: number; label: string }[] = [
  { month: 2, day: 20, label: "Equinox, 20 Mar" },
  { month: 5, day: 21, label: "June solstice, 21 Jun" },
  { month: 11, day: 21, label: "December solstice, 21 Dec" },
];

export function computeSunMetrics(
  viewpoint: Viewpoint,
  horizon: Horizon,
  origin: LatLng,
): SunMetrics {
  const monthDirectMinutes = new Array(12).fill(0);
  const monthFacadeMinutes = new Array(12).fill(0);
  const monthAfternoonMinutes = new Array(12).fill(0);
  const monthDays = new Array(12).fill(0);

  let facadeIrradiationKwh = 0;
  let afternoonIrradiationKwh = 0;

  const cursor = new Date(Date.UTC(REFERENCE_YEAR, 0, 1));
  while (cursor.getUTCFullYear() === REFERENCE_YEAR) {
    const month = cursor.getUTCMonth();
    const day = cursor.getUTCDate();
    monthDays[month] += 1;

    for (let m = 5 * 60; m < 20 * 60; m += STEP_MINUTES) {
      const utcMillis = Date.UTC(REFERENCE_YEAR, month, day, 0, m - TZ_OFFSET_HOURS * 60);
      const pos = sunPosition(utcMillis, origin.lat, origin.lng);
      if (pos.elevation <= 0) continue;

      const visible = pos.elevation > horizonAt(horizon, pos.azimuth);
      if (!visible) continue;
      monthDirectMinutes[month] += STEP_MINUTES;

      const cosIncidence =
        Math.cos(rad(pos.elevation)) * Math.cos(rad(angleDelta(pos.azimuth, viewpoint.facing)));
      if (cosIncidence <= 0) continue;

      monthFacadeMinutes[month] += STEP_MINUTES;
      const kwh = (beamIrradiance(pos.elevation) * cosIncidence * (STEP_MINUTES / 60)) / 1000;
      facadeIrradiationKwh += kwh;

      if (m >= AFTERNOON_FROM_MINUTES) {
        monthAfternoonMinutes[month] += STEP_MINUTES;
        afternoonIrradiationKwh += kwh;
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const totalDays = monthDays.reduce((a, b) => a + b, 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  return {
    meanDirectHoursPerDay: sum(monthDirectMinutes) / 60 / totalDays,
    meanFacadeHoursPerDay: sum(monthFacadeMinutes) / 60 / totalDays,
    meanAfternoonMinutes: sum(monthAfternoonMinutes) / totalDays,
    facadeIrradiationKwh: facadeIrradiationKwh / totalDays,
    afternoonIrradiationKwh: afternoonIrradiationKwh / totalDays,
    monthlyFacadeHours: monthFacadeMinutes.map((v, i) => v / 60 / monthDays[i]),
    monthlyAfternoonMinutes: monthAfternoonMinutes.map((v, i) => v / monthDays[i]),
    profiles: PROFILE_DAYS.map((d) => dayProfile(d, viewpoint, horizon, origin)),
  };
}

function dayProfile(
  day: { month: number; day: number; label: string },
  viewpoint: Viewpoint,
  horizon: Horizon,
  origin: LatLng,
): DayProfile {
  const samples: DayProfile["samples"] = [];

  for (let m = 5 * 60; m < 20 * 60; m += 10) {
    const utcMillis = Date.UTC(REFERENCE_YEAR, day.month, day.day, 0, m - TZ_OFFSET_HOURS * 60);
    const pos = sunPosition(utcMillis, origin.lat, origin.lng);
    if (pos.elevation <= 0) continue;

    const visible = pos.elevation > horizonAt(horizon, pos.azimuth);
    const cosIncidence =
      Math.cos(rad(pos.elevation)) * Math.cos(rad(angleDelta(pos.azimuth, viewpoint.facing)));

    samples.push({
      minutes: m,
      azimuth: pos.azimuth,
      elevation: pos.elevation,
      visible,
      onFacade: visible && cosIncidence > 0,
    });
  }

  const date = `${REFERENCE_YEAR}-${String(day.month + 1).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  return { date, label: day.label, samples };
}
