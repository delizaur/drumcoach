// Tempo maps ("sections"), rhythm patterns and the expected-note grid derived from them.
//
// A section is { start, end, beatLength, meter } in song milliseconds. Songs get one section
// per osu! red line. Metronome mode gets one section, or one per step of the speed trainer.

/**
 * Preset rhythms. `grid` has one character per subdivision of a beat: x = hit, . = rest.
 * Hybrid grids also have a `primary` mask: strokes snap to the primary notes (e.g. 8ths) whenever
 * they're within the good window, and only fall back to the finer notes (e.g. 16ths) otherwise.
 */
export const PATTERNS = [
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
    if (end - start >= 1) sections.push({ start, end, beatLength: r.beatLength, meter: r.meter || 4 });
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
export function buildGrid(sections, pattern) {
  const EPS = 1; // ms; ignore beats that fall right on a section's end
  const beats = [], notes = [];
  let bar0 = 0;

  sections.forEach((s, sec) => {
    const bl = s.beatLength;
    const barMs = bl * s.meter;
    s.bar0 = bar0;

    for (let k = 0; ; k++) {
      const t = s.start + k * bl;
      if (t >= s.end - EPS) break;
      const beatInBar = k % s.meter;
      beats.push({ t, bar: bar0 + Math.floor(k / s.meter), beatInBar, downbeat: beatInBar === 0, sec });
    }

    const cycleMs = pattern.cycle * bl;
    outer:
    for (let c = 0; ; c++) {
      const c0 = s.start + c * cycleMs;
      if (c0 >= s.end - EPS) break;
      for (const h of pattern.hits) {
        const t = c0 + h.pos * bl;
        if (t >= s.end - EPS) break outer;
        const beatPos = (t - s.start) / bl;
        const onBeat = Math.abs(beatPos - Math.round(beatPos)) < 1e-6;
        notes.push({
          t,
          slot: h.slot,
          primary: h.primary,
          sec,
          bar: bar0 + Math.floor((t - s.start) / barMs + 1e-9),
          onBeat,
          downbeat: onBeat && Math.round(beatPos) % s.meter === 0,
        });
      }
    }
    bar0 += Math.max(1, Math.ceil((s.end - s.start - EPS) / barMs));
  });
  return { beats, notes };
}

export function sectionAt(sections, t) {
  let lo = 0, hi = sections.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
