// osu! beatmap (.osu) parsing. Only the parts that matter for timing practice:
// metadata, audio filename, background and the uninherited ("red line") timing points.
import { basename } from './util.js';

const MIN_BEAT_LENGTH = 20; // ms, i.e. 3000 BPM
const KEY_VALUE_SECTIONS = new Set(['General', 'Metadata', 'Difficulty', 'Editor']);

export function parseOsu(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines.find(l => l.trim());
  const vm = /osu file format v(\d+)/.exec(header || '');
  const formatVersion = vm ? Number(vm[1]) : 14;

  const kv = { General: {}, Metadata: {}, Difficulty: {}, Editor: {} };
  const rawTiming = [];
  const objects = [];
  let background = null;
  let section = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const sm = /^\[(\w+)\]$/.exec(line);
    if (sm) { section = sm[1]; continue; }

    if (KEY_VALUE_SECTIONS.has(section)) {
      const i = line.indexOf(':');
      if (i > 0) kv[section][line.slice(0, i).trim()] = line.slice(i + 1).trim();
    } else if (section === 'Events') {
      // Background: 0,0,"filename",x,y
      if (!background && /^(0|Background)\s*,/.test(line)) {
        const m = /^[^,]+,[^,]+,\s*"?([^",]+)"?/.exec(line);
        if (m) background = m[1];
      }
    } else if (section === 'TimingPoints') {
      const parts = line.split(',');
      if (parts.length < 2) continue;
      const time = parseFloat(parts[0]);
      const beatLength = parseFloat(parts[1]);
      const meter = parts.length > 2 ? parseInt(parts[2], 10) || 4 : 4;
      // Old formats have no "uninherited" column: a positive beat length means a red line.
      const uninherited = parts.length > 6 ? parts[6].trim() === '1' : beatLength > 0;
      if (Number.isFinite(time) && Number.isFinite(beatLength)) rawTiming.push({ time, beatLength, meter, uninherited });
    } else if (section === 'HitObjects') {
      // x,y,time,type,...; only the times are used (to find triplet fills); spinners are skipped
      const parts = line.split(',');
      const time = parseInt(parts[2], 10), type = parseInt(parts[3], 10);
      if (Number.isFinite(time) && !(type & 8)) objects.push(time);
    }
  }

  // osu! itself shifts very old maps (format < v5) by 24 ms.
  const shift = formatVersion < 5 ? 24 : 0;

  const timing = rawTiming
    // Some maps add red lines with absurd tempos (beat lengths down to 1e-298 ms) as a visual trick;
    // they mean nothing musically and would make beat loops run forever.
    .filter(t => t.uninherited && t.beatLength >= MIN_BEAT_LENGTH && t.beatLength < 60000)
    .map((t, i) => ({ ...t, i }))
    .sort((a, b) => a.time - b.time || a.i - b.i)
    // when two red lines share a timestamp, the later one in the file wins
    .filter((t, i, arr) => i + 1 >= arr.length || arr[i + 1].time !== t.time)
    .map(t => ({ time: t.time + shift, beatLength: t.beatLength, meter: Math.min(16, Math.max(1, t.meter)) }));

  const M = kv.Metadata, G = kv.General;
  return {
    formatVersion,
    title: M.TitleUnicode || M.Title || 'Unknown title',
    titleAscii: M.Title || '',
    artist: M.ArtistUnicode || M.Artist || 'Unknown artist',
    artistAscii: M.Artist || '',
    creator: M.Creator || '',
    version: M.Version || 'Default',
    setId: Math.max(0, Number(M.BeatmapSetID) || 0),
    audioFilename: G.AudioFilename || '',
    previewTime: Number(G.PreviewTime) || 0,
    mode: Number(G.Mode) || 0,
    background,
    timing,
    objects: objects.map(t => t + shift),
  };
}

/**
 * Turns a list of file entries ({name, bytes()}) — from an .osz archive or loose files —
 * into a list of difficulties with their audio/background entries resolved.
 */
export async function loadBeatmapSet(entries) {
  const osuEntries = entries.filter(e => /\.osu$/i.test(e.name));
  if (!osuEntries.length) throw new Error('No .osu file found. Drop an .osz, or an .osu file together with its audio file.');

  const decoder = new TextDecoder();
  const diffs = [];
  for (const e of osuEntries) {
    try {
      const map = parseOsu(decoder.decode(await e.bytes()));
      if (map.timing.length) diffs.push(map);
    } catch (err) {
      console.warn('Skipping unreadable difficulty', e.name, err);
    }
  }
  if (!diffs.length) throw new Error('The beatmap has no usable timing points.');

  const norm = s => s.replace(/\\/g, '/').toLowerCase();
  const find = fname => {
    if (!fname) return null;
    const target = norm(fname);
    return entries.find(e => norm(e.name) === target)
      || entries.find(e => norm(basename(e.name)) === norm(basename(target)))
      || null;
  };
  const anyAudio = entries.find(e => /\.(mp3|ogg|wav|m4a|flac|opus)$/i.test(e.name)) || null;

  for (const d of diffs) {
    d.audioEntry = find(d.audioFilename) || anyAudio;
    d.bgEntry = find(d.background);
  }
  if (!diffs.some(d => d.audioEntry)) throw new Error('No audio file found. If you dropped a loose .osu, drop its audio file along with it.');

  diffs.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return diffs;
}

export function songKey(d) {
  if (d.plain) return `audio:${d.audioFilename.toLowerCase()}`;
  return d.setId ? `set:${d.setId}` : `${d.artistAscii || d.artist} - ${d.titleAscii || d.title} (${d.creator})`;
}

/** Summary of tempo information for display. */
export function tempoSummary(timing, durationMs) {
  const bpms = timing.map(t => 60000 / t.beatLength);
  // "main" BPM: the tempo that covers the most time
  const cover = new Map();
  timing.forEach((t, i) => {
    const end = i + 1 < timing.length ? timing[i + 1].time : durationMs;
    const bpm = Math.round(bpms[i] * 10) / 10;
    cover.set(bpm, (cover.get(bpm) || 0) + Math.max(0, end - t.time));
  });
  let main = bpms[0], best = -1;
  for (const [bpm, ms] of cover) if (ms > best) { best = ms; main = bpm; }
  return { min: Math.min(...bpms), max: Math.max(...bpms), main, changes: timing.length - 1 };
}
