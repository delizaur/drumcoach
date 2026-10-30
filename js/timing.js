// Tempo maps ("sections"), rhythm patterns and the expected-note grid derived from them.
//
// A section is { start, end, beatLength, meter, phase, sig? } in song milliseconds. Songs get one section
// per timing point; `phase` is the beat of the bar it starts on (0 for osu! red lines, which always
// start a bar, but Clone Hero tempo changes can fall mid-bar). Metronome mode gets one section, or
// one per step of the speed trainer.

/**
 * Preset rhythms. `grid` has one character per subdivision of a beat: x = hit, . = rest.
 * Hybrid grids also have a `primary` mask: strokes snap to the primary notes (e.g. 8ths) whenever
 * they're within the good window, and only fall back to the finer notes (e.g. 16ths) otherwise.
 */
export const PATTERNS = [
  { id: 'auto', name: 'Automatic (from the beatmap or chart)', subdiv: 4, grid: 'xxxx', primary: 'x.x.' },
  { id: 'hybrid-8-16', name: '8ths, 16ths allowed (hybrid)', subdiv: 4, grid: 'xxxx', primary: 'x.x.' },
  { id: 'hybrid-4-8', name: 'Quarters, 8ths allowed (hybrid)', subdiv: 2, grid: 'xx', primary: 'x.' },
  { id: 'hybrid-8-trip', name: '8ths, triplets allowed (hybrid)', subdiv: 6, grid: 'x.xxx.', primary: 'x..x..' },
  { id: 'quarter', name: 'Quarter notes', subdiv: 1, grid: 'x' },
  { id: 'half', name: 'Half notes', subdiv: 1, grid: 'x.' },
  { id: 'eighths', name: 'Eighth notes', subdiv: 2, grid: 'xx' },
  { id: 'offbeat', name: 'Off-beat eighths (only the "&")', subdiv: 2, grid: '.x' },
  { id: 'triplets', name: 'Eighth-note triplets', subdiv: 3, grid: 'xxx' },
  { id: 'swing', name: 'Swung eighths', subdiv: 3, grid: 'x.x' },
  { id: 'sixteenths', name: 'Sixteenth notes', subdiv: 4, grid: 'xxxx' },
  { id: 'gallop', name: 'Gallop (8th + two 16ths)', subdiv: 4, grid: 'x.xx' },
  { id: 'revgallop', name: 'Reverse gallop (two 16ths + 8th)', subdiv: 4, grid: 'xxx.' },
  { id: 'eanda', name: '"e & a" (skip the downbeat)', subdiv: 4, grid: '.xxx' },
  { id: 'sextuplets', name: 'Sextuplets', subdiv: 6, grid: 'xxxxxx' },
  { id: 'backbeat', name: 'Backbeat (2 and 4)', subdiv: 1, grid: '.x' },
  { id: 'clave', name: 'Son clave 3-2', subdiv: 4, grid: 'x..x..x...x.x...' },
  { id: 'custom', name: 'Custom…', subdiv: 4, grid: '' },
];

const SUB_NAMES = { 1: [''], 2: ['', '&'], 3: ['', 'trip', 'let'], 4: ['', 'e', '&', 'a'], 6: ['', '6let 2', 'trip', '&', 'let', '6let 6'] };

function slotLabel(j, subdiv, cycleBeats) {
  const beat = Math.floor(j / subdiv) + 1;
  const sub = j % subdiv;
  const name = (SUB_NAMES[subdiv] || [])[sub] ?? `${sub + 1}/${subdiv}`;
  if (cycleBeats <= 1) return sub === 0 ? 'on the beat' : name;
  if (sub === 0) return `beat ${beat}`;
  return SUB_NAMES[subdiv] ? `${beat}${name}` : `${beat} + ${name}`;
}

const cleanGrid = g => String(g).toLowerCase().replace(/[-_o]/g, '.').replace(/[^x.]/g, '');

export function makePattern({ id = 'custom', name = 'Custom', subdiv, grid, primary = null }) {
  const clean = cleanGrid(grid);
  const mask = primary == null ? null : cleanGrid(primary);
  subdiv = Math.max(1, Math.round(subdiv) || 1);
  if (!clean.includes('x')) return makePattern({ id, name, subdiv: 1, grid: 'x' });
  const cycle = clean.length / subdiv; // in beats
  const hits = [];
  for (let j = 0; j < clean.length; j++) {
    if (clean[j] === 'x') {
      hits.push({ pos: j / subdiv, slot: j, label: slotLabel(j, subdiv, cycle), primary: !mask || mask[j] === 'x' });
    }
  }
  return { id, name, subdiv, grid: clean, cycle, hits, hybrid: hits.some(h => !h.primary) };
}

export function songSections(redLines, endMs, shiftMs = 0) {
  const sections = [];
  redLines.forEach((r, i) => {
    const start = r.time + shiftMs;
    const end = i + 1 < redLines.length ? redLines[i + 1].time + shiftMs : endMs;
    if (end - start >= 1) sections.push({ start, end, beatLength: r.beatLength, meter: r.meter || 4, phase: r.phase || 0, sig: r.sig });
  });
  return sections;
}

export function metronomeSections({ bpm, meter, countIn = 0, trainer = null, durationMs = 3600_000 }) {
  if (!trainer) return [{ start: 0, end: durationMs, beatLength: 60000 / bpm, meter }];
  const sections = [];
  let t = 0, cur = bpm;
  while (t < durationMs) {
    const beatLength = 60000 / cur;
    const bars = (sections.length === 0 ? countIn : 0) + trainer.everyBars;
    const end = t + bars * meter * beatLength;
    sections.push({ start: t, end, beatLength, meter });
    t = end;
    cur = Math.min(Math.max(trainer.max, bpm), cur + trainer.step);
  }
  return sections;
}

/**
 * Expands sections + pattern into sorted lists of beats (for clicks and grid lines)
 * and notes (what the player should hit).
 */
/**
 * @param {{start:number, end:number}[]} [opts.tripletBeats] beats (song ms) whose subdivisions are
 *   replaced by triplets, e.g. drum fills found in a beatmap
 * @param {{start:number, end:number}[]} [opts.sextupletBeats] triplet beats that also get sextuplet
 *   positions (as secondary notes), from the automatic grid
 * @param {(section) => object} [opts.patternFor] pattern for a section, if not `pattern` (e.g. a
 *   coarser grid for fast sections)
 */
export function buildGrid(sections, pattern, { tripletBeats = [], sextupletBeats = [], patternFor = null } = {}) {
  const EPS = 1; // ms; ignore beats that fall right on a section's end
  const beats = [], notes = [];
  let bar0 = 0;

  sections.forEach((s, sec) => {
    const bl = s.beatLength, ph = s.phase || 0;
    s.bar0 = bar0; // the bar s.start falls in
    if (!(bl >= 20)) return; // safety net: a near-zero beat length would never advance the loops below

    for (let k = 0; ; k++) {
      const t = s.start + k * bl;
      if (t >= s.end - EPS) break;
      const beatInBar = (k + ph) % s.meter;
      beats.push({ t, bar: barOf(s, t), beatInBar, downbeat: beatInBar === 0, sec });
    }

    // the pattern's cycle (e.g. a 4-beat clave) starts on a downbeat, also when the section doesn't
    const p = patternFor?.(s) ?? pattern;
    const lead = ph % p.cycle;
    outer:
    for (let c = 0; ; c++) {
      const c0 = s.start + (c * p.cycle - lead) * bl;
      if (c0 >= s.end - EPS) break;
      for (const h of p.hits) {
        const t = c0 + h.pos * bl;
        if (t < s.start - EPS) continue;
        if (t >= s.end - EPS) break outer;
        const beatPos = (t - s.start) / bl;
        const onBeat = Math.abs(beatPos - Math.round(beatPos)) < 1e-6;
        notes.push({
          t,
          slot: h.slot,
          primary: h.primary,
          sec,
          bar: barOf(s, t),
          onBeat,
          downbeat: onBeat && (Math.round(beatPos) + ph) % s.meter === 0,
        });
      }
    }
    // a section that continues mid-bar stays in the bar it starts in
    const span = ph + (s.end - s.start - EPS) / bl, next = sections[sec + 1];
    bar0 += next?.phase ? Math.floor(span / s.meter + EPS / bl) : Math.max(1, Math.ceil(span / s.meter));
  });
  if (!tripletBeats.length && !sextupletBeats.length) return { beats, notes };

  // Beats can be cut short by a timing point in the middle of them (common in maps of live
  // recordings): clip every special beat at its section's end and use that section's tempo.
  const clip = list => list.map(b => {
    const sec = sectionAt(sections, b.start), s = sections[sec];
    return s && b.start >= s.start - EPS && b.start < s.end - EPS
      ? { start: b.start, end: Math.min(b.end, s.end), bl: s.beatLength, sec, s } : null;
  }).filter(Boolean);
  tripletBeats = clip(tripletBeats);

  // In triplet beats, keep (or add) the note on the beat and replace everything in between with
  // the two triplet positions. All of them are primary notes, so hybrid snapping doesn't apply there.
  const inside = t => tripletBeats.some(b => t > b.start + EPS && t < b.end - EPS);
  const out = tripletBeats.length ? notes.filter(n => !inside(n.t)) : notes;
  for (const b of tripletBeats) {
    const { sec, s, bl } = b;
    const beatPos = Math.round((b.start - s.start) / s.beatLength);
    const onBeatNote = out.find(n => Math.abs(n.t - b.start) < EPS);
    if (onBeatNote) onBeatNote.primary = true;
    else out.push({ t: b.start, slot: 0, primary: true, sec, bar: s.bar0 + Math.floor((beatPos + (s.phase || 0)) / s.meter), onBeat: true, downbeat: (beatPos + (s.phase || 0)) % s.meter === 0 });
    for (const k of [1, 2]) {
      if (b.start + (k * bl) / 3 >= b.end - EPS) continue;
      out.push({ t: b.start + (k * bl) / 3, slot: TRIPLET_SLOT + k, primary: true, sec, bar: barOf(s, b.start + (k * bl) / 3), onBeat: false, downbeat: false, triplet: true });
    }
  }
  // Sextuplet positions from the automatic grid, as secondary notes so the triplets are preferred.
  const taken = new Set(out.map(n => Math.round(n.t)));
  const addPositions = (list, fractions, slot0, flag) => {
    for (const b of clip(list)) {
      const { sec, s, bl } = b;
      fractions.forEach((f, k) => {
        const t = b.start + f * bl;
        if (t >= b.end - EPS || taken.has(Math.round(t))) return;
        taken.add(Math.round(t));
        out.push({ t, slot: slot0 + k + 1, primary: false, sec, bar: barOf(s, t), onBeat: false, downbeat: false, [flag]: true });
      });
    }
  };
  addPositions(sextupletBeats, [1 / 6, 3 / 6, 5 / 6], SEXTUPLET_SLOT, 'triplet');
  out.sort((a, b) => a.t - b.t);
  return { beats, notes: out };
}

/** Bar number of time t in section s (after buildGrid has set s.bar0). */
const barOf = (s, t) => s.bar0 + Math.floor(((t - s.start) / s.beatLength + (s.phase || 0)) / s.meter + 1e-9);

/** Slot ids of triplet-fill notes (TRIPLET_SLOT + 1 and + 2), kept apart from the pattern's slots. */
export const TRIPLET_SLOT = 100;
/** Slot ids of sextuplet positions (SEXTUPLET_SLOT + 1..3). */
export const SEXTUPLET_SLOT = 110;

export function sectionAt(sections, t) {
  let lo = 0, hi = sections.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
