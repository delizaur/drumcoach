// Automatic rhythm grid for beatmaps: finds the triplet beats that also need sextuplet positions.
// Straight beats keep the plain grid (8ths with 16ths allowed, or 8ths on fast sections, see main.js):
// osu! maps often have short 1/8 bursts that follow guitar or vocals, and switching the grid to 32nds
// for single beats made it jumpy and narrowed the hit windows around them.
//
// Only the detailed difficulties count (at least 60% of the most detailed one's off-beat objects),
// since easier ones simplify the rhythm, and a beat needs at least two of them to agree, so a single
// overmapped difficulty can't add positions on its own. It only ever adds positions: beatmaps
// simplify rhythms, so a beat mapped with triplets can still have sextuplets on the drums.
import { snapAt, nearKey } from './triplets.js';

const DETAILED_SHARE = 0.6;

const sameTiming = (a, b) => a.length === b.length && a.every((r, i) =>
  Math.abs(r.time - b[i].time) <= 2 && Math.abs(r.beatLength - b[i].beatLength) < 0.01);

/**
 * @param {{timing: object[], objects: number[]}[]} diffs
 * @param {{start: number}[]} tripletBeats beats already detected as triplets (map time)
 * @returns {{sextuplets: {start, end}[]}} triplet beats (map time) that get sextuplet positions
 */
export function finerBeats(diffs, tripletBeats) {
  // Snaps only mean the same thing between difficulties with the same timing points; some mapsets
  // mix timings (e.g. one difficulty mapped against 4-second "beats"). Use the reference timing's.
  const usable = diffs.filter(d => d.timing?.length && d.objects?.length);
  const ref = usable[0];
  const per = usable.filter(d => sameTiming(d.timing, ref?.timing)).map(d => {
    const beats = new Map(); // rounded beat start → { snaps: Set, start, len }
    let offbeat = 0;
    for (const t of d.objects) {
      const { snap, start, len } = snapAt(d.timing, t);
      if (!snap || snap === 1) continue;
      offbeat++;
      const key = Math.round(start);
      if (!beats.has(key)) beats.set(key, { snaps: new Set(), start, len });
      beats.get(key).snaps.add(snap);
    }
    return { beats, offbeat, span: [Math.min(...d.objects), Math.max(...d.objects)] };
  });
  if (!per.length) return { sextuplets: [] };
  const most = Math.max(...per.map(p => p.offbeat));
  const detailed = per.filter(p => p.offbeat > 0 && p.offbeat >= DETAILED_SHARE * most);
  if (!detailed.length) return { sextuplets: [] };
  // two must agree, unless only one detailed difficulty maps that part of the song
  const needAt = t => Math.max(1, Math.min(2, detailed.filter(({ span: [a, b] }) => t >= a - 2000 && t <= b + 2000).length));

  // beat keys of different difficulties may be a millisecond apart (see nearKey)
  const triplet = new Map(tripletBeats.map(b => [Math.round(b.start), true]));
  const isTriplet = key => triplet.has(nearKey(triplet, key));
  const beatOf = (p, key) => p.beats.get(nearKey(p.beats, key));
  const agreed = (key, snaps) => detailed.filter(p => snaps.some(s => beatOf(p, key)?.snaps.has(s))).length >= needAt(key);

  const sextuplets = [];
  const keys = new Map();
  for (const p of detailed) for (const k of p.beats.keys()) keys.set(nearKey(keys, k), true);
  for (const key of [...keys.keys()].sort((a, b) => a - b)) {
    const b = detailed.map(p => beatOf(p, key)).find(Boolean);
    const beat = { start: b.start, end: b.start + b.len };
    if (isTriplet(key) && agreed(key, [6, 12])) sextuplets.push(beat);
  }
  return { sextuplets };
}
