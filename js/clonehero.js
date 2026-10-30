// Clone Hero charts: a song folder (or .zip/.sng) with notes.chart or notes.mid, song.ini and audio
// stems. In free play, as with osu! beatmaps, the grid comes from the tempo map and the drum notes of
// each difficulty only vote on triplet fills (see triplets.js). Picking a difficulty plays its notes
// instead, each on its drum (see placeNote).
import { basename } from './util.js';

const DIFFS = ['Expert', 'Hard', 'Medium', 'Easy'];
const MIN_BEAT_LENGTH = 20; // ms
// .mid drum notes per difficulty: kick, red, yellow, blue, green (5-lane orange), 5-lane green
const MID_BASE = { Expert: 96, Hard: 84, Medium: 72, Easy: 60 };
const MID_2X_KICK = 95; // Expert+ only
const MID_TOM_MARKERS = { 110: 2, 111: 3, 112: 4 }; // pro drums: yellow/blue/green notes under these are toms
const MID_DRUM_TRACKS = ['PART DRUMS', 'PART DRUM', 'PART REAL_DRUMS_PS'];
// reserved audio names; Clone Hero plays all of them together
const STEM_RE = /^(song|guitar|rhythm|bass|keys|drums|drums_[1-4]|vocals|vocals_[12]|crowd)\.(ogg|opus|mp3|wav|m4a|flac|aac)$/i;
const AUDIO_RE = /\.(ogg|opus|mp3|wav|m4a|flac|aac)$/i;

export const isChartFile = path => /\.chart$/i.test(path) || /(^|\/)notes\.mid$/i.test(path);

// Song names may carry Clone Hero's rich text tags, e.g. <color=#FF0000>...</color>.
const plainText = s => String(s ?? '').replace(/<[^>]*>/g, '').trim();

/** song.ini: the keys of its [song] section, lowercased. */
export function parseIni(text) {
  const out = {};
  let section = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const sm = /^\[(.+)\]$/.exec(line);
    if (sm) { section = sm[1].trim().toLowerCase(); continue; }
    const i = line.indexOf('=');
    if (i > 0 && (section === null || section === 'song')) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Both parsers return each difficulty's notes as { tick, pad, plus, cymbal }: pad 0 = kick, 1 = red,
// 2 = yellow, 3 = blue, 4 = green (5-lane orange), 5 = 5-lane green; plus = 2x kick (Expert+ only).

/** .chart: metadata, tempo map and each drum difficulty's notes. */
export function parseChart(text) {
  const sections = {};
  let name = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const sm = /^\[(.+)\]$/.exec(line);
    if (sm) { name = sm[1]; sections[name] = []; continue; }
    const i = line.indexOf('=');
    if (name && i > 0) sections[name].push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  const song = Object.fromEntries((sections.Song || []).map(([k, v]) => [k.toLowerCase(), v.replace(/^"(.*)"$/, '$1')]));
  const tempos = [], sigs = [];
  for (const [k, v] of sections.SyncTrack || []) {
    const tick = Number(k), [type, a, b] = v.split(/\s+/);
    if (type === 'B') tempos.push({ tick, bpm: Number(a) / 1000 });
    else if (type === 'TS') sigs.push({ tick, num: Number(a), den: 2 ** (b === undefined ? 2 : Math.max(0, Number(b))) });
  }
  const notes = {};
  let pro = false; // cymbal markers (66-68 on yellow, blue, green) only exist in pro drums charts
  for (const d of DIFFS) {
    const list = [], cymbals = new Set();
    for (const [k, v] of sections[d + 'Drums'] || []) {
      const [type, a] = v.split(/\s+/), tick = Number(k), n = Number(a);
      if (type !== 'N') continue;
      if (n <= 5) list.push({ tick, pad: n, plus: false });
      else if (n === 32) list.push({ tick, pad: 0, plus: true });
      else if (n >= 66 && n <= 68) cymbals.add(`${tick}|${n - 64}`);
    }
    if (cymbals.size) pro = true;
    for (const x of list) x.cymbal = cymbals.has(`${x.tick}|${x.pad}`);
    if (list.length) notes[d] = list;
  }
  return {
    resolution: Number(song.resolution) || 192,
    tempos, sigs, notes, pro,
    meta: {
      name: song.name, artist: song.artist, charter: song.charter,
      offsetMs: (Number(song.offset) || 0) * 1000, // a later audio start = later notes
      streams: ['musicstream', 'guitarstream', 'rhythmstream', 'bassstream', 'keysstream', 'drumstream',
        'drum2stream', 'drum3stream', 'drum4stream', 'vocalstream', 'crowdstream'].map(k => song[k]).filter(s => s && s !== 'None'),
    },
  };
}

/** notes.mid: tempo map (first track) and each drum difficulty's notes. */
export function parseMid(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (p, n) => String.fromCharCode(...bytes.subarray(p, p + n));
  if (str(0, 4) !== 'MThd') throw new Error('notes.mid is not a MIDI file.');
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error('notes.mid uses SMPTE timing, which charts never do.');

  const tracks = [];
  for (let p = 8 + view.getUint32(4); p + 8 <= bytes.length;) {
    const id = str(p, 4), start = p + 8, end = Math.min(bytes.length, start + view.getUint32(p + 4));
    p = end;
    if (id !== 'MTrk') continue;
    const track = { name: '', tempos: [], sigs: [], ons: [], offs: [] };
    let q = start, tick = 0, status = 0;
    const vlq = () => {
      let x = 0, b;
      do { b = bytes[q++]; x = x * 128 + (b & 0x7f); } while (b & 0x80 && q < end);
      return x;
    };
    while (q < end) {
      tick += vlq();
      if (bytes[q] & 0x80) status = bytes[q++]; // otherwise running status
      if (status === 0xff) {
        const type = bytes[q++], len = vlq(), d = bytes.subarray(q, q + len);
        q += len;
        if (type === 0x03 && !track.name) track.name = str(q - len, len).trim();
        else if (type === 0x51 && len >= 3) track.tempos.push({ tick, bpm: 60e6 / ((d[0] << 16) | (d[1] << 8) | d[2]) });
        else if (type === 0x58 && len >= 2) track.sigs.push({ tick, num: d[0], den: 2 ** d[1] });
        status = 0;
      } else if (status === 0xf0 || status === 0xf7) {
        q += vlq();
        status = 0;
      } else if (status >= 0x80) {
        const kind = status & 0xf0, n = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        if (kind === 0x90 && bytes[q + 1] > 0) track.ons.push({ tick, note: bytes[q] });
        else if (kind === 0x80 || kind === 0x90) track.offs.push({ tick, note: bytes[q] });
        q += n;
      } else {
        break; // a data byte without a status: corrupt track
      }
    }
    tracks.push(track);
  }
  if (!tracks.length) throw new Error('notes.mid has no tracks.');

  const drums = MID_DRUM_TRACKS.map(n => tracks.find(t => t.name.toUpperCase() === n)).find(Boolean);
  const ons = drums?.ons || [];
  // tom markers: spans from a marker's note-on to its note-off
  const toms = ons.filter(e => MID_TOM_MARKERS[e.note]).map(e => ({
    pad: MID_TOM_MARKERS[e.note], start: e.tick,
    end: drums.offs.find(o => o.note === e.note && o.tick > e.tick)?.tick ?? Infinity,
  }));
  const isTom = (pad, tick) => toms.some(m => m.pad === pad && tick >= m.start && tick < m.end);
  const notes = {};
  for (const d of DIFFS) {
    const base = MID_BASE[d], list = [];
    for (const e of ons) {
      const pad = e.note - base, plus = d === 'Expert' && e.note === MID_2X_KICK;
      if (plus || (pad >= 0 && pad <= 5)) list.push({ tick: e.tick, pad: plus ? 0 : pad, plus, cymbal: pad >= 2 && pad <= 4 && !isTom(pad, e.tick) });
    }
    if (list.length) notes[d] = list;
  }
  return { resolution: division, tempos: tracks[0].tempos, sigs: tracks[0].sigs, notes, pro: toms.length > 0, meta: { offsetMs: 0, streams: [] } };
}

/**
 * Turns a tick-based tempo map into timing points in ms (plus `sig`, the time signature to show). Unlike osu! red lines, tempo changes can
 * fall in the middle of a bar, so each point carries `phase`: the beat of the bar it starts on.
 * Beats are quarter notes. A bar that isn't a whole number of them (7/8) gets a point of its own
 * with room for the extra half beat, as osu! mappers do it, rather than 8th-note beats that would
 * double the tempo and make the automatic grid twice as fine.
 */
export function chartTiming({ resolution: res, tempos, sigs }, offsetMs) {
  const byTick = (a, b) => a.tick - b.tick;
  tempos = tempos.filter(t => t.bpm > 0 && Number.isFinite(t.bpm)).sort(byTick);
  sigs = sigs.filter(s => s.num > 0).sort(byTick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  if (!sigs.length || sigs[0].tick > 0) sigs.unshift({ tick: 0, num: 4, den: 4 });

  const segs = []; // tempo segments with their start in ms
  for (const t of tempos) {
    const prev = segs.at(-1);
    const ms = prev ? prev.ms + (t.tick - prev.tick) * 60000 / (prev.bpm * res) : 0;
    if (prev?.tick === t.tick) segs.pop(); // the later marker on a tick wins
    segs.push({ tick: t.tick, bpm: t.bpm, ms });
  }
  const segAt = tick => { let s = segs[0]; for (const x of segs) { if (x.tick > tick) break; s = x; } return s; };
  const toMs = tick => { const s = segAt(tick); return s.ms + (tick - s.tick) * 60000 / (s.bpm * res) + offsetMs; };

  const barTicks = sig => sig.num * res * 4 / sig.den;
  const meterOf = sig => Math.min(16, Math.ceil(barTicks(sig) / res - 1e-6));
  const ticks = new Set([...segs.map(s => s.tick), ...sigs.map(s => s.tick)]);
  const last = Math.max(...ticks);
  sigs.forEach((sig, i) => {
    if (meterOf(sig) * res === barTicks(sig)) return;
    // odd bars: a point at every bar start until the next signature (or 20 minutes past the last marker)
    const end = sigs[i + 1]?.tick ?? last + 1200 * res * 4;
    for (let t = sig.tick + barTicks(sig); t < end; t += barTicks(sig)) ticks.add(t);
  });
  const timing = [];
  let prev = null;
  for (const tick of [...ticks].sort((a, b) => a - b)) {
    const sig = sigs.filter(s => s.tick <= tick).at(-1);
    const beatLength = 60000 / segAt(tick).bpm;
    const m = meterOf(sig), label = `${sig.num}/${sig.den}`;
    const phase = Math.floor(((tick - sig.tick) % barTicks(sig)) / res + 1e-6) % m;
    // a marker that changes nothing (same tempo, same bar position) adds no point
    if (prev && Math.abs(prev.beatLength - beatLength) < 1e-6 && prev.sig === label
      && Math.abs((prev.phase + (tick - prev.tick) / res) % m - phase) < 1e-6) continue;
    if (beatLength < MIN_BEAT_LENGTH || beatLength >= 60000) continue;
    prev = { tick, time: toMs(tick), beatLength, meter: m, phase, sig: label }; // sig: for display
    timing.push(prev);
  }
  return { timing: timing.map(({ tick, ...t }) => t), toMs };
}

// Timeline lanes (LANES in midi.js): 0 cymbals, 1 hi-hat, 2 toms, 3 snare, 4 kick.
const CYMBAL_LANES = [0, 1];

/**
 * Where a chart note goes on the kit: its timeline lane, and the lanes whose strokes play it. Cymbal
 * notes take the hi-hat or any cymbal (yellow is usually the hi-hat, blue the ride, green a crash,
 * but kits and players differ). Plain 4-lane charts don't say which pads are cymbals, so their
 * yellow, blue and green notes take any cymbal or tom.
 */
function placeNote(n, kind) {
  if (n.pad === 0) return { lane: 4, accept: [4] };
  if (n.pad === 1) return { lane: 3, accept: [3] };
  if (kind === 'five') return n.pad === 2 ? { lane: 1, accept: CYMBAL_LANES } : n.pad === 4 ? { lane: 0, accept: CYMBAL_LANES } : { lane: 2, accept: [2] };
  if (kind === 'pro') return n.cymbal ? { lane: n.pad === 2 ? 1 : 0, accept: CYMBAL_LANES } : { lane: 2, accept: [2] };
  return { lane: [1, 2, 0][n.pad - 2] ?? 2, accept: [0, 1, 2] };
}

/** Picks the chart file the way the games do: notes.mid, notes.chart, then other .chart files. */
function pickChart(entries) {
  const name = e => basename(e.name).toLowerCase();
  return entries.find(e => name(e) === 'notes.mid')
    || entries.find(e => name(e) === 'notes.chart')
    || entries.find(e => /\.chart$/i.test(e.name) && /[[(][yf][\])]/i.test(name(e)))
    || entries.find(e => /\.chart$/i.test(e.name))
    || null;
}

/**
 * Turns a chart folder's file entries ({name, bytes()}) into one difficulty per charted drum
 * difficulty (Expert first), each with the song's timing and its own note times.
 */
export async function loadChartSet(entries) {
  const chartEntry = pickChart(entries);
  if (!chartEntry) throw new Error('No notes.chart or notes.mid found.');
  const dir = chartEntry.name.includes('/') ? chartEntry.name.slice(0, chartEntry.name.lastIndexOf('/') + 1) : '';
  const local = entries.filter(e => e.name.startsWith(dir) && !e.name.slice(dir.length).includes('/'));
  const byName = n => n && local.find(e => basename(e.name).toLowerCase() === basename(n).toLowerCase());

  const bytes = await chartEntry.bytes();
  const chart = /\.mid$/i.test(chartEntry.name) ? parseMid(bytes) : parseChart(new TextDecoder().decode(bytes));
  const iniEntry = byName('song.ini');
  const ini = iniEntry ? parseIni(new TextDecoder().decode(await iniEntry.bytes())) : {};

  const { timing, toMs } = chartTiming(chart, chart.meta.offsetMs + (Number(ini.delay) || 0));
  if (!timing.length) throw new Error('The chart has no usable tempo markers.');

  // audio: the reserved stem names, else the chart's own stream tags, else any audio file
  let stems = local.filter(e => STEM_RE.test(basename(e.name)));
  const stem = e => basename(e.name).toLowerCase().replace(/\.[^.]+$/, '');
  if (stems.some(e => /^drums_\d$/.test(stem(e)))) stems = stems.filter(e => stem(e) !== 'drums');
  if (stems.some(e => /^vocals_\d$/.test(stem(e)))) stems = stems.filter(e => stem(e) !== 'vocals');
  stems = stems.filter((e, i) => stems.findIndex(x => stem(x) === stem(e)) === i); // song.ogg + song.opus
  if (!stems.length) stems = chart.meta.streams.map(byName).filter(Boolean);
  if (!stems.length) stems = local.filter(e => AUDIO_RE.test(e.name) && !/^preview\./i.test(basename(e.name))).slice(0, 1);
  if (!stems.length) throw new Error('No audio file found next to the chart.');

  const image = re => local.find(e => re.test(basename(e.name)));
  const bgEntry = byName(ini.background) || image(/^background\.(png|jpe?g|webp)$/i) || image(/^album\.(png|jpe?g|webp)$/i) || null;

  const title = plainText(ini.name || chart.meta.name) || plainText(basename(dir.slice(0, -1))) || 'Unknown title';
  const artist = plainText(ini.artist || chart.meta.artist) || 'Unknown artist';
  const charter = plainText(ini.charter || ini.frets || chart.meta.charter);
  const base = {
    format: 'ch', title, titleAscii: title, artist, artistAscii: artist, creator: charter, setId: 0,
    audioFilename: basename(stems[0].name), audioEntry: stems[0],
    stems: stems.map(e => ({ entry: e, drums: stem(e).startsWith('drums') })),
    bgEntry, timing,
  };
  // drum track type: song.ini says so, or the chart's markers give it away (pro wins over 5-lane)
  const yes = v => /^(true|1)$/i.test(String(v ?? '').trim());
  const hasFifth = Object.values(chart.notes).some(list => list.some(n => n.pad === 5));
  const kind = yes(ini.five_lane_drums) ? 'five' : yes(ini.pro_drums) || chart.pro ? 'pro' : hasFifth ? 'five' : 'four';
  const diffs = chartDifficulties(chart, toMs, kind).map(d => ({ ...base, ...d }));
  return diffs.length ? diffs : [{ ...base, version: 'No drums chart', objects: [] }];
}

/** Each charted difficulty's notes as { t, lane, accept, plus }, one per drum and time, and its note times. */
function chartDifficulties(chart, toMs, kind) {
  return DIFFS.filter(d => chart.notes[d]).map(d => {
    const list = chart.notes[d], seen = new Set();
    const chartNotes = list.map(n => ({ t: toMs(n.tick), plus: n.plus, ...placeNote(n, kind) }))
      .filter(n => { const k = `${n.t}|${n.lane}|${n.plus}`; return !seen.has(k) && seen.add(k); })
      .sort((a, b) => a.t - b.t || a.lane - b.lane);
    return { version: d, chartNotes, objects: [...new Set(list.map(n => n.tick))].map(toMs).sort((a, b) => a - b) };
  });
}

/** The notes of a chart DrumCoach generated itself (see autochart.js): its Expert pro drums. */
export function generatedChartNotes(text) {
  const chart = parseChart(text);
  return chartDifficulties(chart, chartTiming(chart, chart.meta.offsetMs).toMs, 'pro')[0]?.chartNotes || [];
}
