// Triplet fills from beatmaps: finds the beats whose hit objects are snapped to triplet divisions.
//
// Each object's position between two beats reveals its snap (1/2, 1/4, 1/3, ...). Every difficulty
// votes per beat: "triplet" if its off-beat objects there use 1/3, 1/6 or 1/12 snaps, "straight" if
// they use 1/2, 1/4, ... A beat counts as a triplet beat when at least two difficulties (or the only
// one) vote for it and the triplet votes outnumber the straight ones. Beats without any off-beat
// objects in between two triplet beats stay in the section, unless straight evidence comes first.
// Tested on two mapsets of the same song: both found the same one-bar fills, and the drums in the
// audio confirmed them.

const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16]; // coarsest first
const TERNARY = new Set([3, 6, 12]);
const TOL = 1.6; // ms; osu! stores object times rounded to whole milliseconds
const MAX_BRIDGE = 16; // beats without evidence that may sit inside a triplet section (4 bars of 4/4)
const MIN_BEAT = 100;  // ms (600 BPM); shorter beats only occur in joke maps
const MAX_BEATS = 50000; // ~4 hours at 200 BPM; keeps absurd maps from using unbounded memory

function redLineAt(timing, t) {
  let r = timing[0];
  for (const x of timing) if (x.time <= t + 1) r = x;
  return r;
}

/**
 * Snap of a hit object at time t: the coarsest division of the beat it sits on (1 = on the beat,
 * 2 = halfway, 3 = a third, ...), plus the start and length of its beat. snap is null if unsnapped.
 */
export function snapAt(timing, t) {
  const r = redLineAt(timing, t);
  const pos = (t - r.time) / r.beatLength;
  let beat = Math.floor(pos), frac = pos - beat;
  if (frac > 1 - TOL / r.beatLength) { beat++; frac = 0; } // a hair before the next beat
  const snap = SNAPS.find(s => Math.abs(frac * s - Math.round(frac * s)) * r.beatLength / s <= TOL) ?? null;
  return { snap, start: r.time + beat * r.beatLength, len: r.beatLength };
}

/**
 * @param {{timing: object[], objects: number[]}[]} diffs
 * @returns {{start: number, end: number}[]} triplet beats in map time (ms), sorted
 */
export function tripletBeats(diffs) {
  const votes = new Map(); // beat start (rounded ms) → { T, B, start, len }
  let voters = 0;
  for (const d of diffs) {
    if (!d.objects?.length || !d.timing?.length) continue;
    const seen = new Map();
    for (const t of d.objects) {
      const { snap, start, len } = snapAt(d.timing, t);
      if (!snap || snap === 1) continue; // on the beat (or unsnapped): says nothing
      const key = Math.round(start);
      const kind = TERNARY.has(snap) ? 'T' : 'B';
      const prev = seen.get(key);
      seen.set(key, { kind: prev && prev.kind !== kind ? 'B' : kind, start, len }); // mixed counts as straight
    }
    if (seen.size) voters++;
    for (const [key, v] of seen) {
      const e = votes.get(key) || { T: 0, B: 0, start: v.start, len: v.len };
      e[v.kind]++;
      votes.set(key, e);
    }
  }
  const need = Math.min(2, voters);
  if (!need) return [];

  // Walk every beat of the song in order. Many beats have no off-beat objects and can't vote either
  // way; once a triplet section has started, those don't end it. Only a beat with clear straight
  // evidence does, and gaps longer than MAX_BRIDGE beats aren't bridged.
  const ref = diffs.find(d => d.timing?.length && d.objects?.length);
  let lastObject = 0;
  for (const d of diffs) for (const t of d.objects || []) if (t > lastObject) lastObject = t;
  const grid = [];
  ref.timing.forEach((r, i) => {
    if (r.beatLength < MIN_BEAT) return; // joke maps with absurd tempos: no fills to find
    const end = Math.min(i + 1 < ref.timing.length ? ref.timing[i + 1].time : Infinity, lastObject + r.beatLength);
    for (let k = 0, t = r.time; t < end - 1 && grid.length < MAX_BEATS; t = r.time + ++k * r.beatLength) {
      grid.push({ start: t, len: r.beatLength });
    }
  });
  const state = b => {
    const key = Math.round(b.start), v = votes.get(key) ?? votes.get(key - 1) ?? votes.get(key + 1);
    if (!v) return null;
    return v.T >= need && v.T > v.B ? 'T' : v.B >= need && v.B > v.T ? 'B' : null; // weak or tied: no evidence
  };
  const out = [];
  let lastT = -1; // index of the latest triplet beat in the current section
  grid.forEach((b, i) => {
    const s = state(b);
    if (s === 'T') {
      if (lastT >= 0 && i - lastT - 1 <= MAX_BRIDGE) for (let j = lastT + 1; j < i; j++) out.push(grid[j]);
      out.push(b);
      lastT = i;
    } else if (s === 'B') {
      lastT = -1; // strong straight evidence ends the section
    }
  });
  return out.map(b => ({ start: b.start, end: b.start + b.len }));
}

/** Merges adjacent beats into sections (for display). */
export function mergeBeats(beats) {
  const out = [];
  for (const b of beats) {
    const last = out[out.length - 1];
    if (last && b.start - last.end < 2) last.end = b.end;
    else out.push({ ...b });
  }
  return out;
}
