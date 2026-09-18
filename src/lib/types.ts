export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Source of a building's height, so the UI can be honest about confidence.
 * `hdb-register` is HDB's own record of the block's highest storey, which is
 * the only one of these that is authoritative rather than volunteered.
 */
export type HeightSource = "hdb-register" | "height-tag" | "levels-tag" | "inferred";

export interface Building {
  id: string;
  /** Footprint in local ENU metres, closed ring not required. */
  ring: [number, number][];
  /** Roof height above ground, metres. */
  height: number;
  heightSource: HeightSource;
  levels: number | null;
  name: string | null;
  /** Block number, e.g. an HDB block number. */
  blockNo: string | null;
  street: string | null;
  /** Postal code, where the source carries one. Names one building exactly. */
  postal: string | null;
  kind: "hdb" | "residential" | "other";
}

export interface Viewpoint {
  /** Where the window is, in local ENU metres. */
  x: number;
  y: number;
  /** Eye height above ground, metres. */
  z: number;
  /** Facade normal, degrees clockwise from north. The way the window looks out. */
  facing: number;
  floor: number;
  /** Building the unit sits in, if we snapped to one. */
  hostId: string | null;
  /** Index into the host's faces, if the window was placed on one. */
  face: number | null;
}

/** Horizon elevation angle (degrees) per whole degree of azimuth, 0 = north. */
export interface Horizon {
  /** 360 entries, index = azimuth in degrees. */
  elevation: Float64Array;
  /** Horizontal distance to the blocking edge, metres. Infinity where open. */
  distance: Float64Array;
  /** Id of the blocking building per azimuth, or null. */
  blockedBy: (string | null)[];
}

export interface DayProfile {
  /** ISO date, local. */
  date: string;
  label: string;
  /** Samples through the day, one per step, only while the sun is up. */
  samples: {
    minutes: number;
    azimuth: number;
    elevation: number;
    /** Sun is above the built horizon in this direction. */
    visible: boolean;
    /** Sun actually reaches this facade (visible and in front of the window). */
    onFacade: boolean;
  }[];
}

export interface SunMetrics {
  /** Mean hours per day the sun disc is visible from this window's sky. */
  meanDirectHoursPerDay: number;
  /** Mean hours per day the sun lands on this facade. */
  meanFacadeHoursPerDay: number;
  /** Mean minutes per day of sun on the facade at or after 14:00 local. */
  meanAfternoonMinutes: number;
  /**
   * Mean daily facade irradiation, kWh/m2, using a clear-sky beam model.
   * Split so the afternoon share can be read on its own.
   */
  facadeIrradiationKwh: number;
  afternoonIrradiationKwh: number;
  /** Index 0 = January. */
  monthlyFacadeHours: number[];
  monthlyAfternoonMinutes: number[];
  /** Solstices and an equinox, for the sky-path chart. */
  profiles: DayProfile[];
}

export interface BlockageMetrics {
  /** Cosine-weighted sky view factor at the window, 0..1. */
  skyViewFactor: number;
  /** Sky view factor over the 180 degrees the window faces. */
  facadeSkyViewFactor: number;
  /** Horizon elevation straight ahead, degrees. */
  elevationAhead: number;
  /** Distance to the first obstruction straight ahead, metres. Infinity if none. */
  distanceAhead: number;
  /** Widest run of azimuths in front of the window with horizon under 10 degrees. */
  openArcDegrees: number;
  openArcBearing: number;
  /** Share of the facade's 180 degrees blocked above 20 degrees elevation. */
  heavilyBlockedShare: number;
  /** The buildings doing the blocking, worst first. */
  blockers: {
    id: string;
    label: string;
    height: number;
    heightSource: HeightSource;
    distance: number;
    bearing: number;
    elevation: number;
    /** Degrees of the window's view it eats. */
    arcDegrees: number;
  }[];
}

export interface Confidence {
  buildingsConsidered: number;
  /** Blocks whose storey count came from HDB's register. */
  fromHdbRegister: number;
  withMeasuredHeight: number;
  withLevels: number;
  inferred: number;
  /** 0..1. Share of the blocked view whose height came from a real tag. */
  blockerHeightConfidence: number;
  dataTimestamp: string | null;
}

export interface Scores {
  daylight: number;
  afternoonHeat: number;
  openness: number;
  overall: number;
  notes: string[];
}

export interface AnalysisResult {
  origin: LatLng;
  viewpoint: Viewpoint;
  host: {
    label: string;
    levels: number | null;
    /** HDB's record for this block, when it is an HDB block. */
    hdb: { blockNo: string; street: string; postal: string; maxFloorLevel: number | null; yearCompleted: number | null; units: number | null } | null;
    height: number;
    heightSource: HeightSource;
    /**
     * How this block was identified: by its address, because the pin stands
     * inside it, or because it was simply the nearest thing to the pin.
     */
    matchedBy: "postal" | "address" | "pin-inside" | "nearest";
    /** How far the pin was from it, metres. */
    distanceFromPin: number;
    /** The sides of the block, longest first — what a window can actually face. */
    faces: { facing: number; length: number }[];
  } | null;
  buildings: Building[];
  horizon: { elevation: number[]; distance: number[] };
  sun: SunMetrics;
  blockage: BlockageMetrics;
  /**
   * What the Master Plan says about the land in view, and the industry near
   * it. Null where the plan dataset has not been built.
   */
  outlook: import("./outlook").OutlookMetrics | null;
  /**
   * The capped ground near the window, in local metres, so the plan drawing can
   * shade it. Only the uses the outlook treats as a ceiling are sent — water,
   * open land and road reserve — because the rest is ordinary zoned land and
   * shading it would claim something the plan does not say.
   */
  ground: { kind: import("./outlook").GroundKind; ring: [number, number][] }[];
  noise: import("./noise").NoiseMetrics | null;
  confidence: Confidence;
  scores: Scores;
  tookMs: number;
}
