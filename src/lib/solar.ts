import { deg, rad, wrap360 } from "./geo";

/**
 * Solar position by the NOAA Solar Calculator equations (Meeus, low-precision
 * form). Good to roughly 0.01 degrees, which is far finer than the metre-scale
 * uncertainty in the building heights we compare it against.
 */

export interface SunPosition {
  /** Degrees above the horizon, refraction-corrected. */
  elevation: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

function julianDay(utcMillis: number) {
  return utcMillis / 86400000 + 2440587.5;
}

export function sunPosition(
  utcMillis: number,
  latitude: number,
  longitude: number,
): SunPosition {
  const jd = julianDay(utcMillis);
  const t = (jd - 2451545) / 36525;

  const meanLong = wrap360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const eqCentre =
    Math.sin(rad(meanAnom)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(rad(2 * meanAnom)) * (0.019993 - 0.000101 * t) +
    Math.sin(rad(3 * meanAnom)) * 0.000289;

  const trueLong = meanLong + eqCentre;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * t));

  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(125.04 - 1934.136 * t));

  const declination = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));

  const varY = Math.tan(rad(obliq / 2)) ** 2;
  const eqOfTime =
    4 *
    deg(
      varY * Math.sin(2 * rad(meanLong)) -
        2 * eccent * Math.sin(rad(meanAnom)) +
        4 * eccent * varY * Math.sin(rad(meanAnom)) * Math.cos(2 * rad(meanLong)) -
        0.5 * varY * varY * Math.sin(4 * rad(meanLong)) -
        1.25 * eccent * eccent * Math.sin(2 * rad(meanAnom)),
    );

  // Hour angle from true solar time, worked in UTC so the caller's timezone
  // never enters the astronomy.
  const utcMinutes = ((utcMillis / 60000) % 1440 + 1440) % 1440;
  const trueSolarMinutes = (utcMinutes + eqOfTime + 4 * longitude + 1440) % 1440;
  const hourAngle = trueSolarMinutes / 4 < 0 ? trueSolarMinutes / 4 + 180 : trueSolarMinutes / 4 - 180;

  const latR = rad(latitude);
  const decR = rad(declination);
  const haR = rad(hourAngle);

  const cosZenith =
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const zenith = deg(Math.acos(Math.max(-1, Math.min(1, cosZenith))));
  const rawElevation = 90 - zenith;

  let azimuth: number;
  const denom = Math.cos(latR) * Math.sin(rad(zenith));
  if (Math.abs(denom) > 1e-9) {
    const cosAz = (Math.sin(latR) * Math.cos(rad(zenith)) - Math.sin(decR)) / denom;
    const az = deg(Math.acos(Math.max(-1, Math.min(1, cosAz))));
    azimuth = hourAngle > 0 ? wrap360(az + 180) : wrap360(540 - az);
  } else {
    azimuth = declination > latitude ? 180 : 0;
  }

  return { elevation: rawElevation + refraction(rawElevation), azimuth };
}

/** Atmospheric refraction, degrees, per the NOAA approximation. */
function refraction(elevation: number) {
  if (elevation > 85) return 0;
  const te = Math.tan(rad(elevation));
  let r: number;
  if (elevation > 5) {
    r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  } else if (elevation > -0.575) {
    r = 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  } else {
    r = -20.772 / te;
  }
  return r / 3600;
}

/**
 * Clear-sky beam irradiance normal to the sun, W/m2 (ASHRAE clear-sky, the
 * simple air-mass form). Used only to weight the hours: a scorching 3pm sun
 * should not count the same as a glancing 7am one.
 */
export function beamIrradiance(elevation: number) {
  if (elevation <= 0) return 0;
  const airMass = 1 / (Math.sin(rad(elevation)) + 0.50572 * (elevation + 6.07995) ** -1.6364);
  return 1353 * 0.7 ** airMass ** 0.678;
}
