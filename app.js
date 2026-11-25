// TIDO: retro telemetry viewer for live tide gauges, wave buoys and USGS stream gauges.
// Data: same-origin snapshot routes (/snapshot/{group}?region=…), refreshed every 5 minutes.
// Station kinds: "g" NOAA tide gauge, "b" NDBC buoy / met station, "u" USGS stream gauge.

import { REGIONS, REGION_IDS, DEFAULT_REGION, regionOfStation } from "./regions.js";
import { buildStyle, graticule, scanImage, applyPalette, PALETTES, THEMES } from "./mapstyle.js";
import { lineGraph, vMeter, hMeter, fmtNum, esc } from "./gfx.js";

const MIN = 60e3, HOUR = 60 * MIN;
const WINS = { "1h": HOUR, "6h": 6 * HOUR, "24h": 24 * HOUR, "3d": 72 * HOUR };
const WIN_IDS = Object.keys(WINS);
const GROUPS = ["tides", "buoys", "weather", "floods", "gauges"];
const REFRESH_MS = 5 * MIN;
const ALERT_KM = 10; // NWS coastal flood polygon within this distance of a station
const REPORT_KM = 15; // flood reports / flooding river+tide gauges within this distance
const REPORT_H = 24; // …and this recent
const WAVE = { y: 8, r: 12 }; // ft
const WIND = { y: 21, r: 34 }; // kt: small-craft range, gale force
const PERIOD = { y: 14, r: 18 }; // s
const RES = { y: 1, r: 2 }; // ft above prediction
const FLOOD_EV = /coastal flood|storm surge|tidal flood|lakeshore flood/i;
const RIVER_EV = /flood/i; // stream gauges: any NWS flood product (watch, warning, flash flood, coastal)
const RIVER_KM = 3; // a flooding NWPS gauge this close is taken as the same stream site
const RISE = { y: 1, r: 2 }; // ft per 24 h, stream gauge rise
const MARINE_EV = /gale|storm warning|small craft|high surf|hazardous seas|hurricane|tropical storm|special marine/i;
const KIND_RANK = { warning: 3, watch: 2, advisory: 1, statement: 0 };

const $ = (id) => document.getElementById(id);
const R = () => REGIONS[state.region];

const state = {
  region: DEFAULT_REGION,
  win: "24h",
  selId: null,
  want: null, // the station the viewer asked for (hash, saved pick, or region default)
  theme: "light",
  layers: { g: true, b: true, u: true, r: true, a: true },
  tab: "g", // roster tab
  data: null,
  gen: 0,
  fetchedAt: 0,
  link: "init",
  needFit: true,
};

// ---------------------------------------------------------------- time helpers
const dtfCache = new Map();
function dtf(tz, opts) {
  const k = tz + JSON.stringify(opts);
  let f = dtfCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", ...opts }); dtfCache.set(k, f); }
  return f;
}
function partsOf(t, tz) {
  const o = {};
  for (const p of dtf(tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(t)) o[p.type] = p.value;
  return o;
}
const hhmm = (t, tz = R().tz) => { const p = partsOf(t, tz); return `${p.hour % 24 === 0 ? "00" : p.hour}:${p.minute}`; };
const ddhhmm = (t, tz = R().tz) => { const p = partsOf(t, tz); return `${p.day} ${p.hour % 24 === 0 ? "00" : p.hour}:${p.minute}`; };
function tzAbbr(t, tz = R().tz) {
  const p = dtf(tz, { hour: "2-digit", timeZoneName: "short" }).formatToParts(t).find((x) => x.type === "timeZoneName");
  return p ? p.value : "";
}
function tzOffset(t, tz) {
  const p = partsOf(t, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}
const TICKS = { "1h": [5 * MIN, 15 * MIN], "6h": [15 * MIN, HOUR], "24h": [HOUR, 6 * HOUR], "3d": [3 * HOUR, 12 * HOUR] };
function timeTicks(x0, x1, tz, win) {
  const [minor, major] = TICKS[win];
  const off = tzOffset(x0, tz);
  const out = [];
  for (let lt = Math.ceil((x0 + off) / minor) * minor; lt - off <= x1; lt += minor) {
    const isMajor = lt % major === 0;
    const d = new Date(lt);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    out.push({
      t: lt - off,
      major: isMajor,
      label: isMajor ? (win === "1h" ? `${hh}:${mm}` : hh) : "",
      sub: isMajor && midnight ? String(d.getUTCDate()).padStart(2, "0") : "",
    });
  }
  return out;
}
const ago = (t) => {
  const m = Math.round((Date.now() - t) / MIN);
  return m < 1 ? "NOW" : m < 90 ? `${m} MIN AGO` : `${Math.round(m / 60)} H AGO`;
};

// ---------------------------------------------------------------- data
function decodeSeries(s) {
  if (!s || !Array.isArray(s.v)) return [];
  const out = [];
  for (let i = 0; i < s.v.length; i++) {
    if (s.v[i] == null) continue;
    out.push({ t: s.t ? s.t[i] : s.start + i * s.step, v: s.v[i] });
  }
  return out;
}

function expandAlerts(a) {
  if (!a) return null;
  const zones = a.zones || {};
  return {
    count: a.count || 0,
    items: a.items || {},
    features: (a.features || [])
      .map((f) => ({ type: "Feature", geometry: f.geometry || zones[f.zone] || null, properties: f.properties || {} }))
      .filter((f) => f.geometry),
  };
}

async function getSnap(group, region, force) {
  const r = await fetch(`/snapshot/${group}?region=${encodeURIComponent(region)}`, force ? { cache: "no-cache" } : undefined);
  if (!r.ok) throw new Error(`${group.toUpperCase()} HTTP ${r.status}`);
  return r.json();
}

function km(a, b) {
  const kx = 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * 110.57);
}
function segDist0(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / L)) : 0;
  return Math.hypot(x1 + t * dx, y1 + t * dy);
}
/** km from a point to a (multi)polygon; 0 when inside. */
function distToGeom(lon, lat, g) {
  if (!g) return Infinity;
  if (g.type === "GeometryCollection") return Math.min(Infinity, ...(g.geometries || []).map((x) => distToGeom(lon, lat, x)));
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180), ky = 110.57;
  let best = Infinity;
  for (const poly of polys) {
    let inside = false;
    poly.forEach((ring, ri) => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = (ring[i][0] - lon) * kx, yi = (ring[i][1] - lat) * ky;
        const xj = (ring[j][0] - lon) * kx, yj = (ring[j][1] - lat) * ky;
        if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * -yi) / (yj - yi) + xi) c = !c;
        const d = segDist0(xi, yi, xj, yj);
        if (d < best) best = d;
      }
      if (ri === 0) inside = c;
      else if (c) inside = false;
    });
    if (inside) return 0;
  }
  return best;
}

function buildData(region, settled, now) {
  const val = (i) => (settled[i].status === "fulfilled" ? settled[i].value : null);
  const errors = settled.map((s, i) => (s.status === "rejected" ? `${GROUPS[i].toUpperCase()}: ${s.reason?.message || s.reason}` : null)).filter(Boolean);
  const tides = val(0), buoys = val(1), weather = val(2), floods = val(3), streams = val(4);
  // upstream stations the data server could not reach this round
  for (const [name, snap] of [["TIDES", tides], ["BUOYS", buoys], ["USGS", streams]]) for (const e of snap?.data?.errors || []) errors.push(`${name}: ${e}`);

  const gauges = (tides?.data?.stations || []).map((s) => {
    const obs = decodeSeries(s.observed);
    const pred = decodeSeries(s.predicted);
    const pm = new Map(pred.map((p) => [p.t, p.v]));
    const res = [];
    for (const p of obs) { const pv = pm.get(p.t); if (pv != null) res.push({ t: p.t, v: Math.round((p.v - pv) * 1000) / 1000 }); }
    return {
      kind: "g", id: String(s.id), name: s.name, lon: s.lon, lat: s.lat,
      latest: s.latest || null, residual: s.residual ?? null, temp: s.temp || null,
      mhhw: s.mhhw ?? null, flood: s.flood || null, extremes: s.extremes || [], obs, pred, pm, res,
    };
  });
  const bs = (buoys?.data?.buoys || []).map((b) => ({
    kind: "b", id: String(b.id), name: b.name, lon: b.lon, lat: b.lat,
    waveFt: b.waveFt ?? null, period: b.period ?? null, windKt: b.windKt ?? null, windDir: b.windDir ?? null,
    sstF: b.sstF ?? null, updated: b.updated ?? null, levelFt: b.levelFt ?? null,
    wave: decodeSeries(b.series?.waveFt), sst: decodeSeries(b.series?.sstF), level: decodeSeries(b.series?.levelFt),
  }));
  // shore/pier met stations (names end "(wind…)", "(level…)") report no waves; some report water level (NDBC TIDE)
  for (const b of bs) {
    b.windOnly = !b.wave.length && b.waveFt == null;
    b.hasLevel = b.level.length > 0 || b.levelFt != null;
  }
  // USGS stage is against each gauge's own zero: only ever compared with itself over time
  const usgs = (streams?.data?.gauges || []).map((g) => ({
    kind: "u", id: String(g.id), name: g.name, lon: g.lon, lat: g.lat,
    stageFt: g.stageFt ?? null, flowCfs: g.flowCfs ?? null, change24hFt: g.change24hFt ?? null, updated: g.updated ?? null,
    stage: decodeSeries(g.series?.stageFt),
  }));
  for (const u of usgs) u.rate = rateSeries(u.stage);
  const alerts = expandAlerts(weather?.data?.alerts);
  const fd = floods?.data || {};
  const reports = (fd.reports || []).filter((r) => isFinite(r.lon) && isFinite(r.lat) && isFinite(r.t));
  const rivers = (fd.rivers?.flooding || []).filter((r) => isFinite(r.lon) && isFinite(r.lat));

  const d = { region, gauges, buoys: bs, usgs, alerts, reports, rivers, errors, byId: new Map(), now };
  for (const st of [...gauges, ...bs, ...usgs]) {
    d.byId.set(st.id, st);
    annotate(st, d, now);
  }
  return d;
}

/** Stage change over the previous hour (ft/h) at each reading. */
function rateSeries(pts) {
  const out = [];
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    while (j < i && pts[i].t - pts[j].t > HOUR) j++;
    const dt = pts[i].t - pts[j].t;
    if (j < i && dt >= 0.5 * HOUR) out.push({ t: pts[i].t, v: Math.round(((pts[i].v - pts[j].v) / dt) * HOUR * 100) / 100 });
  }
  return out;
}

function floodLevel(g) {
  if (!g.flood || !g.latest || g.flood.minor == null) return null;
  const v = g.latest.v, f = g.flood;
  if (f.major != null && v >= f.major) return "MAJOR";
  if (f.moderate != null && v >= f.moderate) return "MODERATE";
  if (v >= f.minor) return "MINOR";
  return null;
}

function annotate(st, d, now) {
  const seen = new Map();
  for (const f of d.alerts?.features || []) {
    const p = f.properties;
    if (!p.id || seen.has(p.id)) continue;
    const isFlood = FLOOD_EV.test(p.event || "");
    // buoys: marine warnings only (small-craft advisories cover nearly every buoy most days)
    const isMarine = st.kind === "b" && MARINE_EV.test(p.event || "") && (p.kind || d.alerts.items[p.id]?.kind) === "warning";
    // stream gauges: inland flood watches/warnings whose area holds the gauge
    const isRiver = st.kind === "u" && !isFlood && RIVER_EV.test(p.event || "");
    if (!isFlood && !isMarine && !isRiver) continue;
    const dist = distToGeom(st.lon, st.lat, f.geometry);
    if (dist <= (isFlood ? ALERT_KM : isRiver ? 2 : 0.5)) {
      const item = d.alerts.items[p.id] || {};
      seen.set(p.id, { event: p.event, kind: p.kind || item.kind || "statement", ends: item.ends });
    }
  }
  st.alerts = [...seen.values()].sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind]);
  st.reportsNear = d.reports.filter((r) => now - r.t <= REPORT_H * HOUR && km(st, r) <= REPORT_KM);
  st.riversNear = d.rivers.filter((r) => km(st, r) <= REPORT_KM);
  st.alert = st.alerts.length > 0 || st.reportsNear.length > 0 || st.riversNear.length > 0;
  if (st.kind === "g") {
    st.floodLvl = floodLevel(st);
    st.stale = !st.latest || now - st.latest.t > 45 * MIN;
  } else if (st.kind === "u") {
    // no flood stage in the USGS feed: FLOOD lights only when NOAA's river service reports flooding at this site
    const site = st.riversNear.filter((r) => km(st, r) <= RIVER_KM && ["minor", "moderate", "major"].includes(r.now));
    st.floodLvl = site.length ? String(site[0].now).toUpperCase() : null;
    st.stale = !st.updated || now - st.updated > 3 * HOUR;
    st.trend = st.change24hFt == null ? 0 : st.change24hFt >= 0.1 ? 1 : st.change24hFt <= -0.1 ? -1 : 0;
  } else {
    st.gale = st.windKt != null && st.windKt >= WIND.r;
    st.stale = !st.updated || now - st.updated > 3 * HOUR;
    st.waveLvl = st.waveFt == null ? 0 : st.waveFt >= WAVE.r ? 2 : st.waveFt >= WAVE.y ? 1 : 0;
  }
}

// Opening station: the viewer's last pick in that region, else Alameda in the Bay Area, else the first gauge.
const DEFAULT_STATION = { sfbay: "9414750" };
function savedPicks() {
  try { const o = JSON.parse(localStorage.getItem("tido.station") || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}
function savePick(region, id) {
  try { const o = savedPicks(); o[region] = id; localStorage.setItem("tido.station", JSON.stringify(o)); } catch { /* private mode */ }
}
const wantFor = (region) => savedPicks()[region] || DEFAULT_STATION[region] || null;
function pickStation(d) {
  for (const id of [state.want, wantFor(d.region)]) if (id && d.byId.has(id)) return id;
  return d.gauges[0]?.id || d.buoys[0]?.id || d.usgs[0]?.id || null;
}

async function load({ force = false, fit = false } = {}) {
  const region = state.region;
  const token = ++state.gen;
  setLink("sync");
  const settled = await Promise.allSettled(GROUPS.map((g) => getSnap(g, region, force)));
  if (token !== state.gen || region !== state.region) return;
  const now = Date.now();
  const d = buildData(region, settled, now);
  if (!d.gauges.length && !d.buoys.length && !d.usgs.length) {
    setLink("lost", d.errors[0]);
    if (!state.data || state.data.region !== region) { state.data = d; renderAll(); }
    return;
  }
  state.data = d;
  state.fetchedAt = now;
  setLink(d.errors.length ? "partial" : "ok", d.errors.join(" · "));
  if (state.lookup) {
    state.lookup = false;
    const id = state.want;
    if (!d.byId.has(id)) locateStation(id).then((r) => { if (r && r !== state.region) { setRegion(r); state.want = id; } });
  }
  const prevSel = state.selId;
  state.selId = pickStation(d);
  if (state.selId !== prevSel && d.byId.has(state.selId)) state.tab = d.byId.get(state.selId).kind;
  renderAll();
  if (fit || state.needFit) fitRegion();
}

// ---------------------------------------------------------------- map
let map = null;
let mapReady = false;
const markers = new Map(); // id -> { m, el }
let reportMarkers = [];
let popup = null;
const narrowMQ = matchMedia("(max-width: 760px)");

function initMap() {
  const r = R();
  map = new maplibregl.Map({
    container: "map",
    style: buildStyle(state.theme),
    center: r.center,
    zoom: r.zoom - 0.9,
    // style colours follow the theme; applyPalette() re-colours in place on a switch
    maxBounds: r.maxBounds,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    cooperativeGestures: narrowMQ.matches,
    fadeDuration: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation?.();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => {
    try {
      for (const t of THEMES) map.addImage(`scan-${t}`, scanImage(t));
      map.setPaintProperty("bg", "background-pattern", `scan-${state.theme}`);
    } catch { /* plain fill is fine */ }
    const P = PALETTES[state.theme];
    map.addSource("grat", { type: "geojson", data: graticule(R().maxBounds) });
    map.addLayer({ id: "grat", type: "line", source: "grat", paint: { "line-color": P.grat, "line-width": 0.8, "line-dasharray": [2, 3] } }, "place-city");
    map.addSource("alerts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "alerts-fill", type: "fill", source: "alerts",
      paint: { "fill-color": P.alertFill, "fill-opacity": ["match", ["get", "kind"], "warning", 0.16, "watch", 0.1, 0.07] },
    }, "place-city");
    map.addLayer({
      id: "alerts-line", type: "line", source: "alerts",
      paint: { "line-color": P.alertLine, "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.85 },
    }, "place-city");
    map.on("click", "alerts-fill", (e) => {
      const seen = new Set();
      const rows = [];
      for (const f of e.features || []) {
        const p = f.properties;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const it = state.data?.alerts?.items?.[p.id] || {};
        rows.push(`<div class="pp-row"><b>${esc(p.event)}</b>${it.ends ? `<span>UNTIL ${esc(ddhhmm(Date.parse(it.ends)))}</span>` : ""}<p>${esc(p.areaDesc || "")}</p></div>`);
      }
      showPopup(e.lngLat, `<div class="pp-h">NWS ALERT</div>${rows.slice(0, 4).join("")}`);
    });
    map.on("mouseenter", "alerts-fill", () => { map.getCanvas().style.cursor = "help"; });
    map.on("mouseleave", "alerts-fill", () => { map.getCanvas().style.cursor = ""; });
    mapReady = true;
    applyPalette(map, state.theme);
    renderAlertsLayer();
    applyLayers();
  });
  map.on("error", (e) => { if (e?.error?.status) console.warn("map", e.error.status); });
}

function showPopup(lngLat, html) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", className: "tpop", offset: 12 }).setLngLat(lngLat).setHTML(html).addTo(map);
}

function fitRegion() {
  const d = state.data;
  if (!map || !d) return;
  const pts = [...d.gauges, ...d.buoys];
  if (!pts.length) return;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  const pad = narrowMQ.matches ? 26 : 44;
  const narrow = narrowMQ.matches;
  map.fitBounds([[w, s], [e, n]], { padding: { top: pad + (narrow ? 30 : 18), bottom: pad + (narrow ? 44 : 22), left: pad, right: pad + 26 }, maxZoom: 10, duration: 0 });
  state.needFit = false;
}

function markerEl(cls, label, title) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `mk ${cls}`;
  el.dataset.label = label;
  el.title = title;
  return el;
}
// Marker#addTo stamps a generic aria-label ("Map marker"), so name the button after attaching it.
function addMarker(el, lngLat) {
  const m = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(lngLat).addTo(map);
  el.setAttribute("aria-label", el.dataset.label);
  return m;
}

function renderMarkers() {
  const focusedId = document.activeElement?.classList?.contains("mk") ? document.activeElement.dataset.id : null;
  for (const { m } of markers.values()) m.remove();
  markers.clear();
  const d = state.data;
  if (!map || !d) return;
  for (const st of allStations(d)) {
    const el = markerEl(`mk-${st.kind}${st.windOnly ? " met" : ""}`, `${kindName(st)} ${st.name}, ${st.id}`, `${st.name} · ${st.id}`);
    el.dataset.id = st.id;
    el.innerHTML = `<i class="shape"></i><span class="lbl">${esc(shortName(st.name).toUpperCase())}</span>`;
    el.addEventListener("click", (e) => { e.stopPropagation(); select(st.id); });
    const m = addMarker(el, [st.lon, st.lat]);
    markers.set(st.id, { m, el, st });
  }
  updateMarkerStates();
  if (focusedId && markers.has(focusedId)) markers.get(focusedId).el.focus({ preventScroll: true });
}

function updateMarkerStates() {
  for (const { el, st } of markers.values()) {
    el.classList.toggle("sel", st.id === state.selId);
    el.classList.toggle("flood", !!st.floodLvl);
    el.classList.toggle("alert", !!st.alert && !st.floodLvl);
    el.classList.toggle("w1", st.kind === "b" && st.waveLvl === 1);
    el.classList.toggle("w2", st.kind === "b" && st.waveLvl === 2);
    el.classList.toggle("up", st.kind === "u" && st.trend > 0);
    el.classList.toggle("down", st.kind === "u" && st.trend < 0);
    el.classList.toggle("stale", !!st.stale);
    el.setAttribute("aria-pressed", st.id === state.selId ? "true" : "false");
  }
}

function renderReportMarkers() {
  for (const m of reportMarkers) m.remove();
  reportMarkers = [];
  const d = state.data;
  if (!map || !d) return;
  const now = Date.now(), W = WINS[state.win];
  const tz = R().tz;
  for (const r of d.reports) {
    if (now - r.t > W) continue;
    const el = markerEl("mk-r", `Flood report ${r.place}`, `${r.type} · ${r.place}`);
    el.innerHTML = `<i class="shape"></i>`;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopup([r.lon, r.lat], `<div class="pp-h">${esc(r.type)}</div><div class="pp-row"><span>${esc(ddhhmm(r.t, tz))} ${esc(tzAbbr(r.t, tz))} · ${esc(r.source || "")}</span><b>${esc(r.place)}</b><p class="nc">${esc(r.remark || "")}</p></div>`);
    });
    reportMarkers.push(addMarker(el, [r.lon, r.lat]));
  }
  for (const v of d.rivers) {
    const el = markerEl("mk-v", `Flooding gauge ${v.name}`, `${v.name} · ${String(v.now || v.forecast || "").toUpperCase()}`);
    el.innerHTML = `<i class="shape"></i>`;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const fc = v.forecast ? `<span>FORECAST ${esc(v.forecast.toUpperCase())}${v.forecastT ? " · " + esc(ddhhmm(v.forecastT, tz)) : ""}</span>` : "";
      showPopup([v.lon, v.lat], `<div class="pp-h">NWPS GAUGE ${esc(v.id)}</div><div class="pp-row"><b>${esc(v.name)}</b><span>NOW ${esc(String(v.now || "-").toUpperCase())} · ${v.nowValue != null ? esc(v.nowValue) + " " + esc(v.unit || "") : ""}</span>${fc}</div>`);
    });
    reportMarkers.push(addMarker(el, [v.lon, v.lat]));
  }
}

function renderAlertsLayer() {
  if (!mapReady) return;
  const feats = (state.data?.alerts?.features || []).filter((f) => FLOOD_EV.test(f.properties.event || ""));
  map.getSource("alerts")?.setData({ type: "FeatureCollection", features: feats });
  map.getSource("grat")?.setData(graticule(R().maxBounds));
}

function applyLayers() {
  const box = $("map");
  for (const k of ["g", "b", "u", "r"]) box.classList.toggle(`hide-${k}`, !state.layers[k]);
  if (mapReady) for (const id of ["alerts-fill", "alerts-line"]) map.setLayoutProperty(id, "visibility", state.layers.a ? "visible" : "none");
  for (const b of document.querySelectorAll("#m-layers [data-layer]")) b.setAttribute("aria-pressed", state.layers[b.dataset.layer] ? "true" : "false");
}

// ---------------------------------------------------------------- header / status
function setLink(s, msg = "") {
  state.link = s;
  const el = $("hd-link");
  el.dataset.s = s;
  const txt = { init: "INIT", sync: "SYNC", ok: "LINK OK", partial: "LINK PARTIAL", lost: "LINK LOST" }[s];
  const at = state.fetchedAt ? ` ${hhmm(state.fetchedAt)}` : "";
  el.querySelector("span").textContent = s === "sync" ? "SYNC…" : txt + (s === "ok" || s === "partial" ? at : "");
  el.title = msg || "";
}

function tickClock() {
  const now = Date.now();
  const tz = R().tz;
  const p = partsOf(now, tz);
  $("clk-local").textContent = `${p.hour % 24 === 0 ? "00" : p.hour}:${p.minute}:${p.second}`;
  $("clk-tz").textContent = tzAbbr(now, tz);
  const u = new Date(now);
  $("clk-utc").textContent = `${String(u.getUTCHours()).padStart(2, "0")}:${String(u.getUTCMinutes()).padStart(2, "0")}:${String(u.getUTCSeconds()).padStart(2, "0")}Z`;
}

function renderHeader() {
  const r = R();
  $("hd-region").textContent = r.name;
  const d = state.data;
  const el = $("hd-alert");
  if (!d || d.region !== state.region) { el.innerHTML = `<span class="dimt">ACQUIRING ${esc(r.code)}…</span>`; return; }
  const parts = [];
  const flooding = [...d.gauges, ...d.usgs].filter((g) => g.floodLvl);
  if (flooding.length) parts.push(`<span class="tag fl">FLOOD</span><span>${flooding.map((g) => esc(g.name.toUpperCase())).join(", ")}</span>`);
  const counts = new Map();
  for (const it of Object.values(d.alerts?.items || {})) {
    if (!RIVER_EV.test(it.event || "")) continue; // coastal and inland flood products
    const k = it.event.toUpperCase();
    counts.set(k, { n: (counts.get(k)?.n || 0) + 1, rank: KIND_RANK[it.kind] ?? 0 });
  }
  const now = Date.now();
  const rep24 = d.reports.filter((x) => now - x.t <= REPORT_H * HOUR).length;
  const ev = [...counts.entries()].sort((a, b) => b[1].rank - a[1].rank).map(([k, v]) => `${esc(k)}${v.n > 1 ? ` ×${v.n}` : ""}`);
  if (ev.length || rep24 || d.rivers.length) {
    const bits = [...ev];
    if (rep24) bits.push(`${rep24} FLOOD RPT${rep24 > 1 ? "S" : ""} / 24H`);
    if (d.rivers.length) bits.push(`${d.rivers.length} NWPS GAUGE${d.rivers.length > 1 ? "S" : ""} FLOODING`);
    parts.push(`<span class="tag">ALERT</span><span>${bits.join(" · ")}</span>`);
  }
  if (!parts.length) parts.push(`<span class="dimt">NO FLOOD ALERTS · ${d.gauges.length} TIDE · ${d.buoys.length} BUOY · ${d.usgs.length} STREAM NOMINAL</span>`);
  el.innerHTML = parts.join(" ");
  el.title = el.textContent;
}

// ---------------------------------------------------------------- station panels
const cur = () => state.data?.byId.get(state.selId) || null;
// station-type suffixes the data server adds to NDBC names: "(wind)", "(level, water temp)", …
const shortName = (name) => name.replace(/\s*\((?:wind|level|water)[^)]*\)\s*$/i, "");
const allStations = (d) => [...d.gauges, ...d.buoys, ...d.usgs];
const KIND_LABEL = { g: "TIDE", b: "BUOY + MET", u: "STREAM" };
function kindName(st) {
  if (st.kind === "g") return "Tide gauge";
  if (st.kind === "u") return "USGS stream gauge";
  return st.windOnly ? (st.hasLevel ? "Water level station" : "Wind station") : "Buoy";
}
const usgsUrl = (id) => `https://waterdata.usgs.gov/monitoring-location/${encodeURIComponent(id)}/`;
const cfs = (v) => (v == null ? "--" : (v < 0 ? "−" : "") + Math.round(Math.abs(v)).toLocaleString("en-US"));
const trendWord = (st) => (st.trend > 0 ? "RISING" : st.trend < 0 ? "FALLING" : "STEADY");
const trendArrow = (st) => (st.trend > 0 ? "▲" : st.trend < 0 ? "▼" : "■");
const sgn = (v, d = 2) => (v == null ? "--" : (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(d));
const num = (v, d = 1) => (v == null || !isFinite(v) ? "--" : fmtNum(v, d));
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => (deg == null ? "" : COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);

function dms(v, isLat) {
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = Math.round(((a - d) * 60 - m) * 600) / 10;
  if (s >= 60) { s = 0; m++; }
  if (m >= 60) { m = 0; d++; }
  const hemi = isLat ? (v >= 0 ? "N" : "S") : v >= 0 ? "E" : "W";
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${s.toFixed(1).padStart(4, "0")} ${hemi}`;
}

function bins(pts, t0, t1, n) {
  const out = new Array(n).fill(null);
  const bw = (t1 - t0) / n;
  for (const p of pts) {
    if (p.t < t0 || p.t > t1) continue;
    const i = Math.min(n - 1, Math.floor((p.t - t0) / bw));
    out[i] = out[i] == null ? p.v : Math.max(out[i], p.v);
  }
  for (let i = 1; i < n; i++) if (out[i] == null && out[i - 1] != null) out[i] = out[i - 1];
  return out;
}

function meterCols(el) {
  const w = el.clientWidth || 200;
  const n = Math.max(6, Math.min(16, Math.floor((w - 40) / 15)));
  return state.win === "1h" ? Math.min(n, 10) : n;
}

function setText(id, s) { const el = $(id); if (el.textContent !== s) el.textContent = s; }
// long readouts ("12.51", "−1.55") step the big digits down so they fit the box
function fitReadout() { $("readout").classList.toggle("long", ($("ro-v").textContent || "").length >= 5); }
function setLamp(id, label, on, blink) {
  const el = $(id);
  el.textContent = label;
  el.classList.toggle("on", !!on);
  el.classList.toggle("blink", !!blink);
}
function setLegend(id, items) {
  $(id).innerHTML = items.map(([cls, txt]) => `<span class="lk ${cls}"><i></i>${esc(txt)}</span>`).join("");
}
function noData(id, msg) { $(id).innerHTML = `<div class="nodata">${esc(msg)}</div>`; }

function whyLines(st) {
  const out = [];
  if (st.floodLvl && st.kind === "u") out.push(`<b class="r">NWPS: ${st.floodLvl} FLOOD AT THIS SITE</b>`);
  else if (st.floodLvl) out.push(`<b class="r">${st.floodLvl} FLOOD · ≥ ${st.flood[st.floodLvl.toLowerCase()]?.toFixed(2) ?? st.flood.minor.toFixed(2)} FT</b>`);
  if (st.gale) out.push(`<b class="r">GALE FORCE WIND ${Math.round(st.windKt)} KT</b>`);
  const evs = new Map();
  for (const a of st.alerts) evs.set(a.event.toUpperCase(), a);
  for (const [k, a] of evs) out.push(`<span class="${a.kind === "warning" ? "r" : "y"}">NWS ${esc(k)}${a.ends ? ` → ${esc(ddhhmm(Date.parse(a.ends)))}` : ""}</span>`);
  if (st.reportsNear.length) out.push(`<span class="y">${st.reportsNear.length} FLOOD RPT${st.reportsNear.length > 1 ? "S" : ""} ≤${REPORT_KM} KM / ${REPORT_H}H</span>`);
  for (const v of st.riversNear) out.push(`<span class="y">NWPS ${esc(v.id)} ${esc(String(v.now || v.forecast || "").toUpperCase())}</span>`);
  if (!out.length) out.push(`<span class="dimt">NO ACTIVE ALERTS</span>`);
  return out.join("");
}

function renderStation() {
  const st = cur();
  document.body.classList.toggle("is-flood", !!st?.floodLvl);
  if (!st) {
    const msg = state.data && state.data.region === state.region ? "NO STATION" : "ACQUIRING";
    for (const id of ["vm", "g1", "g2", "hm1", "hm2"]) noData(id, msg);
    $("ro-sub").textContent = msg === "ACQUIRING" ? "ACQUIRING SIGNAL" : "SELECT A STATION";
    $("t-raw").innerHTML = "";
    $("t-raw-h").textContent = "RAW FEED";
    $("ro-why").innerHTML = "";
    setText("ro-v", "--.-");
    for (const id of ["hm1-v", "hm2-v"]) setText(id, "--");
    setLamp("lamp1", "FLOOD", false, false);
    setLamp("lamp2", "ALERT", false, false);
    $("readout").classList.remove("alarm");
    $("badge").classList.remove("alarm");
    setText("badge-1", "----");
    setText("badge-2", "STATION");
    setText("co-meta", msg === "ACQUIRING" ? `ACQUIRING ${R().name}` : "NO STATION SELECTED");
    setText("co-line", "LATITUDE --/--/--.- N - LONGITUDE ---/--/--.- W");
    return;
  }
  const now = Date.now();
  const W = WINS[state.win];
  const tz = R().tz;
  if (st.kind === "g") renderGauge(st, now, W, tz);
  else if (st.kind === "u") renderStream(st, now, W, tz);
  else renderBuoy(st, now, W, tz);
  $("ro-why").innerHTML = whyLines(st);
  $("readout").classList.toggle("alarm", !!st.floodLvl);
  fitReadout();
  renderIdent(st, tz);
  renderRaw(st, now, W, tz);
}

function renderGauge(st, now, W, tz) {
  const x0 = now - W, x1 = now + W / 3;
  const obsW = st.obs.filter((p) => p.t >= x0);
  let mx = null, mn = null;
  for (const p of obsW) { if (mx == null || p.v > mx) mx = p.v; if (mn == null || p.v < mn) mn = p.v; }
  const latest = st.latest;
  const minor = st.flood?.minor ?? null, moderate = st.flood?.moderate ?? null, mhhw = st.mhhw;

  setText("ro-k", "MAX");
  setText("ro-v", mx == null ? "--.-" : mx.toFixed(1));
  setText("ro-u", "FT");
  const nextH = st.extremes.find((e) => e.type === "H" && e.t > now);
  $("ro-sub").innerHTML =
    `<span>NOW <b>${latest ? latest.v.toFixed(2) : "--"}</b> FT · ${latest ? hhmm(latest.t, tz) : "--:--"}</span>` +
    `<span>NEXT HIGH ${nextH ? `<b>${nextH.v.toFixed(2)}</b> · ${hhmm(nextH.t, tz)}` : "--"}</span>`;
  setLamp("lamp1", "FLOOD", st.floodLvl, st.floodLvl);
  setLamp("lamp2", "ALERT", st.alert, false);

  // segmented meter scale: yellow from MHHW, red from the minor flood level
  let top = Math.max(mx ?? 0, latest?.v ?? 0) * 1.08;
  if (minor != null) top = Math.max(top, moderate ?? minor + 1, minor + 0.6);
  else if (mhhw != null) top = Math.max(top, mhhw + 1.5);
  top = Math.ceil(top);
  const bottom = Math.min(0, Math.floor(mn ?? 0));
  const yellowAt = mhhw ?? Infinity, redAt = minor ?? Infinity;
  const vm = $("vm");
  if (!obsW.length) noData("vm", "NO SIGNAL");
  else vMeter(vm, {
    cols: bins(st.obs, x0, now, meterCols(vm)), min: bottom, max: top, yellowAt, redAt,
    marks: [{ v: mhhw, label: "MHHW", cls: "yel" }, { v: minor, label: "MINOR", cls: "red" }],
    label: "Water level history",
  });
  setText("vm-l", minor != null ? `WATER LEVEL · ${st.flood.src} FLOOD ${minor.toFixed(1)}` : "WATER LEVEL · FT MLLW");

  // bar 1: level vs flood level
  if (latest) hMeter($("hm1"), { value: latest.v, min: bottom, max: top, yellowAt, redAt, marks: [{ v: minor, cls: "red" }], label: "Water level" });
  else noData("hm1", "NO SIGNAL");
  setText("hm1-v", latest ? latest.v.toFixed(2) : "--");
  setText("hm1-u", "FT MLLW");
  setText("hm1-l", latest && minor != null
    ? (latest.v >= minor ? `LEVEL · ${(latest.v - minor).toFixed(2)} FT ABOVE MINOR FLOOD` : `LEVEL · ${(minor - latest.v).toFixed(2)} FT BELOW MINOR FLOOD`)
    : "LEVEL · NO FLOOD THRESHOLD PUBLISHED");

  // bar 2: residual / surge
  if (st.residual != null) hMeter($("hm2"), { value: st.residual, min: -1, max: 3, yellowAt: RES.y, redAt: RES.r, label: "Residual" });
  else noData("hm2", "NO SIGNAL");
  setText("hm2-v", sgn(st.residual));
  setText("hm2-u", "FT");
  setText("hm2-l", "SURGE / RESIDUAL · OBS − PRED");

  const ticks = timeTicks(x0, x1, tz, state.win);
  const hoverTime = (t) => hhmm(t, tz);
  const marks = st.extremes.filter((e) => e.t > now).map((e) => ({ t: e.t, v: e.v, label: `${e.type} ${e.v.toFixed(1)}`, below: e.type === "L" }));
  lineGraph($("g1"), {
    x: [x0, x1],
    series: [
      { name: "OBS", pts: st.obs, cls: "obs", gap: 20 * MIN },
      { name: "PRED", pts: st.pred, cls: "pred", gap: 20 * MIN },
    ],
    hlines: [
      { v: minor, label: minor != null ? `MINOR FLOOD ${minor.toFixed(2)}` : "", cls: "red", force: W >= 24 * HOUR },
      { v: mhhw, label: mhhw != null ? `MHHW ${mhhw.toFixed(2)}` : "", cls: "yel" },
    ],
    ticks, marks, fcst: true,
    now: { t: now, label: latest ? latest.v.toFixed(2) : "" },
    digits: 2, minSpan: 1, hoverTime, label: `Water level, observed and predicted, ${st.name}`, empty: "NO SIGNAL",
  });
  setText("g1-l", "WATER LEVEL · FT MLLW");
  setLegend("g1-leg", [["obs", "OBS"], ["pred", "PRED"], ...(minor != null ? [["red", "MINOR FLOOD"]] : []), ...(mhhw != null ? [["yel", "MHHW"]] : [])]);

  lineGraph($("g2"), {
    x: [x0, x1],
    series: [{ name: "RES", pts: st.res, cls: "obs", gap: 20 * MIN }],
    hlines: [{ v: RES.y, label: `+${RES.y.toFixed(1)}`, cls: "yel" }],
    ticks, zero: true, fcst: true,
    now: { t: now, label: sgn(st.residual) },
    digits: 2, minSpan: 0.6, hoverTime, label: `Surge residual, ${st.name}`, empty: "NO SIGNAL",
  });
  setText("g2-l", "SURGE · OBSERVED − PREDICTED · FT");
  setLegend("g2-leg", [["obs", "RESIDUAL"], ["zero", "ZERO"]]);
}

/** Scale for a series that is only compared with itself: its own range, padded to whole feet. */
function ownScale(pts, minSpan = 0.5) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  if (!isFinite(lo)) return null;
  const step = hi - lo < 3 ? 0.5 : 1;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi - lo < minSpan) hi = lo + minSpan;
  return { min: lo, max: hi };
}

function renderBuoy(st, now, W, tz) {
  const x0 = now - W, x1 = now + W * 0.05;
  const waveW = st.wave.filter((p) => p.t >= x0);
  const levelW = st.level.filter((p) => p.t >= x0);
  const levelMode = st.windOnly && st.hasLevel; // Everglades / Florida Bay stations: water level, no waves
  let mx = null;
  for (const p of waveW) if (mx == null || p.v > mx) mx = p.v;
  if (levelMode) {
    setText("ro-k", "LEVEL");
    setText("ro-v", st.levelFt == null ? "--.-" : st.levelFt.toFixed(2));
    setText("ro-u", "FT");
  } else if (st.windOnly) {
    setText("ro-k", "WIND");
    setText("ro-v", st.windKt == null ? "--" : String(Math.round(st.windKt)));
    setText("ro-u", "KT");
  } else {
    setText("ro-k", "MAX");
    setText("ro-v", mx == null ? "--.-" : mx.toFixed(1));
    setText("ro-u", "FT");
  }
  const obsAt = `${st.updated ? hhmm(st.updated, tz) : "--:--"}${st.stale ? " · OLD" : ""}`;
  const lvl = st.hasLevel ? ` · LEVEL <b>${num(st.levelFt, 2)}</b> FT` : "";
  $("ro-sub").innerHTML =
    (levelMode ? `<span>LEVEL <b>${num(st.levelFt, 2)}</b> FT · ${obsAt}</span>`
      : st.windOnly ? `<span>OBS ${obsAt} · NO WAVES</span>` : `<span>NOW <b>${num(st.waveFt)}</b> FT · ${obsAt}</span>`) +
    `<span>SST <b>${num(st.sstF)}</b>°F · WIND <b>${st.windKt == null ? "--" : Math.round(st.windKt)}</b> KT ${compass(st.windDir)}</span>` +
    (lvl && !levelMode ? `<span>${lvl.slice(3)}</span>` : "");
  setLamp("lamp1", "GALE", st.gale, st.gale);
  setLamp("lamp2", "ALERT", st.alert, false);

  const vm = $("vm");
  if (waveW.length) {
    const top = Math.max(16, Math.ceil((mx ?? 0) * 1.15));
    vMeter(vm, {
      cols: bins(st.wave, x0, now, meterCols(vm)), min: 0, max: top, yellowAt: WAVE.y, redAt: WAVE.r,
      marks: [{ v: WAVE.y, label: `${WAVE.y}`, cls: "yel" }, { v: WAVE.r, label: `${WAVE.r}`, cls: "red" }],
      label: "Wave height history",
    });
    setText("vm-l", "WAVE HEIGHT · FT");
  } else if (levelW.length) {
    const sc = ownScale(st.level);
    vMeter(vm, { cols: bins(st.level, x0, now, meterCols(vm)), min: sc.min, max: sc.max, yellowAt: Infinity, redAt: Infinity, label: "Water level history" });
    setText("vm-l", "WATER LEVEL · FT");
  } else {
    noData("vm", st.windOnly ? "NO WAVE SENSOR" : "NO SIGNAL");
    setText("vm-l", "WAVE HEIGHT · FT");
  }

  if (st.windKt != null) hMeter($("hm1"), { value: st.windKt, min: 0, max: 50, yellowAt: WIND.y, redAt: WIND.r, marks: [{ v: WIND.r, cls: "red" }], label: "Wind speed" });
  else noData("hm1", "NO WIND SENSOR");
  setText("hm1-v", st.windKt == null ? "--" : String(Math.round(st.windKt)));
  setText("hm1-u", "KT");
  setText("hm1-l", st.windKt == null ? "WIND SPEED" : `WIND SPEED · ${st.windDir ?? "--"}° ${compass(st.windDir)}`);

  if (st.period != null) hMeter($("hm2"), { value: st.period, min: 0, max: 22, yellowAt: PERIOD.y, redAt: PERIOD.r, label: "Wave period" });
  else noData("hm2", "NO SIGNAL");
  setText("hm2-v", st.period == null ? "--" : String(Math.round(st.period)));
  setText("hm2-u", "SEC");
  setText("hm2-l", "DOMINANT WAVE PERIOD");

  const ticks = timeTicks(x0, x1, tz, state.win);
  const hoverTime = (t) => hhmm(t, tz);
  const levelGraph = (el, lab) => {
    lineGraph(el, {
      x: [x0, x1],
      series: [{ name: "LEVEL", pts: st.level, cls: "obs", gap: 3 * HOUR }],
      ticks, now: { t: now, label: st.levelFt != null ? st.levelFt.toFixed(2) : "" },
      digits: 2, minSpan: 0.5, hoverTime, label: `Water level, ${st.name}`, empty: "NO SIGNAL",
    });
    setText(lab, "WATER LEVEL · FT (NDBC TIDE)");
  };
  if (levelMode) {
    levelGraph($("g1"), "g1-l");
    setLegend("g1-leg", [["obs", "LEVEL"]]);
  } else {
    lineGraph($("g1"), {
      x: [x0, x1],
      series: [{ name: "WVHT", pts: st.wave, cls: "obs", gap: 3 * HOUR }],
      hlines: [{ v: WAVE.y, label: `${WAVE.y} FT`, cls: "yel" }, { v: WAVE.r, label: `${WAVE.r} FT`, cls: "red" }],
      ticks, now: { t: now, label: st.waveFt != null ? st.waveFt.toFixed(1) : "" },
      digits: 1, minSpan: 1, hoverTime, label: `Significant wave height, ${st.name}`, empty: st.windOnly ? "NO WAVE SENSOR" : "NO SIGNAL",
    });
    setText("g1-l", "SIGNIFICANT WAVE HEIGHT · FT");
    setLegend("g1-leg", [["obs", "WVHT"], ["yel", `${WAVE.y} FT`], ["red", `${WAVE.r} FT`]]);
  }

  // second graph: sea temperature, or water level when this buoy has level but no temperature
  if (!st.sst.length && st.hasLevel && !levelMode) {
    levelGraph($("g2"), "g2-l");
    setLegend("g2-leg", [["obs", "LEVEL"]]);
  } else {
    lineGraph($("g2"), {
      x: [x0, x1],
      series: [{ name: "SST", pts: st.sst, cls: "obs", gap: 3 * HOUR }],
      ticks, now: { t: now, label: st.sstF != null ? st.sstF.toFixed(1) : "" },
      digits: 1, minSpan: 1, hoverTime, label: `Sea surface temperature, ${st.name}`, empty: "NO TEMP SENSOR",
    });
    setText("g2-l", "SEA SURFACE TEMP · °F");
    setLegend("g2-leg", [["obs", "SST"]]);
  }
}

// USGS stream gauge. Stage is measured from the gauge's own zero, so every scale here is this gauge's own range.
function renderStream(st, now, W, tz) {
  const x0 = now - W, x1 = now + W * 0.05;
  const stageW = st.stage.filter((p) => p.t >= x0);
  setText("ro-k", "STAGE");
  setText("ro-v", st.stageFt == null ? "--.-" : fmtNum(st.stageFt, 2));
  setText("ro-u", "FT");
  const obsAt = `${st.updated ? hhmm(st.updated, tz) : "--:--"}${st.stale ? " · OLD" : ""}`;
  $("ro-sub").innerHTML =
    `<span>24H <b>${sgn(st.change24hFt)}</b> FT ${trendArrow(st)} ${trendWord(st)}</span>` +
    `<span>FLOW <b>${cfs(st.flowCfs)}</b> CFS · ${obsAt}</span>`;
  setLamp("lamp1", "FLOOD", st.floodLvl, st.floodLvl);
  setLamp("lamp2", "ALERT", st.alert, false);

  const vm = $("vm");
  const sc = ownScale(st.stage);
  if (stageW.length && sc) vMeter(vm, { cols: bins(st.stage, x0, now, meterCols(vm)), min: sc.min, max: sc.max, yellowAt: Infinity, redAt: Infinity, label: "Stage history" });
  else noData("vm", "NO SIGNAL");
  setText("vm-l", "STAGE · FT (OWN GAUGE ZERO)");

  if (st.change24hFt != null) hMeter($("hm1"), { value: st.change24hFt, min: -3, max: 3, yellowAt: RISE.y, redAt: RISE.r, marks: [{ v: 0 }], label: "Stage change over 24 hours" });
  else noData("hm1", "NO SIGNAL");
  setText("hm1-v", sgn(st.change24hFt));
  setText("hm1-u", "FT / 24H");
  setText("hm1-l", `24 H CHANGE · ${trendWord(st)}`);

  if (st.flowCfs != null) hMeter($("hm2"), { value: Math.log10(1 + Math.abs(st.flowCfs)), min: 0, max: 5, yellowAt: Infinity, redAt: Infinity, label: "Discharge, log scale" });
  else noData("hm2", "NO FLOW DATA");
  setText("hm2-v", cfs(st.flowCfs));
  setText("hm2-u", "CFS");
  setText("hm2-l", st.flowCfs != null && st.flowCfs < 0 ? "FLOW · REVERSED (TIDAL / PUMPED)" : "FLOW · LOG SCALE 1 → 100K CFS");

  const ticks = timeTicks(x0, x1, tz, state.win);
  const hoverTime = (t) => hhmm(t, tz);
  lineGraph($("g1"), {
    x: [x0, x1],
    series: [{ name: "STAGE", pts: st.stage, cls: "obs", gap: 2 * HOUR }],
    ticks, now: { t: now, label: st.stageFt != null ? st.stageFt.toFixed(2) : "" },
    digits: 2, minSpan: 0.5, hoverTime, label: `Stage, ${st.name}`, empty: "NO SIGNAL",
  });
  setText("g1-l", "STAGE · FT ABOVE GAUGE ZERO");
  setLegend("g1-leg", [["obs", "STAGE"]]);

  const lastRate = st.rate.length ? st.rate[st.rate.length - 1].v : null;
  lineGraph($("g2"), {
    x: [x0, x1],
    series: [{ name: "FT/H", pts: st.rate, cls: "obs", gap: 2 * HOUR }],
    ticks, zero: true, now: { t: now, label: lastRate != null ? sgn(lastRate) : "" },
    digits: 2, minSpan: 0.2, hoverTime, label: `Rate of stage change, ${st.name}`, empty: "NO SIGNAL",
  });
  setText("g2-l", "RATE OF CHANGE · FT / HOUR");
  setLegend("g2-leg", [["obs", "FT/H"], ["zero", "ZERO"]]);
}

function fitBadge() {
  const b = $("badge-1");
  let size = 36;
  b.style.fontSize = `${size}px`;
  while (size > 14 && b.scrollWidth > b.clientWidth + 1) { size -= 2; b.style.fontSize = `${size}px`; }
}

function renderIdent(st, tz) {
  let main, second;
  if (st.kind === "u") {
    const i = st.name.lastIndexOf(",");
    main = (i > 0 ? st.name.slice(0, i) : st.name).toUpperCase();
    second = `${i > 0 ? `${st.name.slice(i + 1).trim().toUpperCase()} · ` : ""}USGS GAUGE`;
  } else {
    const m = st.name.match(/^(.*?)\s*\((.*)\)\s*$/);
    main = (m ? m[1] : st.name).toUpperCase();
    const extra = m && !/^(wind|level|water)/i.test(m[2]) ? `${m[2].toUpperCase()} ` : "";
    const kindWord = st.kind === "g" ? "STATION" : st.windOnly ? (st.hasLevel ? "LEVEL STATION" : "WIND STATION") : "BUOY";
    second = `${extra}${kindWord}`;
  }
  setText("badge-1", main);
  setText("badge-2", second);
  $("badge").classList.toggle("alarm", !!st.floodLvl);
  fitBadge();
  const t = st.kind === "g" ? st.latest?.t : st.updated;
  const last = `LAST OBS ${t ? `${hhmm(t, tz)} ${tzAbbr(t, tz)} (${ago(t)})` : "--"}`;
  let meta;
  if (st.kind === "g") {
    meta = esc(`TIDE GAUGE ${st.id} · NOAA CO-OPS · DATUM MLLW · MHHW ${st.mhhw != null ? st.mhhw.toFixed(2) : "--"} · H2O ${st.temp ? st.temp.v.toFixed(1) + "°F" : "--"} · ${last}`);
  } else if (st.kind === "u") {
    meta = `<a href="${esc(usgsUrl(st.id))}" target="_blank" rel="noopener">USGS ${esc(st.id)} ↗</a> · ${esc(`STAGE ABOVE GAUGE ZERO · ${last}`)}`;
  } else {
    meta = esc(`${st.windOnly ? "MET STATION" : "WAVE BUOY"} ${st.id} · NOAA NDBC${st.hasLevel ? " · LEVEL FROM NDBC TIDE" : ""} · ${last}`);
  }
  $("co-meta").innerHTML = meta;
  setText("co-line", `LATITUDE ${dms(st.lat, true)} - LONGITUDE ${dms(st.lon, false)}`);
}

function renderRaw(st, now, W, tz) {
  const x0 = now - W;
  const head = $("t-raw-h");
  head.innerHTML = `RAW FEED <b>${esc(st.id)}</b> <span>${esc(state.win.toUpperCase())} · ${esc(tzAbbr(now, tz))}</span>`;
  let rows = "";
  let n = 0;
  const LIMIT = 800;
  if (st.kind === "g") {
    rows += `<thead><tr><th class="l">TIME</th><th>OBS</th><th>PRED</th><th>RES</th></tr></thead><tbody>`;
    for (let i = st.obs.length - 1; i >= 0 && n < LIMIT; i--) {
      const p = st.obs[i];
      if (p.t < x0) break;
      const pv = st.pm.get(p.t);
      const res = pv != null ? p.v - pv : null;
      const cls = st.flood?.minor != null && p.v >= st.flood.minor ? ' class="hot"' : "";
      rows += `<tr${cls}><td class="l">${ddhhmm(p.t, tz)}</td><td>${p.v.toFixed(2)}</td><td>${pv != null ? pv.toFixed(2) : "--"}</td><td>${res != null ? sgn(res) : "--"}</td></tr>`;
      n++;
    }
  } else if (st.kind === "u") {
    rows += `<thead><tr><th class="l">TIME</th><th>STAGE</th><th>FT/H</th></tr></thead><tbody>`;
    const rate = new Map(st.rate.map((p) => [p.t, p.v]));
    for (let i = st.stage.length - 1; i >= 0 && n < LIMIT; i--) {
      const p = st.stage[i];
      if (p.t < x0) break;
      const r = rate.get(p.t);
      rows += `<tr><td class="l">${ddhhmm(p.t, tz)}</td><td>${p.v.toFixed(2)}</td><td>${r != null ? sgn(r) : "--"}</td></tr>`;
      n++;
    }
  } else {
    rows += `<thead><tr><th class="l">TIME</th><th>WVHT</th><th>SST</th>${st.hasLevel ? "<th>LVL</th>" : ""}</tr></thead><tbody>`;
    const byT = new Map();
    const put = (pts, k) => { for (const p of pts) if (p.t >= x0) byT.set(p.t, { ...(byT.get(p.t) || {}), [k]: p.v }); };
    put(st.wave, "w");
    put(st.sst, "s");
    put(st.level, "l");
    const ts = [...byT.keys()].sort((a, b) => b - a).slice(0, LIMIT);
    for (const t of ts) {
      const r = byT.get(t);
      rows += `<tr><td class="l">${ddhhmm(t, tz)}</td><td>${r.w != null ? r.w.toFixed(1) : "--"}</td><td>${r.s != null ? r.s.toFixed(1) : "--"}</td>${st.hasLevel ? `<td>${r.l != null ? r.l.toFixed(2) : "--"}</td>` : ""}</tr>`;
      n++;
    }
  }
  if (!n) rows += `<tr><td class="l dimt" colspan="4">${st.windOnly ? `NO SERIES · WIND ${st.windKt != null ? Math.round(st.windKt) + " KT" : "--"} ${compass(st.windDir)}` : "NO READINGS IN WINDOW"}</td></tr>`;
  rows += `</tbody>`;
  $("t-raw").innerHTML = rows;
}

const TAB_NOTE = { g: "LATEST · FT MLLW", b: "LATEST · FT · S · KT · °F", u: "LATEST · STAGE FROM EACH GAUGE'S OWN ZERO" };
function renderRoster() {
  const d = state.data;
  const tz = R().tz;
  const tabs = { g: d ? d.gauges.length : 0, b: d ? d.buoys.length : 0, u: d ? d.usgs.length : 0 };
  for (const k of ["g", "b", "u"]) {
    const tab = $(`tab-${k}`);
    if (!tab) continue;
    const on = state.tab === k;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
    $(`t-${k}`).hidden = !on;
    $(`n-${k}`).textContent = String(tabs[k]);
  }
  if ($("tab-note")) $("tab-note").textContent = TAB_NOTE[state.tab] || "";
  if (!d) { for (const k of ["g", "b", "u"]) $(`t-${k}`).innerHTML = ""; return; }
  const short = (s) => esc((s.length > 22 ? s.slice(0, 21) + "…" : s).toUpperCase());
  const btn = (s) => `<td class="l"><button type="button" class="rb" data-id="${esc(s.id)}" aria-label="Select ${esc(s.name)}">${esc(s.id)}</button></td>`;
  const rowCls = (s, extra = "") => `${s.id === state.selId ? "sel" : ""}${s.stale ? " old" : ""}${extra}`;

  let g = `<thead><tr><th class="l">STN</th><th class="l">NAME</th><th>TIME</th><th>LVL</th><th>PRED</th><th>RES</th><th>MINOR</th><th>H2O°F</th><th>ST</th></tr></thead><tbody>`;
  for (const s of d.gauges) {
    const pv = s.latest ? s.pm.get(s.latest.t) : null;
    const st = s.floodLvl ? `<span class="r">FLD</span>` : s.alert ? `<span class="y">ALR</span>` : s.stale ? `<span class="dimt">OLD</span>` : "OK";
    g += `<tr data-id="${esc(s.id)}" class="${rowCls(s, s.floodLvl ? " hot" : "")}">${btn(s)}` +
      `<td class="l">${short(s.name)}</td><td>${s.latest ? hhmm(s.latest.t, tz) : "--"}</td>` +
      `<td>${s.latest ? s.latest.v.toFixed(2) : "--"}</td><td>${pv != null ? pv.toFixed(2) : "--"}</td><td>${sgn(s.residual)}</td>` +
      `<td>${s.flood?.minor != null ? s.flood.minor.toFixed(2) : "--"}</td><td>${s.temp ? s.temp.v.toFixed(1) : "--"}</td><td>${st}</td></tr>`;
  }
  if (!d.gauges.length) g += `<tr><td class="l dimt" colspan="9">NO TIDE GAUGE DATA</td></tr>`;
  $("t-g").innerHTML = g + "</tbody>";

  let b = `<thead><tr><th class="l">STN</th><th class="l">NAME</th><th>TIME</th><th>WVHT</th><th>DPD</th><th>WSPD</th><th>WDIR</th><th>SST</th><th>LVL</th><th>ST</th></tr></thead><tbody>`;
  for (const s of d.buoys) {
    const st = s.gale ? `<span class="r">GALE</span>` : s.alert ? `<span class="y">ALR</span>` : s.stale ? `<span class="dimt">OLD</span>` : "OK";
    const wcls = s.waveLvl === 2 ? "r" : s.waveLvl === 1 ? "y" : "";
    b += `<tr data-id="${esc(s.id)}" class="${rowCls(s)}">${btn(s)}` +
      `<td class="l">${short(shortName(s.name))}</td><td>${s.updated ? hhmm(s.updated, tz) : "--"}</td>` +
      `<td><span class="${wcls}">${num(s.waveFt)}</span></td><td>${s.period ?? "--"}</td><td>${num(s.windKt)}</td>` +
      `<td>${s.windDir != null ? String(s.windDir).padStart(3, "0") : "--"}</td><td>${num(s.sstF)}</td><td>${num(s.levelFt, 2)}</td><td>${st}</td></tr>`;
  }
  if (!d.buoys.length) b += `<tr><td class="l dimt" colspan="10">NO BUOY DATA</td></tr>`;
  $("t-b").innerHTML = b + "</tbody>";

  let u = `<thead><tr><th class="l">STN</th><th class="l">NAME</th><th>TIME</th><th>STAGE</th><th>24H Δ</th><th class="l">TREND</th><th>FLOW CFS</th><th>ST</th></tr></thead><tbody>`;
  for (const s of d.usgs) {
    const st = s.floodLvl ? `<span class="r">FLD</span>` : s.alert ? `<span class="y">ALR</span>` : s.stale ? `<span class="dimt">OLD</span>` : "OK";
    const tcls = s.change24hFt != null && s.change24hFt >= RISE.r ? "r" : s.change24hFt != null && s.change24hFt >= RISE.y ? "y" : "";
    u += `<tr data-id="${esc(s.id)}" class="${rowCls(s, s.floodLvl ? " hot" : "")}">${btn(s)}` +
      `<td class="l">${short(s.name)}</td><td>${s.updated ? hhmm(s.updated, tz) : "--"}</td>` +
      `<td>${num(s.stageFt, 2)}</td><td><span class="${tcls}">${sgn(s.change24hFt)}</span></td>` +
      `<td class="l"><span class="${tcls}">${trendArrow(s)} ${trendWord(s)}</span></td><td>${cfs(s.flowCfs)}</td><td>${st}</td></tr>`;
  }
  if (!d.usgs.length) u += `<tr><td class="l dimt" colspan="8">NO STREAM GAUGES IN THIS REGION</td></tr>`;
  $("t-u").innerHTML = u + "</tbody>";

  // keep the selected row visible inside its own scroller (never scroll the page)
  const row = document.querySelector(".tbl table:not([hidden]) tr.sel");
  if (row) {
    const box = row.closest(".tbl-b");
    const head = row.closest("table").tHead?.offsetHeight || 0;
    if (row.offsetTop - head < box.scrollTop) box.scrollTop = row.offsetTop - head;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }
}

function renderMapTag() {
  const d = state.data;
  const r = R();
  const met = d ? d.buoys.filter((b) => b.windOnly).length : 0;
  $("map-tag").innerHTML = `<b>${esc(r.name)}</b>${d && d.region === state.region ? ` · ${d.gauges.length} TIDE · ${d.buoys.length - met} BUOY${met ? ` · ${met} MET` : ""}${d.usgs.length ? ` · ${d.usgs.length} STREAM` : ""}` : " · ACQUIRING"}`;
}

function renderMenu() {
  const box = $("m-region");
  const have = [...box.querySelectorAll("[data-region]")].map((b) => b.dataset.region).join();
  if (have !== REGION_IDS.join()) {
    for (const b of box.querySelectorAll("[data-region]")) b.remove();
    for (const id of REGION_IDS) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.region = id;
      b.textContent = REGIONS[id].code;
      box.append(b);
    }
  }
  for (const b of document.querySelectorAll("#m-region [data-region]")) {
    const on = b.dataset.region === state.region;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  }
  for (const b of document.querySelectorAll("#m-win [data-win]")) {
    const on = b.dataset.win === state.win;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  }
  applyLayers();
}

function renderAll() {
  renderHeader();
  renderMapTag();
  renderMenu();
  renderMarkers();
  renderReportMarkers();
  renderAlertsLayer();
  renderRoster();
  renderStation();
  writeUrl();
}

// ---------------------------------------------------------------- actions
function announce(msg) { const el = $("live"); el.textContent = ""; requestAnimationFrame(() => { el.textContent = msg; }); }

function select(id, { pan = true, remember = true } = {}) {
  const st = state.data?.byId.get(id);
  if (!st) return;
  state.selId = id;
  state.want = id;
  state.tab = st.kind;
  if (remember) savePick(state.region, id);
  updateMarkerStates();
  renderRoster();
  renderStation();
  writeUrl();
  if (pan && map && !map.getBounds().contains([st.lon, st.lat])) map.easeTo({ center: [st.lon, st.lat], duration: 500 });
  const v = st.kind === "g" ? (st.latest ? `${st.latest.v.toFixed(2)} feet` : "no reading")
    : st.kind === "u" ? (st.stageFt != null ? `stage ${st.stageFt} feet, ${trendWord(st).toLowerCase()}` : "no reading")
    : st.waveFt != null ? `waves ${st.waveFt} feet` : st.levelFt != null ? `water level ${st.levelFt} feet` : "no wave reading";
  announce(`${st.name}, ${v}${st.floodLvl ? ", flooding" : ""}${st.alert ? ", alert" : ""}`);
}

function stepStation(dir) {
  const d = state.data;
  if (!d) return;
  const list = [...(state.layers.g ? d.gauges : []), ...(state.layers.b ? d.buoys : []), ...(state.layers.u ? d.usgs : [])];
  if (!list.length) return;
  const i = list.findIndex((s) => s.id === state.selId);
  select(list[(i + dir + list.length) % list.length].id);
}

function setRegion(id) {
  if (!REGIONS[id] || (id === state.region && state.data?.region === id)) return;
  state.region = id;
  state.selId = null;
  state.want = wantFor(id);
  state.data = null;
  state.needFit = true;
  if (popup) popup.remove();
  const r = R();
  if (map) {
    map.setMaxBounds(null);
    map.jumpTo({ center: r.center, zoom: r.zoom - 0.9 });
    map.setMaxBounds(r.maxBounds);
  }
  for (const { m } of markers.values()) m.remove();
  markers.clear();
  for (const m of reportMarkers) m.remove();
  reportMarkers = [];
  renderHeader();
  renderMapTag();
  renderMenu();
  renderRoster();
  renderStation();
  renderAlertsLayer();
  tickClock();
  writeUrl();
  announce(`Region ${r.name}`);
  load({ fit: true });
}

function setWin(w) {
  if (!WINS[w] || w === state.win) return;
  state.win = w;
  renderMenu();
  renderReportMarkers();
  renderStation();
  writeUrl();
  announce(`Timeline ${w}`);
}

function toggleLayer(k) {
  state.layers[k] = !state.layers[k];
  applyLayers();
  try { localStorage.setItem("tido.layers", JSON.stringify(state.layers)); } catch { /* private mode */ }
}

function toggleHelp(force) {
  const h = $("help");
  const show = force ?? h.hidden;
  h.hidden = !show;
  $("m-help").setAttribute("aria-expanded", show ? "true" : "false");
  if (show) $("help-x").focus();
}

// ---------------------------------------------------------------- theme
// LIGHT (paper) is the default. A choice saved here wins; otherwise follow the alola.lol site theme cookie:
// missing, "white", "light" or "sepia" -> LIGHT; any other value (the dark palettes) -> CRT.
const LIGHT_SITE_THEMES = new Set(["", "white", "light", "sepia"]);
function cookieTheme() {
  const m = document.cookie.match(/(?:^|;\s*)alola-theme=([^;]*)/);
  let v = "";
  try { v = m ? decodeURIComponent(m[1]).trim().toLowerCase() : ""; } catch { v = ""; }
  // "alola" without alola-theme-picked=alola is EMON's old unasked default (before 2026-11-25), not a choice
  if (v === "alola" && !/(?:^|;\s*)alola-theme-picked=alola(?:;|$)/.test(document.cookie)) v = "";
  return LIGHT_SITE_THEMES.has(v) ? "light" : "crt";
}
function initialTheme() {
  const pre = document.documentElement.dataset.theme; // set by the inline script in index.html
  if (THEMES.includes(pre)) return pre;
  try { const t = localStorage.getItem("tido.theme"); if (THEMES.includes(t)) return t; } catch { /* ignore */ }
  return cookieTheme();
}
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.theme === "crt" ? "#000000" : "#f3f2ea");
  for (const b of document.querySelectorAll("#m-theme [data-theme-set]")) {
    const on = b.dataset.themeSet === state.theme;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  }
}
function setTheme(t, save) {
  if (!THEMES.includes(t)) return;
  state.theme = t;
  if (save) { try { localStorage.setItem("tido.theme", t); } catch { /* private mode */ } }
  applyTheme();
  if (map && mapReady) applyPalette(map, t);
  announce(`Theme ${t === "crt" ? "CRT" : "light"}`);
}

// ---------------------------------------------------------------- URL
// ?station=ID wins over the saved pick and the region default; ?region= and ?t= (timeline) are optional.
// The page keeps the URL in step (replaceState), so a reload or a shared link reopens the same view.
// Older #/region/station/window links are still read once and rewritten.
function readUrl() {
  const q = new URLSearchParams(location.search);
  let region = q.get("region");
  let station = q.get("station");
  let win = q.get("t");
  if (!region && !station && location.hash.startsWith("#/")) {
    const [, r, id, w] = location.hash.split("/");
    region = r;
    try { station = id ? decodeURIComponent(id) : null; } catch { station = null; }
    win = win || w;
  }
  station = station ? station.trim().toUpperCase().slice(0, 16) : null;
  const home = station ? regionOfStation(station) : null;
  if (home) region = home;
  if (REGIONS[region]) state.region = region;
  if (station) { state.want = station; state.lookup = !home; }
  if (win && WINS[win.toLowerCase()]) state.win = win.toLowerCase();
}
function writeUrl() {
  const q = new URLSearchParams({ region: state.region });
  if (state.selId) q.set("station", state.selId);
  q.set("t", state.win);
  const url = `${location.pathname}?${q}`;
  if (location.search !== `?${q}` || location.hash) history.replaceState(null, "", url);
}

/** A ?station= id this page's catalog does not know: look for it in the other regions' snapshots. */
async function locateStation(id) {
  for (const r of REGION_IDS) {
    if (r === state.region) continue;
    const res = await Promise.allSettled([getSnap("tides", r), getSnap("buoys", r), getSnap("gauges", r)]);
    const ids = [...(res[0].value?.data?.stations || []), ...(res[1].value?.data?.buoys || []), ...(res[2].value?.data?.gauges || [])].map((s) => String(s.id).toUpperCase());
    if (ids.includes(id)) return r;
  }
  return null;
}

// ---------------------------------------------------------------- wiring
function wire() {
  $("m-region").addEventListener("click", (e) => { const b = e.target.closest("[data-region]"); if (b) setRegion(b.dataset.region); });
  $("m-win").addEventListener("click", (e) => { const b = e.target.closest("[data-win]"); if (b) setWin(b.dataset.win); });
  $("m-layers").addEventListener("click", (e) => { const b = e.target.closest("[data-layer]"); if (b) toggleLayer(b.dataset.layer); });
  $("m-help").addEventListener("click", () => toggleHelp());
  $("m-theme")?.addEventListener("click", (e) => { const b = e.target.closest("[data-theme-set]"); if (b) setTheme(b.dataset.themeSet, true); });
  $("help-x").addEventListener("click", () => { toggleHelp(false); $("m-help").focus(); });

  // roving arrows inside the two radio groups
  for (const gid of ["m-region", "m-win", "m-theme", "r-tabs"]) {
    $(gid)?.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const btns = [...$(gid).querySelectorAll("button")];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      const n = btns[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + btns.length) % btns.length];
      n.click();
      n.focus();
      e.preventDefault();
      e.stopPropagation();
    });
  }

  $("r-tabs")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b || b.dataset.tab === state.tab) return;
    state.tab = b.dataset.tab;
    b.closest(".tbl").querySelector(".tbl-b").scrollTop = 0;
    renderRoster();
  });
  for (const tid of ["t-g", "t-b", "t-u"]) {
    $(tid).addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) select(tr.dataset.id); });
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const inMap = !!(t && t.closest && t.closest(".maplibregl-canvas-container, .maplibregl-canvas"));
    const k = e.key;
    if (k === "?") toggleHelp();
    else if (k === "Escape") { if (!$("help").hidden) { toggleHelp(false); $("m-help").focus(); } else if (popup) popup.remove(); else return; }
    else if (k >= "1" && k <= "4") setWin(WIN_IDS[+k - 1]);
    else if (k === "r" || k === "R") { const i = REGION_IDS.indexOf(state.region); setRegion(REGION_IDS[(i + (e.shiftKey ? -1 : 1) + REGION_IDS.length) % REGION_IDS.length]); }
    else if (k === "g" || k === "G") toggleLayer("g");
    else if (k === "b" || k === "B") toggleLayer("b");
    else if (k === "s" || k === "S") toggleLayer("u");
    else if (k === "f" || k === "F") toggleLayer("r");
    else if (k === "a" || k === "A") toggleLayer("a");
    else if (k === "t" || k === "T") setTheme(state.theme === "light" ? "crt" : "light", true);
    else if (k === "j" || k === "J" || (k === "ArrowRight" && !inMap)) stepStation(1);
    else if (k === "k" || k === "K" || (k === "ArrowLeft" && !inMap)) stepStation(-1);
    else return;
    e.preventDefault();
  });

  // re-draw instruments when their boxes change size
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { renderStation(); });
  });
  for (const id of ["g1", "g2", "vm", "hm1", "hm2"]) ro.observe($(id));
  narrowMQ.addEventListener?.("change", () => { if (map) map.cooperativeGestures?.[narrowMQ.matches ? "enable" : "disable"]?.(); });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - state.fetchedAt > REFRESH_MS) load({ force: true });
  });
}

function boot() {
  try {
    const saved = JSON.parse(localStorage.getItem("tido.layers") || "null");
    if (saved && typeof saved === "object") for (const k of Object.keys(state.layers)) if (typeof saved[k] === "boolean") state.layers[k] = saved[k];
  } catch { /* ignore */ }
  state.theme = initialTheme();
  applyTheme();
  readUrl();
  if (!state.want) state.want = wantFor(state.region);
  wire();
  renderHeader();
  renderMapTag();
  renderMenu();
  renderStation();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => { if (state.data) { renderStation(); renderHeader(); } }, MIN);
  setInterval(() => load({ force: true }), REFRESH_MS);
  try {
    if (!window.maplibregl) throw new Error("maplibre missing");
    initMap();
  } catch (e) {
    $("map").innerHTML = `<div class="nodata">MAP OFFLINE</div>`;
    console.error(e);
  }
  load({ fit: true });
}

boot();
