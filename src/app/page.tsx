"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PlanMap from "@/components/PlanMap";
import ScoreCard from "@/components/ScoreCard";
import SkyDome from "@/components/SkyDome";
import YearChart from "@/components/YearChart";
import { compassName } from "@/lib/blockage";
import { formatMinutes } from "@/lib/score";
import { isShortFormPostal, looksLikePostalPrefix, parsePostal } from "@/lib/postal";
import type { AddressHit } from "@/lib/onemap";
import type { AnalysisResult, LatLng } from "@/lib/types";

interface Address {
  blockNo: string | null;
  street: string | null;
  postal: string | null;
}

const START: { point: LatLng; label: string; postal: string; address: Address } = {
  point: { lat: 1.362004, lng: 103.85388 },
  label: "406 Ang Mo Kio Avenue 10",
  postal: "560406",
  address: { blockNo: "406", street: "Ang Mo Kio Avenue 10", postal: "560406" },
};

const SEASONS = [
  { label: "Mar", month: 2, day: 20 },
  { label: "Jun", month: 5, day: 21 },
  { label: "Sep", month: 8, day: 21 },
  { label: "Dec", month: 11, day: 21 },
];

export default function Home() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AddressHit[]>([]);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [point, setPoint] = useState<LatLng>(START.point);
  const [label, setLabel] = useState(START.label);
  const [postal, setPostal] = useState<string | null>(START.postal);
  // Carried so the analysis can find the right footprint even when the address
  // point sits out at the gate, as it does for most condos.
  const [address, setAddress] = useState<Address | null>(START.address);
  // Two storeys, not one. `floor` is where the slider handle is, and follows the
  // finger; `runFloor` is the storey the analysis was asked about, and only moves
  // when the finger lifts. Scrubbing a slider is one gesture, so it is one
  // question, not one per tick of the track.
  const [floor, setFloor] = useState(8);
  const [runFloor, setRunFloor] = useState(8);
  const floorRef = useRef(8);
  const scrubbing = useRef(false);
  const [face, setFace] = useState<number | undefined>(undefined);
  // Where the reader dragged the window to. Beats the side buttons when set,
  // because it is the one thing in here they actually know and we do not.
  const [windowAt, setWindowAt] = useState<LatLng | null>(null);
  const [timeMinutes, setTimeMinutes] = useState(16 * 60);
  const [season, setSeason] = useState(SEASONS[3]);

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    // A postal code is only worth sending once it is complete; anything else
    // needs three characters before a match means much.
    const postal = parsePostal(q);
    const ready = postal !== null || (!looksLikePostalPrefix(q) && q.length >= 3);
    if (!ready) {
      setHits([]);
      setSearchNote(null);
      return;
    }
    // Five digits reads as a complete code only because city-centre sectors get
    // typed without their leading zero — but it is also the first five digits of
    // a six-digit one, and OneMap tolerates barely two lookups in a row before
    // it starts refusing. Giving the short form a longer pause lets the sixth
    // keystroke cancel it, so the code the user actually meant gets the request.
    const delay = isShortFormPostal(q) ? 900 : 250;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const json = (await res.json()) as { results: AddressHit[]; error?: string };
        setHits(json.results ?? []);
        setSearchNote(
          json.error
            ? "OneMap is not answering right now — try again in a moment."
            : (json.results ?? []).length === 0 && postal
              ? `No Singapore address at postal code ${postal}.`
              : null,
        );
      } catch {
        setHits([]);
        setSearchNote("Could not reach the address lookup.");
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [query]);

  const choose = useCallback((h: AddressHit) => {
    setPoint({ lat: h.lat, lng: h.lng });
    setLabel(h.building ?? withoutPostal(h.address));
    setPostal(h.postal);
    setAddress({ blockNo: h.blockNo, street: h.road, postal: h.postal });
    setFace(undefined);
    setWindowAt(null);
    setQuery("");
    setHits([]);
    setSearchNote(null);
  }, []);

  const goHome = useCallback(() => {
    setPoint(START.point);
    setLabel(START.label);
    setPostal(START.postal);
    setAddress(START.address);
    setFace(undefined);
    setWindowAt(null);
    setQuery("");
    setHits([]);
    setSearchNote(null);
  }, []);

  const host = result?.host ?? null;
  const storeys = host?.levels ?? (host ? Math.round((host.height - 4) / 3) : null);
  const maxFloor = Math.max(storeys ?? 25, 4);
  const sides = useMemo(() => groupSides(host?.faces ?? []), [host]);

  // The storey someone picked on a 30-storey tower has to be read back down when
  // the next block is four storeys tall, or the analysis quietly runs at an eye
  // height above the roof while the slider shows the top floor. Clamping here
  // rather than in `floor` itself keeps their choice: go back to a tall block and
  // the storey they were looking at is still there.
  const activeFloor = Math.min(floor, maxFloor);
  const askedFloor = Math.min(runFloor, maxFloor);

  /** Move the handle. Only a keystroke commits straight away; a drag waits. */
  const changeFloor = (v: number) => {
    floorRef.current = v;
    setFloor(v);
    if (!scrubbing.current) setRunFloor(v);
  };
  /** The finger has lifted, so now the question is worth asking. */
  const commitFloor = () => {
    scrubbing.current = false;
    setRunFloor(floorRef.current);
  };

  /*
   * One committed change, one request. There is no debounce: everything that
   * reaches this effect is already a finished gesture — a dropped pin, a
   * released slider, a chosen side — so waiting out a timer only adds lag to an
   * answer that already takes a second. Anything still in flight is aborted, so
   * at most one request exists at a time and the newest one always wins.
   */
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/analyse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...point, address, floor: askedFloor, face, window: windowAt }),
          signal: abort.signal,
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Analysis failed");
        setResult(json as AnalysisResult);
        setBusy(false);
      } catch (err) {
        // An abort is this effect being superseded, not a failure: the run that
        // replaced it owns `busy` and `error` now.
        if (abort.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Analysis failed");
        setBusy(false);
      }
    })();
    return () => abort.abort();
  }, [point, address, askedFloor, face, windowAt]);

  return (
    <main className="page">
      <div className="masthead">
        <h1>Homing</h1>
        <span className="tag">prototype</span>
      </div>
      <p className="lede">
        How much sun a flat gets, and what blocks its view.
      </p>

      <div className="search-row">
      <div className="search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // A postal code is unambiguous, so Enter should just go there.
            if (e.key === "Enter" && hits.length > 0) choose(hits[0]);
          }}
          placeholder="Postal code or address — try 560406"
          inputMode="text"
          aria-label="Search by postal code or address"
        />
        {hits.length > 0 && (
          <div className="results">
            {hits.map((h) => (
              <button key={`${h.address}-${h.lat}`} onClick={() => choose(h)}>
                <div className="addr">{h.building ?? withoutPostal(h.address)}</div>
                <div className="sub">
                  {h.postal && <span className="postal">{h.postal}</span>}
                  {withoutPostal(h.address)}
                </div>
              </button>
            ))}
          </div>
        )}
        {searchNote && <div className="search-note">{searchNote}</div>}
      </div>
        <button className="go-home" type="button" onClick={goHome}>Go home</button>
      </div>

      <div className="summary-grid">
        <div className="summary-stack">
          <section className="card unit-card">
            <h2>The unit</h2>
            <div className="unit-name">{label}</div>
            <div className="hint" style={{ marginBottom: 18 }}>
              {postal && <span className="postal">{postal}</span>}
              {/* A gap drawn in CSS is not a gap to a screen reader or to
                  anyone copying the line, and these two run together without it. */}
              {postal && " "}
              {host
                ? `${storeys} storeys${host.levels === null ? ", estimated" : ""}`
                : result
                  ? "no building mapped near this address"
                  : "looking up the neighbourhood"}
            </div>
            {result && host && host.matchedBy === "nearest" && host.distanceFromPin > 25 && (
              <div className="hint" style={{ marginBottom: 18 }}>
                OpenStreetMap has no footprint at this address, so this is the nearest block,{" "}
                {host.distanceFromPin} m away. Click the right one on the plan if it is not this.
              </div>
            )}
            {result && !host && (
              <div className="hint" style={{ marginBottom: 18 }}>
                The sun is still worked out for this spot, but with no block to stand in the window
                is treated as free-standing at storey {activeFloor}.
              </div>
            )}

            <div className="control">
              <label htmlFor="floor">
                <span>Storey</span>
                <span>{activeFloor} of {maxFloor}</span>
              </label>
              {/* A range input captures the pointer for the length of a drag, so
                  losing that capture is the one reliable "the finger has lifted". */}
              <input id="floor" type="range" min={1} max={maxFloor} value={activeFloor}
                onChange={(e) => changeFloor(Number(e.target.value))}
                onPointerDown={() => { scrubbing.current = true; }}
                onLostPointerCapture={commitFloor}
                onPointerUp={commitFloor}
                onPointerCancel={commitFloor}
                onKeyUp={commitFloor}
                onBlur={commitFloor} />
            </div>

            {sides.length > 0 && (
              <div className="control">
                <label><span>Which side are your windows on?</span></label>
                <div className="sides">
                  {sides.map((s) => (
                    <button key={s.index} aria-pressed={result?.viewpoint.face === s.index}
                      disabled={busy}
                      onClick={() => { setFace(s.index); setWindowAt(null); }}>
                      <b>{compassName(s.facing)}</b>
                      <span>Facing {Math.round(s.facing)}°</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {result ? <ScoreCard result={result} /> : <section className="card verdict-loading"><h2>Verdict</h2><p className="hint">Working out the daylight, afternoon warmth and openness of this unit.</p></section>}
        </div>

          <section className="card plan-card">
            <h2>Sun and shadow</h2>
            {error && <div className="state error">{error}</div>}
            {!error && !result && (
              <div className="state">
                Loading the neighbourhood.
                <br />
                A new area can take a minute or two.
              </div>
            )}
            {result && (
              <>
                <PlanMap result={result} timeMinutes={timeMinutes} day={season}
                  windowAt={windowAt} busy={busy}
                  onPlaceWindow={(p) => { setWindowAt(p); setFace(undefined); }} />
                <div className="scrub">
                  <span className="time">{clockLabel(timeMinutes)}</span>
                  <input id="time" type="range" min={7 * 60} max={19 * 60} step={10}
                    value={timeMinutes} onChange={(e) => setTimeMinutes(Number(e.target.value))}
                    aria-label="Time of day" aria-valuetext={clockLabel(timeMinutes)} />
                  <div className="compass-row">
                    {SEASONS.map((s) => (
                      <button key={s.label} aria-pressed={season.label === s.label} onClick={() => setSeason(s)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="fig-caption" aria-live="polite">
                  {busy ? (
                    <span className="working">Working out the answer for this window…</span>
                  ) : (
                    <>Drag the red dot to your unit. The red fan shows the view from that window. Dashed rooflines are estimated heights.</>
                  )}
                </p>
              </>
            )}
          </section>
      </div>

      {result && (
        <details className="workings">
          <summary>Show the workings</summary>

          <div className="figs">
            <section className="card">
              <h2>How open is your view?</h2>
              <SkyDome result={result} />
              <p className="fig-caption">
                A simple front-on slice of what is in front of this window. The skyline is made from nearby buildings.
              </p>
            </section>

            <section className="card">
              <h2>Sun on this wall</h2>
              <YearChart sun={result.sun} />
              <p className="fig-caption">
                Daily average, by month. On the equator a wall can swing from all-day sun in
                December to none in June.
              </p>
            </section>
          </div>

          <section className="card">
            <h2>Measurements</h2>
            <p className="hint compact-hint">Optional detail, for when you want the raw numbers.</p>
            <div className="measurement-groups">
              <details className="measurement-group">
                <summary>Nerd out: sun</summary>
                <div className="stats">
                  <Stat k="Sun on this wall" v={result.sun.meanFacadeHoursPerDay.toFixed(1)} u="h/day" />
                  <Stat k="Sun after 2pm" v={formatMinutes(Math.round(result.sun.meanAfternoonMinutes))} />
                  <Stat k="Heat on this wall" v={result.sun.facadeIrradiationKwh.toFixed(2)} u="kWh/m²/day" />
                  <Stat k="Heat after 2pm" v={result.sun.afternoonIrradiationKwh.toFixed(2)} u="kWh/m²/day" />
                </div>
              </details>
              <details className="measurement-group">
                <summary>Nerd out: sky and view</summary>
                <div className="stats">
                  <Stat k="Widest clear view" v={`${result.blockage.openArcDegrees}°`}
                    u={result.blockage.openArcDegrees > 0 ? compassName(result.blockage.openArcBearing) : undefined} />
                  <Stat k="Wall straight ahead"
                    v={Number.isFinite(result.blockage.distanceAhead) ? `${Math.round(result.blockage.distanceAhead)} m` : "clear"}
                    u={result.blockage.elevationAhead > 0.5 ? `${Math.round(result.blockage.elevationAhead)}° up` : undefined} />
                </div>
              </details>
            </div>
          </section>

          {result.blockage.blockers.length > 0 && (
            <section className="card">
              <h2>What is in the way</h2>
              {result.blockage.blockers.map((b) => (
                <Datum
                  key={b.id}
                  what={b.label}
                  where={`${Math.round(b.distance)} m ${relative(b.bearing, result.viewpoint.facing)} · ${loomsLike(b.elevation)}`}
                  amount={share(b.arcDegrees)}
                  note="of your view"
                />
              ))}
            </section>
          )}

          {result.outlook && (result.outlook.knownDegrees > 0 || result.outlook.durableForegroundDegrees > 0) && <OutlookStory result={result} />}

          {result.noise && (
            <section className="card">
              <h2>Industry nearby</h2>
              <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
                <strong>{result.noise.quiet} out of 100</strong> for how clear this window is of
                industry — higher is quieter. Traffic, trains and planes are not counted yet, so
                this is not the whole noise picture.
              </p>
              {result.noise.sources.length > 0 ? (
                <div className="noise-groups">
                  {groupNoiseSources(result.noise.sources).map((group) => (
                    <div className="noise-group" key={`${group.use}-${group.status}`}>
                      <strong>{group.count > 1 ? `${group.count} × ` : ""}{plainUse(group.use)}</strong>
                      <span>{group.closest} m {relative(group.bearing, result.viewpoint.facing)}</span>
                      <small>{group.status}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="hint">Nothing industrial within {result.noise.reachM} m.</p>
              )}
            </section>
          )}

        </details>
      )}

      <p className="footnote">
        <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)
        and <a href="https://www.onemap.gov.sg/">OneMap</a>. Nobody pays for this answer. Your
        window is placed mid-wall; ground is assumed flat; balconies and trees are not modelled.
        A prototype, not advice.
      </p>
    </main>
  );
}

/** The scrubbed time, as a clock reads it. */
function clockLabel(minutes: number) {
  const h24 = Math.floor(minutes / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(minutes % 60).padStart(2, "0")}${h24 < 12 ? "am" : "pm"}`;
}

/** Where a building's height came from, said plainly. */
const HEIGHT_SOURCE = {
  "hdb-register": "HDB register",
  "height-tag": "measured",
  "levels-tag": "from storeys",
  inferred: "estimated",
} as const;

/** One finding, read as a sentence with its number on the end. */
function Datum({ what, where, amount, note }: { what: string; where: string; amount: string; note?: string }) {
  return (
    <div className="datum">
      <div>
        <div className="what">{what}</div>
        <div className="where">{where}</div>
      </div>
      <div className="amount">
        {amount}
        {note && <small>{note}</small>}
      </div>
    </div>
  );
}

/** A visual first answer to the question of whether an outlook is permanent. */
function OutlookStory({ result }: { result: AnalysisResult }) {
  const outlook = result.outlook!;
  const water = outlook.durableForegrounds.find((foreground) => foreground.label === "Water");
  const protectedPct = Math.round((outlook.protectedDegrees / 181) * 100);
  const shown = outlook.zones
    .filter((z) => !outlook.protectors.some((p) => sameThing(p.label, z.use)))
    .slice(0, 4);

  return (
    <section className="card outlook-card">
      <h2>Will the view last?</h2>
      <div className="outlook-story">
        <div className="outlook-status">{water ? "Water ahead" : "No lasting foreground"}</div>
        <p>
          {water
            ? `Water begins about ${water.distance} m away. It keeps this part of the foreground open, although buildings on the far shore could still change the skyline.`
            : "There is no water or other durable open foreground in this view. Nearby land does not have enough published height data to guarantee the skyline."}
        </p>
      </div>
      <details className="outlook-details">
        <summary>See the planning detail</summary>
        <p className="hint outlook-explainer">
          {protectedPct > 0
            ? `${protectedPct}% of the full forward view has a documented low-height corridor all the way to 200 m.`
            : "No part of the full 200 m skyline corridor has a documented low-height limit."}
        </p>
        {outlook.protectors.map((p) => (
          <Datum
            key={p.label}
            what={sentence(p.label)}
            where={`${p.distance} m ${relative(p.bearing, result.viewpoint.facing)} · nothing can be built here`}
            amount={share(p.arcDegrees)}
            note="of your view"
          />
        ))}
        {shown.map((z) => (
          <Datum
            key={`${z.use}|${z.gpr}`}
            what={plainUse(z.use)}
            where={`${z.distance} m ${relative(z.bearing, result.viewpoint.facing)}`}
            amount={share(z.arcDegrees)}
            note="of your view"
          />
        ))}
      </details>
    </section>
  );
}

type NoiseSource = NonNullable<AnalysisResult["noise"]>["sources"][number];

function groupNoiseSources(sources: NoiseSource[]) {
  const groups = new Map<string, {
    use: string; count: number; closest: number; bearing: number; status: string;
  }>();
  for (const source of sources) {
    const status = source.shielded ? "blocked by buildings" : source.ahead ? "in view" : "behind the block";
    const key = `${source.use}|${status}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
      if (source.distance < group.closest) {
        group.closest = source.distance;
        group.bearing = source.bearing;
      }
    } else {
      groups.set(key, { use: source.use, count: 1, closest: source.distance, bearing: source.bearing, status });
    }
  }
  return [...groups.values()].sort((a, b) => a.closest - b.closest);
}

/**
 * Where something is, from where you are standing.
 *
 * A compass point is the true answer and the wrong one: nobody at a window
 * knows which way is east-south-east, and turning to check is not something a
 * drawing can ask for. What they do know is which way they are facing, so
 * everything is said relative to that.
 */
function relative(bearing: number, facing: number) {
  const off = ((((bearing - facing) % 360) + 540) % 360) - 180;
  const side = off < 0 ? "left" : "right";
  const away = Math.abs(off);
  if (away < 20) return "straight ahead";
  if (away < 65) return `ahead, to your ${side}`;
  if (away < 115) return `to your ${side}`;
  if (away < 160) return `behind you, to the ${side}`;
  return "directly behind you";
}

/** Degrees of a 181° outlook, as a share anyone can picture. */
function share(degrees: number) {
  const pct = Math.round((degrees / 181) * 100);
  return pct < 1 ? "a sliver" : `${pct}%`;
}

/**
 * How high something looms, in words. An elevation angle is the honest number
 * and means nothing to a reader: 46° is not "46 degrees" to anybody standing
 * at a window, it is a wall filling everything they can see.
 */
function loomsLike(elevation: number) {
  if (elevation < 10) return "low on the skyline";
  if (elevation < 25) return "across the lower view";
  if (elevation < 45) return "high up";
  return "towers over you";
}

/**
 * Zoning classes in the words people use for them.
 *
 * "BUSINESS 2" is what the Master Plan calls heavy industry and it is what the
 * plan should be cited as saying — but nobody reading about a flat knows that
 * Business 2 is a foundry and Business 1 is a print shop, and a reader who has
 * to learn a planning code before they can read their own report has been sent
 * away to do homework.
 */
const PLAIN_USE: Record<string, string> = {
  "BUSINESS 1": "Light industry",
  "BUSINESS 2": "Heavy industry",
  "BUSINESS 1 - WHITE": "Light industry",
  "BUSINESS 2 - WHITE": "Heavy industry",
  "BUSINESS PARK": "Business park",
  "TRANSPORT FACILITIES": "Bus or rail depot",
  UTILITY: "Utilities",
  "MASS RAPID TRANSIT": "MRT line or station",
  "PORT / AIRPORT": "Port or airport",
  "RESIDENTIAL WITH COMMERCIAL AT 1ST STOREY": "Flats with shops below",
  "COMMERCIAL & RESIDENTIAL": "Shops and flats",
  "CIVIC & COMMUNITY INSTITUTION": "Community building",
  "EDUCATIONAL INSTITUTION": "School",
  "HEALTH & MEDICAL CARE": "Clinic or hospital",
  "PLACE OF WORSHIP": "Place of worship",
  "SPORTS & RECREATION": "Sports ground",
  "OPEN SPACE": "Open space",
  WATERBODY: "Water",
  "RESERVE SITE": "Reserved land, use undecided",
};

function plainUse(use: string) {
  return PLAIN_USE[use] ?? use.charAt(0) + use.slice(1).toLowerCase();
}

/** A protector and a zone naming the same ground should not be listed twice. */
function sameThing(protector: string, use: string) {
  return protector.toLowerCase().startsWith(use.toLowerCase().split(" ")[0]);
}

/** A label from the plan, with a capital on the front. */
function sentence(label: string) {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** A plot ratio is a number, or one of the plan's codes for having none. */
function ratioLabel(gpr: string) {
  if (/^[\d.]+$/.test(gpr)) return gpr;
  if (gpr === "EVA") return "not published";
  if (gpr === "SDP") return "detailed planning";
  return gpr || "—";
}

/** OneMap ends every address with the postal code, which is shown beside it. */
function withoutPostal(address: string) {
  return address.replace(/\s*singapore\s*\d{6}\s*$/i, "");
}

interface Side {
  index: number;
  facing: number;
  length: number;
}

/**
 * A slab block notched by lift lobbies shows up as several walls pointing the
 * same way. To someone choosing a unit that is one side of the building, so
 * they are shown as one, keyed to the longest of them.
 */
function groupSides(faces: { facing: number; length: number }[]): Side[] {
  const groups: Side[] = [];

  faces.forEach((f, index) => {
    const match = groups.find((g) => {
      const d = Math.abs(((g.facing - f.facing + 540) % 360) - 180);
      return d < 25;
    });
    if (match) match.length += f.length;
    else groups.push({ index, facing: f.facing, length: f.length });
  });

  return groups.filter((g) => g.length >= 15).slice(0, 4);
}

/** How far the block is turned from the cardinal grid, in degrees. */
function gridOffset(facing: number) {
  const off = ((facing % 90) + 90) % 90;
  return Math.round(off > 45 ? 90 - off : off);
}

function Stat({ k, v, u }: { k: string; v: string; u?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">
        {v} {u && <small>{u}</small>}
      </div>
    </div>
  );
}
