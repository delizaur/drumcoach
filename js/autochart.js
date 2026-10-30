// Experimental: charts generated from the audio. ADTOF (adt-worker.js) finds the drum hits, and they are
// written as a Clone Hero .chart on the song's beat grid, so they load like any other chart.
import { sectionAt } from './timing.js';

export const AUTO_CHART_VERSION = 1;
const SR = 44100;
const FRAME_MS = 10; // the model's frame rate is 100 fps
const RES = 192; // ticks per beat: divisible by 3 and 4, for triplets and 16ths
// ADTOF's drums as pro drums notes: [pad, cymbal marker]. Hi-hat on the yellow cymbal, crash and ride
// (one class in ADTOF) on the green one, toms on the blue tom.
const PADS = { kick: [0], snare: [1], hihat: [2, 66], toms: [3], cymbals: [4, 68] };

/** Runs the transcription: each drum's hits as 10 ms frame numbers. */
export async function transcribeDrums(buffer) {
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * SR), SR); // mono at the model's rate
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const audio = (await ctx.startRendering()).getChannelData(0);
  const worker = new Worker(new URL('./adt-worker.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data.hits));
      worker.onerror = e => reject(new Error(e.message || 'The transcription worker failed to start.'));
      worker.postMessage({ audio }, [audio.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Snaps a beat position to 16ths, or to 8th-note triplets when those are clearly closer (the model's
 * timing wobbles by a frame or two, which shouldn't turn straight notes into triplets).
 */
function snap(pos) {
  const q4 = Math.round(pos * 4) / 4, q3 = Math.round(pos * 3) / 3;
  return Math.abs(pos - q3) < Math.abs(pos - q4) / 2 ? q3 : q4;
}

const quoted = s => `"${String(s ?? '').replace(/"/g, "'")}"`;

/**
 * Writes the hits as a .chart (Expert pro drums) on the given sections: one tempo marker per
 * section, tick 0 at the first one (the chart's Offset).
 */
export function chartText(hits, sections, { title, artist }) {
  if (!sections.length) return null;
  const t0 = sections[0].start, ticks = [0];
  for (let i = 1; i < sections.length; i++) {
    const p = sections[i - 1];
    ticks.push(ticks[i - 1] + Math.round((sections[i].start - p.start) / p.beatLength * RES));
  }
  const sync = [];
  let meter = 0;
  sections.forEach((s, i) => {
    if (s.meter !== meter) {
      meter = s.meter;
      sync.push([Math.max(0, ticks[i] - Math.round((s.phase || 0) * RES)), `TS ${meter}`]);
    }
    sync.push([ticks[i], `B ${Math.round(60000 / s.beatLength * 1000)}`]);
  });
  sync.sort((a, b) => a[0] - b[0]);

  const notes = new Map(); // tick → lines, so a drum gets one note per tick
  for (const [drum, frames] of Object.entries(hits)) {
    for (const f of frames) {
      const t = f * FRAME_MS, i = sectionAt(sections, t), s = sections[i];
      if (!s || t < s.start - s.beatLength / 8 || t >= s.end) continue;
      const tick = ticks[i] + Math.round(snap((t - s.start) / s.beatLength) * RES);
      if (tick < 0) continue;
      if (!notes.has(tick)) notes.set(tick, new Set());
      const [pad, cymbal] = PADS[drum];
      notes.get(tick).add(`N ${pad} 0`);
      if (cymbal) notes.get(tick).add(`N ${cymbal} 0`);
    }
  }
  const body = [...notes.keys()].sort((a, b) => a - b).flatMap(tick => [...notes.get(tick)].map(n => `  ${tick} = ${n}`));
  return [
    '[Song]', '{',
    `  Name = ${quoted(title)}`, `  Artist = ${quoted(artist)}`, `  Charter = ${quoted('DrumCoach (ADTOF, auto-generated)')}`,
    `  Offset = ${+(t0 / 1000).toFixed(4)}`, `  Resolution = ${RES}`,
    '}',
    '[SyncTrack]', '{', ...sync.map(([tick, v]) => `  ${tick} = ${v}`), '}',
    '[ExpertDrums]', '{', ...body, '}',
    '',
  ].join('\r\n');
}
