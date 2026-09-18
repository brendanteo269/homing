# Homing

Homing estimates sunlight, afternoon heat, and what blocks the view from a Singapore flat. It uses open data and solar geometry, not listings, agents, or sale prices.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), search for a postal code or address, then choose a storey and window-facing side.

The included data files are enough to run the app. To refresh them from their public sources:

```bash
npm run build-hdb
npm run build-masterplan
npm run build-footprints   # needs osmium: brew install osmium-tool
```

## What it reports

- Direct sun on the chosen wall, across the year and after 2pm.
- A verdict for light, late-day warmth, and openness.
- Nearby buildings, their distance, and how much of the view they block.
- A score out of 100 for how much of the still-open view cannot be built out, and why.
- Nearby industry and infrastructure, named where OpenStreetMap names it, including whether it is shielded.

The score weights and reference values are open in [`src/lib/score.ts`](src/lib/score.ts).

## Limits

- The window is placed at the middle of the chosen building side, not at a specific stack or room.
- Terrain, trees, balconies, fins, and overhangs are not modelled.
- Private-building heights may be inferred. HDB heights use HDB's register where available.
- The future-view check can only confirm published low-height ceilings. Plot ratio is not a building-height limit.
- The industry figure is not a noise model. Road, rail, and aircraft noise are not yet included.
- What a parcel is called comes from OpenStreetMap and is patchy: estates and depots are usually named, substations rarely. A parcel is named only where a matching feature covers it, so it says the zoning and nothing more rather than guess.

## Data and sources

HDB block data and URA Master Plan layers are from [data.gov.sg](https://data.gov.sg/). Other building footprints and heights come from [OpenStreetMap](https://www.openstreetmap.org/copyright), built into `data/footprints.json.gz` from a [Geofabrik](https://download.geofabrik.de/) extract rather than queried per request — a cold neighbourhood took the best part of a minute of [Overpass](https://overpass-api.de/) time, which is still the fallback when that file has not been built. The derived file is OpenStreetMap data and carries its ODbL terms. Addresses come from [OneMap](https://www.onemap.gov.sg/). Solar position uses NOAA equations and an ASHRAE clear-sky beam model.

## Useful commands

```bash
npm run analyse -- 560406 --floor 8
npm run calibrate
npm run check-outlook
npm run build-footprints
npm run typecheck
npm run build
```

A prototype, not advice.
