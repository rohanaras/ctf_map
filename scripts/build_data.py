"""Fetch and prepare the GeoJSON files the map loads from ``data/``.

Run with:  uv run --with shapely --with defusedxml scripts/build_data.py

Sources
-------
- Flags: Google My Maps (KML export for attributes, viewer page for the
  geocoded coordinates, which the KML export leaves out).
- Play area: Census TIGERweb county polygons for DC, Arlington, Alexandria.
- Metro lines / stations / entrances: DC GIS Transportation MapServer.
- Dividing line: 16th Street NW centerline from OpenStreetMap (Overpass).
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import defusedxml.ElementTree as ET
from pathlib import Path

from shapely.geometry import LineString, Polygon, mapping, shape
from shapely.ops import unary_union

OUT = Path(__file__).resolve().parent.parent / "data"
MID = "1TEIOawlrN2B1Hraah-fE7cfqU7zClOc"
UA = {"User-Agent": "ctf-map-builder/1.0"}
DCGIS = (
    "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/"
    "Transportation_Rail_Bus_WebMercator/MapServer"
)

# Manual coordinate fixes where Google's geocode of the address is wrong.
# Keyed by (side, pair number).
FIXES = {
    # Address was "Metro Center,21st St NW & H St NW" -> geocoded to 21st & L.
    ("West", 2): (38.8991, -77.0466),
}


def get(url, data=None, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError:
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


def get_json(url, data=None):
    return json.loads(get(url, data))


def write(name, obj):
    path = OUT / name
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"wrote {path.name} ({path.stat().st_size // 1024} KB)")


def round_coords(geom, nd=5):
    """Round GeoJSON coordinates to ~1 m to keep files small."""

    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]

    geom = dict(geom)
    geom["coordinates"] = r(geom["coordinates"])
    return geom


def build_flags():
    K = "{http://www.opengis.net/kml/2.2}"
    kml = ET.fromstring(
        get(f"https://www.google.com/maps/d/kml?mid={MID}&forcekml=1").encode()
    )
    placemarks = []
    for folder in kml.iter(K + "Folder"):
        for p in folder.findall(K + "Placemark"):
            attrs = {
                d.get("name"): (d.find(K + "value").text or "").strip()
                for d in p.iter(K + "Data")
            }
            attrs["name"] = p.find(K + "name").text.strip()
            placemarks.append(attrs)

    # The viewer page embeds each placemark's geocoded point as [[[lat,lng]]],
    # in the same order as the KML.
    viewer = get(f"https://www.google.com/maps/d/viewer?mid={MID}").replace("\\", "")
    coords = [
        (float(a), float(b))
        for a, b in re.findall(r"\[\[\[(3[89]\.\d+),(-7[67]\.\d+)\]\]", viewer)
    ]
    assert len(coords) == len(placemarks), (len(coords), len(placemarks))

    feats = []
    for attrs, (lat, lng) in zip(placemarks, coords):
        side = attrs["Side"]
        pair = int(float(attrs["Pair Number"]))
        lat, lng = FIXES.get((side, pair), (lat, lng))
        name = re.sub(r"^The ", "", attrs["name"])
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lng, lat]},
                "properties": {
                    "id": f"{side[0]}{pair}",
                    "side": side,
                    "pair": pair,
                    "name": name,
                    "tier": attrs.get("Tier", ""),
                    "description": attrs.get("Specific Description", ""),
                    "nearest": attrs.get("Nearest Metro Station", ""),
                    "baseline": attrs.get("Game Baseline Station", ""),
                },
            }
        )
    write("flags.geojson", {"type": "FeatureCollection", "features": feats})


def build_play_area():
    """Write the play-area outline; return (DC, Virginia) geometries."""
    where = urllib.parse.quote("GEOID IN ('11001','51013','51510')")
    gj = get_json(
        "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
        f"State_County/MapServer/1/query?where={where}&outFields=GEOID&f=geojson&outSR=4326"
    )
    geoms = {f["properties"]["GEOID"]: shape(f["geometry"]) for f in gj["features"]}

    def merge(gs):
        # Buffer out/in slightly to close slivers along shared borders.
        return unary_union([g.buffer(0.00005) for g in gs]).buffer(-0.00005)

    dc = merge([geoms["11001"]])
    va = merge([geoms["51013"], geoms["51510"]])
    area = merge([dc, va]).simplify(0.00003)
    write(
        "play_area.geojson",
        {
            "type": "Feature",
            "geometry": round_coords(mapping(area)),
            "properties": {"bounds": list(area.bounds)},
        },
    )
    return dc, va


def build_divider(dc, va):
    """Write the 16th St dividing line and the West/East territories.

    By rule, all of Virginia is West; DC is split by 16th St NW, extended
    straight south from Lafayette Square to the DC line.
    """
    q = (
        '[out:json];way["highway"]["name"="16th Street Northwest"]'
        "(38.89,-77.05,39.0,-77.02);out geom;"
    )
    els = get_json(
        "https://overpass-api.de/api/interpreter",
        urllib.parse.urlencode({"data": q}).encode(),
    )["elements"]
    pts = [(p["lat"], p["lon"]) for w in els for p in w["geometry"]]
    # 16th St is dual-carriageway in places; average lon in 0.005-deg lat bins
    # north of Lafayette Square to get a single centerline.
    bins = {}
    for lat, lon in pts:
        if lat >= 38.8995:
            bins.setdefault(round(lat / 0.005), []).append(lon)
    line = [
        (sum(v) / len(v), k * 0.005) for k, v in sorted(bins.items(), reverse=True)
    ]
    # Extend straight north past the MD line and straight south past DC.
    coords = [(line[0][0], 39.05)] + line + [(line[-1][0], 38.70)]
    full = LineString(coords)

    west_half = Polygon([(-78, 39.05)] + coords + [(-78, 38.70)])
    west = unary_union([dc.intersection(west_half), va]).simplify(0.00003)
    east = dc.difference(west_half).simplify(0.00003)
    divider = full.intersection(dc)  # only draw the line inside DC

    write(
        "divider.geojson",
        {"type": "Feature", "geometry": round_coords(mapping(divider)), "properties": {}},
    )
    write(
        "territories.geojson",
        {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"side": side},
                 "geometry": round_coords(mapping(g.buffer(0)))}
                for side, g in [("West", west), ("East", east)]
            ],
        },
    )


def build_metro():
    for layer, name in [(58, "metro_lines"), (51, "metro_stations"), (111, "metro_entrances")]:
        gj = get_json(f"{DCGIS}/{layer}/query?where=1%3D1&outFields=*&f=geojson&outSR=4326")
        keep = {"NAME", "LINE", "EXIT_TO_ST", "WEB_URL"}
        for f in gj["features"]:
            f["properties"] = {k.lower(): v for k, v in f["properties"].items() if k in keep}
            if f["geometry"]["type"] != "Point":
                f["geometry"] = round_coords(mapping(shape(f["geometry"]).simplify(0.00002)))
            else:
                f["geometry"] = round_coords(f["geometry"], 6)
        write(f"{name}.geojson", {"type": "FeatureCollection", "features": gj["features"]})


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    build_flags()
    dc, va = build_play_area()
    build_divider(dc, va)
    build_metro()
