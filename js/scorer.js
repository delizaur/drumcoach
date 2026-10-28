// Quantizes strokes to a rhythm grid and keeps running statistics.
//
// The selected rhythm is a grid of allowed positions, not a part the player has to play in full:
// every stroke snaps to the nearest grid note and is judged by its distance to it. Strokes too far
// from the grid are misses. Grid notes nobody plays are simply skipped, so an 8th-note grid also
// covers quarters, or any mix of the two. Strokes on different pads are scored independently, so
// kick + snare on the same grid note are two hits.
//
// All times are song milliseconds; errors are reported in real milliseconds (adjusted for playback rate).
import { lowerBound, meanSd } from './util.js';

/** Judgment windows (± real ms). A stroke further than `good` from the nearest grid note is a miss. */
export const STRICTNESS = {
  relaxed: { perfect: 30, great: 55, good: 90 },
  normal: { perfect: 18, great: 35, good: 60 },
  strict: { perfect: 10, great: 22, good: 40 },
};
export const JUDGMENTS = ['perfect', 'great', 'good', 'miss'];
export const MISS = 3;
const WEIGHT = [1, 0.75, 0.45, 0];

// Windows scale with the grid spacing. Between two neighbouring grid notes, the windows cover at most
// COVERED of the space, so the middle (30% of the gap, e.g. ±9 ms around the midpoint of two 16ths at
// 200 BPM) is always a miss, however fast the tempo. In hybrid grids, primary notes (e.g. 8ths) get a
// larger share of that space than the secondary ones (16ths), so a sloppy 8th isn't taken for a 16th.
// When the good window shrinks, great and perfect shrink with it once they'd crowd it.
const COVERED = 0.7;
const PULL_PRIMARY = 3, PULL_SECONDARY = 2;
const GREAT_SHARE = 0.75, PERFECT_SHARE = 0.5; // of the (shrunk) good window, at most
const MAX_WINDOW = 150;  // strokes further than this past the first/last grid note are ignored
const DOUBLE_TRIGGER = 35; // strokes on the same pad this close together count as one

export class Scorer {
  constructor(notes, { windows, rate = 1, scoreFrom = -Infinity }) {
    this.notes = notes;
    this.windows = windows;
    this.rate = rate;
    this.first = lowerBound(notes, scoreFrom);
    this.hybrid = notes.some(x => x.primary === false); // grid with primary (e.g. 8th) and secondary (16th) notes
    this.judge = new Int8Array(notes.length).fill(-1); // best judgment among the strokes on each grid note
    this.claimed = new Set(); // "noteIndex|pad" pairs already played
    this.hits = [];     // strokes on the grid: { t, err, j, i, slot, sec, pad, lane, zones: {early, late} windows }
    this.misses = [];   // strokes too far off the grid: same shape
    this.extras = [];   // same pad striking an already-played grid note again: { t, pad, lane }
    this.counts = [0, 0, 0, 0];
    this.streak = 0;
    this.maxStreak = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.weight = 0;
    this.lastStroke = new Map(); // pad → time of its last stroke
  }

  pull(i) { return this.hybrid && !this.notes[i].primary ? PULL_SECONDARY : PULL_PRIMARY; }

  /** Windows (± real ms) of grid note i on one side (d = -1 early, +1 late), scaled to the spacing. */
  windowsAt(i, d) {
    const n = this.notes, w = this.windows, k = i + d;
    if (k < 0 || k >= n.length) return w;
    const reach = COVERED * Math.abs(n[k].t - n[i].t) * this.pull(i) / (this.pull(i) + this.pull(k));
    const good = Math.min(w.good, reach / this.rate);
    return { perfect: Math.min(w.perfect, PERFECT_SHARE * good), great: Math.min(w.great, GREAT_SHARE * good), good };
  }

  classify(errMs, i) {
    const a = Math.abs(errMs), w = this.windowsAt(i, errMs < 0 ? -1 : 1);
    return a <= w.perfect ? 0 : a <= w.great ? 1 : a <= w.good ? 2 : MISS;
  }

  /**
   * Registers a stroke at song time t on a pad (see padOf in midi.js).
   * @returns {null | {type: 'double'|'extra'|'hit'|'miss', hit?: object}}
   */
  hit(t, pad = 'pad', lane = 3) {
    const last = this.lastStroke.get(pad);
    if (last !== undefined && Math.abs(t - last) < DOUBLE_TRIGGER * this.rate) return { type: 'double' };
    this.lastStroke.set(pad, t);

    const n = this.notes;
    if (this.first >= n.length) return null;
    let i = lowerBound(n, t);
    if (i >= n.length || (i > 0 && t - n[i - 1].t < n[i].t - t)) i--;
    if (i < this.first) {
      // warm-up strokes before scoring starts are ignored, unless they are closest to the first scored note
      if (i + 1 !== this.first || t - n[i].t < n[this.first].t - t) return null;
      i = this.first;
    }
    if (this.classify((t - n[i].t) / this.rate, i) === MISS) {
      // Outside the nearest note's window: the neighbour on the other side may reach further (a
      // primary note next to a secondary one in a hybrid grid). Windows never overlap.
      const k = i + (t > n[i].t ? 1 : -1);
      if (k >= this.first && k < n.length && this.classify((t - n[k].t) / this.rate, k) !== MISS) i = k;
    }

    const errSong = t - n[i].t;
    const edge = (i === 0 && errSong < 0) || (i === n.length - 1 && errSong > 0);
    if (edge && Math.abs(errSong) > MAX_WINDOW * this.rate) return null; // before the first / after the last grid note

    const err = errSong / this.rate;
    const j = this.classify(err, i);
    const zones = { early: this.windowsAt(i, -1), late: this.windowsAt(i, 1) }; // for display
    if (j === MISS) {
      this.counts[MISS]++;
      this.streak = 0;
      const miss = { t, err, j, i, slot: n[i].slot, sec: n[i].sec, pad, lane, zones };
      this.misses.push(miss);
      return { type: 'miss', hit: miss };
    }
    const key = `${i}|${pad}`;
    if (this.claimed.has(key)) {
      this.extras.push({ t, pad, lane });
      return { type: 'extra' };
    }

    this.claimed.add(key);
    if (this.judge[i] === -1 || j < this.judge[i]) this.judge[i] = j;
    this.counts[j]++;
    this.sum += err;
    this.sumSq += err * err;
    this.weight += WEIGHT[j];
    this.streak++;
    this.maxStreak = Math.max(this.maxStreak, this.streak);
    const hit = { t, err, j, i, slot: n[i].slot, sec: n[i].sec, pad, lane, zones };
    this.hits.push(hit);
    return { type: 'hit', hit };
  }

  stats() {
    const nHits = this.hits.length;
    const judged = nHits + this.misses.length;
    const mean = nHits ? this.sum / nHits : 0;
    const variance = nHits > 1 ? (this.sumSq - (this.sum * this.sum) / nHits) / (nHits - 1) : 0;
    const sd = Math.sqrt(Math.max(0, variance));
    return {
      judged, nHits, mean, sd, ur: sd * 10,
      accuracy: judged ? this.weight / judged : null,
      counts: this.counts, extra: this.extras.length,
      streak: this.streak, maxStreak: this.maxStreak,
    };
  }

  recentMean(k = 16) {
    const h = this.hits.slice(-k);
    return h.length ? h.reduce((a, x) => a + x.err, 0) / h.length : 0;
  }

  /** Per-key breakdown of strokes. keyFn receives a stroke ({ i, lane, ... }) and returns a group key. */
  groupBy(keyFn) {
    const groups = new Map();
    const get = k => {
      if (!groups.has(k)) groups.set(k, { key: k, errs: [], misses: 0 });
      return groups.get(k);
    };
    for (const h of this.hits) get(keyFn(h)).errs.push(h.err);
    for (const m of this.misses) get(keyFn(m)).misses++;
    return [...groups.values()].map(g => ({ ...g, ...meanSd(g.errs) }));
  }
}
