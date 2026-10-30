// Drum transcription with ADTOF (models/adtof), off the main thread. Takes mono 44.1 kHz samples and
// returns each drum's hits as 10 ms frame numbers.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';

const CLASSES = ['kick', 'snare', 'toms', 'hihat', 'cymbals'];
const THRESHOLDS = [0.22, 0.24, 0.32, 0.22, 0.30]; // the authors'
// madmom's NotePeakPickingProcessor settings, in frames at 100 fps
const PRE_AVG = 10, POST_AVG = 1, PRE_MAX = 2, POST_MAX = 1, COMBINE = 2;

ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which GitHub Pages can't set up
let session = null;

/** madmom's peak picking for one drum: frames above the local average + threshold that are local maxima. */
function peaks(act, threshold) {
  const n = act.length, det = new Float32Array(n), out = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i - PRE_AVG; k <= i + POST_AVG; k++) s += k >= 0 && k < n ? act[k] : 0;
    det[i] = act[i] >= s / (PRE_AVG + POST_AVG + 1) + threshold ? act[i] : 0;
  }
  for (let i = 0; i < n; i++) {
    if (!det[i]) continue;
    let m = 0;
    for (let k = i - PRE_MAX; k <= i + POST_MAX; k++) if (k >= 0 && k < n) m = Math.max(m, det[k]);
    if (det[i] === m && (!out.length || i - out.at(-1) > COMBINE)) out.push(i);
  }
  return out;
}

self.onmessage = async ({ data: { audio } }) => {
  try {
    session ||= await ort.InferenceSession.create(new URL('../models/adtof/adtof_frame_rnn.onnx', import.meta.url).href);
    const { activations: act } = await session.run({ waveform: new ort.Tensor('float32', audio, [1, audio.length]) });
    const frames = act.dims[1], hits = {};
    CLASSES.forEach((name, c) => {
      const curve = new Float32Array(frames);
      for (let f = 0; f < frames; f++) curve[f] = act.data[f * CLASSES.length + c];
      hits[name] = peaks(curve, THRESHOLDS[c]);
    });
    self.postMessage({ hits });
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  }
};
