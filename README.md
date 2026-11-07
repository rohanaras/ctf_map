# DC Capture the Flag map

A mobile web map for a city-wide game of capture the flag across DC, Arlington and Alexandria.

- **Dividing line:** 16th St NW, extended straight south past the White House.
  **Red** defends the West (incl. Arlington & Alexandria), **Blue** defends the East.
- **Start:** Scott Circle (★).
- **Flags:** 15 per side, from the [Google My Map](https://www.google.com/maps/d/edit?mid=1TEIOawlrN2B1Hraah-fE7cfqU7zClOc).
  Each has a 0.1 mi attacker safe zone, shown at zoom ≥ 15.
- **Metrorail** lines and stations; station entrances appear at zoom ≥ 16.
- **Your location:** live dot, plus which territory you're in and the distance to the nearest flag / whether you're in a safe zone.

Static site: `index.html` + `app.js` + `style.css` + `data/*.geojson`, with Leaflet and the
OpenFreeMap Positron basemap (an open-source Carto Light lookalike that needs no API key).

## Updating the data

If the flags change in Google My Maps, rebuild:

```sh
uv run --with shapely --with defusedxml scripts/build_data.py
```

Coordinates come from Google's geocode of each flag's address. `FIXES` in the script
overrides any that land in the wrong place (currently W2, the GWU hippo).

## Local preview

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Browsers only allow geolocation on `https://` or `localhost`.
