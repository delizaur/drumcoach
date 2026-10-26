// Matches hits to expected notes and keeps running statistics.
// All times are song milliseconds; errors are reported in real milliseconds (adjusted for playback rate).
import { lowerBound, meanSd } from './util.js';

/** Judgment windows (± real ms) for perfect / great / good. Anything up to the hit window is "off". */
export const STRICTNESS = {
  relaxed: { perfect: 30, great: 55, good: 90 },
  normal: { perfect: 18, great: 35, good: 60 },
  strict: { perfect: 10, great: 22, good: 40 },
};
export const JUDGMENTS = ['perfect', 'great', 'good', 'off', 'miss'];
export const MISS = 4;
const WEIGHT = [1, 0.75, 0.45, 0.15, 0];

const MAX_WINDOW = 150;  // a hit further than this from any note (or past half the gap to a neighbour) is an extra
const CHORD_WINDOW = 35; // strokes this close together count as one (kick + crash, flams)

export class Scorer {
  constructor(notes, { windows, rate = 1, scoreFrom = -Infinity }) {
    this.notes = notes;
    this.windows = windows;
    this.rate = rate;
    this.first = lowerBound(notes, scoreFrom);
    this.cursor = this.first;
    this.judge = new Int8Array(notes.length).fill(-1);
    this.hits = [];     // { t, err, j, i, slot, sec }
    this.extras = [];   // { t }
    this.misses = [];   // note indices
    this.counts = [0, 0, 0, 0, 0];
    this.streak = 0;
    this.maxStreak = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.weight = 0;
    this.lastStroke = -Infinity;
  }

  /** Half-width of the matching window around note i, in song ms. */
  windowAt(i) {
    const n = this.notes;
    let w = MAX_WINDOW * this.rate;
    if (i > 0) w = Math.min(w, (n[i].t - n[i - 1].t) / 2);
    if (i + 1 < n.length) w = Math.min(w, (n[i + 1].t - n[i].t) / 2);
    return w;
  }

  classify(errMs) {
    const a = Math.abs(errMs), w = this.windows;
    return a <= w.perfect ? 0 : a <= w.great ? 1 : a <= w.good ? 2 : 3;
  }

  /**
   * Registers a stroke at song time t.
   * @returns {null | {type: 'chord'|'extra'|'hit', hit?: object}}
   */
  hit(t) {
    if (Math.abs(t - this.lastStroke) < CHORD_WINDOW * this.rate) return { type: 'chord' };
    this.lastStroke = t;

    const n = this.notes;
    if (!n.length) return null;
    let i = lowerBound(n, t);
    if (i >= n.length || (i > 0 && t - n[i - 1].t < n[i].t - t)) i--;
    if (i < this.first) {
      // before scoring starts: ignore warm-up hits, but a late hit on the first scored note still counts
      if (i + 1 !== this.first || t < n[this.first].t - this.windowAt(this.first)) return null;
      i = this.first;
    }

    const errSong = t - n[i].t;
    if (Math.abs(errSong) > this.windowAt(i) || this.judge[i] !== -1) {
      this.extras.push({ t });
      return { type: 'extra' };
    }

    const err = errSong / this.rate;
    const j = this.classify(err);
    this.judge[i] = j;
    this.counts[j]++;
    this.sum += err;
    this.sumSq += err * err;
    this.weight += WEIGHT[j];
    this.streak = j <= 2 ? this.streak + 1 : 0;
    this.maxStreak = Math.max(this.maxStreak, this.streak);
    const hit = { t, err, j, i, slot: n[i].slot, sec: n[i].sec };
    this.hits.push(hit);
    return { type: 'hit', hit };
  }

  /** Marks every unhit note whose window closed before `now` as missed. Returns the new misses. */
  update(now) {
    const n = this.notes, out = [];
    while (this.cursor < n.length && n[this.cursor].t + this.windowAt(this.cursor) < now) {
      const i = this.cursor++;
      if (this.judge[i] === -1) {
        this.judge[i] = MISS;
        this.counts[MISS]++;
        this.misses.push(i);
        this.streak = 0;
        out.push(i);
      }
    }
    return out;
  }

  stats() {
    const nHits = this.hits.length;
    const judged = nHits + this.counts[MISS];
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

  /** Per-key breakdown of hits/misses. keyFn receives (noteIndex) and returns a group key. */
  groupBy(keyFn) {
    const groups = new Map();
    const get = k => {
      if (!groups.has(k)) groups.set(k, { key: k, errs: [], misses: 0 });
      return groups.get(k);
    };
    for (const h of this.hits) get(keyFn(h.i)).errs.push(h.err);
    for (const i of this.misses) get(keyFn(i)).misses++;
    return [...groups.values()].map(g => ({ ...g, ...meanSd(g.errs) }));
  }
}
