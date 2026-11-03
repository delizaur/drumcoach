// Iterative radix-2 FFT with precomputed twiddles and bit-reversal table.
export class FFT {
  constructor(size) {
    if (size & (size - 1)) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  // Writes |X[k]| for k < out.length, given a real (already windowed) frame.
  magnitudes(input, out) {
    const { re, im } = this;
    this.forward(input);
    for (let k = 0; k < out.length; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }

  // Forward transform of a real frame; the spectrum is left in this.re / this.im.
  forward(input) {
    const { size, re, im, rev } = this;
    for (let i = 0; i < size; i++) {
      re[rev[i]] = input[i];
      im[i] = 0;
    }
    this.butterflies();
  }

  // Inverse transform of a Hermitian spectrum given for bins 0..size/2; writes the real
  // signal (unscaled by 1/size, like most FFT libraries leave to the caller) to `out`.
  inverseReal(specRe, specIm, out) {
    const { size, re, im, rev } = this;
    const half = size / 2;
    // Conjugate the full spectrum, transform forward, conjugate again → inverse.
    for (let k = 0; k < size; k++) {
      const j = rev[k];
      if (k <= half) {
        re[j] = specRe[k];
        im[j] = -specIm[k];
      } else {
        re[j] = specRe[size - k];
        im[j] = specIm[size - k];
      }
    }
    this.butterflies();
    for (let i = 0; i < size; i++) out[i] = re[i];
  }

  butterflies() {
    const { size, re, im, cos, sin } = this;
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

export function hannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}
