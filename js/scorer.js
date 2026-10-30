// Quantizes strokes to a rhythm grid and keeps running statistics.
//
// The selected rhythm is a grid of allowed positions, not a part the player has to play in full:
// every stroke snaps to the nearest grid note and is judged by its distance to it. Strokes too far
// from the grid are misses. Grid notes nobody plays are simply skipped, so an 8th-note grid also
// covers quarters, or any mix of the two. Strokes on different pads are scored independently, so
// kick + snare on the same grid note are two hits.
//
// Chart notes (a Clone Hero difficulty) are different: each has a drum (`lane`, plus the `accept`ed
// stroke lanes), a stroke only counts for notes of its drum, and each note can be played once. Notes
// nobody plays are counted as skipped once their window has passed (see advance).
//
// All times are song milliseconds; errors are reported in real milliseconds (adjusted for playback rate).
import { lowerBound, meanSd } from './util.js';

/** Judgment windows (± real ms). A stroke further than `good` from the nearest grid note is a miss. */
export const STRICTNESS = {
  relaxed: { perfect: 30, great: 55, good: 100 },
  normal: { perfect: 18, great: 35, good: 70 },
  strict: { perfect: 10, great: 22, good: 50 },
};
export const JUDGMENTS = ['perfect', 'great', 'good', 'miss'];
export const MISS = 3;
const WEIGHT = [1, 0.75, 0.45, 0];

// Windows scale with the grid spacing. Between two neighbouring grid notes, the windows cover at most
// COVERED of the space, so the middle (20% of the gap, e.g. ±9 ms around the midpoint of two 16ths at
// 160 BPM) is always a miss, however fast the tempo. In hybrid grids, primary notes (e.g. 8ths) get a
// larger share of that space than the secondary ones (16ths), so a sloppy 8th isn't taken for a 16th.
// When the good window shrinks, great and perfect shrink with it once they'd crowd it.
const COVERED = 0.8;
const PULL_PRIMARY = 3, PULL_SECONDARY = 2;
const GREAT_SHARE = 0.75, PERFECT_SHARE = 0.5; // of the (shrunk) good window, at most
const MAX_WINDOW = 150;  // strokes further than this past the first/last grid note are ignored
const DOUBLE_TRIGGER = 35; // strokes on the same pad this close together count as one
const SKIP_MARGIN = 100; // ms past a chart note's late window before it counts as skipped
const CHORD = 1; // ms; chart notes this close are played together, not neighbours

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
    this.chart = notes.some(x => x.accept);
    if (this.chart) {
      this.skipped = new Uint8Array(notes.length); // 1 = chart note nobody played
      this.nSkipped = 0;
      this.skipCursor = this.first;
      // neighbours for the windows: the nearest notes on the same drum(s) that aren't in the same chord
      this.prev = new Int32Array(notes.length).fill(-1);
      this.next = new Int32Array(notes.length).fill(-1);
      const byGroup = new Map();
      notes.forEach((x, i) => {
        const key = x.accept.join();
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key).push(i);
      });
      for (const list of byGroup.values()) {
        for (let a = 0; a < list.length; a++) {
          const t = notes[list[a]].t;
          for (let b = a - 1; b >= 0; b--) if (t - notes[list[b]].t >= CHORD) { this.prev[list[a]] = list[b]; break; }
          for (let b = a + 1; b < list.length; b++) if (notes[list[b]].t - t >= CHORD) { this.next[list[a]] = list[b]; break; }
        }
      }
    }
  }

  pull(i) { return this.hybrid && !this.notes[i].primary ? PULL_SECONDARY : PULL_PRIMARY; }

  /** Windows (± real ms) of grid note i on one side (d = -1 early, +1 late), scaled to the spacing. */
  windowsAt(i, d) {
    const n = this.notes, w = this.windows, k = this.chart ? (d < 0 ? this.prev[i] : this.next[i]) : i + d;
    if (k < 0 || k >= n.length) return w;
    const reach = COVERED * Math.abs(n[k].t - n[i].t) * this.pull(i) / (this.pull(i) + this.pull(k));
    const good = Math.min(w.good, reach / this.rate);
    return { perfect: Math.min(w.perfect, PERFECT_SHARE * good), great: Math.min(w.great, GREAT_SHARE * good), good };
  }

  /** Typical good window (real ms) of the main grid notes (8ths in a hybrid grid) between song times t0 and t1. */
  typicalGood(t0, t1) {
    const n = this.notes, goods = [];
    for (let i = Math.max(this.first, lowerBound(n, t0)); i < n.length && n[i].t <= t1; i++) {
      if (this.hybrid && !n[i].primary) continue;
      goods.push(Math.max(this.windowsAt(i, -1).good, this.windowsAt(i, 1).good));
    }
    if (!goods.length) return this.windows.good;
    goods.sort((a, b) => a - b);
    return goods[goods.length >> 1];
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
    if (this.chart) return this.hitChart(t, pad, lane);

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

  /** hit() for chart notes: the stroke plays the closest unplayed note of its drum within the windows. */
  hitChart(t, pad, lane) {
    const n = this.notes;
    if (pad === 'hihat-pedal') return null; // charts leave the hi-hat foot out; keeping time with it is fine
    if (this.first >= n.length) return null;
    if (t < n[this.first].t - MAX_WINDOW * this.rate || t > n[n.length - 1].t + MAX_WINDOW * this.rate) return null;

    const reach = this.windows.good * this.rate;
    let best = -1, bestKey = null, nearest = -1;
    for (let i = Math.max(this.first, lowerBound(n, t - 2000)); i < n.length && n[i].t <= t + 2000; i++) {
      if (!n[i].accept.includes(lane)) continue;
      const d = Math.abs(t - n[i].t);
      if (nearest < 0 || d < Math.abs(t - n[nearest].t)) nearest = i;
      if (d > reach || this.classify((t - n[i].t) / this.rate, i) === MISS) continue;
      // unplayed notes first, then the stroke's own lane (hi-hat vs cymbal), then the closest
      const key = [this.judge[i] === -1 ? 0 : 1, n[i].lane === lane ? 0 : 1, d];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && d < bestKey[2])))) {
        best = i; bestKey = key;
      }
    }

    if (best < 0) {
      // no note of this drum within reach: a miss. If another drum has a note right there, it's on
      // time but on the wrong drum; otherwise it's shown against this drum's nearest note.
      let i = Math.min(Math.max(this.first, lowerBound(n, t)), n.length - 1);
      if (i > this.first && t - n[i - 1].t < n[i].t - t) i--;
      const wrong = this.classify((t - n[i].t) / this.rate, i) !== MISS;
      if (!wrong && nearest >= 0) i = nearest;
      const err = (t - n[i].t) / this.rate;
      this.counts[MISS]++;
      this.streak = 0;
      const miss = { t, err, j: MISS, i, slot: n[i].slot, sec: n[i].sec, pad, lane, wrong, zones: { early: this.windowsAt(i, -1), late: this.windowsAt(i, 1) } };
      this.misses.push(miss);
      return { type: 'miss', hit: miss };
    }
    if (this.judge[best] !== -1) {
      this.extras.push({ t, pad, lane });
      return { type: 'extra' };
    }

    const err = (t - n[best].t) / this.rate, j = this.classify(err, best);
    if (this.skipped[best]) { this.skipped[best] = 0; this.nSkipped--; } // a late stroke after all
    this.judge[best] = j;
    this.counts[j]++;
    this.sum += err;
    this.sumSq += err * err;
    this.weight += WEIGHT[j];
    this.streak++;
    this.maxStreak = Math.max(this.maxStreak, this.streak);
    const hit = { t, err, j, i: best, slot: n[best].slot, sec: n[best].sec, pad, lane, zones: { early: this.windowsAt(best, -1), late: this.windowsAt(best, 1) } };
    this.hits.push(hit);
    return { type: 'hit', hit };
  }

  /** Chart notes whose window ended before song time `now` without a stroke become skipped. */
  advance(now) {
    if (!this.chart) return 0;
    const n = this.notes;
    let added = 0;
    while (this.skipCursor < n.length && n[this.skipCursor].t + this.windowsAt(this.skipCursor, 1).good * this.rate + SKIP_MARGIN * this.rate < now) {
      const i = this.skipCursor++;
      if (this.judge[i] !== -1) continue;
      this.skipped[i] = 1;
      this.nSkipped++;
      this.streak = 0;
      added++;
    }
    return added;
  }

  stats() {
    const nHits = this.hits.length;
    const judged = nHits + this.misses.length;
    const skipped = this.chart ? this.nSkipped : 0; // they count against the accuracy
    const mean = nHits ? this.sum / nHits : 0;
    const variance = nHits > 1 ? (this.sumSq - (this.sum * this.sum) / nHits) / (nHits - 1) : 0;
    const sd = Math.sqrt(Math.max(0, variance));
    return {
      judged, nHits, mean, sd, ur: sd * 10,
      accuracy: judged + skipped ? this.weight / (judged + skipped) : null,
      counts: this.counts, extra: this.extras.length, skipped, chart: this.chart,
      notes: this.chart ? this.notes.length - this.first : 0,
      streak: this.streak, maxStreak: this.maxStreak,
    };
  }

  /** The per-note results and running totals, for replay files (see restore). */
  snapshot() {
    return {
      judge: [...this.judge], skipped: this.chart ? [...this.skipped] : null,
      counts: [...this.counts], streak: this.streak, maxStreak: this.maxStreak,
      sum: this.sum, sumSq: this.sumSq, weight: this.weight,
    };
  }

  /**
   * A scorer in the state a replay file describes: a snapshot, plus the strokes with the outcome each
   * one had ({ t, r: 'hit'|'miss'|'extra'|…, j, err, i, wrong, pad, lane }). Nothing is scored again,
   * so a replay's results stay as they were, even if the scoring changes later.
   */
  static restore(notes, opts, snap, strokes) {
    const sc = new Scorer(notes, opts);
    sc.judge.set(snap.judge);
    if (sc.chart && snap.skipped) {
      sc.skipped.set(snap.skipped);
      sc.nSkipped = snap.skipped.reduce((a, v) => a + v, 0);
      sc.skipCursor = notes.length;
    }
    sc.counts = [...snap.counts];
    Object.assign(sc, { streak: snap.streak, maxStreak: snap.maxStreak, sum: snap.sum, sumSq: snap.sumSq, weight: snap.weight });
    for (const x of strokes) {
      if (x.r === 'extra') sc.extras.push({ t: x.t, pad: x.pad, lane: x.lane });
      if (x.r !== 'hit' && x.r !== 'miss') continue;
      const n = notes[x.i];
      const hit = { t: x.t, err: x.err, j: x.j, i: x.i, slot: n.slot, sec: n.sec, pad: x.pad, lane: x.lane, zones: { early: sc.windowsAt(x.i, -1), late: sc.windowsAt(x.i, 1) } };
      if (x.wrong) hit.wrong = true;
      (x.r === 'hit' ? sc.hits : sc.misses).push(hit);
    }
    return sc;
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
