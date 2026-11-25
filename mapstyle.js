// Monochrome basemaps from the OSM US Tileservice (OpenMapTiles schema).
//   light  paper land, white sea, dark green ink coastline (the default)
//   crt    black sea, near-black land with a faint raster texture, glowing green coastline

export const PALETTES = {
  light: {
    land: "#eeede3",
    water: "#ffffff",
    coast: "#1f6e35",
    coastGlow: "#1f6e35",
    coastGlowOpacity: 0,
    urban: "#e4e9de",
    park: "#e1eadc",
    road: "#cbd9cc",
    motorway: "#a3c1aa",
    boundary: "#98b5a0",
    labelDim: "#46745a",
    halo: "#f4f3ec",
    grat: "#d2e0d4",
    alertFill: "#e0253a",
    alertLine: "#d81b32",
  },
  crt: {
    land: "#020f05",
    water: "#000000",
    coast: "#39ff6a",
    coastGlow: "#1fd34e",
    coastGlowOpacity: 0.35,
    urban: "#042a0f",
    park: "#03190a",
    road: "#0b4a1d",
    motorway: "#12702c",
    boundary: "#0f5c25",
    labelDim: "#1a8c3a",
    halo: "#000000",
    grat: "#0a3a17",
    alertFill: "#ff2d3f",
    alertLine: "#ff4a5a",
  },
};
export const THEMES = Object.keys(PALETTES);
const pal = (theme) => PALETTES[theme] || PALETTES.light;
// kept for older callers
export const P = PALETTES.crt;

const name = ["coalesce", ["get", "name:en"], ["get", "name"]];

export function buildStyle(theme = "light") {
  const C = pal(theme);
  return {
    version: 8,
    name: `TIDO ${theme}`,
    glyphs: "https://tiles.openstreetmap.us/fonts/{fontstack}/{range}.pbf",
    sources: {
      omt: { type: "vector", url: "https://tiles.openstreetmap.us/vector/openmaptiles.json" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.land } },
      {
        id: "landuse-urban",
        type: "fill",
        source: "omt",
        "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial", "retail"]]],
        paint: { "fill-color": C.urban, "fill-opacity": 0.85 },
      },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": C.park, "fill-opacity": 0.8 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": C.water } },
      {
        id: "coast-glow",
        type: "line",
        source: "omt",
        "source-layer": "water",
        paint: {
          "line-color": C.coastGlow,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 12, 6],
          "line-blur": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 12, 5],
          "line-opacity": C.coastGlowOpacity,
        },
      },
      {
        id: "coast",
        type: "line",
        source: "omt",
        "source-layer": "water",
        paint: {
          "line-color": C.coast,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 12, 1.6],
        },
      },
      {
        id: "waterway",
        type: "line",
        source: "omt",
        "source-layer": "waterway",
        minzoom: 8,
        paint: { "line-color": C.road, "line-width": 0.7 },
      },
      {
        id: "road-major",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 8,
        filter: ["in", ["get", "class"], ["literal", ["primary", "trunk"]]],
        paint: { "line-color": C.road, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 14, 2] },
      },
      {
        id: "road-motorway",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 6,
        filter: ["==", ["get", "class"], "motorway"],
        paint: { "line-color": C.motorway, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 14, 2.5] },
      },
      {
        id: "boundary",
        type: "line",
        source: "omt",
        "source-layer": "boundary",
        filter: ["<=", ["to-number", ["get", "admin_level"], 99], 4],
        paint: { "line-color": C.boundary, "line-dasharray": [3, 3], "line-width": 0.8 },
      },
      {
        id: "place-city",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        filter: ["==", ["get", "class"], "city"],
        layout: {
          "text-field": name,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10, 12, 14],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.12,
        },
        paint: { "text-color": C.labelDim, "text-halo-color": C.halo, "text-halo-width": 1.4 },
      },
      {
        id: "place-town",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        minzoom: 9.5,
        filter: ["in", ["get", "class"], ["literal", ["town", "suburb"]]],
        layout: {
          "text-field": name,
          "text-font": ["Noto Sans Regular"],
          "text-size": 10,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.1,
        },
        paint: { "text-color": C.labelDim, "text-halo-color": C.halo, "text-halo-width": 1.2, "text-opacity": 0.8 },
      },
    ],
  };
}

/** Re-colour a loaded map in place (keeps sources, overlays and markers). */
export function applyPalette(map, theme) {
  const C = pal(theme);
  const set = (id, prop, v) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); };
  set("bg", "background-color", C.land);
  if (map.hasImage && map.hasImage(`scan-${theme}`)) set("bg", "background-pattern", `scan-${theme}`);
  set("landuse-urban", "fill-color", C.urban);
  set("park", "fill-color", C.park);
  set("water", "fill-color", C.water);
  set("coast-glow", "line-color", C.coastGlow);
  set("coast-glow", "line-opacity", C.coastGlowOpacity);
  set("coast", "line-color", C.coast);
  set("waterway", "line-color", C.road);
  set("road-major", "line-color", C.road);
  set("road-motorway", "line-color", C.motorway);
  set("boundary", "line-color", C.boundary);
  for (const id of ["place-city", "place-town"]) {
    set(id, "text-color", C.labelDim);
    set(id, "text-halo-color", C.halo);
  }
  set("grat", "line-color", C.grat);
  set("alerts-fill", "fill-color", C.alertFill);
  set("alerts-line", "line-color", C.alertLine);
}

/** Lat/lon graticule lines every `step` degrees across the region bounds. */
export function graticule([[w, s], [e, n]], step = 0.5) {
  const features = [];
  const r = (v) => Math.round(v * 1e6) / 1e6;
  for (let x = Math.ceil(w / step) * step; x <= e; x += step) {
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[r(x), s], [r(x), n]] } });
  }
  for (let y = Math.ceil(s / step) * step; y <= n; y += step) {
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[w, r(y)], [e, r(y)]] } });
  }
  return { type: "FeatureCollection", features };
}

/** Faint horizontal raster lines for the land fill (an 8x4 tile). */
export function scanImage(theme = "crt") {
  const w = 8, h = 4;
  const [on, off] = theme === "light" ? [[226, 225, 212], [238, 237, 227]] : [[6, 40, 14], [2, 15, 5]];
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = y === 0 ? on : off;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
