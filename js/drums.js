// Synthesized drum kit, played when pads are hit. Every voice is built from oscillators and
// filtered noise, so no sample files need to be downloaded.

// General MIDI drum notes (plus common Roland/Alesis extras) → voice
const NOTE_VOICE = {
  35: 'kick', 36: 'kick',
  37: 'stick', 38: 'snare', 40: 'rimshot', 39: 'clap',
  41: 'tomFloor', 43: 'tomFloor', 58: 'tomFloor',
  45: 'tomMid', 47: 'tomMid',
  48: 'tomHigh', 50: 'tomHigh',
  42: 'hatClosed', 22: 'hatClosed', 44: 'hatPedal', 46: 'hatOpen', 26: 'hatOpen',
  49: 'crash', 57: 'crash', 55: 'splash', 52: 'china',
  51: 'ride', 59: 'ride', 53: 'bell',
};

// Relative loudness of each voice, so kick and snare sit on top and cymbals don't swamp them.
const LEVEL = {
  kick: 1.9, snare: 2.3, rimshot: 2.1, stick: 3, clap: 3,
  tomHigh: 1.8, tomMid: 1.8, tomFloor: 1.9,
  hatClosed: 1.6, hatPedal: 2, hatOpen: 1,
  crash: 0.55, splash: 0.85, china: 0.65, ride: 0.6, bell: 0.9,
};

export class DrumKit {
  constructor(ctx) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    // gentle limiter so big chords don't clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.1;
    this.out.connect(comp).connect(ctx.destination);
    this.noise = this.makeNoise(2);
    this.openHats = new Set();
  }

  set volume(v) { this.out.gain.value = v; }

  makeNoise(seconds) {
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Plays the voice for a MIDI note right away. velocity 1–127. */
  play(note, velocity = 100) {
    const voice = NOTE_VOICE[note] || 'snare';
    const v = Math.pow(Math.min(127, Math.max(1, velocity)) / 127, 1.4);
    const t = this.ctx.currentTime;
    if (voice === 'hatClosed' || voice === 'hatPedal') this.chokeHats(t);
    // Voices write to this.out; point it at a per-hit level stage for the duration of the call.
    const level = this.ctx.createGain();
    level.gain.value = LEVEL[voice];
    level.connect(this.out);
    const out = this.out;
    this.out = level;
    try { this[voice](t, v); } finally { this.out = out; }
    setTimeout(() => level.disconnect(), 2500);
  }

  // ---- building blocks

  /** Envelope gain node: instant attack, exponential decay to silence. */
  env(t, peak, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    return g;
  }

  noiseHit(t, { peak, decay, type = 'highpass', freq = 5000, q = 0.7, dest = this.out }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.env(t, peak, decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + decay + 0.05);
    return { src, gain: g };
  }

  tone(t, { peak, decay, from, to = from, sweep = 0.05, type = 'sine', dest = this.out }) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + sweep);
    const g = this.env(t, peak, decay);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  /** Inharmonic square-wave cluster (808 style) for metallic sounds. */
  metal(t, { peak, decay, freq = 8000, base = 300, dest = this.out }) {
    const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 0.8;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = freq * 0.6;
    const g = this.env(t, peak, decay);
    bp.connect(hp).connect(g).connect(dest);
    for (const r of ratios) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = base * r;
      o.connect(bp);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
    return g;
  }

  chokeHats(t) {
    for (const g of this.openHats) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0.0001, t, 0.01);
    }
    this.openHats.clear();
  }

  // ---- voices

  kick(t, v) {
    this.tone(t, { peak: 1.0 * v, decay: 0.35 + 0.1 * v, from: 140 + 60 * v, to: 45, sweep: 0.08 });
    this.noiseHit(t, { peak: 0.25 * v, decay: 0.012, type: 'lowpass', freq: 3000 });
  }

  snare(t, v) {
    this.tone(t, { peak: 0.55 * v, decay: 0.09, from: 260, to: 180, sweep: 0.04, type: 'triangle' });
    this.noiseHit(t, { peak: 0.7 * v, decay: 0.14 + 0.08 * v, type: 'highpass', freq: 1200 + 1500 * v });
  }

  rimshot(t, v) {
    this.snare(t, v);
    this.tone(t, { peak: 0.35 * v, decay: 0.03, from: 1700, type: 'square' });
  }

  stick(t, v) {
    this.tone(t, { peak: 0.5 * v, decay: 0.035, from: 1100, to: 800, sweep: 0.02, type: 'triangle' });
    this.noiseHit(t, { peak: 0.3 * v, decay: 0.03, type: 'bandpass', freq: 3500, q: 2 });
  }

  clap(t, v) {
    for (let k = 0; k < 3; k++) this.noiseHit(t + k * 0.011, { peak: 0.5 * v, decay: 0.03, type: 'bandpass', freq: 1500, q: 1.5 });
    this.noiseHit(t + 0.033, { peak: 0.5 * v, decay: 0.16, type: 'bandpass', freq: 1500, q: 1.2 });
  }

  tom(t, v, freq) {
    this.tone(t, { peak: 0.85 * v, decay: 0.45, from: freq * 1.6, to: freq, sweep: 0.06 });
    this.noiseHit(t, { peak: 0.15 * v, decay: 0.05, type: 'lowpass', freq: 2500 });
  }
  tomHigh(t, v) { this.tom(t, v, 210); }
  tomMid(t, v) { this.tom(t, v, 155); }
  tomFloor(t, v) { this.tom(t, v, 100); }

  hatClosed(t, v) {
    this.metal(t, { peak: 0.35 * v, decay: 0.05 + 0.03 * v, freq: 9000 });
    this.noiseHit(t, { peak: 0.2 * v, decay: 0.04, freq: 8000 });
  }

  hatPedal(t, v) {
    this.metal(t, { peak: 0.2 * v, decay: 0.035, freq: 8500 });
  }

  hatOpen(t, v) {
    const g = this.metal(t, { peak: 0.3 * v, decay: 0.5, freq: 8500 });
    const n = this.noiseHit(t, { peak: 0.15 * v, decay: 0.45, freq: 7500 });
    this.openHats.add(g).add(n.gain);
    setTimeout(() => { this.openHats.delete(g); this.openHats.delete(n.gain); }, 600);
  }

  crash(t, v) {
    this.noiseHit(t, { peak: 0.55 * v, decay: 1.6, type: 'highpass', freq: 4000 });
    this.metal(t, { peak: 0.2 * v, decay: 1.2, freq: 6000, base: 370 });
  }

  splash(t, v) {
    this.noiseHit(t, { peak: 0.5 * v, decay: 0.6, type: 'highpass', freq: 5500 });
    this.metal(t, { peak: 0.15 * v, decay: 0.45, freq: 8000, base: 420 });
  }

  china(t, v) {
    this.noiseHit(t, { peak: 0.5 * v, decay: 1.1, type: 'bandpass', freq: 3000, q: 0.9 });
    this.metal(t, { peak: 0.3 * v, decay: 0.9, freq: 4000, base: 260 });
  }

  ride(t, v) {
    this.metal(t, { peak: 0.22 * v, decay: 1.2, freq: 5000, base: 330 });
    this.noiseHit(t, { peak: 0.12 * v, decay: 0.35, freq: 9000 });
    this.tone(t, { peak: 0.06 * v, decay: 0.8, from: 3200 });
  }

  bell(t, v) {
    this.tone(t, { peak: 0.25 * v, decay: 1.0, from: 1450, type: 'triangle' });
    this.tone(t, { peak: 0.12 * v, decay: 0.8, from: 2900 });
    this.metal(t, { peak: 0.12 * v, decay: 0.6, freq: 5000, base: 330 });
  }
}
