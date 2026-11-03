// Drum removal with HTDemucs (see demucs.js), off the main thread. Takes 44.1 kHz stereo samples and
// returns everything but the drums (bass + other + vocals) as a 16-bit WAV file.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
import { separate, MODEL_SAMPLE_RATE } from './demucs.js';
import { SEPARATION_MODEL_URL, savedModel, saveModel } from './drumless.js';

ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which GitHub Pages can't set up
let ready = null;

const progress = (stage, value) => self.postMessage({ type: 'progress', stage, value });

self.onmessage = async ({ data: { left, right } }) => {
  try {
    ready ||= loadModel().then(createSession);
    const { session, backend } = await ready;
    const run = async (mix, mag, segment, bins, frames) => {
      const out = await session.run({
        mix: new ort.Tensor('float32', mix, [1, 2, segment]),
        mag: new ort.Tensor('float32', mag, [1, 4, bins, frames]),
      });
      return { freq: out.freq.data, time: out.time.data };
    };
    progress('separate', 0);
    const [[l, r]] = await separate(left, right, [['bass', 'other', 'vocals']], run, p => progress('separate', p));
    const wav = encodeWav(l, r, MODEL_SAMPLE_RATE);
    self.postMessage({ type: 'result', wav, backend }, [wav]);
  } catch (err) {
    ready = null; // a failed download is retried next time
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};

/** The model's bytes: saved from an earlier download, or downloaded (and saved) with progress. */
async function loadModel() {
  const saved = await savedModel();
  if (saved) return saved;

  progress('download', 0);
  let bytes;
  for (let attempt = 1; !bytes; attempt++) { // a large download can drop midway
    try {
      bytes = await download(SEPARATION_MODEL_URL, p => progress('download', p));
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`Model download failed (attempt ${attempt}), retrying`, err);
    }
  }
  await saveModel(bytes);
  return bytes;
}

async function download(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The model download failed (HTTP ${res.status}).`);
  const size = Number(res.headers.get('content-length')) || 0, chunks = [];
  let received = 0;
  for (const reader = res.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (size) onProgress(received / size);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return bytes;
}

/** An ONNX Runtime session on the GPU (WebGPU) when there is one, otherwise on the CPU. */
async function createSession(model) {
  progress('load', 0);
  const create = provider => ort.InferenceSession.create(model, { executionProviders: [provider], logSeverityLevel: 3 });
  if (self.navigator.gpu) {
    try { return { session: await create('webgpu'), backend: 'webgpu' }; } catch (err) { console.warn('WebGPU unavailable, using WebAssembly', err); }
  }
  return { session: await create('wasm'), backend: 'wasm' };
}

/** 16-bit stereo PCM WAV. */
function encodeWav(left, right, rate) {
  const n = left.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const str = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 4, true);
  const pcm = x => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0, p = 44; i < n; i++, p += 4) {
    v.setInt16(p, pcm(left[i]), true);
    v.setInt16(p + 2, pcm(right[i]), true);
  }
  return buf;
}
