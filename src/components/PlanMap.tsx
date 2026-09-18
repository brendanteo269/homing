"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compassName } from "@/lib/blockage";
import { makeProjection, nearestFacade, rad, walkOutline } from "@/lib/geo";
import { sunPosition } from "@/lib/solar";
import type { AnalysisResult, Building, LatLng } from "@/lib/types";

const W = 960;
const H = 620;
const VIEW_RADIUS_M = 200;
/** Past this the wedge is context, not information, so it stops. */
const SIGHT_DRAW_M = 150;

/**
 * An axonometric view, not a plan.
 *
 * What this app measures is blockage, and blockage is a question about height:
 * the same footprint 40 m away is a hedge at three storeys and a wall at thirty.
 * A flat plan cannot show that, so the massing is extruded and drawn in one
 * canvas pass — a few thousand flat polygons, no library, no WebGL, about as
 * fast as filling the same area twice.
 *
 * Heights are drawn true. Exaggerating them would look better and would be a
 * lie about the one number the reader is here to judge.
 */
const COS = Math.cos(Math.PI / 6);
/**
 * How high the camera stands, in degrees above the ground.
 *
 * The ground is laid back by the sine of this, so 90 would be a flat plan
 * looking straight down and 0 would be standing in the street with the ground
 * edge-on. The view opens at 31, which is the three-quarter angle a site model
 * is photographed at, and the reader can take it up or down from there — a
 * block's height is the thing they are here to judge, and how much of it they
 * can see is a property of where they are standing.
 */
const PITCH_HOME = 31;
const PITCH_MIN = 6;
/**
 * Stopping well short of straight down. The last twenty degrees or so turn the
 * massing back into a flat plan — roofs, and almost no wall — which is the one
 * thing this drawing exists not to be.
 */
const PITCH_MAX = 55;
const PITCH_STEP = 8;
/** A drag down the full height of the plan swings the camera this far. */
const PITCH_PER_HEIGHT = 120;
/**
 * The pitch the world is scaled at, whatever it is then tilted to.
 *
 * Fitting the frame to the live pitch instead would zoom the whole
 * neighbourhood in as the camera came down — the ground foreshortens, so less
 * of it needs the height — and the reader would be pulled towards the block
 * every time they wanted to look at it from lower down. Tilting a camera does
 * not change how far away it is, so neither does this.
 */
const SQUASH_FIT = Math.sin((PITCH_HOME * Math.PI) / 180);

/** The classic three-quarter view: the corner of the block faces the reader. */
const AZIMUTH_HOME = 45;
/**
 * The engine only fetches 600 m of neighbourhood, so there is nothing to see
 * past it — zooming out further would widen the frame onto blank ground and
 * drag every one of those buildings through the painter's sort for nothing.
 * At 0.6 the frame's far corner lands just inside that radius, which is both
 * the most there is to show and the most it is worth drawing.
 */
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.35;
/** One notch of a mouse wheel is about 100, and should be about 15% of zoom. */
const WHEEL_SENSITIVITY = 0.0015;
/** A trackpad pinch arrives as a wheel event with ctrl held, and much smaller. */
const PINCH_SENSITIVITY = 0.01;
const SWIVEL_STEP = 15;
/** A drag across the full width of the plan turns it half way round. */
const SWIVEL_PER_WIDTH = 180;
/**
 * How near the window marker a press has to land to take hold of it, in real
 * screen pixels — not in the canvas's own 960-wide space, which is what this
 * used to be. On a phone the canvas draws at about a third scale, so 16 of its
 * pixels were 5 of the reader's: an 11 px target for the one control the whole
 * drawing is built around. A coarse pointer gets the full 44 px.
 */
const GRAB_RADIUS_FINE_PX = 16;
const GRAB_RADIUS_COARSE_PX = 22;
/**
 * How far the marker drops back when something stands in front of it. Faint
 * enough to read as behind, solid enough to still be found and grabbed — it is
 * a control as well as a drawing.
 */
const HIDDEN_ALPHA = 0.28;
/**
 * How far one press of the window buttons slides it along the wall.
 *
 * A flat's frontage is seven to ten metres, so four moves the window by about
 * half a unit: fine enough to pick a stack, coarse enough that crossing a long
 * slab does not take thirty presses.
 */
const NUDGE_M = 4;

/** Segments the sun ray is split into, so it can pass behind a block and out. */
const RAY_SEGMENTS = 22;
/** How far past the canvas edge the sun ray runs before it is cut. */
const RAY_MARGIN_PX = 12;
/** A ray always worth drawing, however steeply it leaves the frame. */
const RAY_MIN_M = 25;

interface Props {
  result: AnalysisResult;
  /** Local time of day, minutes past midnight, for the shadow cast. */
  timeMinutes: number;
  /** Day of the year to cast shadows on, as a month/day pair. */
  day: { month: number; day: number };
  /** Where the reader dragged the window to, snapped to a wall of the block. */
  onPlaceWindow: (point: LatLng) => void;
  /**
   * The placement already committed, if any. The marker is drawn from this
   * rather than from the analysis, because the analysis is a few hundred
   * milliseconds behind and drawing from it snapped the marker back to where
   * it used to be for every one of them.
   */
  windowAt: LatLng | null;
  /**
   * An answer is being worked out. The view still turns and zooms — that costs
   * nothing — but the marker cannot be taken hold of until the first answer is
   * back, so a gesture can never outrun its answer.
   */
  busy: boolean;
}

export default function PlanMap({
  result, timeMinutes, day, onPlaceWindow, windowAt, busy,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [azimuth, setAzimuth] = useState(AZIMUTH_HOME);
  const [pitch, setPitch] = useState(PITCH_HOME);
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ x: number; y: number; azimuth: number; pitch: number } | null>(null);
  // Where the marker is while a finger is on it. Null the rest of the time, so
  // the analysis stays the single source of truth once the finger lifts.
  const [placing, setPlacing] = useState<[number, number] | null>(null);
  /**
   * Whether the window can be moved by button as well as by dragging.
   *
   * The marker is a 4.5 px dot on a canvas that draws at about a third scale on
   * a phone, and dragging it means covering the very thing being aimed at with
   * a thumb. So under a touch screen the buttons are simply there; under a
   * mouse, where the drag works well, they are offered and stay out of the way
   * until asked for. Resolved after mount, because the server cannot know which
   * it is and guessing would mismatch the first render.
   */
  const [nudging, setNudging] = useState(false);
  useEffect(() => {
    setNudging(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  // The view turns about the block being reported on, not about the pin: on a
  // condo the pin can sit out at the gate, and swivelling round a gate throws
  // the block the reader came to look at off the side of the frame.
  const host = useMemo(
    () => result.buildings.find((b) => b.id === result.viewpoint.hostId) ?? null,
    [result],
  );

  const camera: Camera = useMemo(
    () => ({ azimuth, pitch, zoom, pivot: host ? centroid(host.ring) : [0, 0] }),
    [host, azimuth, pitch, zoom],
  );

  // Where the marker belongs, in the order of who knows best: the finger on it
  // now, then the placement already made, then the analysis.
  const marker: [number, number] = useMemo(() => {
    if (placing) return placing;
    if (windowAt) {
      const [x, y] = makeProjection(result.origin).toLocal(windowAt);
      return [x, y];
    }
    return [result.viewpoint.x, result.viewpoint.y];
  }, [placing, windowAt, result]);

  // Wheel has to be bound by hand: React registers onWheel passively, and a
  // passive listener is not allowed to call preventDefault.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const step = lines(e);
      if (!step) return;
      const next = clampZoom(zoom * Math.exp(-step));
      // At either end of the range, hand the scroll back to the page. Swallowing
      // it would strand a reader who is only trying to get past the map.
      if (next === zoom) return;
      e.preventDefault();
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // One draw per frame at most. A drag fires pointer events far faster than
    // the massing can be repainted, and without this the queue runs away.
    const frame = requestAnimationFrame(() => draw(ctx, result, timeMinutes, day, camera, marker));
    return () => cancelAnimationFrame(frame);
  }, [result, timeMinutes, day, camera, marker]);

  const toCanvas = (clientX: number, clientY: number, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    return [((clientX - rect.left) / rect.width) * W, ((clientY - rect.top) / rect.height) * H];
  };

  /** Is this press on the window marker? Asked of where it is drawn, not of
   *  where the last analysis put it — during a recompute those differ. The
   *  radius is a screen measurement, so it is converted into canvas space at
   *  whatever scale the canvas is currently drawn at. */
  const onMarker = (px: number, py: number, el: HTMLCanvasElement) => {
    if (!host) return false;
    const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    const screenPx = coarse ? GRAB_RADIUS_COARSE_PX : GRAB_RADIUS_FINE_PX;
    const grab = screenPx * (W / (el.getBoundingClientRect().width || W));
    const v = view(camera);
    const [mx, my] = marker;
    return Math.hypot(px - v.sx(mx, my), py - v.sy(mx, my, result.viewpoint.z)) <= grab;
  };

  /**
   * A window is on a wall, so wherever the finger goes the marker lands on the
   * nearest point of the block's outline. That is also what keeps a courtyard
   * reachable: the inside of a C is as much a part of the outline as the front.
   */
  const snap = (px: number, py: number): [number, number] => {
    const [gx, gy] = view(camera).ground(px, py);
    if (!host) return [gx, gy];
    const wall = nearestFacade(gx, gy, host.ring);
    return [wall.x, wall.y];
  };

  /**
   * Slide the window along the wall, one press at a time.
   *
   * Left and right mean left and right on the screen, not clockwise round the
   * outline: which way a footprint is wound is an accident of how it was drawn,
   * and the camera turns anyway. So both candidates are projected and the one
   * that actually moves the way the arrow points is the one taken.
   */
  const nudge = (dir: 1 | -1) => {
    if (!host || busy) return;
    const [mx, my] = marker;
    const forward = walkOutline(mx, my, host.ring, NUDGE_M);
    const back = walkOutline(mx, my, host.ring, -NUDGE_M);
    const v = view(camera);
    const rightwards = v.sx(forward[0], forward[1]) >= v.sx(back[0], back[1]);
    const next = rightwards === dir > 0 ? forward : back;
    setPlacing(next);
    onPlaceWindow(makeProjection(result.origin).toLatLng(next[0], next[1]));
    setPlacing(null);
  };

  const swivel = (by: number) => setAzimuth((a) => a + by);
  const tilt = (by: number) => setPitch((p) => clampPitch(p + by));
  const scaleZoom = (by: number) => setZoom((z) => clampZoom(z * by));

  return (
    <div className={`plan canvas-wrap${busy ? " busy" : ""}`}>
      <canvas
        ref={ref}
        role="img"
        aria-label={planDescription(result)}
        style={{ aspectRatio: `${W} / ${H}` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const [px, py] = toCanvas(e.clientX, e.clientY, e.currentTarget);
          // Either the marker is being taken hold of, or the view is being
          // swivelled. The marker is the more specific, so it is asked first.
          if (!busy && onMarker(px, py, e.currentTarget)) {
            setPlacing(snap(px, py));
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY, azimuth, pitch };
        }}
        onPointerMove={(e) => {
          if (placing) {
            const [px, py] = toCanvas(e.clientX, e.clientY, e.currentTarget);
            setPlacing(snap(px, py));
            return;
          }
          const d = drag.current;
          if (!d) {
            // Nothing is being dragged, so the cursor's job is to say what could be.
            const [px, py] = toCanvas(e.clientX, e.clientY, e.currentTarget);
            e.currentTarget.style.cursor = !busy && onMarker(px, py, e.currentTarget) ? "grab" : "";
            return;
          }
          // One drag does both: across turns the camera round the block,
          // down brings it lower and up lifts it overhead.
          const box = e.currentTarget.getBoundingClientRect();
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          setAzimuth(d.azimuth + (dx / (box.width || W)) * SWIVEL_PER_WIDTH);
          setPitch(clampPitch(d.pitch - (dy / (box.height || H)) * PITCH_PER_HEIGHT));
        }}
        onPointerUp={() => {
          if (placing) {
            onPlaceWindow(makeProjection(result.origin).toLatLng(placing[0], placing[1]));
            setPlacing(null);
            return;
          }
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPlacing(null);
        }}
      />

      {/* The window's own controls, kept apart from the camera's: one moves the
          unit being reported on, the others only change where you stand to look
          at it. Mixing them in one row invites pressing the wrong sort. */}
      {nudging ? (
        <div className="window-nudge">
          <span>Window</span>
          <button onClick={() => nudge(-1)} disabled={!host || busy}
            aria-label={`Move the window ${NUDGE_M} metres left along the block`} title="Move left along the wall">
            <Glyph d="M13 9H5M8.5 5.5 5 9l3.5 3.5" />
          </button>
          <button onClick={() => nudge(1)} disabled={!host || busy}
            aria-label={`Move the window ${NUDGE_M} metres right along the block`} title="Move right along the wall">
            <Glyph d="M5 9h8M9.5 5.5 13 9l-3.5 3.5" />
          </button>
          {!host && <small>no block here to move along</small>}
          <button className="as-text" onClick={() => setNudging(false)}>Hide</button>
        </div>
      ) : (
        <div className="window-nudge">
          <button className="as-text" onClick={() => setNudging(true)}>Move the window with buttons</button>
        </div>
      )}

      <div className="plan-controls">
        <button onClick={() => swivel(-SWIVEL_STEP)} aria-label="Turn the view left" title="Turn left">
          <Turn back />
        </button>
        <button onClick={() => swivel(SWIVEL_STEP)} aria-label="Turn the view right" title="Turn right">
          <Turn />
        </button>
        <button
          onClick={() => tilt(PITCH_STEP)}
          disabled={pitch >= PITCH_MAX - 1e-6}
          aria-label="Raise the view"
          title="Raise the view"
        >
          <Glyph d="M9 14V4M4.5 8.5 9 4l4.5 4.5" />
        </button>
        <button
          onClick={() => tilt(-PITCH_STEP)}
          disabled={pitch <= PITCH_MIN + 1e-6}
          aria-label="Lower the view"
          title="Lower the view"
        >
          <Glyph d="M9 4v10M4.5 9.5 9 14l4.5-4.5" />
        </button>
        <button
          onClick={() => scaleZoom(1 / ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM + 1e-6}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Glyph d="M4 9h10" />
        </button>
        <button
          onClick={() => scaleZoom(ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM - 1e-6}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Glyph d="M4 9h10M9 4v10" />
        </button>
      </div>
    </div>
  );
}

/**
 * Drawn rather than typed. A rotation arrow is not in every typeface, and a
 * glyph that falls back lands at a different weight and size from its
 * neighbours; these four share one stroke and one box.
 */
function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A three-quarter turn with a head on it, mirrored for the other direction. */
function Turn({ back = false }: { back?: boolean }) {
  return (
    <svg
      viewBox="0 0 18 18"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      style={back ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M4.2 9a4.8 4.8 0 1 1 1.9 3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M4.2 5.6v3.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}



export interface Camera {
  /** Where the viewer stands, in degrees round the pivot. */
  azimuth: number;
  /** How high the viewer stands, in degrees above the ground. */
  pitch: number;
  /** 1 is the framing the plan opens at. */
  zoom: number;
  /** The point the view turns about, in local metres: the chosen block. */
  pivot: [number, number];
}

export const HOME: Camera = { azimuth: AZIMUTH_HOME, pitch: PITCH_HOME, zoom: 1, pivot: [0, 0] };

const clampPitch = (p: number) => Math.max(PITCH_MIN, Math.min(PITCH_MAX, p));
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * How much a wheel event should move the zoom, as a log step so that a notch
 * changes the view by the same proportion wherever you are in the range.
 *
 * Browsers report the same gesture in three different units, and a trackpad
 * pinch turns up as a wheel event with ctrl held and a tiny delta, so both are
 * normalised before they get anywhere near the camera.
 */
function lines(e: WheelEvent) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  return e.deltaY * unit * (e.ctrlKey ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY);
}

/** The screen transform: world metres (east, north, up) to canvas pixels. */
function view(camera: Camera) {
  // The ground covers a diamond 2R across each diagonal; fit that, then come in
  // slightly, since the far corners hold nothing worth seeing.
  const scale =
    Math.min(W / (4 * VIEW_RADIUS_M * COS), H / (4 * VIEW_RADIUS_M * SQUASH_FIT)) *
    1.18 *
    camera.zoom;
  const cx = W / 2;
  // Room above the horizon for the towers to stand up in.
  //
  // The pivot sits at this line, so it is where the chosen block meets the
  // ground. As the camera comes down the ground foreshortens into it and the
  // towers grow upward out of it, which left the whole neighbourhood stacked in
  // the top of the frame with nothing underneath — so the line goes down as the
  // camera does, and the model stays in the middle of the picture.
  const drop = Math.max(0, (SQUASH_FIT - Math.sin(rad(camera.pitch))) / SQUASH_FIT);
  const cy = H / 2 + 54 + drop * H * 0.16;

  // Turning the camera is turning the world underneath it. Everything is
  // measured from the pivot, so the chosen block holds the middle of the frame
  // while the neighbourhood swings around it.
  const a = rad(camera.azimuth);
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  const [ox, oy] = camera.pivot;

  /** Across the screen, and into it. Both are still true metres. */
  const across = (x: number, y: number) => (x - ox) * cosA - (y - oy) * sinA;
  const into = (x: number, y: number) => (x - ox) * sinA + (y - oy) * cosA;

  const kx = COS * scale * Math.SQRT2;
  const ky = Math.sin(rad(camera.pitch)) * scale * Math.SQRT2;

  const sx = (x: number, y: number) => cx + across(x, y) * kx;
  const sy = (x: number, y: number, z: number) => cy - into(x, y) * ky - z * scale;

  return {
    scale,
    /** Canvas pixels per metre measured straight across the screen. */
    kx,
    sx,
    sy,
    /** Depth: larger is further from the viewer. */
    depth: into,
    /**
     * The world direction of increasing depth — straight away from the viewer
     * along the ground. Walking the other way is walking down a view ray.
     */
    away: [sinA, cosA] as [number, number],
    /**
     * Metres of height gained per metre travelled toward the viewer, for the
     * same pixel. The camera looks down, so a view ray climbs as it comes
     * forward: that is why a window on the far wall of its own block is covered
     * by the roof standing in front of it.
     */
    rise: ky / scale,
    /**
     * A direction turned into the camera's frame. Unlike a position it takes no
     * pivot shift, so it is the right thing to ask of a wall's normal: `into`
     * positive means the wall points away from the viewer, and the sign of
     * `across` says which of the two visible sides it is.
     */
    direction: (dx: number, dy: number): [across: number, into: number] => [
      dx * cosA - dy * sinA,
      dx * sinA + dy * cosA,
    ],
    /** Back from a point on the canvas to the ground plane under it. */
    ground(px: number, py: number): [number, number] {
      const u = (px - cx) / kx;
      const w = (cy - py) / ky;
      return [ox + u * cosA + w * sinA, oy - u * sinA + w * cosA];
    },
    /** How far out the frame reaches, in metres, and so what is worth drawing. */
    reachM: (VIEW_RADIUS_M * 1.6) / camera.zoom,
  };
}

type View = ReturnType<typeof view>;

function draw(
  ctx: CanvasRenderingContext2D,
  result: AnalysisResult,
  timeMinutes: number,
  day: { month: number; day: number },
  camera: Camera,
  marker: [number, number],
) {
  const v = view(camera);
  const c = palette();

  ctx.fillStyle = c.ground;
  ctx.fillRect(0, 0, W, H);

  const sun = sunPosition(
    Date.UTC(2026, day.month, day.day, 0, timeMinutes - 8 * 60),
    result.origin.lat,
    result.origin.lng,
  );

  // The Master Plan's ground goes down first, under everything: it is the
  // surface the model stands on, not an overlay on top of it.
  drawGround(ctx, v, c, result);
  drawGrid(ctx, v, c);

  // The engine reads 600 m of neighbourhood and the frame holds a slice of it.
  // Drawing what falls outside costs exactly as much as drawing what you can
  // see, so it is culled — and because zooming out widens the frame, the cull
  // radius follows it rather than being fixed.
  const [ox, oy] = camera.pivot;
  const cull = v.reachM + 60;
  const inFrame = result.buildings.filter((b) => {
    const [gx, gy] = centroid(b.ring);
    return Math.hypot(gx - ox, gy - oy) < cull;
  });

  // Ground shadows go down before any massing, as a single path: overlapping
  // blocks must not stack up into darker patches.
  if (sun.elevation > 1) drawShadows(ctx, v, c, inFrame, result, sun);

  // Painter's algorithm. Far blocks first, so near ones overlap them; a block's
  // own walls are ordered the same way inside drawBlock.
  const blockerIds = new Set(result.blockage.blockers.map((b) => b.id));
  const ordered = [...inFrame].sort(
    (a, b) => v.depth(...centroid(b.ring)) - v.depth(...centroid(a.ring)),
  );
  for (const b of ordered) {
    drawBlock(ctx, v, c, b, b.id === result.viewpoint.hostId, blockerIds.has(b.id));
  }

  // The fan stands in the model now rather than lying under it, so it is drawn
  // with the massing already down and asks for itself which parts are covered.
  const hiddenAt = occluders(v, inFrame);
  drawSightline(ctx, v, c, result, hiddenAt);
  drawWindow(ctx, v, c, result, sun, marker, hiddenAt);
  drawFurniture(ctx, v, c, sun);
}

/** Read the theme off the document so the drawing and the CSS cannot drift. */
function palette() {
  // Every one of these is a CSS custom property, because a canvas cannot read
  // the stylesheet and the plan has to change with the theme like everything
  // else. The fallbacks only ever run during server render.
  const fallback = {
    ground: "#f6e6cd",
    grid: "rgba(36,72,85,0.07)",
    water: "#a8d3dd",
    green: "#cfe0bd",
    road: "#eee0c4",
    shadow: "rgba(135,79,65,0.16)",
    roof: "#eddcc2",
    wallLit: "#ddc9ab",
    wallDark: "#c9b596",
    edge: "#bda88a",
    hostRoof: "#2f5a68",
    hostWall: "#244855",
    hostWallDark: "#1a353f",
    hostLabel: "#fbe9d0",
    blockerRoof: "#cbb098",
    blockerWall: "#b9997f",
    blockerWallDark: "#a2836c",
    fanFill: "rgba(63,109,168,0.16)",
    fanLine: "rgba(63,109,168,0.6)",
    ray: "#e07a2c",
    sun: "#d8321e",
    ink: "#3d4127",
    faint: "#5f6443",
    muted: "#55593a",
    // The canvas cannot inherit a font, so it is told the family by name.
    face: 'Manrope, ui-sans-serif, system-ui, sans-serif',
  };
  if (typeof window === "undefined") return fallback;
  const s = getComputedStyle(document.documentElement);
  const get = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb;
  const token = (suffix: string, key: keyof typeof fallback) =>
    get(`--plan-${suffix}`, fallback[key]);

  return {
    ground: token("ground", "ground"),
    grid: token("grid", "grid"),
    water: token("water", "water"),
    green: token("green", "green"),
    road: token("road", "road"),
    shadow: token("shadow", "shadow"),
    roof: token("roof", "roof"),
    wallLit: token("wall-lit", "wallLit"),
    wallDark: token("wall-dark", "wallDark"),
    edge: token("edge", "edge"),
    hostRoof: token("host-roof", "hostRoof"),
    hostWall: token("host-wall", "hostWall"),
    hostWallDark: token("host-wall-dark", "hostWallDark"),
    hostLabel: token("host-label", "hostLabel"),
    blockerRoof: token("blocker-roof", "blockerRoof"),
    blockerWall: token("blocker-wall", "blockerWall"),
    blockerWallDark: token("blocker-wall-dark", "blockerWallDark"),
    fanFill: token("fan-fill", "fanFill"),
    fanLine: token("fan-line", "fanLine"),
    ray: token("ray", "ray"),
    sun: token("sun", "sun"),
    ink: get("--ink", fallback.ink),
    faint: get("--faint", fallback.faint),
    muted: get("--muted", fallback.muted),
    face: get("--sans", fallback.face),
  };
}

type Palette = ReturnType<typeof palette>;

/**
 * Water, open land and road reserve, flat on the ground plane.
 *
 * These are the three things the outlook engine will not let a building rise
 * on, so shading them is the verdict's reasoning drawn rather than written:
 * the reader sees the reservoir their score is made of. Everything else stays
 * bare ground, because the plan zones it by floor area and not height and
 * colouring it in would be a claim about a skyline that nobody has published.
 */
function drawGround(
  ctx: CanvasRenderingContext2D,
  v: View,
  c: Palette,
  result: AnalysisResult,
) {
  for (const g of result.ground) {
    ctx.fillStyle = g.kind === "water" ? c.water : g.kind === "open" ? c.green : c.road;
    ctx.beginPath();
    for (let i = 0; i < g.ring.length; i++) {
      const [gx, gy] = g.ring[i];
      if (i === 0) ctx.moveTo(v.sx(gx, gy), v.sy(gx, gy, 0));
      else ctx.lineTo(v.sx(gx, gy), v.sy(gx, gy, 0));
    }
    ctx.closePath();
    ctx.fill();
  }
}

/** A 50 m ground grid, in perspective with everything else. */
function drawGrid(ctx: CanvasRenderingContext2D, v: View, c: Palette) {
  const R = Math.ceil((v.reachM + 100) / 50) * 50;
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = -R; m <= R; m += 50) {
    ctx.moveTo(v.sx(m, -R), v.sy(m, -R, 0));
    ctx.lineTo(v.sx(m, R), v.sy(m, R, 0));
    ctx.moveTo(v.sx(-R, m), v.sy(-R, m, 0));
    ctx.lineTo(v.sx(R, m), v.sy(R, m, 0));
  }
  ctx.stroke();
}

function drawShadows(
  ctx: CanvasRenderingContext2D,
  v: View,
  c: Palette,
  inFrame: Building[],
  result: AnalysisResult,
  sun: { azimuth: number; elevation: number },
) {
  const reach = Math.min(result.viewpoint.z + 80, 420) / Math.tan(rad(sun.elevation));
  const ox = -Math.sin(rad(sun.azimuth));
  const oy = -Math.cos(rad(sun.azimuth));
  const path = new Path2D();

  for (const b of inFrame) {
    const d = Math.min(b.height / Math.tan(rad(sun.elevation)), reach);
    const dx = ox * d;
    const dy = oy * d;
    const ring = b.ring;

    addFace(path, ring.map(([x, y]) => [v.sx(x + dx, y + dy), v.sy(x + dx, y + dy, 0)] as const));
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      addFace(path, [
        [v.sx(ring[j][0], ring[j][1]), v.sy(ring[j][0], ring[j][1], 0)],
        [v.sx(ring[i][0], ring[i][1]), v.sy(ring[i][0], ring[i][1], 0)],
        [v.sx(ring[i][0] + dx, ring[i][1] + dy), v.sy(ring[i][0] + dx, ring[i][1] + dy, 0)],
        [v.sx(ring[j][0] + dx, ring[j][1] + dy), v.sy(ring[j][0] + dx, ring[j][1] + dy, 0)],
      ]);
    }
  }
  ctx.fillStyle = c.shadow;
  ctx.fill(path);
}

/**
 * One block: the walls that face the viewer, then the roof on top. The viewer
 * stands to the south-west, so a wall is visible when its outward normal points
 * that way.
 */
function drawBlock(
  ctx: CanvasRenderingContext2D,
  v: View,
  c: Palette,
  b: Building,
  isHost: boolean,
  isBlocker: boolean,
) {
  const ring = b.ring;
  const h = b.height;
  // Which side of an edge is outside is a property of the whole ring, so it is
  // worth one signed area rather than a point-in-polygon test per wall.
  const outward = signedArea(ring) > 0 ? 1 : -1;
  const tone = isHost
    ? { roof: c.hostRoof, lit: c.hostWall, dark: c.hostWallDark }
    : isBlocker
      ? { roof: c.blockerRoof, lit: c.blockerWall, dark: c.blockerWallDark }
      : { roof: c.roof, lit: c.wallLit, dark: c.wallDark };

  type Wall = { pts: [number, number][]; depth: number; lit: boolean };
  const walls: Wall[] = [];

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;

    const nx = (outward * dy) / len;
    const ny = (-outward * dx) / len;
    // Whether a wall can be seen is a question about the camera, not about the
    // compass. Testing the normal against world east and north was the same
    // thing only while the view was pinned to the south-west corner; once it
    // swivels, that test culls whichever walls happen to face north-east and
    // leaves the near side of every block open to the ground.
    const [across, into] = v.direction(nx, ny);
    if (into > 0) continue; // this wall points away from the viewer

    walls.push({
      pts: [
        [v.sx(ax, ay), v.sy(ax, ay, 0)],
        [v.sx(bx, by), v.sy(bx, by, 0)],
        [v.sx(bx, by), v.sy(bx, by, h)],
        [v.sx(ax, ay), v.sy(ax, ay, h)],
      ],
      depth: v.depth((ax + bx) / 2, (ay + by) / 2),
      // Two flat tones rather than a shading ramp: of the two sides a viewer
      // can see, one reads lit and one reads turned away, so the massing stays
      // crisp at every angle instead of flattening into a silhouette when the
      // camera comes round to where both visible sides were the same tone.
      lit: across > 0,
    });
  }

  walls.sort((p, q) => q.depth - p.depth);
  for (const wall of walls) {
    fillFace(ctx, wall.pts, wall.lit ? tone.lit : tone.dark);
  }

  const roof = ring.map(([x, y]) => [v.sx(x, y), v.sy(x, y, h)] as [number, number]);
  fillFace(ctx, roof, tone.roof);

  // A crisp top edge is what makes the massing read as solid at this size.
  ctx.beginPath();
  roof.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.strokeStyle = isHost ? c.hostRoof : c.edge;
  ctx.lineWidth = isHost ? 1.5 : 1;
  // A guessed height is drawn as a guess.
  if (b.heightSource === "inferred" && !isHost) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  if ((isHost || isBlocker) && b.blockNo && polygonSpan(roof) > 26) {
    const [gx, gy] = centroid(ring);
    ctx.fillStyle = isHost ? c.hostLabel : c.muted;
    ctx.font = `${isHost ? "600" : "500"} 11px ${c.face}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(b.blockNo, v.sx(gx, gy), v.sy(gx, gy, h));
  }
}

/**
 * The drawing in words, for anyone who cannot see it. A canvas is opaque to a
 * screen reader, and this one carries the answer, not decoration.
 */
function planDescription(result: AnalysisResult) {
  const { blockage, viewpoint } = result;
  const worst = blockage.blockers[0];
  return (
    `Plan of the neighbourhood. The window is on storey ${viewpoint.floor}, facing ` +
    `${compassName(viewpoint.facing)}, and sees ${blockage.openArcDegrees}° of clear sky. ` +
    (worst
      ? `The biggest obstruction is ${worst.label}, ${Math.round(worst.distance)} m to the ` +
        `${compassName(worst.bearing)}.`
      : "Nothing blocks the view in front.")
  );
}

/**
 * Which parts of the drawing are hidden behind a block.
 *
 * The projection is orthographic, so every pixel is a straight line through the
 * world and the question has an exact answer: walk from the point toward the
 * viewer and see whether that line passes through any block on its way out.
 *
 * This used to compare the point's depth against each block's centroid, which
 * is not the same question — a long slab whose middle sits behind the point can
 * still have its near end standing in front of it. The answer then changed as
 * the view turned, on geometry that had not moved.
 */
function occluders(v: View, inFrame: Building[]) {
  const items = inFrame.map((b) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of b.ring) {
      const sx = v.sx(x, y);
      // A block occupies the screen from its roofline down to its footings.
      const top = v.sy(x, y, b.height);
      const foot = v.sy(x, y, 0);
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (top < minY) minY = top;
      if (foot > maxY) maxY = foot;
    }
    return { b, minX, maxX, minY, maxY };
  });

  const [ax, ay] = v.away;
  // The ray starts a hand's width forward of the point, because the marker is
  // snapped flat onto a wall and would otherwise always register as touching
  // its own block.
  const EPS_M = 0.25;
  /**
   * How much solid the ray has to pass through before the point counts as
   * covered. A ray that grazes a corner clips it for a few millimetres, which
   * is arithmetic rather than anything a reader could see; real cover is metres
   * deep. Ignoring the slivers is also what keeps the answer steady, since they
   * are exactly the cases where the crossings and the fill rule can disagree.
   */
  const MIN_COVER_M = 0.5;

  /**
   * Does this block stand on the view ray in front of the point? The ray is
   * walked in metres of depth: `t` metres toward the viewer is `t * v.rise`
   * metres higher, so it eventually climbs clear of the roof, and `far` is
   * where. Anything past that is over the top of the block and not covered by
   * it.
   */
  const inFront = (x: number, y: number, z: number, b: Building) => {
    const far = (b.height - z) / v.rise;
    if (far <= EPS_M) return false;

    // Where the ray crosses the outline. A block is not always convex — a C
    // shaped slab is two crossings in and two out — so every crossing is kept
    // and the spans between them are read in order.
    const ring = b.ring;
    const ts: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [px, py] = ring[j];
      const ex = ring[i][0] - px;
      const ey = ring[i][1] - py;
      // dir = (-ax, -ay), toward the viewer.
      const den = -ax * ey + ay * ex;
      if (Math.abs(den) < 1e-9) continue; // the edge runs along the ray
      const wx = px - x;
      const wy = py - y;
      const t = (wx * ey - wy * ex) / den;
      // Half-open, so a ray through a vertex is one crossing and not two.
      const u = (wx * -ay - wy * -ax) / den;
      if (t > EPS_M && u >= 0 && u < 1) ts.push(t);
    }
    ts.sort((m, n) => m - n);

    let inside = pointInRing(x - ax * EPS_M, y - ay * EPS_M, ring);
    let from = EPS_M;
    for (const t of ts) {
      if (inside && Math.min(t, far) - from >= MIN_COVER_M) return true;
      if (t >= far) return false;
      inside = !inside;
      from = t;
    }
    return inside && far - from >= MIN_COVER_M;
  };

  return function hiddenAt(x: number, y: number, z: number) {
    const px = v.sx(x, y);
    const py = v.sy(x, y, z);
    for (const it of items) {
      // A block whose silhouette misses this pixel cannot be on the ray at all,
      // and that is four comparisons rather than a walk round its outline.
      if (px < it.minX || px > it.maxX || py < it.minY || py > it.maxY) continue;
      if (inFront(x, y, z, it.b)) return true;
    }
    return false;
  };
}

/** Degrees of azimuth between samples round the fan. */
const SIGHT_STEP_DEG = 2;
/** How much of its normal fill a stretch of the fan keeps when behind a block. */
const SIGHT_BEHIND = 0.45;
/**
 * A jump in how far the view runs, beyond which the two bearings are looking
 * at different things and the wall between them is a building's flank rather
 * than a stretch of skyline.
 */
const STEP_M = 12;
/** How much of the wall's fill its flanks carry, being seen nearly edge-on. */
const FLANK_FILL = 0.55;

/**
 * What the window can see, as a room of air with a floor and walls.
 *
 * This began as a flat wedge at z = 0 — drawn from the right numbers, wrong to
 * look at, because a window on the eighth storey cannot see a puddle on the
 * pavement. Lifting it to the window's own height and letting blocks cover it
 * put it in the model, but it was still a sheet of paper in a world of solids.
 *
 * So the far edge stands up. At each bearing the floor runs out to whatever
 * stops the view, and a wall rises there to the top of it — the horizon
 * elevation the engine measured, at the distance it measured, so the line
 * along the top is your own skyline. Flat where you see out, stepping up where
 * the neighbours rise.
 *
 * The wall is what is hard to draw, and the first attempt at it folded through
 * itself. Sweeping one ribbon along the whole far edge breaks wherever the
 * sightline jumps — 150 m of open view at one bearing, 30 m into a neighbour
 * at the next — because the polygon doubles back on itself between those two
 * ends and fills as a bowtie. A jump like that is not a fault in the data, it
 * is the corner of a building, so the sweep is cut there and the gap is closed
 * with the face that really stands in it: the flank of the block, seen edge-on.
 */
function drawSightline(
  ctx: CanvasRenderingContext2D,
  v: View,
  c: Palette,
  result: AnalysisResult,
  hiddenAt: (x: number, y: number, z: number) => boolean,
) {
  const { x, y, z, facing } = result.viewpoint;

  const samples: Sample[] = [];
  for (let a = -90; a <= 90; a += SIGHT_STEP_DEG) {
    const az = facing + a;
    const i = ((Math.round(az) % 360) + 360) % 360;
    const raw = result.horizon.distance[i];
    // A ray running past the drawing radius meets something further out than
    // the edge being drawn. Standing that blocker's height up at the near edge
    // would put a wall across an open view, so it is left flat.
    const stopped = Number.isFinite(raw) && raw > 0 && raw <= SIGHT_DRAW_M;
    const d = stopped ? raw : SIGHT_DRAW_M;
    const px = x + Math.sin(rad(az)) * d;
    const py = y + Math.cos(rad(az)) * d;
    samples.push({
      x: px,
      y: py,
      d,
      top: stopped ? z + d * Math.tan(rad(result.horizon.elevation[i])) : z,
      behind: hiddenAt((x + px) / 2, (y + py) / 2, z),
    });
  }

  const runs = runsOf(samples);
  const at = (p: Sample, h: number) => [v.sx(p.x, p.y), v.sy(p.x, p.y, h)] as const;

  // The floor, filled a run at a time. Filling it one sliver at a time would
  // lay ninety translucent wedges edge to edge and show a seam at every join.
  ctx.fillStyle = c.fanFill;
  for (const run of runs) {
    ctx.globalAlpha = run.behind ? SIGHT_BEHIND : 1;
    ctx.beginPath();
    ctx.moveTo(v.sx(x, y), v.sy(x, y, z));
    for (const p of run.items) ctx.lineTo(...at(p, z));
    ctx.closePath();
    ctx.fill();
  }

  // The flanks: where the view jumps from one distance to another, the face
  // that stands between the two, drawn before the walls so they sit over it.
  for (let i = 1; i < runs.length; i++) {
    const before = runs[i - 1].items[runs[i - 1].items.length - 1];
    const after = runs[i].items[0];
    if (Math.abs(before.d - after.d) < STEP_M) continue;
    ctx.globalAlpha = (runs[i].behind ? SIGHT_BEHIND : 1) * FLANK_FILL;
    ctx.beginPath();
    ctx.moveTo(...at(before, z));
    ctx.lineTo(...at(after, z));
    ctx.lineTo(...at(after, after.top));
    ctx.lineTo(...at(before, before.top));
    ctx.closePath();
    ctx.fill();
  }

  // The wall, fading as it rises.
  //
  // A blocker 140 m off at 21 degrees tops out fifty metres above the window,
  // so filled evenly this is the largest thing in the picture and washes the
  // neighbourhood pink — the reader ends up looking at the annotation instead
  // of through it. Fading keeps it solid where it meets the floor, which is
  // where it reads as standing up, and lets the line along its top carry the
  // rest. Nothing is clipped, so nothing is understated: the top edge is drawn
  // at the height it really is.
  for (const run of runs) {
    const floorY = run.items.reduce((m, p) => Math.max(m, at(p, z)[1]), -Infinity);
    const topY = run.items.reduce((m, p) => Math.min(m, at(p, p.top)[1]), Infinity);
    if (floorY - topY < 0.5) continue;

    const wash = ctx.createLinearGradient(0, floorY, 0, topY);
    wash.addColorStop(0, c.fanFill);
    wash.addColorStop(1, fade(c.fanFill));
    ctx.globalAlpha = run.behind ? SIGHT_BEHIND : 1;
    ctx.fillStyle = wash;
    ctx.beginPath();
    for (const p of run.items) ctx.lineTo(...at(p, z));
    for (let i = run.items.length - 1; i >= 0; i--) ctx.lineTo(...at(run.items[i], run.items[i].top));
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = c.fanLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of run.items) ctx.lineTo(...at(p, p.top));
    ctx.stroke();
  }

  // The floor's outline goes round the whole wedge at once rather than per run:
  // a run boundary is a change in what stands in front, not an edge of
  // anything, and stroking each would rule spurious lines across the fan.
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = c.fanLine;
  ctx.beginPath();
  ctx.moveTo(v.sx(x, y), v.sy(x, y, z));
  for (const p of samples) ctx.lineTo(...at(p, z));
  ctx.closePath();
  ctx.stroke();

  ctx.globalAlpha = 1;
}

interface Sample {
  x: number;
  y: number;
  /** How far the view runs at this bearing, metres. */
  d: number;
  /** Height of the skyline where the view stops, metres above the ground. */
  top: number;
  /** Something stands between the window and here. */
  behind: boolean;
}

/**
 * The fan cut into stretches that can each be filled as one simple polygon.
 *
 * A stretch ends where the answer changes about what stands in front, and
 * where the view jumps far enough that sweeping across the gap would fold the
 * polygon over itself. Stretches overlap their neighbour by a sample so the
 * floor fills meet instead of leaving a hairline between them.
 */
function runsOf(samples: Sample[]) {
  const runs: { behind: boolean; items: Sample[] }[] = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    const previous = last?.items[last.items.length - 1];
    const continues = last && previous && last.behind === s.behind && Math.abs(previous.d - s.d) < STEP_M;
    if (continues) last.items.push(s);
    else runs.push({ behind: s.behind, items: previous ? [previous, s] : [s] });
  }
  return runs;
}

/** The same colour with nothing left of it, for the top of a fading wall. */
function fade(colour: string) {
  const parts = colour.match(/[\d.]+/g);
  return parts && parts.length >= 3 ? `rgba(${parts[0]},${parts[1]},${parts[2]},0)` : "transparent";
}

/**
 * How far a ray toward the sun can run before it leaves the canvas.
 *
 * Every metre it travels moves it a fixed distance across the picture and a
 * fixed distance up it — across from the ground it covers, up from the height
 * it gains — so the edge it will cross first falls out of two divisions.
 */
function rayReach(
  v: View,
  sun: { azimuth: number; elevation: number },
  px: number,
  py: number,
) {
  const [across, into] = v.direction(Math.sin(rad(sun.azimuth)), Math.cos(rad(sun.azimuth)));
  const perMetreX = across * v.kx;
  const perMetreY = -into * v.rise * v.scale - Math.tan(rad(sun.elevation)) * v.scale;

  const edge = (at: number, per: number, limit: number) =>
    per > 0 ? (limit + RAY_MARGIN_PX - at) / per : per < 0 ? (-RAY_MARGIN_PX - at) / per : Infinity;

  return Math.max(
    RAY_MIN_M,
    Math.min(edge(px, perMetreX, W), edge(py, perMetreY, H), VIEW_RADIUS_M * 1.6),
  );
}

/** The window itself, at its real height on the wall, and the sun's bearing. */
function drawWindow(
  ctx: CanvasRenderingContext2D,
  v: View,
  c: Palette,
  result: AnalysisResult,
  sun: { azimuth: number; elevation: number },
  marker: [number, number],
  hiddenAt: (x: number, y: number, z: number) => boolean,
) {
  // The marker leads and the analysis follows, so it draws where it has been
  // put rather than where the last answer came back from.
  const [x, y] = marker;
  const { z } = result.viewpoint;
  const px = v.sx(x, y);
  const py = v.sy(x, y, z);

  // The marker is drawn after the massing, so without this it floats on the
  // roof of whatever is standing in front of it — which reads as the window
  // being on the near side of a block when it is on the far one.
  const behind = hiddenAt(x, y, z);
  const solid = behind ? HIDDEN_ALPHA : 1;
  // The dot is the one thing on the plan you are meant to find at a glance, so
  // being behind a block dims it rather than all but erasing it.
  const dot = behind ? 0.7 : 1;

  // A dropline to the ground, so the storey is something you can see.
  ctx.globalAlpha = solid;
  ctx.beginPath();
  ctx.moveTo(v.sx(x, y), v.sy(x, y, 0));
  ctx.lineTo(px, py);
  ctx.strokeStyle = c.ray;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (sun.elevation > 0) {
    // The ray runs a long way and can pass behind a block on its way out, so it
    // is drawn a piece at a time and each piece answers for itself. Watching it
    // disappear into a tower and come out the far side is the whole point of it.
    // Run it at the sun's real angle and stop it where it leaves the frame.
    //
    // It used to climb at 0.28 of the true slope, which kept a long ray on the
    // canvas and drew a lie: a sun 48° up came out looking 17° up, so the one
    // line in the picture whose whole job is to say where the sun is said the
    // wrong thing, and read as a flat line ruled over the drawing rather than a
    // ray in it. Shortening it instead costs nothing — past the frame edge
    // there was never anything to see.
    const d = rayReach(v, sun, v.sx(x, y), v.sy(x, y, z));
    const tx = x + Math.sin(rad(sun.azimuth)) * d;
    const ty = y + Math.cos(rad(sun.azimuth)) * d;
    const tz = z + d * Math.tan(rad(sun.elevation));

    ctx.strokeStyle = c.sun;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.25;
    for (let i = 0; i < RAY_SEGMENTS; i++) {
      const a = i / RAY_SEGMENTS;
      const b = (i + 1) / RAY_SEGMENTS;
      const at = (f: number) => [x + (tx - x) * f, y + (ty - y) * f, z + (tz - z) * f] as const;
      const [mx, my, mz] = at((a + b) / 2);
      ctx.globalAlpha = (hiddenAt(mx, my, mz) ? HIDDEN_ALPHA : 1) * 0.85;
      const [ax, ay, az] = at(a);
      const [bx, by, bz] = at(b);
      ctx.beginPath();
      ctx.moveTo(v.sx(ax, ay), v.sy(ax, ay, az));
      ctx.lineTo(v.sx(bx, by), v.sy(bx, by, bz));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  ctx.globalAlpha = dot;
  ctx.beginPath();
  ctx.arc(px, py, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = c.ray;
  ctx.fill();
  ctx.strokeStyle = c.ground;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
}


function drawFurniture(
  ctx: CanvasRenderingContext2D,
  v: View,
  c: Palette,
  sun: { azimuth: number; elevation: number },
) {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // The clock is read out beside the scrubber now, so this says the one thing
  // the drawing cannot: where the sun is standing while it casts these shadows.
  ctx.fillStyle = c.muted;
  ctx.font = `11px ${c.face}`;
  ctx.fillText(
    sun.elevation > 0
      ? `Sun ${Math.round(sun.elevation)}° up, in the ${compassName(sun.azimuth)}`
      : "Sun is down",
    20,
    28,
  );

  // Scale bar. Measured straight across the screen, where a metre is a metre
  // whichever way the camera is pointing.
  const barM = 50;
  const barLen = barM * v.kx;
  const bx = 20;
  const by = H - 22;
  ctx.strokeStyle = c.faint;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + barLen, by);
  ctx.moveTo(bx, by - 3.5);
  ctx.lineTo(bx, by + 3.5);
  ctx.moveTo(bx + barLen, by - 3.5);
  ctx.lineTo(bx + barLen, by + 3.5);
  ctx.stroke();
  ctx.fillStyle = c.faint;
  ctx.font = `10px ${c.face}`;
  ctx.fillText(`${barM} M`, bx + barLen + 8, by + 3.5);

  // North, pointing the way north actually points in this projection.
  const ax = W - 46;
  const ay = 52;
  const nx = v.sx(0, 10) - v.sx(0, 0);
  const ny = v.sy(0, 10, 0) - v.sy(0, 0, 0);
  const nLen = Math.hypot(nx, ny);
  const ux = (nx / nLen) * 15;
  const uy = (ny / nLen) * 15;
  ctx.beginPath();
  ctx.moveTo(ax + ux, ay + uy);
  ctx.lineTo(ax - ux * 0.55 - uy * 0.4, ay - uy * 0.55 + ux * 0.4);
  ctx.lineTo(ax - ux * 0.55 + uy * 0.4, ay - uy * 0.55 - ux * 0.4);
  ctx.closePath();
  ctx.fillStyle = c.muted;
  ctx.fill();
  ctx.font = `600 10px ${c.face}`;
  ctx.textAlign = "center";
  ctx.fillText("N", ax + ux * 1.9, ay + uy * 1.9 + 3);
}

function fillFace(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: string) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Adds a polygon to `path`, always wound the same way. */
function addFace(path: Path2D, points: readonly (readonly [number, number])[]) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  const ordered = area < 0 ? [...points].reverse() : points;
  ordered.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
}

function signedArea(ring: [number, number][]) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function pointInRing(x: number, y: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Longest screen dimension of a face, for deciding if a label will fit. */
function polygonSpan(pts: [number, number][]) {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  return maxX - minX;
}

function centroid(ring: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}
