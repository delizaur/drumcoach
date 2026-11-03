// HTDemucs source separation around an ONNX export whose graph excludes the STFT/iSTFT
// (Ghilda/htdemucs-onnx). Padding, spectrograms and segment blending replicate the reference
// PyTorch code (demucs.htdemucs._spec/_ispec and demucs.apply.apply_model with shifts=0).

import { FFT, hannWindow } from './fft.js';

export const MODEL_SAMPLE_RATE = 44100;
export const SOURCES = ['drums', 'bass', 'other', 'vocals'];

const SEGMENT = 343980; // 7.8 s
const N_FFT = 4096;
const HOP = 1024;
const BINS = 2048;
const FRAMES = 336; // ceil(SEGMENT / HOP)
const PAD = (HOP / 2) * 3; // HTDemucs' extra reflect padding around the segment
const OVERLAP = 0.25;
const NORM = Math.sqrt(N_FFT); // torch.stft(normalized=True) divides by this

const fft = new FFT(N_FFT);
const window = hannWindow(N_FFT);

// Single reflection without repeating the edge sample, like torch's 'reflect' padding.
function reflectPad(x, left, right) {
  const n = x.length;
  const out = new Float32Array(n + left + right);
  for (let i = 0; i < out.length; i++) {
    let j = i - left;
    if (j < 0) j = -j;
    if (j >= n) j = 2 * (n - 1) - j;
    out[i] = x[j];
  }
  return out;
}

// HTDemucs._spec for one channel, written as (real, imag) channel planes of `mag`.
function spectrogram(x, mag, channel) {
  const padded = reflectPad(x, PAD, PAD + FRAMES * HOP - x.length);
  const centered = reflectPad(padded, N_FFT / 2, N_FFT / 2); // torch.stft(center=True)
  const frame = new Float64Array(N_FFT);
  const rePlane = 2 * channel * BINS * FRAMES;
  const imPlane = rePlane + BINS * FRAMES;
  for (let f = 0; f < FRAMES; f++) {
    const start = (f + 2) * HOP; // the first two STFT frames are dropped
    for (let i = 0; i < N_FFT; i++) frame[i] = centered[start + i] * window[i];
    fft.forward(frame);
    for (let k = 0; k < BINS; k++) {
      mag[rePlane + k * FRAMES + f] = fft.re[k] / NORM;
      mag[imPlane + k * FRAMES + f] = fft.im[k] / NORM;
    }
  }
}

// HTDemucs._ispec: inverse of `spectrogram` for one channel, `SEGMENT` samples long.
function inverseSpectrogram(re, im) {
  const frames = FRAMES + 4; // two empty frames are added on each side
  const out = new Float64Array(N_FFT + HOP * (frames - 1));
  const envelope = new Float64Array(out.length);
  const specRe = new Float64Array(N_FFT / 2 + 1);
  const specIm = new Float64Array(N_FFT / 2 + 1);
  const frame = new Float64Array(N_FFT);
  for (let t = 0; t < frames; t++) {
    const f = t - 2;
    const offset = t * HOP;
    for (let i = 0; i < N_FFT; i++) envelope[offset + i] += window[i] * window[i];
    if (f < 0 || f >= FRAMES) continue;
    for (let k = 0; k < BINS; k++) {
      specRe[k] = re[k * FRAMES + f];
      specIm[k] = im[k * FRAMES + f];
    }
    specRe[BINS] = specIm[BINS] = 0; // the dropped Nyquist bin
    fft.inverseReal(specRe, specIm, frame);
    // × NORM undoes the forward normalization, / N_FFT is the inverse FFT's scale.
    for (let i = 0; i < N_FFT; i++) out[offset + i] += (frame[i] * window[i] * NORM) / N_FFT;
  }
  const result = new Float32Array(SEGMENT);
  const start = N_FFT / 2 + PAD; // remove the STFT centering and HTDemucs' padding
  for (let i = 0; i < SEGMENT; i++) result[i] = out[start + i] / envelope[start + i];
  return result;
}

// Runs the network on one SEGMENT-long stereo chunk; returns, for each group of source indices,
// the group's sum as [left, right].
async function separateSegment(run, left, right, groups) {
  const mix = new Float32Array(2 * SEGMENT);
  mix.set(left, 0);
  mix.set(right, SEGMENT);
  const mag = new Float32Array(4 * BINS * FRAMES);
  spectrogram(left, mag, 0);
  spectrogram(right, mag, 1);
  const { freq, time } = await run(mix, mag, SEGMENT, BINS, FRAMES);

  const plane = BINS * FRAMES;
  return groups.map((wanted) => [0, 1].map((ch) => {
    // The iSTFT is linear, so the wanted sources' spectrograms are summed first.
    const re = new Float32Array(plane);
    const im = new Float32Array(plane);
    for (const s of wanted) {
      const base = (s * 4 + 2 * ch) * plane;
      for (let i = 0; i < plane; i++) {
        re[i] += freq[base + i];
        im[i] += freq[base + plane + i];
      }
    }
    const out = inverseSpectrogram(re, im);
    for (const s of wanted) {
      const base = (s * 2 + ch) * SEGMENT;
      for (let i = 0; i < SEGMENT; i++) out[i] += time[base + i];
    }
    return out;
  }));
}

/**
 * Separates a 44.1 kHz stereo signal. `groups` lists groups of source names (from SOURCES), e.g.
 * [['bass'], ['other']]; returns each group's sum as [left, right], from one pass of the network.
 * `run(mix, mag, ...)` runs the ONNX model and resolves to { freq, time }.
 */
export async function separate(left, right, groups, run, onProgress = () => {}) {
  const length = left.length;
  const indices = groups.map((sources) => sources.map((s) => SOURCES.indexOf(s)));

  // Like demucs.separate: normalize by the mono mix's mean and standard deviation.
  let mean = 0;
  for (let i = 0; i < length; i++) mean += (left[i] + right[i]) / 2;
  mean /= length;
  let variance = 0;
  for (let i = 0; i < length; i++) variance += ((left[i] + right[i]) / 2 - mean) ** 2;
  const std = Math.sqrt(variance / Math.max(1, length - 1)) || 1;

  // Triangular weights blend overlapping segments.
  const weight = new Float32Array(SEGMENT);
  for (let i = 0; i < SEGMENT; i++) weight[i] = (i < SEGMENT / 2 ? i + 1 : SEGMENT - i) / (SEGMENT / 2);

  const out = groups.map(() => [new Float32Array(length), new Float32Array(length)]);
  const total = new Float32Array(length);
  const stride = Math.floor((1 - OVERLAP) * SEGMENT);
  const offsets = [];
  for (let offset = 0; offset < length; offset += stride) offsets.push(offset);

  for (const [n, offset] of offsets.entries()) {
    // A short final chunk is centered in a full segment of the surrounding audio.
    const chunkLength = Math.min(SEGMENT, length - offset);
    const trim = Math.floor((SEGMENT - chunkLength) / 2);
    const start = offset - trim;
    const chunk = [new Float32Array(SEGMENT), new Float32Array(SEGMENT)];
    for (let i = 0; i < SEGMENT; i++) {
      const j = start + i;
      if (j < 0 || j >= length) continue;
      chunk[0][i] = (left[j] - mean) / std;
      chunk[1][i] = (right[j] - mean) / std;
    }
    const result = await separateSegment(run, chunk[0], chunk[1], indices);
    for (let i = 0; i < chunkLength; i++) total[offset + i] += weight[i];
    result.forEach((stereo, g) => {
      for (const ch of [0, 1]) {
        for (let i = 0; i < chunkLength; i++) out[g][ch][offset + i] += weight[i] * stereo[ch][trim + i];
      }
    });
    onProgress((n + 1) / offsets.length);
  }

  for (const channel of out.flat()) {
    for (let i = 0; i < length; i++) channel[i] = (channel[i] / total[i]) * std + mean;
  }
  return out;
}
