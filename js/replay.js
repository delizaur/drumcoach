// Replay files: a session's results, every stroke with its timing and judgment, and the grid it was
// played on (notes, beats and tempo map), so a replay shows the same results on any machine, whatever
// the song's settings there. "Replay + song" bundles it in a ZIP with the song's files.
import { readZip, writeZip } from './zip.js';

export const REPLAY_FORMAT = 'drumcoach-replay';
export const REPLAY_VERSION = 1;
const REPLAY_NAME = 'replay.json';
const SONG_DIR = 'song/';

// JSON has no Infinity (metronome sessions have no end), so it's written as a string.
const replacer = (k, v) => (typeof v === 'number' && !Number.isFinite(v) && !Number.isNaN(v) ? (v > 0 ? 'Infinity' : '-Infinity') : v);
const reviver = (k, v) => (v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v);

export const encodeReplay = data => JSON.stringify(data, replacer);

function decodeReplay(text) {
  let data;
  try { data = JSON.parse(text, reviver); } catch { data = null; }
  if (data?.format !== REPLAY_FORMAT) throw new Error("This isn't a DrumCoach replay file.");
  if (!(data.version <= REPLAY_VERSION)) throw new Error('This replay was made by a newer version of DrumCoach. Reload the page to update it.');
  return data;
}

/** A file name for a replay: its title and when it was played. */
export function replayFileName(data, ext) {
  const d = new Date(data.playedAt), two = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}`;
  return `${data.title} ${stamp}`.replace(/[\\/:*?"<>|]+/g, '_').trim() + `.replay.${ext}`;
}

/**
 * A replay and the song's files ({ file, path } items, as the library keeps them) in one ZIP.
 * @returns {Promise<Blob>}
 */
export async function bundleReplay(data, songItems) {
  const files = [{ path: REPLAY_NAME, data: new TextEncoder().encode(encodeReplay(data)) }];
  for (const { file, path } of songItems) files.push({ path: SONG_DIR + path, data: new Uint8Array(await file.arrayBuffer()) });
  return writeZip(files);
}

/**
 * Reads a replay (.json) or a replay bundled with its song (.zip).
 * @returns {Promise<{data: object, songItems: Array<{file: Blob, path: string}> | null}>}
 */
export async function readReplayFile(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b) return { data: decodeReplay(await file.text()), songItems: null }; // not "PK"
  const entries = await readZip(file);
  const main = entries.find(e => e.name === REPLAY_NAME);
  if (!main) throw new Error("This ZIP file doesn't contain a DrumCoach replay.");
  const data = decodeReplay(new TextDecoder().decode(await main.bytes()));
  const songItems = [];
  for (const e of entries) {
    if (e.name.startsWith(SONG_DIR) && e.name.length > SONG_DIR.length) {
      songItems.push({ file: new Blob([await e.bytes()]), path: e.name.slice(SONG_DIR.length) });
    }
  }
  return { data, songItems: songItems.length ? songItems : null };
}

/** Saves a file to the user's downloads. */
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
