// Automatic beat sync: finds how far a map's beat grid is from the drums in its audio.
//
// The audio is split into a low band (kicks) and a high band (snares, hats, cymbals). In each, an
// onset curve marks where the loudness jumps (1 ms resolution). Every candidate shift of the map's
// beats is scored by the average onset strength at the shifted beat times; the best-scoring shift
// is the sync offset. Averaging over hundreds of beats cancels hits that aren't on the beat.

export const SYNC_VERSION = 1; // bump to invalidate cached results when the algorithm changes

const RANGE = 60;            // ms searched either way
const STEP = 0.5;            // ms
const MIN_CONFIDENCE = 1.5;  // best score / median score; below this the result isn't trusted
const SECTION_MIN_BEATS = 32;
const SECTION_FLAG_MS = 10;  // a section this far from the whole-map value gets flagged

async function bandPass(buffer, type, freq) {
  const ctx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate); // mono downmix
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  src.connect(f).connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/** Onset strength per millisecond: rise in log energy over a 4 ms window, normalized to mean 1. */
function onsetCurve(x, sampleRate) {
  const hop = Math.round(sampleRate / 1000), W = 4;
  const n = Math.floor(x.length / hop);
  const energy = new Float32Array(n);
  for (let i = W; i < n; i++) {
    let s = 0;
    for (let j = (i - W) * hop; j < i * hop; j++) s += x[j] * x[j];
    energy[i] = Math.log(1e-10 + s / (W * hop));
  }
  const curve = new Float32Array(n);
  let mean = 0;
  for (let i = 3; i < n - 3; i++) {
    curve[i] = Math.max(0, energy[i + 2] - energy[i - 2]);
    mean += curve[i];
  }
  mean /= n;
  if (mean > 0) for (let i = 0; i < n; i++) curve[i] /= mean;
  return curve;
}

/** Combined kick + snare/cymbal onset curve of a song, one value per millisecond. */
export async function drumOnsets(buffer) {
  const [low, high] = await Promise.all([bandPass(buffer, 'lowpass', 150), bandPass(buffer, 'highpass', 2500)]);
  const a = onsetCurve(low, buffer.sampleRate), b = onsetCurve(high, buffer.sampleRate);
  return a.map((v, i) => v + b[i]);
}

/** Best shift (ms) for a list of beat times, and how clearly it stands out. */
function bestShift(curve, beats) {
  const at = t => {
    const i = Math.floor(t), a = t - i;
    return (curve[i] || 0) * (1 - a) + (curve[i + 1] || 0) * a;
  };
  const scores = [];
  let best = -1, shift = 0;
  for (let o = -RANGE; o <= RANGE + 1e-9; o += STEP) {
    let s = 0;
    for (const t of beats) s += at(t + o);
    scores.push(s);
    if (s > best) { best = s; shift = o; }
  }
  const median = [...scores].sort((a, b) => a - b)[scores.length >> 1];
  return { shift, confidence: median > 0 ? best / median : (best > 0 ? Infinity : 0) };
}

/**
 * @param {AudioBuffer} buffer decoded song
 * @param {{time:number, beatLength:number, meter:number}[]} redLines the map's timing points
 * @returns {Promise<{ok:boolean, offset:number, confidence:number, beats:number,
 *   sections: {index:number, time:number, bpm:number, beats:number, offset:number, confidence:number}[],
 *   flagged: object[]}>} offset: ms to move the map's beats later (negative = earlier)
 */
export async function analyzeSync(buffer, redLines) {
  const curve = await drumOnsets(buffer);

  const duration = buffer.duration * 1000;
  const perSection = redLines.map((r, i) => {
    const end = i + 1 < redLines.length ? redLines[i + 1].time : duration;
    const beats = [];
    for (let t = r.time; t < end - 1; t += r.beatLength) {
      if (t > RANGE + 200 && t < duration - RANGE - 200) beats.push(t);
    }
    return { index: i, time: r.time, bpm: 60000 / r.beatLength, beats };
  });
  const all = perSection.flatMap(s => s.beats);
  if (all.length < 16) return { ok: false, offset: 0, confidence: 0, beats: all.length, sections: [], flagged: [] };

  const whole = bestShift(curve, all);
  const ok = whole.confidence >= MIN_CONFIDENCE;
  const sections = perSection
    .filter(s => s.beats.length >= SECTION_MIN_BEATS)
    .map(s => ({ index: s.index, time: s.time, bpm: s.bpm, beats: s.beats.length, ...rename(bestShift(curve, s.beats)) }));
  const flagged = ok && sections.length > 1
    ? sections.filter(s => s.confidence >= MIN_CONFIDENCE && Math.abs(s.offset - whole.shift) >= SECTION_FLAG_MS)
    : [];
  return { ok, offset: whole.shift, confidence: whole.confidence, beats: all.length, sections, flagged };
}

const rename = ({ shift, confidence }) => ({ offset: shift, confidence });
