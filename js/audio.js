// Audio engine: one AudioContext drives music playback and metronome clicks, and acts as the
// master clock. Input events carry performance.now()-based timestamps; perfToCtx() maps them
// onto the context timeline *as heard* (output latency included, via getOutputTimestamp).

const CLICK = {
  accent: { freq: 1760, gain: 1.0 },
  beat: { freq: 1175, gain: 0.7 },
  sub: { freq: 880, gain: 0.35 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.clockSamples = [];
    this.clockOffset = 0;   // seconds; audible context time = perf seconds + clockOffset
    this.source = null;
    this.t0 = 0;            // context time at which song position `startPos` is rendered
    this.startPos = 0;      // song ms
    this.rate = 1;
    this.voices = new Set();
  }

  ensureContext() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.musicGain = this.ctx.createGain();
    this.clickGain = this.ctx.createGain();
    this.musicGain.connect(this.ctx.destination);
    this.clickGain.connect(this.ctx.destination);
  }

  /** Creates/resumes the context. Must be called from a user gesture the first time. */
  async init() {
    this.ensureContext();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  /** Decodes compressed audio. Works before the context is resumed (no user gesture needed). */
  async decode(bytes) {
    this.ensureContext();
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return await this.ctx.decodeAudioData(copy);
  }

  setMusicVolume(v) { if (this.musicGain) this.musicGain.gain.value = v; }
  setClickVolume(v) { if (this.clickGain) this.clickGain.gain.value = v; }

  /** Call regularly (every animation frame). Keeps the perf→audio clock mapping fresh and smooth. */
  syncClock() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    let sample;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
      sample = ts.contextTime - ts.performanceTime / 1000;
    } else {
      sample = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - performance.now() / 1000;
    }
    this.clockSamples.push(sample);
    if (this.clockSamples.length > 31) this.clockSamples.shift();
    const sorted = [...this.clockSamples].sort((a, b) => a - b);
    this.clockOffset = sorted[sorted.length >> 1];
  }

  /** performance.now()-domain ms → context seconds of the audio being heard at that instant. */
  perfToCtx(perfMs) { return perfMs / 1000 + this.clockOffset; }

  songTimeAtCtx(c) { return this.startPos + (c - this.t0) * 1000 * this.rate; }
  ctxAtSongTime(s) { return this.t0 + (s - this.startPos) / 1000 / this.rate; }
  /** Song position (ms) currently audible. */
  audibleSongTime() { return this.songTimeAtCtx(this.perfToCtx(performance.now())); }
  /** Song position (ms) currently being rendered (for scheduling). */
  renderSongTime() { return this.songTimeAtCtx(this.ctx.currentTime); }

  get outputLatencyMs() {
    if (!this.ctx) return null;
    return ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
  }

  /** Starts the transport so that song position `startPos` is rendered `leadIn` seconds from now. */
  start({ buffer = null, startPos = 0, rate = 1, leadIn = 0.15 } = {}) {
    this.stop();
    this.t0 = this.ctx.currentTime + leadIn;
    this.startPos = startPos;
    this.rate = rate;
    if (buffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(this.musicGain);
      if (startPos >= 0) src.start(this.t0, startPos / 1000);
      else src.start(this.ctxAtSongTime(0), 0);
      this.source = src;
    }
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    for (const v of this.voices) { try { v.stop(); } catch { /* not started */ } }
    this.voices.clear();
  }

  /** Schedules a metronome click at context time `when`. */
  click(when, kind = 'beat') {
    const ctx = this.ctx, spec = CLICK[kind] || CLICK.beat;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = spec.freq;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(spec.gain, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
    osc.connect(env).connect(this.clickGain);
    osc.start(when);
    osc.stop(when + 0.06);
    this.voices.add(osc);
    osc.onended = () => { this.voices.delete(osc); env.disconnect(); };
  }
}
