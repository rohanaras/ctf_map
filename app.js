(() => {
  "use strict";

  const SAFE_ZONE_M = 160.934; // 0.1 mi
  const SAFE_ZONE_MIN_ZOOM = 14;
  const ENTRANCE_MIN_ZOOM = 16;
  const START = [38.90767, -77.03647]; // Scott Circle

  const LINE_STYLE = {
    // WMATA colors; offsets (px) separate lines that share track. Offsets are
    // relative to drawing direction, so `reverse` flips lines digitized the
    // opposite way (silver runs E->W in the source; blue/orange run W->E).
    red: { color: "#BF0D3E", offset: 0 },
    orange: { color: "#ED8B00", offset: 0 },
    silver: { color: "#919D9D", offset: 4, reverse: true },
    blue: { color: "#009CDE", offset: -4 },
    green: { color: "#00B140", offset: 0 },
    yellow: { color: "#FFD100", offset: 4 },
  };
  const TEAM = {
    West: { name: "Red", color: "#d7263d" },
    East: { name: "Blue", color: "#1f5fd6" },
  };

  const map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    minZoom: 11,
    maxZoom: 19,
    zoomSnap: 0.5,
  });
  window.ctfMap = map; // handy for debugging in the console
  L.control.attribution({ position: "topright", prefix: false }).addTo(map);

  // OpenFreeMap "Positron" = open-source Carto Light style, no API key needed.
  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/positron",
    attribution:
      '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> · Metro: DC GIS',
  }).addTo(map);

  // Pane order (low → high): tiles 200, tint 350, overlay (metro, divider) 400,
  // mask 450, zones 500, stations 550, markers 600, popups 700.
  map.createPane("tint").style.zIndex = 350;
  map.createPane("mask").style.zIndex = 450;
  map.createPane("zones").style.zIndex = 500;
  map.createPane("stations").style.zIndex = 550;
  for (const p of ["tint", "mask", "zones"]) map.getPane(p).style.pointerEvents = "none";

  const getJSON = (f) => fetch(`data/${f}.geojson`).then((r) => r.json());

  // ---------- geometry helpers ----------
  const toRad = (d) => (d * Math.PI) / 180;
  function distM(a, b) {
    const R = 6371008.8;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function inRing(pt, ring) {
    // ring: [[lng,lat],...]; pt: [lat,lng]
    const [y, x] = pt;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inPolygon(pt, geom) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    return polys.some(
      (rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h))
    );
  }
  const fmtDist = (m) => {
    const mi = m / 1609.344;
    return mi < 0.2 ? `${Math.round(m * 3.28084)} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  };

  // ---------- state ----------
  let playArea = null;
  let territories = []; // [{side, geometry}]: all of VA is West by rule
  let flags = [];

  Promise.all([
    getJSON("play_area"),
    getJSON("divider"),
    getJSON("territories"),
    getJSON("metro_lines"),
    getJSON("metro_stations"),
    getJSON("metro_entrances"),
    getJSON("flags"),
  ]).then(([area, div, terr, lines, stations, entrances, flagFC]) => {
    playArea = area.geometry;
    territories = terr.features.map((f) => ({ side: f.properties.side, geometry: f.geometry }));
    flags = flagFC.features;

    // --- crop: fit, limit panning, mask everything outside the play area
    const [w, s, e, n] = area.properties.bounds;
    const bounds = L.latLngBounds([s, w], [n, e]);
    map.fitBounds(bounds, { padding: [8, 8] });
    map.setMaxBounds(bounds.pad(0.25));
    map.options.minZoom = Math.max(10, map.getBoundsZoom(bounds.pad(0.25)) - 0.5);

    const world = [[-90, -360], [-90, 360], [90, 360], [90, -360]];
    const polys = playArea.type === "Polygon" ? [playArea.coordinates] : playArea.coordinates;
    const holes = polys.map((rings) => rings[0].map(([x, y]) => [y, x]));
    L.polygon([world, ...holes], {
      pane: "mask",
      stroke: false,
      fillColor: "#f2f2ef",
      fillOpacity: 0.88,
      interactive: false,
    }).addTo(map);
    L.geoJSON(area, {
      pane: "mask",
      style: { color: "#555", weight: 2, fill: false, interactive: false },
    }).addTo(map);

    // --- team territories (West = Virginia + DC west of 16th St) and the line
    L.geoJSON(terr, {
      pane: "tint",
      interactive: false,
      style: (f) => ({ stroke: false, fillColor: TEAM[f.properties.side].color, fillOpacity: 0.07 }),
    }).addTo(map);
    L.geoJSON(div, {
      interactive: false,
      style: { color: "#1d1d1f", weight: 3, dashArray: "8 6", opacity: 0.85 },
    }).addTo(map);

    // --- metro lines (offset where lines share track)
    for (const f of lines.features) {
      const st = LINE_STYLE[f.properties.name] || { color: "#666", offset: 0 };
      const parts =
        f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const part of parts) {
        const ll = part.map(([x, y]) => [y, x]);
        if (st.reverse) ll.reverse();
        L.polyline(
          ll,
          { color: st.color, weight: 4, offset: st.offset, opacity: 0.95, interactive: false }
        ).addTo(map);
      }
    }

    // --- stations
    const stationLayer = L.layerGroup().addTo(map);
    const inPlay = (f) => inPolygon([f.geometry.coordinates[1], f.geometry.coordinates[0]], playArea);
    for (const f of stations.features.filter(inPlay)) {
      const [x, y] = f.geometry.coordinates;
      L.circleMarker([y, x], {
        pane: "stations", radius: 4.5, color: "#222", weight: 2, fillColor: "#fff", fillOpacity: 1,
      })
        .bindTooltip(f.properties.name, {
          permanent: true, direction: "right", offset: [6, 0], className: "station-label",
        })
        .bindPopup(`<h3>${esc(f.properties.name)}</h3><div class="meta">Lines: ${esc(f.properties.line)}</div>`)
        .addTo(stationLayer);
    }

    // --- station entrances (zoomed in only)
    const entranceLayer = L.layerGroup();
    for (const f of entrances.features.filter(inPlay)) {
      const [x, y] = f.geometry.coordinates;
      L.marker([y, x], {
        pane: "stations",
        icon: L.divIcon({
          className: "",
          html: '<div style="width:10px;height:10px;background:#333;border:1.5px solid #fff;border-radius:2px"></div>',
          iconSize: [10, 10],
        }),
      })
        .bindPopup(
          `<h3>${esc(titleCase(f.properties.name))} entrance</h3>${esc(f.properties.exit_to_st || "")}`
        )
        .addTo(entranceLayer);
    }

    // --- flags + safe zones
    const zoneLayer = L.layerGroup();
    for (const f of flags) {
      const p = f.properties;
      const [x, y] = f.geometry.coordinates;
      const team = TEAM[p.side];
      L.circle([y, x], {
        pane: "zones", radius: SAFE_ZONE_M, color: team.color, weight: 2, dashArray: "5 5",
        fillColor: team.color, fillOpacity: 0.1, interactive: false,
      }).addTo(zoneLayer);
      L.marker([y, x], {
        icon: L.divIcon({
          className: "",
          html: `<div class="flag-pin ${p.side}"><span>${p.id}</span></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 36],
          popupAnchor: [0, -34],
        }),
        zIndexOffset: 100,
      })
        .bindPopup(
          `<span class="tag ${p.side}">${p.id}</span><b>${team.name} flag</b>` +
            `<h3>${esc(p.name)}</h3>${esc(p.description)}` +
            `<div class="meta">${esc(p.tier)}<br>Nearest Metro: ${esc(p.nearest)}` +
            ` · Baseline: ${esc(p.baseline)}</div>`
        )
        .addTo(map);
    }

    L.marker(START, {
      icon: L.divIcon({ className: "start-pin", html: "★", iconSize: [28, 28] }),
      zIndexOffset: 200,
    })
      .bindPopup("<h3>Start: Scott Circle</h3>")
      .addTo(map);

    function onZoom() {
      const z = map.getZoom();
      map.getContainer().classList.toggle("zoom-lt-14", z < 14);
      toggle(zoneLayer, z >= SAFE_ZONE_MIN_ZOOM);
      toggle(entranceLayer, z >= ENTRANCE_MIN_ZOOM);
    }
    map.on("zoomend", onZoom);
    onZoom();

    if (lastPos) updateStatus(lastPos);
  });

  function toggle(layer, on) {
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    else if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }
  function titleCase(s) {
    return String(s ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ---------- user location ----------
  const statusEl = document.getElementById("status");
  const statusMain = document.getElementById("status-main");
  const statusSub = document.getElementById("status-sub");
  const locBtn = document.getElementById("btn-locate");
  let lastPos = null;
  let me = null;
  let meAcc = null;
  let watchId = null;
  let followNext = true;

  function updateStatus(pos) {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    statusEl.classList.remove("red", "blue");
    if (!playArea) return;
    const t = territories.find((t) => inPolygon(ll, t.geometry));
    if (!t) {
      statusMain.textContent = "Outside the play area";
    } else {
      statusEl.classList.add(t.side === "West" ? "red" : "blue");
      statusMain.textContent = `${t.side} territory · ${TEAM[t.side].name} defends`;
    }
    let nearest = null;
    for (const f of flags) {
      const [x, y] = f.geometry.coordinates;
      const d = distM(ll, [y, x]);
      if (!nearest || d < nearest.d) nearest = { f, d };
    }
    const zone = nearest && nearest.d <= SAFE_ZONE_M;
    statusSub.textContent = nearest
      ? (zone ? `In safe zone of ${nearest.f.properties.id} · ` : "") +
        `Nearest flag ${nearest.f.properties.id} (${fmtDist(nearest.d)})` +
        ` · ±${Math.round(pos.coords.accuracy * 3.28084)} ft`
      : "";
  }

  function onPos(pos) {
    lastPos = pos;
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (!me) {
      meAcc = L.circle(ll, {
        radius: pos.coords.accuracy, color: "#0a84ff", weight: 1, fillOpacity: 0.1, interactive: false,
      }).addTo(map);
      me = L.circleMarker(ll, {
        radius: 8, color: "#fff", weight: 3, fillColor: "#0a84ff", fillOpacity: 1,
      }).addTo(map);
    } else {
      me.setLatLng(ll);
      meAcc.setLatLng(ll).setRadius(pos.coords.accuracy);
    }
    const mb = map.options.maxBounds;
    if (followNext && (!mb || mb.contains(ll))) {
      followNext = false;
      map.setView(ll, Math.max(map.getZoom(), 15));
    }
    locBtn.classList.add("active");
    updateStatus(pos);
  }

  function onErr(err) {
    locBtn.classList.remove("active");
    statusMain.textContent =
      err.code === 1 ? "Location blocked — enable it in browser settings" : "Can't get location";
    statusSub.textContent = "";
  }

  function startWatch() {
    if (!("geolocation" in navigator)) return onErr({ code: 0 });
    if (watchId !== null) return;
    statusMain.textContent = "Finding you…";
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, maximumAge: 5000, timeout: 20000,
    });
  }

  locBtn.addEventListener("click", () => {
    if (lastPos) map.setView([lastPos.coords.latitude, lastPos.coords.longitude], Math.max(map.getZoom(), 15));
    else followNext = true;
    startWatch();
  });

  // Ask on load (browser shows its own permission prompt).
  startWatch();

  // ---------- legend ----------
  const legend = document.getElementById("legend");
  document.getElementById("btn-legend").addEventListener("click", () => (legend.hidden = !legend.hidden));
  document.getElementById("legend-close").addEventListener("click", () => (legend.hidden = true));
})();
