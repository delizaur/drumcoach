// Triplet fills from beatmaps: finds the beats whose hit objects are snapped to triplet divisions.
//
// Each object's position between two beats reveals its snap (1/2, 1/4, 1/3, ...). Every difficulty
// votes per beat: "triplet" if its off-beat objects there use 1/3, 1/6 or 1/12 snaps, "straight" if
// they use 1/2, 1/4, ... A beat counts as a triplet beat when at least two difficulties (or the only
// one) vote for it and the triplet votes outnumber the straight ones. Tested on two mapsets of the
// same song: both found the same one-bar fills, and the drums in the audio confirmed them.

const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16]; // coarsest first
const TERNARY = new Set([3, 6, 12]);
const TOL = 1.6; // ms; osu! stores object times rounded to whole milliseconds

function redLineAt(timing, t) {
  let r = timing[0];
  for (const x of timing) if (x.time <= t + 1) r = x;
  return r;
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
      const r = redLineAt(d.timing, t);
      const pos = (t - r.time) / r.beatLength;
      let beat = Math.floor(pos), frac = pos - beat;
      if (frac > 1 - TOL / r.beatLength) { beat++; frac = 0; } // a hair before the next beat
      const snap = SNAPS.find(s => Math.abs(frac * s - Math.round(frac * s)) * r.beatLength / s <= TOL);
      if (!snap || snap === 1) continue; // on the beat (or unsnapped): says nothing
      const start = r.time + beat * r.beatLength, key = Math.round(start);
      const kind = TERNARY.has(snap) ? 'T' : 'B';
      const prev = seen.get(key);
      seen.set(key, { kind: prev && prev.kind !== kind ? 'B' : kind, start, len: r.beatLength }); // mixed counts as straight
    }
    if (seen.size) voters++;
    for (const [key, v] of seen) {
      const e = votes.get(key) || { T: 0, B: 0, start: v.start, len: v.len };
      e[v.kind]++;
      votes.set(key, e);
    }
  }
  const need = Math.min(2, voters);
  return [...votes.values()]
    .filter(v => need > 0 && v.T >= need && v.T > v.B)
    .sort((a, b) => a.start - b.start)
    .map(v => ({ start: v.start, end: v.start + v.len }));
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
