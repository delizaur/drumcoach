// Tempo detection for songs without an osu! map: finds a steady beat grid in the audio.
//
// 1. Coarse tempo candidates: peaks of the onset curve's autocorrelation (averaged over 20 s
//    windows), scored over the first four multiples of each lag, with a mild preference for
//    tempos near 130 BPM.
// 2. For each candidate, a fine search of period and phase on a smoothed onset curve.
// 3. A robust straight-line fit through the clear onsets nearest to each predicted beat.
// 4. A final fine-tune that maximises the grid's fit to the onsets on a sharper curve.
// 5. Beat tracking: live recordings speed up and slow down, so a single tempo drifts off the beat
//    over the song. The beat's shift from the straight grid is measured in chunks of 16 beats, and
//    the timing gets an extra red line wherever it moves more than a few ms away.
//
// Tested against 99 hand-timed osu! maps with a constant tempo: the right grid was among the
// three candidates (allowing a half-beat shift) for 97 of them, typically within 1 ms.
import { drumOnsets } from './beatsync.js';

export const TEMPO_VERSION = 3;

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

const ACF_WINDOW = 20000; // ms

function coarseCandidates(env, from, to, count) {
  const D = 4, i0 = Math.floor(from / D), n = Math.floor(to / D) - i0;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < D; j++) s += env[(i0 + i) * D + j]; e[i] = s; }
  // autocorrelation in overlapping windows, each normalised by its own energy, so every part of
  // the song counts the same: a short section with very sharp hits (a click-like outro) would
  // otherwise outweigh the rest of the song
  const W = Math.min(n, ACF_WINDOW / D), wins = [];
  for (let a = 0; a + W <= n; a += W / 2) {
    let mean = 0, energy = 0;
    for (let i = a; i < a + W; i++) mean += e[i];
    mean /= W;
    for (let i = a; i < a + W; i++) energy += (e[i] - mean) ** 2;
    if (energy > 0) wins.push({ a, mean, energy });
  }
  const cache = new Map();
  const acf = lag => {
    if (cache.has(lag)) return cache.get(lag);
    let total = 0;
    for (const { a, mean, energy } of wins) {
      let s = 0;
      for (let i = a + lag; i < a + W; i++) s += (e[i] - mean) * (e[i - lag] - mean);
      total += s / energy;
    }
    cache.set(lag, total);
    return total;
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

const TRACK_STEP = 16;    // beats per chunk; the beat's shift from the straight tempo is measured on each
const TRACK_RANGE = 100;  // ms the shift may reach (at most a sixth of a beat)
const TRACK_STIFF = 0.03; // cost of changing the shift between chunks, per ms² (the fit averages 1)
const TRACK_MIN = 4;      // shifts that all stay within this (ms) keep the straight tempo

/**
 * Follows a candidate's beat through the song in chunks: times (ms) of beats 0, TRACK_STEP,
 * 2·TRACK_STEP, … counted from the beat at `phase`, or [] when the straight tempo already fits.
 * The shifts are the path that best fits the onsets while changing smoothly (dynamic programming),
 * so a chunk where an off-beat stands out doesn't pull the grid away.
 */
function track(soft, sharp, period, phase) {
  const n = Math.ceil((soft.length - phase) / period / TRACK_STEP) + 1;
  // mean curve value on the beats of chunk i (centred on beat i·TRACK_STEP), shifted by d ms
  const fit = (curve, i, d) => {
    let s = 0;
    for (let k = i * TRACK_STEP - TRACK_STEP / 2; k < (i + 1) * TRACK_STEP - TRACK_STEP / 2; k++) s += at(curve, phase + k * period + d);
    return s / TRACK_STEP;
  };
  const R = Math.round(Math.min(TRACK_RANGE, period / 6)), S = 2 * R + 1;
  const score = new Float64Array(S), next = new Float64Array(S), from = [];
  for (let s = 0; s < S; s++) score[s] = fit(soft, 0, s - R);
  for (let i = 1; i < n; i++) {
    const back = new Int16Array(S);
    for (let s = 0; s < S; s++) {
      let best = -Infinity;
      for (let p = 0; p < S; p++) { const v = score[p] - TRACK_STIFF * (s - p) ** 2; if (v > best) { best = v; back[s] = p; } }
      next[s] = best + fit(soft, i, s - R);
    }
    score.set(next);
    from.push(back);
  }
  const shift = new Float64Array(n);
  let s = score.indexOf(Math.max(...score));
  for (let i = n - 1; i >= 0; i--) { shift[i] = s - R; if (i) s = from[i - 1][s]; }
  // finer, on the sharper curve
  for (let i = 0; i < n; i++) {
    let best = -1, d = shift[i];
    for (let x = shift[i] - 1.5; x <= shift[i] + 1.5; x += 0.25) { const v = fit(sharp, i, x); if (v > best) { best = v; d = x; } }
    if (best > 0) shift[i] = d;
  }
  // smoothing: median of 3, then mean of 3
  const med = shift.map((v, i) => median([shift[Math.max(0, i - 1)], v, shift[Math.min(n - 1, i + 1)]]));
  const smooth3 = med.map((v, i) => (med[Math.max(0, i - 1)] + v + med[Math.min(n - 1, i + 1)]) / 3);
  if (smooth3.every(v => Math.abs(v) <= TRACK_MIN)) return [];
  return [...smooth3].map((d, i) => Math.round((phase + i * TRACK_STEP * period + d) * 10) / 10);
}

const TIMING_TOLERANCE = 3;

/**
 * Red lines for a detected candidate, after the player's adjustments: a single tempo, or one more
 * line wherever the tracked beat moves more than TIMING_TOLERANCE ms from it (on the downbeats).
 * @param {{period:number, phase:number, beats?:number[]}} c
 * @param {{mult:number, half:boolean, meter:number, bar:number}} adj
 */
export function tempoTiming(c, { mult, half, meter, bar }, durationMs) {
  const P = c.period / mult, beats = c.beats?.length > 1 ? c.beats : null;
  // time of the candidate's beat x (fractional; 0 = the beat at phase)
  const at = x => {
    if (!beats) return c.phase + x * c.period;
    const i = Math.max(0, Math.min(beats.length - 2, Math.floor(x / TRACK_STEP)));
    return beats[i] + (beats[i + 1] - beats[i]) * (x / TRACK_STEP - i);
  };
  const x0 = ((half ? 0.5 : 0) + bar) / mult, perBar = meter / mult; // candidate beats
  // downbeats from the last one before 0 ms (so the first bar is complete) to past the end
  let n = Math.floor(-x0 / perBar) + 1;
  while (at(x0 + n * perBar) >= 0) n--;
  const T = [];
  for (; T.length < 2 || T.at(-2) < durationMs; n++) T.push(at(x0 + n * perBar));
  if (!beats) return [{ time: T[0], beatLength: P, meter }];
  // greedy: each line runs as far as a straight tempo stays within the tolerance of every downbeat
  const lines = [];
  for (let i = 0; i < T.length - 1;) {
    let j = i + 1;
    for (let k = j + 1; k < T.length; k++) {
      const ok = T.slice(i + 1, k).every((t, m) => Math.abs(t - (T[i] + (T[k] - T[i]) * (m + 1) / (k - i))) <= TIMING_TOLERANCE);
      if (!ok) break;
      j = k;
    }
    lines.push({ time: T[i], beatLength: (T[j] - T[i]) / ((j - i) * meter), meter });
    i = j;
  }
  return lines;
}

/**
 * @param {AudioBuffer} buffer
 * @returns {Promise<{candidates: {bpm:number, period:number, phase:number, fit:number, beats:number[]}[], clear:boolean}>}
 *   candidates in order of preference; phase = time (ms) of a beat in [0, period); beats = tracked
 *   times of every TRACK_STEP-th beat from there (see tempoTiming)
 */
export async function detectTempo(buffer, count = 3) {
  const env = await drumOnsets(buffer);
  const from = 1000, to = env.length - 1000;
  if (to - from < 10000) return { candidates: [], clear: false };
  const soft = smooth(env, 4), sharp = smooth(env, 1.5);
  const candidates = coarseCandidates(env, from, to, count).map(P0 => refine(env, soft, sharp, P0, from, to));
  // the grid that sits best on the onsets first; a slower grid only lands on the strongest hits, so
  // it tends to fit better: when the best one has a double-tempo partner, the partner goes first
  candidates.sort((a, b) => b.fit - a.fit);
  const double = candidates.findIndex(c => Math.abs(candidates[0].period / c.period / 2 - 1) < 0.01);
  if (double > 0) candidates.unshift(...candidates.splice(double, 1));
  for (const c of candidates) c.beats = track(soft, sharp, c.period, c.phase);
  // the curve averages 1, so a grid on the beat of percussive music scores well above that
  return { candidates, clear: (candidates[0]?.fit || 0) >= 1.8 };
}
