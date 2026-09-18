# Homing

How much sun a Singapore flat actually gets, and what is standing in front of it.

A prototype of the two factors nobody in the Singapore property market currently
measures neutrally: **direct sunlight** on a specific unit, and **blockage** of its
view and sky. Everything is computed from open data and the real position of the
sun. No listings, no agents, no developer input, nothing to sell.

```bash
npm install
npm run dev          # http://localhost:3000
npm run analyse -- 560406 --floor 8
```

The datasets in `data/` are committed, so nothing needs building to run this.
`npm run build-hdb` and `npm run build-masterplan` rebuild them from source when
HDB or URA publish an update.

Any Singapore postal code works, typed however you write it — `560406`, `18956`,
`S138632`, `Singapore 609601` — as does a block and street, or a `lat,lng`.

## What it computes

Give it a postal code, pick a storey and **which side of the block** your windows
are on, and it returns:

| | |
|---|---|
| **Direct sun on the facade** | hours per day, averaged over a full year, and month by month |
| **Afternoon sun** | minutes per day after 2pm — the west-sun problem, stated in numbers |
| **Facade beam load** | kWh/m² per day, so a 4pm hour is not counted the same as an 8am one |
| **Sky view factor** | how much sky the window can see, all round and straight ahead |
| **Open arc** | the widest unbroken sightline in front, and where it points |
| **Blockers** | which blocks are in the way, how far, how high they rise, how much view they eat |
| **Will the view last** | how much of the outlook is over ground the Master Plan will not let a building rise on |
| **Industry nearby** | what is zoned for industry and infrastructure within 800 m, and whether anything stands between |

Three 0–100 scores — daylight, afternoon heat, openness — and one headline. The
weights and the reference values they are measured against are in
[`src/lib/score.ts`](src/lib/score.ts), stated openly so you can disagree with
them rather than having to take a number on trust.

The same block, same storey, the two sides of the slab:

```
406 Ang Mo Kio Ave 10, floor 8 — SSW side (200°)
  Overall 42/100    light 39   stays cool  59   open view 31
  2h 09m of direct sun after 2pm, carrying 0.77 of its 0.86 kWh/m² day

406 Ang Mo Kio Ave 10, floor 8 — NNE side (21°)
  Overall 94/100    light 94   stays cool  91   open view 97
  1h 13m after 2pm, but only 0.11 of its 1.22 kWh/m² — June sunset, grazing
```

Two windows in one block, on the same floor, back to back. Note what the
second pair of numbers is for: both sides take afternoon sun, and counting
minutes would call them similar. The energy says otherwise. What reaches the
north-east wall is the last of a June sun setting round at 292°, striking the
wall almost edge-on; what reaches the south-west wall is the real thing.

## Facing is a property of the block, not the compass

A window does not face due east because you picked "east" off a compass rose. It
faces whichever way its wall points, and Blk 406 sits 21° off the grid — so no
unit in it faces east, west, north or south, and never will.

So the app derives the block's **actual faces** from its footprint: it walks the
outline, merges walls pointing within 18° of each other, and offers those as the
choice. Picking one moves the window to the middle of that wall and takes its
true bearing. Blk 406 comes back as two long sides, 95 m at 21° and 94 m at
200°, and three short ends.

Getting that from HDB's own outlines took more than merging by angle. HDB draws
what it built: every balcony return, every window reveal, and the lift and stair
cores standing six or eight metres proud of the corridor side. Merging only
walls that follow one another put Blk 406's front in seventeen pieces, none
wider than 23 m, and offered seventeen sides of a building that has two. So runs
of wall that point the same way **and stand in the same plane** are read as one
side, however much is drawn between them. Standing in the same plane is what
keeps that honest: the two wings of a C-shaped condominium also point the same
way, but they are tens of metres apart and which one you are on changes the
answer, so they stay separate.

Where in that wall your unit actually sits — corner stack or middle stack, which
room the window belongs to — needs a floor plan. HDB and URA publish those per
block, but as drawings behind a login, not as data, so there is no open source to
wire up. Until one exists, the middle of the chosen side is the honest
approximation, and the app says so.

## Finding the right block

A postal code names one building in Singapore, which makes it the shortest way
to ask about a home — but the point OneMap returns is the address's *registered*
location, and for a large development that is the gate or the management office,
not the tower. Snapping to the nearest footprint gets the building next door.

For an HDB block there is now nothing to infer. HDB files a postal code against
every block it has built, so the footprint is simply looked up by it: an exact
match, for four in five homes in the country, and the end of the guardhouse
problem for all of them.

Everywhere else the old reasoning still applies, in descending order of what the
evidence is worth. The block number and street ride along with the pin, and the
footprint carrying them wins over whatever the pin happens to be standing on.
One address is often several footprints — the tower, plus the guardhouse and the
bin centre tagged with the same number — so the largest residential one is
taken. Where no footprint matches, the result says whether the block was the one
the pin stands in or merely the nearest, and how far away it was, rather than
quietly answering for a different building. Which of the four rules fired is
reported either way.

## How it works

1. **Footprints and heights** come from whichever source actually knows.

   HDB publishes the outline of every one of its 13,436 blocks, and publishes
   separately the highest storey in each of them. Between those two registers,
   the shape and the height of the building four in five Singaporeans live in
   are a matter of record rather than a guess. `npm run build-hdb` joins them
   into `data/hdb-blocks.json.gz` — 13,213 of the 13,436, or 98.3%.

   The join is the awkward part, and the script says why at length. The short
   version: the two registers share no key, the six-character street code on a
   footprint is not decodable into a street name, and guessing at it would put
   a wrong storey count on a block without anything looking wrong. So the codes
   are resolved out of OneMap's gazetteer, one lookup per code, and the blocks
   that still do not place are resolved one at a time.

   Everything else — private condominiums, shophouses, offices, the industrial
   estates — comes from OpenStreetMap via Overpass, 600 m around the pin,
   cached on disk for a fortnight. Those heights come from a `height` tag where
   one exists, else `building:levels` times a floor-to-floor height for that
   building type plus roof plant, else the median of tagged buildings with a
   comparable footprint — a 1,300 m² slab is sized against the slab next door,
   not against the estate's bin centres. Which of the four sources applied is
   carried through to the output, per building.

   OSM maps HDB blocks too, so the two overlap. Where both describe the same
   building, HDB's record wins and the OSM copy is dropped.

2. **The window** is placed on one of the block's derived faces — the one nearest
   the pin unless you pick another — 0.6 m clear of the wall, at
   `(storey − 1) × floor height + 1.5 m`. The wall's outward normal is the
   direction it faces. Your own block stays in the model, so it correctly blocks
   everything behind you: a mid-floor window on a slab sees about half the sky,
   not all of it.
3. **The skyline** is a ray cast at every degree of the compass: for each, the
   nearest edge that rises above eye level, and the angle it subtends. 360 rays
   against a few hundred buildings, in about 40 ms.
4. **The sun** is the NOAA solar position algorithm, stepped every five minutes
   of every day of a year. A sample counts when it clears the skyline in its
   direction *and* falls on the front of the facade. Energy is weighted by an
   ASHRAE clear-sky beam model, so heat load reflects when the sun is up, not
   just how long.
5. **The Master Plan** is read over the same ground. For each degree of the
   window's outlook, the land out to 200 m is walked and asked what may be
   built on it: a road reserve, a reservoir or a park cannot take a tower, a
   landed housing area carries a two or three storey envelope, and some areas
   carry a published storey or metre ceiling outright. Where every metre of a
   direction is capped low enough that nothing there could rise into this view,
   that direction is reported as protected. Most of Singapore is zoned by plot
   ratio instead, which sets floor area rather than height, and those degrees
   are counted as unknown rather than guessed at. The same layer names the
   zoned industry within 800 m, which the ray cast then tests for shielding.
6. **Scores** are computed from those measurements against reference values
   established by running the same engine on an unobstructed site
   (`npm run calibrate`).

Nothing is fitted, trained, or tuned against sale prices. Every number traces
back to geometry and an ephemeris.

## Checks

`npm run calibrate` runs the engine with no buildings and prints the results:

- Sky view factor 1.000, open arc 180° — the sky is fully visible when nothing is in it.
- Every orientation gets ~6.0 h/day of direct sun, as it must on the equator.
- A due-east facade gets 0 minutes after 2pm; a due-west one gets 310.
- 21 Jun 13:00 SGT: sun 67.9° up, bearing 4° — north, as it should be in June.
- 21 Dec 13:00 SGT: sun 65.2° up, bearing 179° — south.
- 21 Jun 07:00 SGT: sun on the horizon, bearing 67°, matching the almanac's ~07:00 sunrise.

## What it does not model yet

Stated plainly, because a score that hides its gaps is worse than no score:

- **Terrain is flat.** Fine across an HDB estate, wrong on a slope.
- **Only simple footprints.** Buildings mapped in OSM as multipolygon relations —
  some malls and larger condos — are skipped entirely.
- **No balconies, fins, overhangs or trees**, all of which shade real windows.
- **Future blockage is only half answered.** The plan gives a real ceiling for
  road reserves, water, parks, landed housing and the areas under explicit
  height control — about a third of a typical outlook. The rest is zoned by
  plot ratio, and a plot ratio is not a height: site coverage across Singapore's
  housing estates runs from 0.20 to 0.37, so a ratio of 2.8 means anything from
  eight storeys to fourteen. Those degrees are reported as unpublished rather
  than turned into a number.
- **Comparing what is built against what is allowed does not work**, and the
  attempt is instructive. Dividing floor area by site area put 76% of HDB
  parcels over their own permitted ratio, because a footprint includes the void
  deck apron that the tower above does not, and because a plan parcel often
  excludes the open space the estate actually stands on. So there is no
  "this plot could still take another 40%" here, and there should not be.
- **The industry figure is not a noise level.** Singapore publishes no noise
  map and no open per-road traffic count. Roads, rail and aircraft are the
  loudest things in most homes here and none of them are in it, so it is scored
  on its own rather than folded into the headline.
- **Heights are still inferred for private blocks.** HDB's register covers its
  own blocks and nothing else, so a neighbourhood of condominiums is as
  uncertain as it ever was. The output reports what share of *your* blocked
  view rests on a guess, and around a typical HDB address about half the
  buildings in the extract now come from the register instead.
- **223 HDB blocks have no storey count**, of 13,436. Nearly all stand on roads
  the property register does not list, because it records blocks of flats:
  HDB's landed terraces at Pasir Ris are absent by design, and the estates
  cleared under SERS at Commonwealth and Saint George's have outlived their
  entries in it. Those blocks fall back to an inferred height, as before.
- **A block is its ground-floor outline, extruded.** Where a tower stands on a
  wider void deck, the whole apron is taken up to roof height, so the block is
  modelled slightly too fat. Both sources trace the outline the same way, so
  this is not new, but it is visible now: about one residential block in a
  hundred has a footprint more than twice what its flats per floor imply.
- **Diffuse light is approximated** by sky view factor rather than modelled.
- **No floor plans**, so the window is placed at the middle of the chosen side.
  A corner unit and a middle-stack unit on the same face get the same answer.
- **Which side the pin defaults to can flip** if the address point sits near the
  block's centreline. It always lands on a real side; pick the other with one click.

## Sources

- Land use zoning and plot ratios — [Master Plan 2025 Land Use layer](https://data.gov.sg/datasets/d_a8c3546b26712e35021f3a681d0353ae/view), Urban Redevelopment Authority, via data.gov.sg, Open Data Licence
- Permitted storeys on landed housing — [Master Plan 2025 SDCP Landed Housing Area layer](https://data.gov.sg/datasets/d_70a5a4b67d9171dc0db6f6fd259a3215/view), same source and licence
- Published height ceilings — [Master Plan 2019 SDCP Building Height Control layer](https://data.gov.sg/datasets/d_ee8e2e0d13a50a699f9100029b8c0b0a/view); the 2025 edition publishes these only as map annotations with no polygon attached, so this one layer is an edition behind
- Gazetted monuments — [Master Plan 2025 Monument Building and Site layer](https://data.gov.sg/datasets/d_4b1c160040f9c9309be12b2fed5e6395/view)
- HDB block footprints — [HDB Existing Building](https://data.gov.sg/datasets/d_16b157c52ed637edd6ba1232e026258d/view), Housing & Development Board, via data.gov.sg, Open Data Licence
- HDB storey counts, completion years and unit counts — [HDB Property Information](https://data.gov.sg/datasets/d_17f5382f26140b1fdae0ba2ef6239d2f/view), same source and licence
- All other building footprints and storey counts — [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL, via [Overpass API](https://overpass-api.de/)
- Addresses and coordinates — [OneMap](https://www.onemap.gov.sg/), Singapore Land Authority
- Solar position — NOAA Solar Calculator equations (Meeus, *Astronomical Algorithms*)
- Clear-sky beam irradiance — ASHRAE clear-sky model

## Layout

```
src/lib/postal.ts      postal codes as people type them
src/lib/onemap.ts      address and postal code lookup, cached
src/lib/cache.ts       disk cache for both upstream services
src/lib/hdb.ts         HDB's own blocks: footprints, storeys, spatial index
src/lib/masterplan.ts  URA zoning and published height ceilings, spatial index
src/lib/outlook.ts     whether the view can be built out
src/lib/noise.ts       zoned industry near the window, and what shields it
src/lib/street.ts      road names as three gazetteers spell them
src/lib/solar.ts       sun position and clear-sky irradiance
src/lib/geo.ts         local projection, polygon maths, facade snapping
src/lib/buildings.ts   Overpass fetch, height resolution, caching
src/lib/horizon.ts     the ray cast
src/lib/sun.ts         the year-long exposure simulation
src/lib/blockage.ts    sky view factor, open arcs, ranked blockers
src/lib/score.ts       measurements to 0-100, and the notes
src/lib/analyse.ts     puts it together
scripts/analyse.ts     CLI report
scripts/calibrate.ts   reference values and sanity checks
scripts/build-hdb.ts   joins HDB's two registers into data/hdb-blocks.json.gz
scripts/build-masterplan.ts  URA zoning and ceilings into data/masterplan.json.gz
```

A prototype, not advice.
