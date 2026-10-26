// Tempo detection for songs without an osu! map: finds a steady beat grid in the audio.
//
// 1. Coarse tempo candidates: peaks of the onset curve's autocorrelation, scored over the first
//    four multiples of each lag, with a mild preference for tempos near 130 BPM.
// 2. For each candidate, a fine search of period and phase on a smoothed onset curve.
// 3. A robust straight-line fit through the clear onsets nearest to each predicted beat.
// 4. A final fine-tune that maximises the grid's fit to the onsets on a sharper curve.
//
// Tested against 99 hand-timed osu! maps with a constant tempo: the right grid was among the
// three candidates (allowing a half-beat shift) for 97 of them, typically within 1 ms.
import { drumOnsets } from './beatsync.js';

export const TEMPO_VERSION = 1;

function smooth(x, sigma) {
  const r = Math.ceil(sigma * 3), k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); ks += v; }
  const out = new Float32Array(x.length);
  for (let i = r; i < x.length - r; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += x[i + j] * k[j + r];
    out[i] = s / ks;
  }
  return out;
}

const at = (x, t) => { const i = Math.floor(t), a = t - i; return (x[i] || 0) * (1 - a) + (x[i + 1] || 0) * a; };

/** Mean curve value on the grid phase + k·period within [from, to). */
function comb(x, period, phase, from, to) {
  let s = 0, c = 0;
  for (let t = from + phase; t < to; t += period) { s += at(x, t); c++; }
  return s / (c || 1);
}

function linfit(pts) {
  const n = pts.length;
  let sk = 0, st = 0, skk = 0, skt = 0;
  for (const [k, t] of pts) { sk += k; st += t; skk += k * k; skt += k * t; }
  const b = (n * skt - sk * st) / (n * skk - sk * sk);
  return { a: (st - b * sk) / n, b };
}

const median = v => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1] || 0; };

function coarseCandidates(env, from, to, count) {
  const D = 4, i0 = Math.floor(from / D), n = Math.floor(to / D) - i0;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < D; j++) s += env[(i0 + i) * D + j]; e[i] = s; }
  let mean = 0;
  for (const v of e) mean += v;
  mean /= n;
  for (let i = 0; i < n; i++) e[i] -= mean;
  const cache = new Map();
  const acf = lag => {
    if (cache.has(lag)) return cache.get(lag);
    let s = 0;
    for (let i = lag; i < n; i++) s += e[i] * e[i - lag];
    cache.set(lag, s);
    return s;
  };
  const lo = Math.floor(240 / D), hi = Math.ceil(1000 / D), score = {}; // 60–250 BPM
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = 60000 / (lag * D);
    let s = 0;
    for (let m = 1; m <= 4; m++) s += acf(m * lag);
    score[lag] = s * Math.exp(-0.5 * (Math.log2(bpm / 130) / 1.1) ** 2);
  }
  const peaks = [];
  for (let lag = lo + 1; lag < hi; lag++) if (score[lag] >= score[lag - 1] && score[lag] >= score[lag + 1]) peaks.push(lag);
  peaks.sort((a, b) => score[b] - score[a]);
  const out = [];
  for (const lag of peaks) {
    if (out.every(o => Math.abs(o / lag - 1) > 0.05)) out.push(lag);
    if (out.length === count) break;
  }
  return out.map(l => l * D);
}

function refine(env, soft, sharp, P0, from, to) {
  // fine search of period (±1.5 %) and phase on the smoothed curve
  let P = P0, phi = 0, best = -1;
  for (let p = P0 * 0.985; p <= P0 * 1.015; p += P0 * 0.0005) {
    for (let f = 0; f < p; f += 4) { const v = comb(soft, p, f, from, to); if (v > best) { best = v; P = p; phi = f; } }
  }
  const Pc = P, fc = phi;
  best = -1;
  for (let p = Pc - P0 * 0.0006; p <= Pc + P0 * 0.0006; p += 0.002) {
    for (let f = fc - 6; f <= fc + 6; f += 0.5) { const v = comb(soft, p, f, from, to); if (v > best) { best = v; P = p; phi = f; } }
  }
  // robust line fit through the clear onsets nearest to each predicted beat
  for (let iter = 0; iter < 3; iter++) {
    const win = Math.min(25, P / 8), pts = [];
    for (let k = 0; from + phi + k * P < to; k++) {
      const t = from + phi + k * P;
      let bi = -1, bv = 3; // clear onsets only: 3× the average strength
      for (let i = Math.round(t - win); i <= Math.round(t + win); i++) if (env[i] > bv) { bv = env[i]; bi = i; }
      if (bi >= 0) pts.push([k, bi - from]);
    }
    if (pts.length < 12) break;
    let fit = linfit(pts);
    const res = pts.map(([k, t]) => t - (fit.a + fit.b * k));
    const mad = median(res.map(Math.abs)) * 1.4826 || 1;
    fit = linfit(pts.filter((_, i) => Math.abs(res[i]) <= 2.5 * mad));
    phi = fit.a;
    P = fit.b;
  }
  // fine-tune directly against the sharp curve
  const span = P * 0.0002, P1 = P, f1 = phi;
  best = -1;
  for (let p = P1 - span; p <= P1 + span; p += span / 100) {
    for (let f = f1 - 3; f <= f1 + 3; f += 0.25) { const v = comb(sharp, p, f, from, to); if (v > best) { best = v; P = p; phi = f; } }
  }
  const phase = (((from + phi) % P) + P) % P; // first beat at or after 0 ms
  return { period: P, phase, bpm: 60000 / P, fit: best };
}

/**
 * @param {AudioBuffer} buffer
 * @returns {Promise<{candidates: {bpm:number, period:number, phase:number, fit:number}[], clear:boolean}>}
 *   candidates in order of preference; phase = time (ms) of a beat in [0, period)
 */
export async function detectTempo(buffer, count = 3) {
  const env = await drumOnsets(buffer);
  const from = 1000, to = env.length - 1000;
  if (to - from < 10000) return { candidates: [], clear: false };
  const soft = smooth(env, 4), sharp = smooth(env, 1.5);
  const candidates = coarseCandidates(env, from, to, count).map(P0 => refine(env, soft, sharp, P0, from, to));
  // the curve averages 1, so a grid on the beat of percussive music scores well above that
  return { candidates, clear: (candidates[0]?.fit || 0) >= 1.8 };
}
