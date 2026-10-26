// Quantizes strokes to a rhythm grid and keeps running statistics.
//
// The selected rhythm is a grid of allowed positions, not a part the player has to play in full:
// every stroke snaps to the nearest grid note and is judged by its distance to it. Strokes too far
// from the grid are misses. Grid notes nobody plays are simply skipped, so an 8th-note grid also
// covers quarters, or any mix of the two.
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

const MAX_WINDOW = 150;  // strokes further than this past the first/last grid note are ignored
const CHORD_WINDOW = 35; // strokes this close together count as one (kick + crash, flams)

export class Scorer {
  constructor(notes, { windows, rate = 1, scoreFrom = -Infinity }) {
    this.notes = notes;
    this.windows = windows;
    this.rate = rate;
    this.first = lowerBound(notes, scoreFrom);
    this.judge = new Int8Array(notes.length).fill(-1); // judgment of the stroke that claimed each grid note
    this.hits = [];     // strokes on the grid: { t, err, j, i, slot, sec }
    this.misses = [];   // strokes too far off the grid: { t, err, i }
    this.extras = [];   // second strokes on an already-played grid note: { t }
    this.counts = [0, 0, 0, 0];
    this.streak = 0;
    this.maxStreak = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.weight = 0;
    this.lastStroke = -Infinity;
  }

  classify(errMs) {
    const a = Math.abs(errMs), w = this.windows;
    return a <= w.perfect ? 0 : a <= w.great ? 1 : a <= w.good ? 2 : MISS;
  }

  /**
   * Registers a stroke at song time t.
   * @returns {null | {type: 'chord'|'extra'|'hit'|'miss', hit?: object}}
   */
  hit(t) {
    if (Math.abs(t - this.lastStroke) < CHORD_WINDOW * this.rate) return { type: 'chord' };
    this.lastStroke = t;

    const n = this.notes;
    if (this.first >= n.length) return null;
    let i = lowerBound(n, t);
    if (i >= n.length || (i > 0 && t - n[i - 1].t < n[i].t - t)) i--;
    if (i < this.first) {
      // warm-up strokes before scoring starts are ignored, unless they are closest to the first scored note
      if (i + 1 !== this.first || t - n[i].t < n[this.first].t - t) return null;
      i = this.first;
    }

    const errSong = t - n[i].t;
    const edge = (i === 0 && errSong < 0) || (i === n.length - 1 && errSong > 0);
    if (edge && Math.abs(errSong) > MAX_WINDOW * this.rate) return null; // before the first / after the last grid note

    const err = errSong / this.rate;
    const j = this.classify(err);
    if (j === MISS) {
      this.counts[MISS]++;
      this.streak = 0;
      const miss = { t, err, j, i, slot: n[i].slot, sec: n[i].sec };
      this.misses.push(miss);
      return { type: 'miss', hit: miss };
    }
    if (this.judge[i] !== -1) {
      this.extras.push({ t });
      return { type: 'extra' };
    }

    this.judge[i] = j;
    this.counts[j]++;
    this.sum += err;
    this.sumSq += err * err;
    this.weight += WEIGHT[j];
    this.streak++;
    this.maxStreak = Math.max(this.maxStreak, this.streak);
    const hit = { t, err, j, i, slot: n[i].slot, sec: n[i].sec };
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

  /** Per-key breakdown of strokes. keyFn receives the grid note index and returns a group key. */
  groupBy(keyFn) {
    const groups = new Map();
    const get = k => {
      if (!groups.has(k)) groups.set(k, { key: k, errs: [], misses: 0 });
      return groups.get(k);
    };
    for (const h of this.hits) get(keyFn(h.i)).errs.push(h.err);
    for (const m of this.misses) get(keyFn(m.i)).misses++;
    return [...groups.values()].map(g => ({ ...g, ...meanSd(g.errs) }));
  }
}
