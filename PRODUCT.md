# Homing — product notes

## The gap

Singapore has unusually good open data about its buildings and unusually bad
information about individual homes. Every consumer-facing property service is
funded by the people selling the property:

| Service | What it scores | Funded by |
|---|---|---|
| PropertyGuru, 99.co, Ohmyhome | listings, valuations | agents, developers, listings |
| StackedHomes | editorial reviews of launches | developers, ads |
| PropertyNet.SG | 100-point score, but purely financial (price vs comps, lease, yield) | subscriptions |
| BCA Quality Housing Portal | CONQUAS build quality, developer level, new builds only | government |
| BTO Analysis, Compass Overlay | afternoon sun, BTO or stack level only | hobby projects |
| VibeHood | walkability to MRT, hawker, schools | hobby project |

Nobody scores a *unit* on liveability, neutrally, across factors. The closest
things are single-factor hobby tools that stop where the interesting part starts.

## Why start with sun and blockage

Of the factors a buyer cares about — sunlight, blockage, noise, facilities,
build quality, future development — sun and blockage are the ones that are:

- **Expensive to get wrong.** You cannot fix a west-facing living room, and you
  cannot fix a block built 30 m from your window.
- **Impossible to judge from a viewing.** You see the unit at one hour, on one
  day, in one season. At the equator a facade can swing from all-day sun in
  December to none in June.
- **Systematically misrepresented.** Nobody selling a unit volunteers that it
  bakes from 3pm.
- **Fully computable from open data**, with no proprietary inputs and nothing to
  train — which is exactly what makes the result defensible.

Amenity proximity, by contrast, is already served, and noise needs modelling work
plus datasets that are less clean.

## Neutrality as the product

The score is only worth anything if the reader believes it is not for sale. That
constrains the business model before it constrains the code:

- Every number traces to geometry and an ephemeris. Nothing is fitted to prices.
- The weights are published and arguable. The reference values they are measured
  against are reproducible with `npm run calibrate`.
- Uncertainty is reported, not hidden: the output states what share of the view
  blocking *your* window rests on an inferred building height.
- The limitations list in the README is part of the product, not an apology.

Taking agent or developer money would end all of that. Viable instead:

- **Freemium** — block-level score free, unit-level report paid.
- **One-off reports**, roughly $20–30 for a unit you are about to bid on.
- **Subscription** for buyers actively hunting, who will check dozens of units.

## Keeping it readable

A neutral score is worthless if nobody can read it. The default view answers one
question — is this a good unit, and why — with a number, three bars, two
sentences and a plan. Every measurement, the sky dome, the blocker table and the
confidence report sit behind one "show the workings" toggle. They are what make
the score checkable, but they are not what a buyer opens the page for.

## What to build next, in order

1. ~~**Future blockage.**~~ **Partly done, and the framing turned out to be
   backwards.** The sentence this was meant to produce — "your unblocked west
   view is zoned for a 30-storey residential plot" — cannot be derived: a plot
   ratio sets floor area, not height, and measuring what is already built
   against what is allowed put 76% of HDB parcels over their own limit, because
   neither the footprint nor the parcel boundary means what that sum needs it to
   mean. What the plan does support is the opposite and better claim. Road
   reserves, water, parks, landed housing envelopes and explicit height controls
   are ceilings, and where they cover a window's outlook that part of the view
   is safe for good. 21% of HDB blocks have one within 300 m. "Nobody can build
   this out" is a promise; "something might go up" was only ever a worry.
2. ~~**Better heights.**~~ **Done.** HDB Property Information carries
   `max_floor_lvl` per block and HDB Existing Building carries the footprints;
   joined, they replace both inference and OpenStreetMap for every HDB block in
   the country, and make the postal code an exact match to a footprint rather
   than a nearest-thing guess. The join was the work: the two registers share
   no key, and the street code on a footprint is not decodable — `CHA` is both
   Choa Chu Kang Ave and Chai Chee Ave — so the table is resolved a street code
   at a time out of OneMap rather than guessed at.
3. **Noise.** Changi and Seletar flight corridors, LTA's road network weighted by
   class, above-ground MRT alignments, and coffeeshops and bin centres from OSM.
   The other factor no one measures and everyone complains about after moving in.
4. **Floor plans, for real windows.** Today the window is the middle of a chosen
   face. HDB publishes block floor plans and URA holds approved plans for private
   developments, but both are drawings behind a login rather than data. Getting
   per-stack window positions means acquiring and vectorising them block by
   block — expensive, and precisely why nobody has done it. It is also the step
   that turns "this side of the block" into "unit #08-114".
5. **Stack comparison.** Score every stack and storey in a block at once and rank
   them. This is the shape a buyer actually wants: not "is unit X good" but
   "which unit in this block should I be bidding on".
6. **Multipolygon buildings and terrain**, to stop being wrong in the places the
   README currently admits to.
