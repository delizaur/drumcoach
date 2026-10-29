// Canvas views: scrolling timeline, hit-error meter, timing scatter plot and error histogram.
import { lowerBound } from './util.js';
import { MISS } from './scorer.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let C = null;
function colors() {
  if (!C) {
    C = {
      judge: ['--perfect', '--great', '--good', '--miss'].map(css),
      extra: css('--extra'), text: css('--text'), muted: css('--muted'), faint: css('--faint'),
      accent: css('--accent'), panel2: css('--panel-2'), border: css('--border'),
    };
  }
  return C;
}
const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

class CanvasView {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.w = this.h = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // resizing clears the canvas, so repaint the last frame
    if (this.last) this.draw(this.last);
  }
}

// ---------------------------------------------------------------- timeline

export class Timeline extends CanvasView {
  constructor(canvas) {
    super(canvas);
    this.futureMs = 1400; // real ms visible ahead of the hit line at zoom 1
    this.hitFrac = 0.5; // hit line in the middle
    this.zoom = 1; // > 1 spreads the notes out
    this.showWindows = false; // draw each grid note's timing windows
  }

  /**
   * @param {object} s
   *  now, rate, notes, beats, sections, scorer, lanes (names), hiddenBar(bar)→bool
   */
  draw(s) {
    this.last = s;
    const { g, w, h } = this, c = colors();
    g.clearRect(0, 0, w, h);
    if (!s) return;

    const hitX = Math.round(w * this.hitFrac);
    const pxPerMs = (w - hitX) / (this.futureMs / this.zoom);
    const toX = t => hitX + ((t - s.now) / s.rate) * pxPerMs;
    const t0 = s.now - (hitX / pxPerMs) * s.rate - 50;
    const t1 = s.now + ((w - hitX) / pxPerMs) * s.rate + 50;
    // layout: header (tempo, bar numbers) · grid row (the rhythm) · one lane per drum
    const gridY = 38;
    const laneTop = 56, laneBottom = h - 4;
    const nLanes = s.lanes.length;
    const laneH = (laneBottom - laneTop) / nLanes;
    const laneY = lane => laneTop + laneH * (lane + 0.5);

    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fillRect(0, gridY - 12, w, 24);
    for (let l = 0; l < nLanes; l++) {
      g.fillStyle = l % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.045)';
      g.fillRect(0, laneTop + l * laneH, w, laneH);
    }

    // silent bars (gap trainer)
    if (s.hiddenBar) {
      g.font = '600 11px system-ui'; g.textAlign = 'left';
      for (let i = lowerBound(s.beats, t0 - 10000); i < s.beats.length && s.beats[i].t <= t1; i++) {
        const b = s.beats[i];
        if (b.downbeat && s.hiddenBar(b.bar)) {
          const sec = s.sections[b.sec];
          const x0 = toX(b.t), x1 = toX(Math.min(sec.end, b.t + sec.beatLength * sec.meter));
          if (x1 < 0) continue;
          g.fillStyle = alpha(c.accent, 0.07);
          g.fillRect(x0, 0, x1 - x0, h);
          g.fillStyle = alpha(c.accent, 0.7);
          g.fillText('SILENT · keep going', Math.max(x0, 0) + 6, gridY + 4);
        }
      }
    }

    // triplet sections (fills found in the beatmap)
    if (s.tripletSections?.length) {
      g.font = '600 10.5px system-ui'; g.textAlign = 'left';
      for (const f of s.tripletSections) {
        if (f.end < t0 || f.start > t1) continue;
        const x0 = toX(f.start), x1 = toX(f.end);
        g.fillStyle = alpha(c.judge[2], 0.07);
        g.fillRect(x0, gridY - 12, x1 - x0, laneBottom - gridY + 12);
        g.fillStyle = alpha(c.judge[2], 0.85);
        g.fillText('TRIPLETS', Math.max(x0, 0) + 5, laneBottom - 5);
      }
    }

    // beat grid
    g.textAlign = 'left';
    for (let i = lowerBound(s.beats, t0); i < s.beats.length && s.beats[i].t <= t1; i++) {
      const b = s.beats[i], x = Math.round(toX(b.t)) + 0.5;
      g.strokeStyle = b.downbeat ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.09)';
      g.lineWidth = b.downbeat ? 1.5 : 1;
      g.beginPath(); g.moveTo(x, b.downbeat ? 18 : gridY - 10); g.lineTo(x, laneBottom); g.stroke();
      if (b.downbeat) {
        g.fillStyle = c.faint; g.font = '11px system-ui';
        g.fillText(String(b.bar + 1), x + 4, 24);
      }
    }

    // tempo labels at section starts
    g.font = '600 12px system-ui';
    for (let i = 0; i < s.sections.length; i++) {
      const sec = s.sections[i];
      if (sec.start < t0 - 4000 || sec.start > t1) continue;
      const prev = s.sections[i - 1];
      const bpm = (60000 / sec.beatLength) * s.rate;
      if (prev && Math.abs(prev.beatLength - sec.beatLength) < 0.01 && prev.meter === sec.meter) continue;
      const x = Math.max(70, toX(sec.start) + 4);
      g.fillStyle = c.accent;
      g.fillText(`${+bpm.toFixed(1)} BPM${sec.meter !== 4 ? ` · ${sec.meter}/4` : ''}`, x, 13);
    }

    const sc = s.scorer;

    // timing windows of each grid note (they shrink where notes are close together): bars on the
    // grid row, and a faint tint through the lanes so the miss gaps between notes stand out
    if (this.showWindows) {
      for (let i = Math.max(sc.first, lowerBound(s.notes, t0 - 200)); i < s.notes.length && s.notes[i].t <= t1 + 200; i++) {
        const n = s.notes[i];
        if (s.hiddenBar?.(n.bar)) continue;
        const early = sc.windowsAt(i, -1), late = sc.windowsAt(i, 1);
        for (const [k, j, a, lane] of [['good', 2, 0.3, 0.05], ['great', 1, 0.4, 0.05], ['perfect', 0, 0.55, 0.06]]) {
          const x0 = toX(n.t - early[k] * s.rate), x1 = toX(n.t + late[k] * s.rate);
          g.fillStyle = alpha(c.judge[j], lane);
          g.fillRect(x0, laneTop, x1 - x0, laneBottom - laneTop);
          g.fillStyle = alpha(c.judge[j], a);
          g.fillRect(x0, gridY - 9, x1 - x0, 18);
        }
      }
    }

    // grid notes: where strokes may land (on any drum)
    for (let i = lowerBound(s.notes, t0); i < s.notes.length && s.notes[i].t <= t1; i++) {
      const n = s.notes[i], x = toX(n.t), j = sc.judge[i];
      const r = n.downbeat ? 7 : n.onBeat ? 6 : n.primary === false ? 3 : 4.5; // hybrid: secondary notes are small
      if (!n.onBeat) { // faint guide through the lanes for subdivisions
        g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(Math.round(x) + 0.5, laneTop); g.lineTo(Math.round(x) + 0.5, laneBottom); g.stroke();
      }
      if (i < sc.first) {
        g.strokeStyle = c.faint; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, gridY, r - 1, 0, Math.PI * 2); g.stroke();
        continue;
      }
      if (j === -1) {
        if (s.hiddenBar?.(n.bar)) continue;
        if (n.t < s.now - sc.windows.good * s.rate) {
          // grid note that wasn't played: that's allowed, just fade it out
          g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 1.5;
          g.beginPath(); g.arc(x, gridY, r - 1, 0, Math.PI * 2); g.stroke();
          continue;
        }
        g.fillStyle = n.downbeat ? '#ffffff' : '#d9dde6';
        g.beginPath(); g.arc(x, gridY, r, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = alpha(c.judge[j], 0.35);
        g.strokeStyle = c.judge[j]; g.lineWidth = 2;
        g.beginPath(); g.arc(x, gridY, r, 0, Math.PI * 2); g.fill(); g.stroke();
      }
    }

    // strokes in their drum's lane, with a line back to the grid note they snapped to
    const offsetLink = (gx, x, y, col, dashed) => {
      g.strokeStyle = alpha(col, 0.55); g.lineWidth = 1.5;
      if (dashed) g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(gx, y); g.lineTo(x, y); g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.moveTo(gx, y - 6); g.lineTo(gx, y + 6); g.stroke(); // target tick
    };
    const r = Math.min(7, laneH * 0.3);
    for (let k = sc.hits.length - 1; k >= 0; k--) {
      const hit = sc.hits[k];
      if (hit.t < t0) break;
      if (hit.t > t1) continue;
      const x = toX(hit.t), y = laneY(hit.lane), col = c.judge[hit.j];
      offsetLink(toX(s.notes[hit.i].t), x, y, col, false);
      g.fillStyle = col;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    for (let k = sc.misses.length - 1; k >= 0; k--) {
      const m = sc.misses[k];
      if (m.t < t0) break;
      if (m.t > t1) continue;
      const x = toX(m.t), y = laneY(m.lane), col = c.judge[MISS];
      offsetLink(toX(s.notes[m.i].t), x, y, col, true);
      g.strokeStyle = col; g.lineWidth = 2.25;
      g.beginPath();
      g.moveTo(x - r, y - r); g.lineTo(x + r, y + r);
      g.moveTo(x + r, y - r); g.lineTo(x - r, y + r);
      g.stroke();
    }
    for (let k = sc.extras.length - 1; k >= 0; k--) {
      const e = sc.extras[k];
      if (e.t < t0) break;
      if (e.t > t1) continue;
      g.strokeStyle = alpha(c.extra, 0.8); g.lineWidth = 1.5;
      g.beginPath(); g.arc(toX(e.t), laneY(e.lane), r * 0.7, 0, Math.PI * 2); g.stroke();
    }

    // hit line
    g.fillStyle = alpha(c.accent, 0.18);
    g.fillRect(hitX - 6, 0, 12, h);
    g.fillStyle = c.accent;
    g.fillRect(hitX - 1, 0, 2, h);

    // lane labels
    g.font = '600 10.5px system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle';
    const label = (text, y, color) => {
      const tw = g.measureText(text).width;
      g.fillStyle = 'rgba(12,14,18,0.75)';
      g.fillRect(4, y - 8, tw + 10, 16);
      g.fillStyle = color;
      g.fillText(text, 9, y + 0.5);
    };
    s.lanes.forEach((name, l) => label(name.toUpperCase(), laneY(l), c.muted));
    label('GRID', gridY, c.faint);
    g.textBaseline = 'alphabetic';
  }
}

// ---------------------------------------------------------------- error meter

export class ErrorMeter extends CanvasView {
  /**
   * @param {{recent: {err:number, j:number, at:number}[], windows, zones?: {early, late}, mean:number|null, now:number}} s
   * zones: the windows of the latest stroke's grid note on each side (they shrink on dense grids);
   * the meter eases towards them so alternating 8ths and 16ths don't make it flicker.
   */
  draw(s) {
    this.last = s;
    const { g, w, h } = this, c = colors();
    g.clearRect(0, 0, w, h);
    const range = s.windows.good * 1.6;
    const toX = e => w / 2 + (Math.max(-range, Math.min(range, e)) / range) * (w / 2 - 6);
    const cy = h / 2;

    const target = s.zones || { early: s.windows, late: s.windows };
    const ease = (a, b) => a == null ? b : a + (b - a) * 0.2;
    const cur = this.zones || (this.zones = { early: {}, late: {} });
    for (const side of ['early', 'late']) {
      for (const k of ['perfect', 'great', 'good']) cur[side][k] = ease(cur[side][k], target[side][k]);
    }

    // zones, outermost first
    g.fillStyle = alpha(c.judge[MISS], 0.12);
    g.fillRect(toX(-range), cy - 5, toX(range) - toX(-range), 10);
    for (const [k, j] of [['good', 2], ['great', 1], ['perfect', 0]]) {
      g.fillStyle = alpha(c.judge[j], 0.22);
      g.fillRect(toX(-cur.early[k]), cy - 5, toX(cur.late[k]) - toX(-cur.early[k]), 10);
    }
    g.fillStyle = c.text;
    g.fillRect(w / 2 - 1, cy - 14, 2, 28);

    // tick labels
    g.fillStyle = c.faint; g.font = '10px system-ui'; g.textAlign = 'center';
    g.fillText(`−${Math.round(target.early.good)}`, toX(-cur.early.good), h - 2);
    g.fillText(`+${Math.round(target.late.good)}`, toX(cur.late.good), h - 2);

    for (const hit of s.recent) {
      const age = (s.now - hit.at) / 4000;
      if (age >= 1) continue;
      g.fillStyle = alpha(c.judge[hit.j], 1 - age);
      g.fillRect(toX(hit.err) - 1.5, cy - 13, 3, 26);
    }

    if (s.mean != null) {
      const x = toX(s.mean);
      g.fillStyle = c.text;
      g.beginPath(); g.moveTo(x, cy - 15); g.lineTo(x - 6, cy - 24); g.lineTo(x + 6, cy - 24); g.closePath(); g.fill();
    }
  }
}

// ---------------------------------------------------------------- scatter

export class Scatter extends CanvasView {
  /** Pixel x (CSS px) of song time t in the last drawn chart. */
  xFor(t) { const m = this.map; return m ? m.padL + ((t - m.x0) / m.span) * m.pw : 0; }
  /** Song time at pixel x in the last drawn chart (clamped to the plot). */
  timeAt(x) { const m = this.map; return m ? m.x0 + Math.min(1, Math.max(0, (x - m.padL) / m.pw)) * m.span : 0; }

  /** @param {{hits, misses, x0, x1, windows, good?: number, sectionStarts?: number[], tripletSections?: {start, end}[], timeAxis?: boolean}} s */
  draw(s) {
    this.last = s;
    const { g, w, h } = this, c = colors();
    g.clearRect(0, 0, w, h);
    const padL = 40, padR = 8, padT = 8, padB = 18;
    // scaled to the typical good window in use (it shrinks with the grid spacing), with room for the
    // misses around it: they lie within half the spacing, ~1.25× the good window of the main notes
    const range = Math.ceil(((s.good ?? s.windows.good) * 1.3) / 10) * 10;
    const pw = w - padL - padR, ph = h - padT - padB;
    const span = Math.max(1, s.x1 - s.x0);
    this.map = { x0: s.x0, span, padL, pw };
    const toX = t => padL + ((t - s.x0) / span) * pw;
    const toY = e => padT + ph / 2 - (Math.max(-range, Math.min(range, e)) / range) * (ph / 2);

    // judgment bands: the windows each stroke was judged with (they shrink on dense grids), from
    // halfway to the previous stroke to halfway to the next; the nominal windows away from strokes
    const nominal = { early: s.windows, late: s.windows }, REACH = 2000, right = padL + pw;
    const px = t => Math.min(right, Math.max(padL, Math.round(toX(t))));
    const strokes = [...s.hits, ...s.misses].filter(x => x.zones).sort((a, b) => a.t - b.t);
    const segs = [];
    let cursor = padL;
    strokes.forEach((st, k) => {
      const a = k ? Math.max((strokes[k - 1].t + st.t) / 2, st.t - REACH) : st.t - REACH;
      const b = k + 1 < strokes.length ? Math.min((st.t + strokes[k + 1].t) / 2, st.t + REACH) : st.t + REACH;
      const xa = Math.max(cursor, px(a)), xb = px(b);
      if (xa > cursor) segs.push([cursor, xa, nominal]);
      if (xb > xa) segs.push([xa, xb, st.zones]);
      cursor = Math.max(cursor, xb);
    });
    if (cursor < right) segs.push([cursor, right, nominal]);
    for (const [k, j] of [['good', 2], ['great', 1], ['perfect', 0]]) {
      g.fillStyle = alpha(c.judge[j], 0.07);
      for (const [x0, x1, z] of segs) g.fillRect(x0, toY(z.late[k]), x1 - x0, toY(-z.early[k]) - toY(z.late[k]));
    }
    // axes
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, toY(0) + 0.5); g.lineTo(w - padR, toY(0) + 0.5); g.stroke();
    g.fillStyle = c.faint; g.font = '10px system-ui'; g.textAlign = 'right';
    for (const v of [-range, -range / 2, 0, range / 2, range]) {
      g.fillText(v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`, padL - 6, toY(v) + 3);
    }
    g.save(); g.translate(10, padT + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
    g.fillText('ms (early ↓ / late ↑)', 0, 0); g.restore();

    // time axis (song position)
    if (s.timeAxis) {
      const step = [5, 10, 15, 30, 60, 120, 300].find(sec => span / (sec * 1000) <= 10) * 1000 || 600000;
      g.textAlign = 'center'; g.fillStyle = c.faint;
      for (let t = Math.ceil(s.x0 / step) * step; t <= s.x1; t += step) {
        const x = toX(t), sec = Math.round(t / 1000);
        g.fillRect(Math.round(x), padT + ph, 1, 3);
        g.fillText(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, Math.min(w - padR - 12, Math.max(padL + 12, x)), h - 3);
      }
    }

    // triplet sections, highlighted like in the scrolling timeline
    if (s.tripletSections?.length) {
      g.font = '600 10px system-ui'; g.textAlign = 'left';
      for (const f of s.tripletSections) {
        if (f.end < s.x0 || f.start > s.x1) continue;
        const x0 = px(f.start), x1 = px(f.end);
        g.fillStyle = alpha(c.judge[2], 0.1);
        g.fillRect(x0, padT, Math.max(1, x1 - x0), ph);
        if (x1 - x0 > 56) { g.fillStyle = alpha(c.judge[2], 0.85); g.fillText('TRIPLETS', x0 + 4, padT + 11); }
      }
    }

    if (s.sectionStarts) {
      g.strokeStyle = alpha(c.accent, 0.35); g.setLineDash([3, 4]);
      for (const t of s.sectionStarts) {
        if (t <= s.x0 || t >= s.x1) continue;
        const x = Math.round(toX(t)) + 0.5;
        g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + ph); g.stroke();
      }
      g.setLineDash([]);
    }

    // off-grid strokes as rings (clamped to the plot)
    g.strokeStyle = alpha(c.judge[MISS], 0.9); g.lineWidth = 1.25;
    for (const m of s.misses) {
      g.beginPath(); g.arc(toX(m.t), toY(m.err), 2.6, 0, Math.PI * 2); g.stroke();
    }

    const r = s.hits.length > 1500 ? 1.4 : 2.2;
    for (const hit of s.hits) {
      g.fillStyle = alpha(c.judge[hit.j], 0.85);
      g.beginPath(); g.arc(toX(hit.t), toY(hit.err), r, 0, Math.PI * 2); g.fill();
    }

    // moving average
    const win = 16;
    if (s.hits.length >= 4) {
      g.strokeStyle = c.text; g.lineWidth = 1.75; g.beginPath();
      let sum = 0;
      s.hits.forEach((hit, k) => {
        sum += hit.err;
        if (k >= win) sum -= s.hits[k - win].err;
        const n = Math.min(k + 1, win), x = toX(hit.t), y = toY(sum / n);
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
    }
  }
}

// ---------------------------------------------------------------- histogram

export class Histogram extends CanvasView {
  draw(s) {
    this.last = s;
    const { hits, windows, mean } = s;
    const { g, w, h } = this, c = colors();
    g.clearRect(0, 0, w, h);
    const range = Math.ceil((windows.good * 1.6) / 10) * 10;
    const bin = range > 80 ? 5 : 3;
    const nb = Math.ceil((2 * range) / bin);
    // each bar is stacked by the judgments its hits actually got (windows vary with the grid spacing)
    const counts = new Array(nb).fill(0), byJudge = Array.from({ length: nb }, () => [0, 0, 0, 0]);
    for (const hit of hits) {
      const b = Math.floor((Math.max(-range, Math.min(range - 0.001, hit.err)) + range) / bin);
      counts[b]++;
      byJudge[b][hit.j]++;
    }
    const max = Math.max(1, ...counts);
    const padB = 16, padT = 8, bw = w / nb, scale = (h - padB - padT) / max;
    for (let b = 0; b < nb; b++) {
      let y = h - padB;
      for (let j = 0; j <= MISS; j++) {
        const hh = byJudge[b][j] * scale;
        if (!hh) continue;
        g.fillStyle = alpha(c.judge[j], 0.85);
        g.fillRect(b * bw + 0.5, y - hh, Math.max(1, bw - 1), hh);
        y -= hh;
      }
    }
    g.fillStyle = c.text;
    g.fillRect(w / 2 - 0.5, padT, 1, h - padB - padT);
    if (mean != null) {
      const x = w / 2 + (Math.max(-range, Math.min(range, mean)) / range) * (w / 2);
      g.strokeStyle = c.accent; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, h - padB); g.stroke(); g.setLineDash([]);
    }
    g.fillStyle = c.faint; g.font = '10px system-ui'; g.textAlign = 'center';
    g.fillText(`−${range}`, 14, h - 3); g.fillText('0', w / 2, h - 3); g.fillText(`+${range}`, w - 14, h - 3);
  }
}

/** Small strip used by the calibration dialog. */
export function drawCalibStrip(canvas, errors) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, c = colors(), range = 150;
  g.clearRect(0, 0, w, h);
  g.fillStyle = c.panel2; g.fillRect(0, h / 2 - 12, w, 24);
  g.fillStyle = c.muted; g.fillRect(w / 2 - 1, h / 2 - 18, 2, 36);
  g.font = '10px system-ui'; g.textAlign = 'center'; g.fillStyle = c.faint;
  g.fillText('click', w / 2, h - 2); g.fillText(`−${range} ms`, 24, h - 2); g.fillText(`+${range} ms`, w - 26, h - 2);
  errors.forEach((e, k) => {
    const x = w / 2 + (Math.max(-range, Math.min(range, e)) / range) * (w / 2 - 4);
    g.fillStyle = alpha(c.accent, 0.35 + 0.65 * ((k + 1) / errors.length));
    g.fillRect(x - 1.5, h / 2 - 12, 3, 24);
  });
}
