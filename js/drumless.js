// Drumless versions of songs: HTDemucs (separation-worker.js) splits the song and everything but the
// drums is kept, so you can play along in place of the original drummer.
import { MODEL_SAMPLE_RATE } from './demucs.js';

// HTDemucs v4 (Meta, MIT) exported to ONNX with the STFT outside the graph, pinned to a commit.
export const SEPARATION_MODEL_URL =
  'https://huggingface.co/Ghilda/htdemucs-onnx/resolve/850cd89461d0817276337061c29e6abceb86d75f/htdemucs.onnx';
export const MODEL_MB = 166;
export const DRUMLESS_VERSION = 1; // bumped when the separation changes, so old versions are made again

// The downloaded model is kept in IndexedDB (Cache Storage isn't always available), keyed by its URL.
const MODEL_DB = 'drumgrade-models', MODEL_STORE = 'files';

async function models(mode, fn) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(MODEL_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(MODEL_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(MODEL_STORE, mode);
      const req = fn(tx.objectStore(MODEL_STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Whether the model is downloaded already. */
export async function modelDownloaded() {
  try { return (await models('readonly', s => s.count(SEPARATION_MODEL_URL))) > 0; } catch { return false; }
}

/** The downloaded model's bytes, or null. */
export async function savedModel() {
  try {
    const blob = await models('readonly', s => s.get(SEPARATION_MODEL_URL));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
}

/** Keeps the model for next time, in place of any other version of it. */
export async function saveModel(bytes) {
  try {
    await models('readwrite', s => { s.clear(); return s.put(new Blob([bytes]), SEPARATION_MODEL_URL); });
  } catch (err) {
    console.warn('Could not save the model', err); // it's downloaded again next time
  }
}

let gpu = null;
/** Whether this browser offers WebGPU with a usable adapter, so the model can run on the GPU. */
export function gpuSupported() {
  return gpu ||= (async () => {
    try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
  })();
}

/**
 * The song without its drums, as a WAV file. `onProgress(stage, fraction)` reports 'download' (only
 * when the model isn't cached), 'load' and 'separate'; `onBackend('webgpu' | 'wasm')` tells where the
 * model runs once it's loaded. Aborting the signal stops the work.
 * @returns {Promise<Blob>}
 */
export async function removeDrums(buffer, { onProgress = () => {}, onBackend = () => {}, signal } = {}) {
  // the model works on 44.1 kHz stereo; mono songs are spread to both channels
  const ctx = new OfflineAudioContext(2, Math.ceil(buffer.duration * MODEL_SAMPLE_RATE), MODEL_SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const audio = await ctx.startRendering();
  const left = audio.getChannelData(0).slice(), right = audio.getChannelData(1).slice();

  const worker = new Worker(new URL('./separation-worker.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress(data.stage, data.value);
        else if (data.type === 'backend') onBackend(data.backend);
        else if (data.type === 'error') reject(new Error(data.message));
        else resolve(new Blob([data.wav], { type: 'audio/wav' }));
      };
      worker.onerror = e => reject(new Error(e.message || 'The drum removal worker failed to start.'));
      worker.postMessage({ left, right }, [left.buffer, right.buffer]);
    });
  } finally {
    worker.terminate();
  }
}
