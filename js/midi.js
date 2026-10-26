// Web MIDI input. Emits note-on events with performance.now()-domain timestamps.

const DRUM_NAMES = {
  22: 'Hi-hat edge (closed)', 26: 'Hi-hat edge (open)',
  35: 'Kick 2', 36: 'Kick', 37: 'Side stick', 38: 'Snare', 39: 'Clap', 40: 'Snare rim',
  41: 'Floor tom 2', 42: 'Hi-hat closed', 43: 'Floor tom', 44: 'Hi-hat pedal', 45: 'Tom 3',
  46: 'Hi-hat open', 47: 'Tom 2', 48: 'Tom 1', 49: 'Crash', 50: 'Tom 1 rim', 51: 'Ride',
  52: 'China', 53: 'Ride bell', 55: 'Splash', 57: 'Crash 2', 58: 'Tom 3 rim', 59: 'Ride 2',
};
export const drumName = note => DRUM_NAMES[note] || `Note ${note}`;

export class MidiInput {
  constructor({ onNote, onChange }) {
    this.onNote = onNote;
    this.onChange = onChange;
    this.access = null;
    this.status = 'pending'; // pending | unsupported | denied | ready
    this.error = '';
    this.selected = 'all';
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.status = 'unsupported';
      this.onChange();
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.status = 'ready';
      this.access.onstatechange = () => this.bind();
      this.bind();
    } catch (err) {
      this.status = 'denied';
      this.error = err?.message || String(err);
      this.onChange();
    }
  }

  get inputs() {
    return this.access ? [...this.access.inputs.values()].filter(i => i.state !== 'disconnected') : [];
  }

  /** The inputs currently being listened to. */
  get active() {
    const all = this.inputs;
    return this.selected === 'all' ? all : all.filter(i => i.id === this.selected);
  }

  select(id) {
    this.selected = id || 'all';
    this.onChange();
  }

  bind() {
    for (const input of this.inputs) {
      input.onmidimessage = e => this.handle(e, input);
    }
    this.onChange();
  }

  handle(e, input) {
    if (this.selected !== 'all' && input.id !== this.selected) return;
    const [status, note, velocity] = e.data;
    if ((status & 0xf0) !== 0x90 || !velocity) return; // note-on only (velocity 0 = note-off)
    const now = performance.now();
    let time = e.timeStamp;
    // Some implementations report 0 or a different time origin; fall back to arrival time.
    if (!time || Math.abs(now - time) > 1000) time = now;
    this.onNote({ note, velocity, time, channel: (status & 0x0f) + 1, device: input.name });
  }
}
