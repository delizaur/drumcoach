// Latency calibration: play along to a click and measure the average offset of the hits.
import { median, meanSd } from './util.js';

const BPM = 140;
const BEAT_MS = 60000 / BPM;
const COUNT_IN = 4;
const TARGET_HITS = 30;
const TOTAL_CLICKS = COUNT_IN + TARGET_HITS + 6;

export class Calibration {
  constructor(audio, { onBeat, onProgress, onDone }) {
    this.audio = audio;
    this.onBeat = onBeat;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.active = false;
  }

  async start() {
    await this.audio.init();
    this.audio.start({ startPos: 0, rate: 1, leadIn: 0.3 });
    this.clicks = [];
    for (let k = 0; k < TOTAL_CLICKS; k++) {
      const t = k * BEAT_MS;
      this.clicks.push(t);
      this.audio.click(this.audio.ctxAtSongTime(t), k % 4 === 0 ? 'accent' : 'beat');
    }
    this.errors = [];
    this.lastHit = -Infinity;
    this.beatShown = -1;
    this.active = true;
    this.timer = setTimeout(() => this.finish(), TOTAL_CLICKS * BEAT_MS + 900);
  }

  /** Called every animation frame while active. */
  tick() {
    if (!this.active) return;
    const now = this.audio.audibleSongTime();
    const k = Math.floor(now / BEAT_MS + 0.0001);
    if (k >= 0 && k < TOTAL_CLICKS && k !== this.beatShown) {
      this.beatShown = k;
      this.onBeat(k, COUNT_IN);
    }
  }

  /** @param {number} songTime raw (uncompensated) song time of the hit */
  hit(songTime) {
    if (!this.active) return;
    if (songTime - this.lastHit < 60) return; // chord/flam
    this.lastHit = songTime;
    const k = Math.round(songTime / BEAT_MS);
    if (k < COUNT_IN || k >= TOTAL_CLICKS) return;
    const err = songTime - this.clicks[k];
    if (Math.abs(err) > BEAT_MS * 0.45) return;
    this.errors.push(err);
    this.onProgress(this.errors, TARGET_HITS);
    if (this.errors.length >= TARGET_HITS) this.finish();
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    this.audio.stop();
  }

  finish() {
    if (!this.active) return;
    this.cancel();
    const errs = this.errors;
    if (errs.length < 8) {
      this.onDone({ ok: false, n: errs.length });
      return;
    }
    // Drop outliers (stray hits, missed beats) before averaging.
    const med = median(errs);
    const mad = median(errs.map(e => Math.abs(e - med))) * 1.4826;
    const kept = errs.filter(e => Math.abs(e - med) <= Math.max(3 * mad, 20));
    const { mean, sd } = meanSd(kept);
    this.onDone({ ok: true, offset: Math.round(mean), sd, n: kept.length, dropped: errs.length - kept.length });
  }
}
