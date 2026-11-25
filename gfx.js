// SVG instruments: line graphs and segmented LED meters. Each draws into a
// container at its current pixel size; callers re-draw on resize. All colours
// come from CSS (style.css), so the light and CRT themes share this code.

export const COL = {
  phos: "#39ff6a",
  phosMid: "#22c24a",
  dim: "#0f5a22",
  faint: "#082e12",
  unlit: "#06200c",
  white: "#f1fff4",
  yellow: "#f4ec3c",
  orange: "#ffa92b",
  red: "#ff2d3f",
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const f1 = (n) => Math.round(n * 10) / 10;

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export function niceTicks(lo, hi, count) {
  const step = niceStep(hi - lo, count);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return { ticks: out, step };
}

const decimals = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
const fmtNum = (v, d) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(d);

function nearest(pts, t) {
  let lo = 0, hi = pts.length - 1;
  if (hi < 0) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(pts[lo].t - t) <= Math.abs(pts[hi].t - t) ? pts[lo] : pts[hi];
}

function pathD(pts, X, Y, x0, x1, gap) {
  let d = "";
  let prev = null;
  for (const p of pts) {
    if (p.t < x0 - gap || p.t > x1 + gap) { prev = null; continue; }
    const cmd = prev && p.t - prev.t <= gap ? "L" : "M";
    d += `${cmd}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`;
    prev = p;
  }
  return d;
}

function emptySvg(w, h, msg) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <text x="${w / 2}" y="${h / 2}" class="g-empty" text-anchor="middle" dominant-baseline="middle">${esc(msg)}</text></svg>`;
}

/**
 * Line graph.
 *  o.x        [t0, t1]
 *  o.series   [{ name, pts:[{t,v}], cls, gap }]  first one is the primary trace
 *  o.hlines   [{ v, label, cls, force }]
 *  o.ticks    [{ t, major, label, sub }]
 *  o.now      { t, label }  vertical cursor
 *  o.fcst     shade the area right of the cursor
 *  o.marks    [{ t, v, label, below }]
 *  o.zero     include and draw 0
 *  o.unit, o.digits, o.minSpan, o.empty, o.hoverTime(t) -> string
 */
export function lineGraph(el, o) {
  const w = Math.max(160, Math.floor(el.clientWidth));
  const h = Math.max(90, Math.floor(el.clientHeight));
  const m = { l: 42, r: 10, t: 22, b: 32 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const [x0, x1] = o.x;
  let lo = Infinity, hi = -Infinity;
  for (const s of o.series) for (const p of s.pts) if (p.t >= x0 && p.t <= x1) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  if (!isFinite(lo)) { el.innerHTML = emptySvg(w, h, o.empty || "NO SIGNAL"); el._g = null; return; }
  const span0 = Math.max(hi - lo, o.minSpan || 0.5);
  for (const l of o.hlines || []) {
    if (l.v == null || !isFinite(l.v)) continue;
    if (l.force || (l.v <= hi + span0 * 0.6 && l.v >= lo - span0 * 0.6)) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); }
  }
  if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const minSpan = o.minSpan || 0.5;
  if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
  const pad = (hi - lo) * 0.1;
  lo -= pad; hi += pad;
  const X = (t) => m.l + ((t - x0) / (x1 - x0)) * iw;
  const Y = (v) => m.t + ((hi - v) / (hi - lo)) * ih;
  const { ticks: yt, step: ys } = niceTicks(lo, hi, Math.max(2, Math.floor(ih / 30)));
  const yd = Math.max(decimals(ys), o.digitsAxis ?? 0);
  const clipId = `c${Math.random().toString(36).slice(2, 8)}`;

  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.label || "graph")}">`;
  s += `<defs><clipPath id="${clipId}"><rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/></clipPath></defs>`;

  // forecast shading
  if (o.now && o.fcst) {
    const xn = X(o.now.t);
    s += `<rect class="g-fcst" x="${xn}" y="${m.t}" width="${Math.max(0, m.l + iw - xn)}" height="${ih}"/>`;
    if (m.l + iw - xn > 40) s += `<text class="g-fcst-t" x="${xn + 5}" y="${m.t + 11}">FCST</text>`;
  }
  // grid
  for (const v of yt) s += `<line class="g-grid" x1="${m.l}" x2="${m.l + iw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
  for (const tk of o.ticks || []) if (tk.major) s += `<line class="g-grid" x1="${X(tk.t).toFixed(1)}" x2="${X(tk.t).toFixed(1)}" y1="${m.t}" y2="${m.t + ih}"/>`;
  if (o.zero && 0 > lo && 0 < hi) s += `<line class="g-zero" x1="${m.l}" x2="${m.l + iw}" y1="${Y(0)}" y2="${Y(0)}"/>`;

  // reference lines
  s += `<g clip-path="url(#${clipId})">`;
  for (const l of o.hlines || []) {
    if (l.v == null || l.v < lo || l.v > hi) continue;
    const y = Y(l.v).toFixed(1);
    s += `<line class="g-h ${l.cls || ""}" x1="${m.l}" x2="${m.l + iw}" y1="${y}" y2="${y}"/>`;
    s += `<text class="g-hl ${l.cls || ""}" x="${m.l + 4}" y="${+y - 3}">${esc(l.label)}</text>`;
  }
  // traces (secondary first so the primary draws on top)
  for (let i = o.series.length - 1; i >= 0; i--) {
    const sr = o.series[i];
    const d = pathD(sr.pts, X, Y, x0, x1, sr.gap || Infinity);
    if (d) s += `<path class="g-line ${sr.cls || ""}" d="${d}"/>`;
  }
  for (const mk of o.marks || []) {
    if (mk.t < x0 || mk.t > x1 || mk.v < lo || mk.v > hi) continue;
    const x = X(mk.t).toFixed(1), y = Y(mk.v);
    let below = !!mk.below;
    if (below && y + 20 > m.t + ih) below = false;
    else if (!below && y - 20 < m.t) below = true;
    s += `<path class="g-mark" d="M${x} ${(y + (below ? 4 : -4)).toFixed(1)}l-3.5 ${below ? 6 : -6}h7z"/>`;
    const tx = Math.min(Math.max(+x, m.l + 18), m.l + iw - 18).toFixed(1);
    s += `<text class="g-mark-t" x="${tx}" y="${(below ? y + 19 : y - 12).toFixed(1)}" text-anchor="middle">${esc(mk.label)}</text>`;
  }
  s += `</g>`;

  // axes + ticks
  s += `<path class="g-axis" d="M${m.l} ${m.t}V${m.t + ih}H${m.l + iw}"/>`;
  for (const v of yt) {
    const y = Y(v).toFixed(1);
    s += `<line class="g-axis" x1="${m.l - 6}" x2="${m.l}" y1="${y}" y2="${y}"/>`;
    s += `<text class="g-yl" x="${m.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtNum(v, yd)}</text>`;
  }
  for (const tk of o.ticks || []) {
    const x = X(tk.t).toFixed(1);
    const len = tk.major ? 8 : 4;
    s += `<line class="g-axis" x1="${x}" x2="${x}" y1="${m.t + ih}" y2="${m.t + ih - len}"/>`;
    if (tk.label) {
      s += `<text class="g-xl" x="${x}" y="${m.t + ih + 12}" text-anchor="middle">${esc(tk.label)}</text>`;
      if (tk.sub) s += `<text class="g-xl g-xs" x="${x}" y="${m.t + ih + 24}" text-anchor="middle">${esc(tk.sub)}</text>`;
    }
  }

  // now cursor with value box
  if (o.now && o.now.t >= x0 && o.now.t <= x1) {
    const xn = X(o.now.t).toFixed(1);
    s += `<line class="g-now" x1="${xn}" x2="${xn}" y1="${m.t - 2}" y2="${m.t + ih}"/>`;
    if (o.now.label) {
      const bw = Math.max(30, o.now.label.length * 7 + 10);
      const bx = Math.min(Math.max(+xn - bw / 2, m.l), m.l + iw - bw);
      s += `<rect class="g-nowbox" x="${bx}" y="${m.t - 20}" width="${bw}" height="15"/>`;
      s += `<text class="g-nowt" x="${bx + bw / 2}" y="${m.t - 9}" text-anchor="middle">${esc(o.now.label)}</text>`;
    }
    const prim = o.series[0];
    const last = prim && prim.pts.length ? prim.pts[prim.pts.length - 1] : null;
    if (last && last.t >= x0 && last.t <= x1) s += `<circle class="g-dot" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="3"/>`;
  }
  s += `<g class="g-hov" visibility="hidden"><line class="g-hovl" y1="${m.t}" y2="${m.t + ih}"/><circle class="g-hovd" r="3.5"/><rect class="g-hovbox" y="${m.t + 2}" height="16"/><text class="g-hovt" y="${m.t + 14}"></text></g>`;
  s += `</svg>`;
  el.innerHTML = s;
  el._g = { o, X, Y, m, iw, ih, x0, x1, lo, hi };
  if (!el._hov) bindHover(el);
}

function bindHover(el) {
  el._hov = true;
  const hide = () => { const g = el.querySelector(".g-hov"); if (g) g.setAttribute("visibility", "hidden"); };
  el.addEventListener("pointerleave", hide);
  el.addEventListener("pointermove", (ev) => {
    const G = el._g;
    if (!G) return;
    const r = el.getBoundingClientRect();
    const px = ev.clientX - r.left;
    if (px < G.m.l || px > G.m.l + G.iw) return hide();
    const t = G.x0 + ((px - G.m.l) / G.iw) * (G.x1 - G.x0);
    const prim = G.o.series[0];
    const p = nearest(prim.pts, t);
    if (!p || Math.abs(p.t - t) > (prim.gap || 3600e3)) return hide();
    const parts = [G.o.hoverTime ? G.o.hoverTime(p.t) : ""];
    for (const sr of G.o.series) {
      const q = nearest(sr.pts, p.t);
      if (q && Math.abs(q.t - p.t) <= (sr.gap || 3600e3) / 2) parts.push(`${sr.name} ${fmtNum(q.v, G.o.digits ?? 2)}`);
    }
    const txt = parts.filter(Boolean).join("  ");
    const g = el.querySelector(".g-hov");
    const x = G.X(p.t);
    g.setAttribute("visibility", "visible");
    const ln = g.querySelector(".g-hovl"); ln.setAttribute("x1", x); ln.setAttribute("x2", x);
    const d = g.querySelector(".g-hovd"); d.setAttribute("cx", x); d.setAttribute("cy", G.Y(p.v));
    const tw = txt.length * 6.3 + 10;
    const bx = x + tw + 8 > G.m.l + G.iw ? x - tw - 6 : x + 6;
    const box = g.querySelector(".g-hovbox"); box.setAttribute("x", bx); box.setAttribute("width", tw);
    const tt = g.querySelector(".g-hovt"); tt.setAttribute("x", bx + 5); tt.textContent = txt;
  });
}

// Segment colours are CSS classes (s-u unlit, s-g1..s-g5 green ramp, s-y, s-o, s-r, s-cap) so each theme
// paints them its own way.
function segClass(v, o, frac) {
  if (v >= o.redAt) return "s-r";
  if (v >= o.yellowAt) {
    const k = isFinite(o.redAt) ? (v - o.yellowAt) / (o.redAt - o.yellowAt) : 0;
    return k > 0.55 ? "s-o" : "s-y";
  }
  return `s-g${1 + Math.min(4, Math.floor(Math.max(0, frac) * 5))}`;
}

/**
 * Vertical LED histogram: one column per time bin, segments green -> yellow -> red.
 *  o.cols [v|null], o.min, o.max, o.yellowAt, o.redAt, o.marks [{v,label,cls}]
 */
export function vMeter(el, o) {
  const w = Math.max(80, Math.floor(el.clientWidth));
  const h = Math.max(80, Math.floor(el.clientHeight));
  const sw = 40;
  const gw = w - sw;
  const pad = 3;
  const rows = Math.max(10, Math.min(60, Math.floor((h - pad * 2) / 7)));
  const segH = (h - pad * 2) / rows;
  const n = o.cols.length;
  const cw = (gw - pad) / Math.max(1, n);
  const span = o.max - o.min;
  const warnFrac = isFinite(o.yellowAt) ? (o.yellowAt - o.min) / span : 1;
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.label || "meter")}">`;
  s += `<rect class="m-frame" x="0.5" y="0.5" width="${gw - 0.5}" height="${h - 1}"/>`;
  for (let c = 0; c < n; c++) {
    const v = o.cols[c];
    let topLit = -1;
    if (v != null) for (let r = 0; r < rows; r++) if (v > o.min + span * (r + 0.25) / rows) topLit = r;
    for (let r = 0; r < rows; r++) {
      const mid = o.min + (span * (r + 0.5)) / rows;
      const lit = r <= topLit;
      let cls = "s-u";
      if (lit) cls = c === n - 1 && r === topLit ? "s-cap" : segClass(mid, o, ((r + 0.5) / rows) / Math.max(0.01, warnFrac));
      const x = pad + c * cw + 1;
      const y = h - pad - (r + 1) * segH + 1;
      s += `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${(segH - 2).toFixed(1)}"/>`;
    }
  }
  // scale
  const Yv = (v) => h - pad - ((v - o.min) / span) * (h - pad * 2);
  const { ticks, step } = niceTicks(o.min, o.max, Math.max(3, Math.floor(h / 26)));
  const d = decimals(step);
  for (const v of ticks) {
    const y = Yv(v);
    if (y < 4 || y > h - 2) continue;
    s += `<text class="m-scale" x="${gw + 6}" y="${y.toFixed(1)}" dominant-baseline="middle">${fmtNum(v, d)}</text>`;
  }
  for (const mk of o.marks || []) {
    if (mk.v == null || mk.v < o.min || mk.v > o.max) continue;
    const y = Yv(mk.v).toFixed(1);
    s += `<line class="m-mark ${mk.cls || ""}" x1="${pad}" x2="${gw}" y1="${y}" y2="${y}"/>`;
    s += `<text class="m-markt ${mk.cls || ""}" x="${gw - 3}" y="${+y - 3}" text-anchor="end">${esc(mk.label)}</text>`;
  }
  s += `</svg>`;
  el.innerHTML = s;
}

/** Horizontal LED bar: o.value, o.min, o.max, o.yellowAt, o.redAt */
export function hMeter(el, o) {
  const w = Math.max(80, Math.floor(el.clientWidth));
  const h = Math.max(24, Math.floor(el.clientHeight));
  const rows = 3;
  const pad = 3;
  const cols = Math.max(10, Math.floor((w - pad * 2) / 8));
  const cw = (w - pad * 2) / cols;
  const rh = (h - pad * 2) / rows;
  const span = o.max - o.min;
  const warnFrac = isFinite(o.yellowAt) ? (o.yellowAt - o.min) / span : 1;
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.label || "bar meter")}">`;
  for (let c = 0; c < cols; c++) {
    const mid = o.min + (span * (c + 0.5)) / cols;
    const lit = o.value != null && o.value > o.min + (span * (c + 0.25)) / cols;
    const cls = lit ? segClass(mid, o, ((c + 0.5) / cols) / Math.max(0.01, warnFrac)) : "s-u";
    for (let r = 0; r < rows; r++) {
      s += `<rect class="${cls}" x="${(pad + c * cw + 1).toFixed(1)}" y="${(pad + r * rh + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${(rh - 2).toFixed(1)}"/>`;
    }
  }
  for (const mk of o.marks || []) {
    if (mk.v == null || mk.v <= o.min || mk.v >= o.max) continue;
    const x = (pad + ((mk.v - o.min) / span) * (w - pad * 2)).toFixed(1);
    s += `<line class="m-mark ${mk.cls || ""}" x1="${x}" x2="${x}" y1="0" y2="${h}"/>`;
  }
  s += `</svg>`;
  el.innerHTML = s;
}

export { f1, fmtNum, esc };
