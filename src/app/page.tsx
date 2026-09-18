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
  // Which result the arrow keys are on. A fresh set of hits starts on the
  // first, because that is the one Enter has always taken.
  const [active, setActive] = useState(0);
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
        setActive(0);
        setSearchNote(
          json.error
            ? "OneMap is not answering right now — try again in a moment."
            : (json.results ?? []).length === 0 && postal
              ? `No Singapore address at postal code ${postal}.`
              : null,
        );
      } catch {
        setHits([]);
        setActive(0);
        setSearchNote("Could not reach the address lookup.");
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [query]);

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

  /**
   * The button beside the box. With something typed it loads that address —
   * the suggestion list is there to be read, not to be clicked through — and
   * it asks OneMap itself rather than waiting on the list, so a code typed and
   * submitted inside the debounce still goes somewhere.
   */
  const submit = useCallback(async () => {
    const q = query.trim();
    if (!q) return goHome();
    if (hits.length > 0) return choose(hits[active] ?? hits[0]);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const json = (await res.json()) as { results: AddressHit[]; error?: string };
      const hit = (json.results ?? [])[0];
      if (hit) return choose(hit);
      setSearchNote(
        json.error
          ? "OneMap is not answering right now — try again in a moment."
          : `Nothing found for "${q}".`,
      );
    } catch {
      setSearchNote("Could not reach the address lookup.");
    }
  }, [query, hits, active, choose, goHome]);

  const host = result?.host ?? null;
  // A launched BTO has no building yet, so `host` is null — but its storeys are
  // announced, which is better evidence than anything inferred from a footprint.
  const bto = result?.bto ?? null;
  const storeys = host?.levels ?? (host ? Math.round((host.height - 4) / 3) : (bto?.storeys ?? null));
  // 25 is the last resort for a pin with no building and no launch under it: a
  // slider has to stop somewhere, and it is not a claim about this address.
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
      </div>
      <p className="lede">
        How much sun a house gets, and what blocks its view.
      </p>

      <div className="search-row">
      {/* A list that only closes when it is chosen from is a list that sits over
          the page. Leaving the field at all — clicking away, or tabbing past the
          last result — puts it away; Escape does too, without moving focus. */}
      <div className="search" onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHits([]);
      }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setHits([]); return; }
            // Enter is the button: it works whether or not the list is up yet.
            if (e.key === "Enter") { submit(); return; }
            if (hits.length === 0) return;
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            // The arrows walk the list, so the page must not scroll under them.
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
          }}
          placeholder="Postal code or address — try 560406"
          inputMode="text"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="search-results"
          aria-activedescendant={hits.length > 0 ? `hit-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Search by postal code or address"
        />
        {hits.length > 0 && (
          <div className="results" id="search-results" role="listbox">
            {hits.map((h, i) => (
              <button key={`${h.address}-${h.lat}`} id={`hit-${i}`} type="button"
                role="option" aria-selected={i === active}
                onMouseEnter={() => setActive(i)} onClick={() => choose(h)}>
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
        <button className="go-home" type="button" onClick={submit}>Go home</button>
      </div>

      <div className="summary-grid">
        <div className="summary-stack">
          <section className="card unit-card">
            <h2>The unit</h2>
            <div className="unit-name">
              {bto && <span className="bto-tag">BTO</span>}
              {bto ? bto.name : label}
            </div>
            {bto && (
              <div className="bto-line">
                Launched {monthName(bto.launch)}
                {bto.completion ? `, due ${monthName(bto.completion)}` : ""} · {bto.town}
              </div>
            )}
            <div className="hint" style={{ marginBottom: 18 }}>
              {postal && <span className="postal">{postal}</span>}
              {/* A gap drawn in CSS is not a gap to a screen reader or to
                  anyone copying the line, and these two run together without it. */}
              {postal && " "}
              {host
                ? `${storeys} storeys${host.levels === null ? ", estimated" : ""}`
                : bto
                  ? `${bto.blocks ? `${bto.blocks} blocks, ` : ""}${bto.storeysLow ? `${bto.storeysLow}–${bto.storeys}` : bto.storeys} storeys${bto.units ? `, ${bto.units.toLocaleString()} flats` : ""}`
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
            {result && !host && bto && (
              <div className="hint" style={{ marginBottom: 18 }}>
                Nothing is built here yet, so this is the sun and the skyline at storey{" "}
                {activeFloor} on this site — not in a particular block.{" "}
                {bto.blocks ? `The ${bto.blocks} blocks` : "The blocks"} are not drawn, so they do
                not yet shade each other, and the window faces north until they are.
              </div>
            )}
            {result && !host && !bto && (
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

          {result ? <ScoreCard result={result} busy={busy} /> : <section className="card verdict-loading"><h2>Verdict</h2><p className="hint">Working out the daylight, afternoon warmth and openness of this unit.</p></section>}
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
                    <>Drag the orange dot to your unit, or walk it along the wall with the Window buttons. The blue fan shows the view from that window, and the red line is the sun. Dashed rooflines are estimated heights.</>
                  )}
                </p>
                {result.ground.length > 0 && (
                  <p className="plan-key">
                    <span><i style={{ background: "var(--plan-water)" }} />Water</span>
                    <span><i style={{ background: "var(--plan-green)" }} />Park or open space</span>
                    <span><i style={{ background: "var(--plan-road)" }} />Road reserve</span>
                    <span>— the Master Plan will not let a building rise on these.</span>
                  </p>
                )}
              </>
            )}
          </section>
      </div>

      {result && (
        <details className="workings stale" data-busy={busy || undefined}>
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
                <details className="nerd-more">
                  <summary>Nerd out even more</summary>
                  <div className="stats">
                    <Stat k="Sun above the skyline" v={result.sun.meanDirectHoursPerDay.toFixed(1)} u="h/day, any direction" />
                    <Stat k="Sunniest month" v={MONTH_NAMES[extremeMonth(result.sun.monthlyFacadeHours, "max")]}
                      u={`${Math.max(...result.sun.monthlyFacadeHours).toFixed(1)} h/day`} />
                    <Stat k="Dimmest month" v={MONTH_NAMES[extremeMonth(result.sun.monthlyFacadeHours, "min")]}
                      u={`${Math.min(...result.sun.monthlyFacadeHours).toFixed(1)} h/day`} />
                    <Stat k="Afternoon share of heat"
                      v={result.sun.facadeIrradiationKwh > 0
                        ? `${Math.round((result.sun.afternoonIrradiationKwh / result.sun.facadeIrradiationKwh) * 100)}%`
                        : "—"} />
                  </div>
                </details>
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
                <details className="nerd-more">
                  <summary>Nerd out even more</summary>
                  <div className="stats">
                    <Stat k="Sky view factor" v={`${Math.round(result.blockage.skyViewFactor * 100)}%`} u="whole dome" />
                    <Stat k="Sky in front" v={`${Math.round(result.blockage.facadeSkyViewFactor * 100)}%`} u="the 180° you face" />
                    <Stat k="Blocked above 20°" v={`${Math.round(result.blockage.heavilyBlockedShare * 100)}%`} u="of that half" />
                    <Stat k="Window faces" v={`${Math.round(result.viewpoint.facing)}°`} u={compassName(result.viewpoint.facing)} />
                    <Stat k="Eye height" v={result.viewpoint.z.toFixed(1)} u="m above ground" />
                    <Stat k="Buildings considered" v={String(result.confidence.buildingsConsidered)}
                      u={`${Math.round(result.confidence.blockerHeightConfidence * 100)}% real heights`} />
                  </div>
                </details>
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

          {result.outlook && <OutlookStory result={result} />}

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
                    <div className="noise-group" key={`${group.name ?? group.use}-${group.status}`}>
                      <strong>
                        {/* A count in front of a name reads as several of them;
                            one estate mapped as six parcels is still one estate. */}
                        {!group.name && group.count > 1 ? `${group.count} × ` : ""}
                        {group.name ?? plainUse(group.use)}
                      </strong>
                      <span>{group.closest} m {relative(group.bearing, result.viewpoint.facing)}</span>
                      <small>{group.name ? `${plainUse(group.use)} · ${group.status}` : group.status}</small>
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
        and <a href="https://www.onemap.gov.sg/">OneMap</a>.
      </p>
    </main>
  );
}

/** "2026-06" as "Jun 2026". Launch and completion are only ever known to a month. */
function monthName(yyyymm: string) {
  const [year, month] = yyyymm.split("-");
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

/** The scrubbed time, as a clock reads it. */
function clockLabel(minutes: number) {
  const h24 = Math.floor(minutes / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(minutes % 60).padStart(2, "0")}${h24 < 12 ? "am" : "pm"}`;
}

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

/**
 * One number for whether this outlook is permanent, and one sentence for why.
 *
 * The share is taken over the view that is still open, not over the whole 180:
 * a window with a block already across it has nothing left to lose, and marking
 * that direction down a second time would answer a question about the future
 * with a fact about the present. The three shares behind the number stay in the
 * detail, because a reader wants to know whether the view holds — not how many
 * degrees of it the Master Plan declines to put a ceiling on.
 */
function OutlookStory({ result }: { result: AnalysisResult }) {
  const outlook = result.outlook!;
  const open = outlook.protectedDegrees + outlook.atRiskDegrees + outlook.unknownDegrees;
  const secured = open === 0 ? 0 : Math.round((outlook.protectedDegrees / open) * 100);
  const widest = outlook.protectors[0];
  const shown = outlook.zones
    .filter((z) => !outlook.protectors.some((p) => sameThing(p.label, z.use)))
    .slice(0, 4);

  return (
    <section className="card outlook-card">
      <h2>Will the view last?</h2>
      <div className="headline">
        <span className="n" style={{ color: lastingBand(outlook, open, secured) }}>
          {open === 0 ? "—" : secured}
        </span>
        <span className="of">out of 100<br />stays open</span>
      </div>
      <div className="outlook-story">
        <p>{whyItLasts(outlook, open, secured, widest)}</p>
      </div>
      <details className="outlook-details">
        <summary>See the planning detail</summary>
        <p className="hint outlook-explainer">
          {open === 0
            ? `Buildings already stand across the whole of this outlook within ${outlook.reachM} m.`
            : `Of the view still open, ${secured}% is capped all the way out to ${outlook.reachM} m, ${Math.round((outlook.atRiskDegrees / open) * 100)}% carries a ceiling high enough to build into it, and ${Math.round((outlook.unknownDegrees / open) * 100)}% has no published ceiling either way.`}
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

/**
 * Parcels rolled up into things a reader would recognise.
 *
 * Named ground groups by its name, so the six parcels of one industrial estate
 * come back as that estate rather than as "3 × Light industry". Unnamed ground
 * still groups by zoning, because that is genuinely all that is known about it.
 */
function groupNoiseSources(sources: NoiseSource[]) {
  const groups = new Map<string, {
    use: string; name: string | null; count: number; closest: number; bearing: number; status: string;
  }>();
  for (const source of sources) {
    const status = source.shielded ? "blocked by buildings" : source.ahead ? "in view" : "behind the block";
    const key = `${source.name ?? source.use}|${status}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
      if (source.distance < group.closest) {
        group.closest = source.distance;
        group.bearing = source.bearing;
      }
    } else {
      groups.set(key, {
        use: source.use, name: source.name, count: 1,
        closest: source.distance, bearing: source.bearing, status,
      });
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
/**
 * What colour a low score deserves.
 *
 * Not the verdict card's scale, deliberately. A low share here means one of two
 * opposite things: land that is allowed to be built into, or land nobody has
 * published a height for. Painting the second one red would say a view is going
 * to be lost when the honest answer is that nobody knows, so the unknown case
 * is left the colour of ordinary text and the sentence beside it does the work.
 */
function lastingBand(
  outlook: NonNullable<AnalysisResult["outlook"]>,
  open: number,
  secured: number,
) {
  if (open === 0) return "var(--muted)";
  if (secured >= 70) return "var(--good)";
  if (outlook.atRiskDegrees > outlook.protectedDegrees) return "var(--bad)";
  if (secured >= 45) return "var(--warn)";
  return "var(--muted)";
}

/**
 * Why the number is what it is, in one sentence.
 *
 * One sentence is the whole design. A reader who has just been handed a score
 * wants to know what to do with it, and the honest distinction — land that may
 * be built into, against land nobody has published a height for — survives the
 * difference between "could change" and "is allowed to". The arithmetic behind
 * it is a click away for anyone who wants to argue with it.
 */
function whyItLasts(
  outlook: NonNullable<AnalysisResult["outlook"]>,
  open: number,
  secured: number,
  widest: { label: string; distance: number } | undefined,
) {
  // No widest protector means nothing at all is capped, which is a different
  // sentence rather than the same one with a clause missing.
  const only = widest
    ? `; only the ${widest.label} ${widest.distance} m out is guaranteed`
    : ", and none of it is guaranteed";

  if (open === 0) return "Buildings already close this view — nothing left here to lose.";
  if (secured >= 50) {
    return `Most of this view is over ground nothing can be built on${widest ? ` — the ${widest.label}, ${widest.distance} m out` : ""}.`;
  }
  if (outlook.unknownDegrees >= outlook.atRiskDegrees) {
    return `No published height limit covers most of this view${only}.`;
  }
  return `Most of this view may legally be built up into${only}.`;
}

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

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Index of the brightest or dimmest month on this wall. */
function extremeMonth(hours: number[], which: "max" | "min") {
  const target = which === "max" ? Math.max(...hours) : Math.min(...hours);
  return hours.indexOf(target);
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
