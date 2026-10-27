import { AudioEngine } from './audio.js';
import { MidiInput, drumName, padOf, LANES } from './midi.js';
import { readZip } from './zip.js';
import { loadBeatmapSet, songKey, tempoSummary } from './osu.js';
import { analyzeSync, SYNC_VERSION } from './beatsync.js';
import { detectTempo, TEMPO_VERSION } from './tempo.js';
import { PATTERNS, makePattern, songSections, metronomeSections, buildGrid, sectionAt, TRIPLET_SLOT } from './timing.js';
import { tripletBeats, mergeBeats } from './triplets.js';
import { Scorer, STRICTNESS, JUDGMENTS, MISS } from './scorer.js';
import { Timeline, ErrorMeter, Scatter, Histogram, drawCalibStrip } from './render.js';
import { Calibration } from './calibration.js';
import { DrumKit } from './drums.js';
import { library } from './library.js';
import { lowerBound, clamp, fmtTime, fmtMs, escapeHtml, basename } from './util.js';

const $ = id => document.getElementById(id);

// ================================================================ settings

const SETTINGS_KEY = 'drumcoach.settings.v1';
const DEFAULTS = {
  mode: 'metronome',
  // input
  midiInput: 'all', minVelocity: 8, mutedNotes: [], seenPads: [], keyboard: true, latency: 0, audioBuffer: 10,
  padSounds: false, keySounds: true, padVolume: 0.8, // kits usually have their own sounds; the keyboard doesn't
  // metronome
  bpm: 100, meter: 4, countIn: 1,
  trainerOn: false, trainerStep: 5, trainerBars: 4, trainerMax: 180,
  gapOn: false, gapPlay: 2, gapMute: 2,
  // shared
  pattern: 'hybrid-8-16', customSubdiv: 4, customGrid: 'x..x..x.',
  clickMode: 'beats', clickVolume: 0.7, strictness: 'normal',
  // song
  rate: 1, musicVolume: 0.85, songClick: false, lastSong: null, songPrefs: {},
  autoSync: true, syncFineTune: 0, syncMigrated: false, useTriplets: true,
  openGroups: { playalongGroup: true, libraryBox: true }, // collapsible panel sections
};

const settings = (() => {
  const base = structuredClone(DEFAULTS);
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...base, ...stored };
  } catch {
    return base;
  }
})();

function save() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// Per-song offsets saved before auto-sync existed were compensating for what auto-sync now fixes.
if (!settings.syncMigrated) {
  for (const p of Object.values(settings.songPrefs)) p.offset = 0;
  settings.syncMigrated = true;
  save();
}

// Used when a song's beat can't be detected: the typical offset measured across osu! maps.
const FALLBACK_SYNC = 22;

function songPrefs() {
  if (!song) return { offset: 0, diff: 0, startAt: 0 };
  return (settings.songPrefs[song.key] ||= { offset: 0, diff: 0, startAt: 0 });
}

// ================================================================ state

const audio = new AudioEngine(settings.audioBuffer);
let song = null;      // { key, diffs, diff, diffIndex, buffer, audioName, durationMs, bgName, bgUrl }
let session = null;
let calib = null;
let schedulerTimer = 0;
const recent = [];    // recent hits for the error meter: { err, j, at }

const timeline = new Timeline($('timeline'));
const errorMeter = new ErrorMeter($('errorMeter'));
const scatter = new Scatter($('scatter'));

// ================================================================ input

const midi = new MidiInput({ onNote: onMidiNote, onChange: renderMidiStatus });
midi.selected = settings.midiInput;
midi.init();

let flashTimer = 0;
function onMidiNote(ev) {
  // sound first: everything else can wait a millisecond
  if (ev.velocity >= settings.minVelocity) playPad(ev.note, ev.velocity);
  ev.delay = performance.now() - ev.time;
  const chip = $('midiChip');
  chip.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => chip.classList.remove('flash'), 70);
  notePad(ev);

  // muted pads still sound (above), they just aren't scored
  if (ev.velocity < settings.minVelocity || settings.mutedNotes.includes(ev.note)) return;
  stroke(ev.time, ev.note);
}

let kit = null;
function playPad(note, velocity, { keyboard = false } = {}) {
  if (!(keyboard ? settings.keySounds : settings.padSounds) || audio.ctx?.state !== 'running') return;
  kit ||= new DrumKit(audio.ctx);
  kit.volume = settings.padVolume;
  kit.play(note, velocity);
}

// Browsers only allow audio after a user gesture, and MIDI input doesn't count as one.
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, () => { audio.init().catch(() => {}); }, { once: true, capture: true });
}

// keyboard stand-ins for pads: Space = kick, F/J = snare, D/K = hi-hat
const HIT_KEYS = { ' ': 36, f: 38, j: 38, d: 42, k: 42 };
function isTyping(el) {
  return el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el.type)));
}
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && session) { e.preventDefault(); stopSession(true); return; }
  if (!settings.keyboard || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
  const note = HIT_KEYS[e.key.toLowerCase()];
  if (!note || !(session || calib?.active)) return;
  e.preventDefault();
  if (e.repeat) return;
  playPad(note, 100, { keyboard: true });
  stroke(e.timeStamp || performance.now(), note);
});
window.addEventListener('keyup', e => {
  if (e.key === ' ' && (session || calib?.active) && !isTyping(e.target)) e.preventDefault();
});

/** A single drum stroke on a MIDI note at a performance.now()-domain time. */
function stroke(perfTime, note) {
  if (!audio.ctx) return;
  const songT = audio.songTimeAtCtx(audio.perfToCtx(perfTime));
  if (calib?.active) { calib.hit(songT); return; }
  if (!session) return;
  const { pad, lane } = padOf(note);
  const res = session.scorer.hit(songT - settings.latency * session.rate, pad, lane);
  if (!res) return;
  if (res.type === 'hit' || res.type === 'miss') {
    recent.push({ err: res.hit.err, j: res.hit.j, at: performance.now() });
    if (recent.length > 60) recent.shift();
    showFeedback(res.hit.j, res.hit.err);
  }
  if (res.type !== 'double') session.scatterDirty = true;
}

// ================================================================ session

function currentPattern() {
  const def = PATTERNS.find(p => p.id === settings.pattern) || PATTERNS[0];
  if (def.id === 'custom') {
    return makePattern({ id: 'custom', name: 'Custom', subdiv: settings.customSubdiv, grid: settings.customGrid });
  }
  return makePattern(def);
}

function buildClicks(grid, mode, hiddenBar, from) {
  if (mode === 'off') return [];
  const audible = x => !(hiddenBar && hiddenBar(x.bar));
  let events = grid.beats.filter(audible).map(b => ({ t: b.t, kind: b.downbeat ? 'accent' : 'beat' }));
  if (mode === 'pattern') {
    events = events.concat(grid.notes.filter(n => !n.onBeat && audible(n)).map(n => ({ t: n.t, kind: 'sub' })));
    events.sort((a, b) => a.t - b.t);
  }
  return events.filter(e => e.t >= from - 1);
}

/**
 * Locks the setup panel during a session so settings can't change mid-run. In a tempo preview the
 * tempo controls stay usable, since adjusting them while listening is the point of the preview.
 */
function lockSetup(locked, keep = null) {
  const setup = document.querySelector('.setup');
  for (const el of setup.querySelectorAll('[inert]')) el.inert = false;
  const walk = el => {
    for (const child of el.children) {
      if (keep && child.contains(keep)) { child.inert = false; if (child !== keep) walk(child); }
      else child.inert = locked;
    }
  };
  walk(setup);
  setup.classList.toggle('locked', locked);
}

async function startSession({ preview = false, from = null } = {}) {
  if (session) return;
  if (settings.mode === 'song' && !song?.diff) return;
  await audio.init();
  audio.setMusicVolume(settings.musicVolume);
  audio.setClickVolume(settings.clickVolume);

  const pattern = currentPattern();
  const windows = STRICTNESS[settings.strictness] || STRICTNESS.normal;
  let sections, startPos = 0, rate = 1, scoreFrom, endMs = Infinity, buffer = null, hiddenBar = null, triplets = [];
  let clickMode = settings.clickMode;

  if (settings.mode === 'song') {
    const prefs = songPrefs();
    rate = settings.rate;
    buffer = song.buffer;
    endMs = song.durationMs;
    if (settings.autoSync && !song.sync) {
      $('startBtn').textContent = 'Analyzing…';
      await song.syncReady;
      $('startBtn').textContent = 'Start';
    }
    const shift = totalSync();
    sections = songSections(song.diff.timing, endMs, shift);
    if (settings.useTriplets && song.triplets?.length) {
      triplets = song.triplets.map(b => ({ start: b.start + shift, end: b.end + shift }));
    }
    if (!sections.length) return showSongError('This difficulty has no timing points inside the audio.');
    startPos = clamp(from ?? prefs.startAt, 0, Math.max(0, endMs - 3000));
    const sec = sections[sectionAt(sections, startPos)];
    scoreFrom = startPos + Math.max(1000 * rate, 2 * sec.beatLength);
    if (preview) clickMode = settings.clickMode === 'off' ? 'beats' : settings.clickMode;
    else if (!settings.songClick) clickMode = 'off';
  } else {
    const { bpm, meter, countIn } = settings;
    const trainer = settings.trainerOn
      ? { step: settings.trainerStep, everyBars: settings.trainerBars, max: settings.trainerMax }
      : null;
    sections = metronomeSections({ bpm, meter, countIn, trainer });
    scoreFrom = Math.max(countIn * meter, 1) * (60000 / bpm) - 1;
    if (settings.gapOn) {
      const { gapPlay: play, gapMute: mute } = settings;
      hiddenBar = bar => bar >= countIn && (bar - countIn) % (play + mute) >= play;
    }
  }

  const grid = buildGrid(sections, pattern, { tripletBeats: triplets });
  session = {
    preview,
    mode: settings.mode,
    title: settings.mode === 'song'
      ? `${song.diff.artist} – ${song.diff.title} [${song.diff.version}]`
      : `Metronome · ${settings.bpm} BPM${settings.trainerOn ? ' (speed trainer)' : ''}`,
    pattern, windows, sections, rate, startPos, endMs, scoreFrom, hiddenBar,
    lanes: LANES,
    tripletSections: mergeBeats(triplets),
    notes: grid.notes,
    beats: grid.beats,
    scorer: new Scorer(grid.notes, { windows, rate, scoreFrom }),
    clicks: buildClicks(grid, clickMode, hiddenBar, startPos),
    clickCursor: 0,
    now: startPos,
    lastUi: 0,
    lastScatter: 0,
    scatterDirty: true,
  };
  recent.length = 0;

  audio.start({ buffer, startPos, rate, leadIn: 0.15 });
  session.dropoutsAtStart = audio.dropoutStats();
  scheduleClicks();
  schedulerTimer = setInterval(scheduleClicks, 20);

  $('startBtn').textContent = 'Stop';
  $('startBtn').classList.replace('primary', 'stop');
  $('idleHint').hidden = true;
  $('progress').hidden = session.mode !== 'song';
  lockSetup(true, preview ? $('tempoBox') : null);
}

function scheduleClicks() {
  const s = session;
  if (!s || s.clickCursor >= s.clicks.length) return;
  const ctxNow = audio.ctx.currentTime;
  const horizon = audio.renderSongTime() + 150 * s.rate;
  while (s.clickCursor < s.clicks.length && s.clicks[s.clickCursor].t <= horizon) {
    const ev = s.clicks[s.clickCursor++];
    const when = audio.ctxAtSongTime(ev.t);
    if (when >= ctxNow) audio.click(when, ev.kind);
  }
}

function stopSession(withResults) {
  if (!session) return;
  const s = session;
  session = null;
  clearInterval(schedulerTimer);
  const d = audio.dropoutStats();
  s.dropouts = { events: d.events - s.dropoutsAtStart.events, ms: d.ms - s.dropoutsAtStart.ms };
  audio.stop();

  $('startBtn').textContent = 'Start';
  $('startBtn').classList.replace('stop', 'primary');
  $('idleHint').hidden = false;
  lockSetup(false);
  updateStartButton();

  drawScatter(s, true);
  if (withResults && !s.preview && s.scorer.stats().judged >= 4) showResults(s);
}

// ================================================================ frame loop

function frame() {
  requestAnimationFrame(frame);
  audio.syncClock();
  calib?.tick();
  const perfNow = performance.now();
  const s = session;

  if (s) {
    const now = audio.audibleSongTime();
    s.now = now;
    timeline.draw(s);
    if (perfNow - s.lastUi > 100) { s.lastUi = perfNow; updateLive(s); }
    if (s.scatterDirty && perfNow - s.lastScatter > 250) drawScatter(s);
    if (s.mode === 'song' && now > s.endMs + 400) stopSession(true);
  }

  const windows = s?.windows || STRICTNESS[settings.strictness] || STRICTNESS.normal;
  const last = recent.filter(h => h.j !== MISS).slice(-12);
  errorMeter.draw({
    recent,
    windows,
    now: perfNow,
    mean: last.length >= 3 && perfNow - last[last.length - 1].at < 4000
      ? last.reduce((a, h) => a + h.err, 0) / last.length : null,
  });
}
requestAnimationFrame(frame);

function scatterRange(s) {
  const x0 = s.scoreFrom;
  const x1 = s.mode === 'song' ? s.endMs : Math.max(s.now, x0 + 30000);
  return { x0, x1 };
}

function drawScatter(s, final = false) {
  s.scatterDirty = false;
  s.lastScatter = performance.now();
  const { x0, x1 } = scatterRange(s);
  scatter.draw({
    hits: s.scorer.hits, misses: s.scorer.misses, notes: s.notes, windows: s.windows,
    x0, x1: final && s.mode !== 'song' ? Math.max(x0 + 1000, s.now) : x1,
    sectionStarts: s.sections.length > 1 ? s.sections.map(x => x.start) : null,
  });
}

function tendency(m) {
  if (Math.abs(m) < 3) return 'centered';
  return m < 0 ? `rushing ${Math.abs(m).toFixed(0)} ms` : `dragging ${m.toFixed(0)} ms`;
}

function updateLive(s) {
  const st = s.scorer.stats();
  $('tAcc').textContent = st.accuracy == null ? '—' : `${(st.accuracy * 100).toFixed(1)}%`;
  $('tAccSub').textContent = `${st.nHits} on the grid · ${st.counts[MISS]} off`;
  $('tMean').textContent = st.nHits ? fmtMs(st.mean) : '—';
  $('tMeanSub').textContent = st.nHits >= 4 ? `last 16: ${tendency(s.scorer.recentMean(16))}` : ' ';
  $('tSd').innerHTML = st.nHits > 1 ? `${st.sd.toFixed(1)}<small>ms</small>` : '—';
  $('tSdSub').textContent = st.nHits > 1 ? `UR ${st.ur.toFixed(0)}` : ' ';
  $('tStreak').textContent = st.streak;
  $('tStreakSub').textContent = `best ${st.maxStreak}`;
  renderCounts(st);

  const now = s.now;
  const sec = s.sections[sectionAt(s.sections, now)];
  $('bpmNow').textContent = +((60000 / sec.beatLength) * s.rate).toFixed(1);
  if (s.mode === 'song') {
    $('posNow').textContent = `${fmtTime(now)} / ${fmtTime(s.endMs)}`;
    $('progressBar').style.width = `${clamp((now - s.startPos) / (s.endMs - s.startPos), 0, 1) * 100}%`;
  } else {
    const bi = lowerBound(s.beats, now + 1) - 1;
    const b = s.beats[Math.max(0, bi)];
    if (now < 0) $('posNow').textContent = 'Get ready…';
    else if (b.bar < settings.countIn) $('posNow').textContent = `Count-in · ${b.beatInBar + 1}`;
    else $('posNow').textContent = `Bar ${b.bar + 1 - settings.countIn} · beat ${b.beatInBar + 1}${s.hiddenBar?.(b.bar) ? ' · silent' : ''}`;
  }
}

function renderCounts(st) {
  const els = $('counts').querySelectorAll('b');
  [...st.counts, st.extra].forEach((v, k) => { els[k].textContent = v; });
}

function resetLive() {
  for (const id of ['tAcc', 'tMean', 'tSd']) $(id).textContent = '—';
  for (const id of ['tAccSub', 'tMeanSub', 'tSdSub']) $(id).textContent = ' ';
  $('tStreak').textContent = '0';
  $('tStreakSub').textContent = 'best 0';
  renderCounts({ counts: [0, 0, 0, 0], extra: 0 });
}

const JUDGE_COLOR = ['var(--perfect)', 'var(--great)', 'var(--good)', 'var(--miss)'];
function showFeedback(j, err) {
  const el = $('feedback');
  el.style.color = JUDGE_COLOR[j];
  const detail = Math.abs(err) < 1 ? 'on time' : `${fmtMs(err)} ${err < 0 ? 'early' : 'late'}`;
  el.innerHTML = `${JUDGMENTS[j]}<small>${detail || '&nbsp;'}</small>`;
  el.classList.remove('show');
  void el.offsetWidth; // restart the animation
  el.classList.add('show');
}

// ================================================================ results

function insightsFor(st, slotRows, tempoRows, laneRows) {
  if (st.nHits < 4) return ['Not enough hits to say much yet. Play a bit longer!'];
  const out = [];
  const m = st.mean, sd = st.sd;
  if (Math.abs(m) < 3) out.push(`On average you're right on the beat (${fmtMs(m, 1)}).`);
  else if (m < 0) out.push(`You tend to <b>rush</b>: on average ${Math.abs(m).toFixed(1)} ms ahead of the beat.`);
  else out.push(`You tend to <b>drag</b>: on average ${m.toFixed(1)} ms behind the beat.`);

  const level = sd < 8 ? 'Machine-like consistency' : sd < 14 ? 'Very consistent' : sd < 22 ? 'Fairly consistent'
    : sd < 35 ? 'Your timing wanders quite a bit' : 'Your timing is all over the place';
  out.push(`${level}: your hits have a spread (σ) of ${sd.toFixed(1)} ms.${sd >= 22 ? ' Try a slower tempo and focus on keeping the notes even.' : ''}`);

  const solid = slotRows.filter(r => r.n >= 6);
  if (solid.length > 1) {
    const worst = solid.reduce((a, r) => (Math.abs(r.mean - m) > Math.abs(a.mean - m) ? r : a));
    const d = worst.mean - m;
    if (Math.abs(d) >= 5) out.push(`Your <b>${escapeHtml(worst.label)}</b> notes land ${Math.abs(d).toFixed(0)} ms ${d < 0 ? 'earlier' : 'later'} than the rest.`);
    const loose = solid.reduce((a, r) => (r.sd > a.sd ? r : a));
    const tight = solid.reduce((a, r) => (r.sd < a.sd ? r : a));
    if (loose.sd - tight.sd >= 6) out.push(`<b>${escapeHtml(loose.label)}</b> is your least steady subdivision (σ ${loose.sd.toFixed(0)} ms vs ${tight.sd.toFixed(0)} ms for ${escapeHtml(tight.label)}).`);
  }

  const drums = laneRows.filter(r => r.n >= 6);
  if (drums.length > 1) {
    const worst = drums.reduce((a, r) => (Math.abs(r.mean - m) > Math.abs(a.mean - m) ? r : a));
    const d = worst.mean - m;
    if (Math.abs(d) >= 5) out.push(`Your <b>${worst.label.toLowerCase()}</b> strokes land ${Math.abs(d).toFixed(0)} ms ${d < 0 ? 'earlier' : 'later'} than the rest of the kit.`);
  }

  const tempos = tempoRows.filter(r => r.n >= 6);
  if (tempos.length > 1) {
    const worst = tempos.reduce((a, r) => (Math.abs(r.mean) > Math.abs(a.mean) ? r : a));
    if (Math.abs(worst.mean) >= 4 && Math.abs(worst.mean - m) >= 4) out.push(`At <b>${worst.label}</b> you ${worst.mean < 0 ? 'rushed' : 'dragged'} the most (${fmtMs(worst.mean)} on average).`);
    const loose = tempos.reduce((a, r) => (r.sd > a.sd ? r : a));
    if (loose.sd > sd * 1.25 && loose.sd - sd >= 4) out.push(`Your timing was least steady at <b>${loose.label}</b> (σ ${loose.sd.toFixed(0)} ms).`);
  }

  const missRate = st.counts[MISS] / st.judged;
  if (missRate > 0.1) out.push(`${(missRate * 100).toFixed(0)}% of your strokes were too far from the grid and counted as misses.`);
  if (st.extra > Math.max(4, 0.1 * st.judged)) out.push(`${st.extra} strokes doubled up on a grid note that was already played. If a pad you aren't practicing with (like the hi-hat pedal) caused them, mute it in Settings. If you're playing faster notes on purpose, pick a finer rhythm grid.`);
  return out;
}

function breakdownTable(title, rows) {
  const cell = v => `<td class="${v < -2 ? 'early' : v > 2 ? 'late' : ''}">${fmtMs(v)}</td>`;
  return `<div><p class="cap">${title}</p><table class="breakdown">
    <thead><tr><th></th><th>on grid</th><th>off</th><th>avg</th><th>σ</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${escapeHtml(r.label)}</td><td>${r.n}</td><td>${r.misses}</td>${r.n ? cell(r.mean) : '<td>—</td>'}<td>${r.n > 1 ? `${r.sd.toFixed(1)} ms` : '—'}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function showResults(s) {
  const st = s.scorer.stats();
  const slotLabel = new Map(s.pattern.hits.map(h => [h.slot, h.label]));
  slotLabel.set(TRIPLET_SLOT + 1, 'trip (fills)');
  slotLabel.set(TRIPLET_SLOT + 2, 'let (fills)');
  const slotRows = s.scorer.groupBy(h => s.notes[h.i].slot)
    .sort((a, b) => a.key - b.key)
    .map(r => ({ ...r, label: slotLabel.get(r.key) || `slot ${r.key}` }));
  const laneRows = s.scorer.groupBy(h => h.lane)
    .sort((a, b) => a.key - b.key)
    .map(r => ({ ...r, label: LANES[r.key] }));
  const tempoRows = s.scorer.groupBy(h => Math.round((60000 / s.sections[s.notes[h.i].sec].beatLength) * s.rate * 10) / 10)
    .sort((a, b) => a.key - b.key)
    .map(r => ({ ...r, label: `${r.key} BPM` }));

  $('resultsTitle').textContent = s.title;
  const acc = st.accuracy == null ? '—' : `${(st.accuracy * 100).toFixed(1)}%`;
  const dropoutNote = s.dropouts?.events > 0 ? `
    <div class="dropout-warn">
      <b>${s.dropouts.events} audio dropout${s.dropouts.events > 1 ? 's' : ''}</b> during this session (${Math.round(s.dropouts.ms)} ms of missing audio).
      Dropouts make the audio stutter and the grid jump back, which can throw off your timing and these results.
      Try a larger <b>audio buffer</b> in Settings, then run the calibration again.
      <button class="btn small" type="button" id="dropoutSettings">Open settings</button>
    </div>` : '';
  $('resultsBody').innerHTML = dropoutNote + `
    <div class="res-tiles">
      <div class="tile"><div class="tile-label">Accuracy</div><div class="tile-value">${acc}</div><div class="tile-sub">${st.counts[0]} perfect · ${st.counts[1]} great · ${st.counts[2]} good</div></div>
      <div class="tile"><div class="tile-label">Average offset</div><div class="tile-value">${st.nHits ? fmtMs(st.mean, 1) : '—'}</div><div class="tile-sub">${st.nHits ? tendency(st.mean) : ''}</div></div>
      <div class="tile"><div class="tile-label">Consistency <span class="nocase">(σ)</span></div><div class="tile-value">${st.nHits > 1 ? st.sd.toFixed(1) : '—'}<small>ms</small></div><div class="tile-sub">UR ${st.ur.toFixed(0)}</div></div>
      <div class="tile"><div class="tile-label">Strokes</div><div class="tile-value">${st.nHits}<small>/ ${st.judged} on grid</small></div><div class="tile-sub">${st.counts[MISS]} off the grid · ${st.extra} doubled · best streak ${st.maxStreak}</div></div>
    </div>
    <div class="insights"><ul>${insightsFor(st, slotRows, tempoRows, laneRows).map(t => `<li>${t}</li>`).join('')}</ul></div>
    <div class="res-charts">
      <div><p class="cap">Timing over the session</p><canvas id="resScatter"></canvas></div>
      <div><p class="cap">Distribution (dashed line = average)</p><canvas id="resHist"></canvas></div>
    </div>
    <div class="res-tables">
      ${laneRows.length > 1 ? breakdownTable('By drum', laneRows) : ''}
      ${slotRows.length > 1 ? breakdownTable('By subdivision', slotRows) : ''}
      ${tempoRows.length > 1 ? breakdownTable('By tempo', tempoRows) : ''}
    </div>`;

  const offBtn = $('resultsOffset');
  const suggest = Math.round(st.mean);
  offBtn.hidden = !(s.mode === 'song' && st.nHits >= 20 && Math.abs(suggest) >= 3);
  if (!offBtn.hidden) {
    const next = songPrefs().offset + suggest;
    offBtn.textContent = `Shift this song's beats by ${fmtMs(suggest)}`;
    offBtn.title = `Use this if you think the map's timing is off, not you. The song offset becomes ${fmtMs(next)}.`;
    offBtn.onclick = () => {
      songPrefs().offset = clamp(next, -120, 120);
      save();
      renderSongInfo();
      offBtn.hidden = true;
    };
  }

  $('dropoutSettings')?.addEventListener('click', () => {
    $('resultsDialog').close();
    openSettings();
    $('audioBuffer').focus();
  });
  $('resultsDialog').showModal();
  const { x0 } = scatterRange(s);
  new Scatter($('resScatter')).draw({
    hits: s.scorer.hits, misses: s.scorer.misses, notes: s.notes, windows: s.windows,
    x0, x1: s.mode === 'song' ? s.endMs : Math.max(x0 + 1000, s.now),
    sectionStarts: s.sections.length > 1 ? s.sections.map(x => x.start) : null,
  });
  new Histogram($('resHist')).draw({ hits: s.scorer.hits, windows: s.windows, mean: st.nHits ? st.mean : null });
}

$('resultsClose').onclick = () => $('resultsDialog').close();
$('resultsAgain').onclick = () => { $('resultsDialog').close(); resetLive(); startSession(); };

// ================================================================ song loading

function showSongError(msg) {
  $('songError').textContent = msg;
  $('songError').hidden = !msg;
}

// A song's source files are { file, path } items; `path` is relative to the beatmap folder.
// (Library records saved by older versions hold plain File objects.)
const asItems = list => [...list].map(x => (x instanceof Blob ? { file: x, path: x.name } : x));
const isArchive = path => /\.(osz|zip)$/i.test(path);

async function filesToEntries(items) {
  const entries = [];
  for (const { file, path } of items) {
    if (isArchive(path)) entries.push(...await readZip(file));
    else entries.push({ name: path, size: file.size, bytes: async () => new Uint8Array(await file.arrayBuffer()) });
  }
  return entries;
}

/** Parses a song's files. Also returns the subset worth keeping in the library. */
const AUDIO_RE = /\.(mp3|ogg|wav|m4a|flac|opus|aac)$/i;

/** A song without an osu! map: its beat grid is detected from the audio when it loads. */
function plainDiff(entry) {
  const base = basename(entry.name).replace(/\.[^.]+$/, '');
  const dash = base.indexOf(' - ');
  const [artist, title] = dash > 0 ? [base.slice(0, dash), base.slice(dash + 3)] : ['', base];
  return {
    plain: true, title, titleAscii: title, artist, artistAscii: artist, creator: '', version: 'Detected tempo',
    setId: 0, audioFilename: basename(entry.name), audioEntry: entry, bgEntry: null, timing: [],
  };
}

async function readSongSet(items) {
  const entries = await filesToEntries(items);
  if (!entries.some(e => /\.osu$/i.test(e.name))) {
    const audioEntry = entries.find(e => AUDIO_RE.test(e.name));
    if (audioEntry) {
      const keep = items.length === 1 && isArchive(items[0].path) ? items : items.filter(it => it.path === audioEntry.name);
      return { diffs: [plainDiff(audioEntry)], keep };
    }
  }
  const diffs = await loadBeatmapSet(entries);
  const fallbackAudio = diffs.find(d => d.audioEntry).audioEntry;
  for (const d of diffs) d.audioEntry ||= fallbackAudio;
  // Unpacked folders can hold videos, storyboards and hitsounds; only keep what we use.
  const used = new Set(diffs.flatMap(d => [d.audioEntry?.name, d.bgEntry?.name]));
  const keep = items.length === 1 && isArchive(items[0].path)
    ? items
    : items.filter(it => /\.osu$/i.test(it.path) || used.has(it.path));
  return { diffs, keep };
}

const libraryRecord = (diffs, files) => ({
  id: songKey(diffs[0]), title: diffs[0].title, artist: diffs[0].artist, creator: diffs[0].creator, files, usedAt: Date.now(),
});

async function loadSong(list, { fromLibrary = false } = {}) {
  showSongError('');
  $('dropZone').querySelector('strong').textContent = 'Loading…';
  try {
    const { diffs, keep } = await readSongSet(asItems(list));
    const next = { key: songKey(diffs[0]), diffs, diff: null, diffIndex: -1, buffer: null, audioName: null, durationMs: 0, bgName: null, bgUrl: null, sync: null, syncReady: null,
      triplets: diffs[0].plain ? [] : tripletBeats(diffs) };
    const prefs = settings.songPrefs[next.key];
    await selectDifficulty(next, prefs && prefs.diff < diffs.length ? prefs.diff : 0);
    if (next.diff.plain) {
      $('dropZone').querySelector('strong').textContent = 'Detecting tempo…';
      await setupPlain(next);
    }
    startSync(next);
    if (song?.bgUrl) URL.revokeObjectURL(song.bgUrl);
    song = next;
    songPrefs().diff = song.diffIndex;

    settings.lastSong = song.key;
    save();
    if (fromLibrary) library.touch(song.key);
    else await library.put(libraryRecord(diffs, keep));
  } catch (err) {
    console.error(err);
    showSongError(err?.name === 'EncodingError'
      ? "Couldn't decode the song's audio. Your browser may not support this format (Safari can't play .ogg)."
      : err?.message || String(err));
  } finally {
    renderSongInfo();
    renderLibrary();
    updateStartButton();
  }
}

async function selectDifficulty(target, index) {
  const d = target.diffs[index];
  if (target.audioName !== d.audioEntry.name) {
    target.buffer = await audio.decode(await d.audioEntry.bytes());
    target.audioName = d.audioEntry.name;
    target.durationMs = target.buffer.duration * 1000;
  }
  const bgName = d.bgEntry?.name || null;
  if (bgName !== target.bgName) {
    if (target.bgUrl) URL.revokeObjectURL(target.bgUrl);
    target.bgUrl = bgName ? URL.createObjectURL(new Blob([await d.bgEntry.bytes()])) : null;
    target.bgName = bgName;
  }
  target.diff = d;
  target.diffIndex = index;
}

const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * Splits dropped/selected items into songs: each archive is one song, and so is each folder
 * containing .osu files (with everything below it). Loose top-level files form one song.
 */
function groupItems(items) {
  items = items.filter(it => !basename(it.path).startsWith('.'));
  const archives = items.filter(it => isArchive(it.path));
  const rest = items.filter(it => !isArchive(it.path));
  const roots = [...new Set(rest.filter(it => /\.osu$/i.test(it.path)).map(it => dirOf(it.path)))]
    .sort((a, b) => b.length - a.length); // deepest first, so nested beatmap folders win
  // audio files outside any beatmap folder become songs of their own (tempo is detected)
  const loneAudio = rest.filter(it => AUDIO_RE.test(it.path) && !roots.some(r => r === '' || it.path.startsWith(r + '/')))
    .map(it => [{ file: it.file, path: basename(it.path) }]);
  if (!roots.length) return [...archives.map(a => [a]), ...loneAudio];

  const groups = new Map();
  for (const it of rest) {
    const root = roots.find(r => r === '' || it.path.startsWith(r + '/'));
    if (root === undefined) continue; // not inside any beatmap folder
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ file: it.file, path: root ? it.path.slice(root.length + 1) : it.path });
  }
  const folders = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  return [...archives.map(a => [a]), ...folders, ...loneAudio];
}

/** Files from a drop, including everything inside dropped folders. */
async function droppedItems(dataTransfer) {
  // Entries must be grabbed synchronously: the DataTransfer is emptied once the handler yields.
  const entries = [...(dataTransfer.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map(f => ({ file: f, path: f.name }));
  const out = [];
  const walk = async entry => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { // readEntries returns results in batches
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/** Starts (or reuses the cached) beat-sync analysis for a song's current difficulty. */
function startSync(target) {
  const prefs = (settings.songPrefs[target.key] ||= { offset: 0, diff: 0, startAt: 0 });
  const cache = (prefs.sync ||= {});
  if (target.diff.plain) {
    target.sync = { v: SYNC_VERSION, ok: true, offset: 0, confidence: 99, flagged: [], plain: true };
    target.syncReady = Promise.resolve(target.sync);
    return;
  }
  const key = target.diff.version;
  const cached = cache[key];
  if (cached?.v === SYNC_VERSION) {
    target.sync = cached;
    target.syncReady = Promise.resolve(cached);
    return;
  }
  target.sync = null;
  const done = rec => {
    target.sync = rec;
    if (song === target) renderSongInfo();
    return rec;
  };
  target.syncReady = analyzeSync(target.buffer, target.diff.timing)
    .then(r => {
      const rec = {
        v: SYNC_VERSION, ok: r.ok, offset: r.offset,
        confidence: Number.isFinite(r.confidence) ? +r.confidence.toFixed(2) : 99,
        flagged: r.flagged.map(f => ({ time: f.time, bpm: f.bpm, offset: f.offset })),
      };
      cache[key] = rec;
      save();
      return done(rec);
    })
    .catch(err => {
      console.warn('Beat sync analysis failed', err);
      return done({ v: SYNC_VERSION, ok: false, offset: 0, confidence: 0, flagged: [] });
    });
}

/** Detects (or reuses the cached) tempo candidates of a plain audio song and builds its grid. */
async function setupPlain(target) {
  const prefs = (settings.songPrefs[target.key] ||= { offset: 0, diff: 0, startAt: 0 });
  if (prefs.tempoDetect?.v !== TEMPO_VERSION) {
    const r = await detectTempo(target.buffer);
    prefs.tempoDetect = { v: TEMPO_VERSION, clear: r.clear, candidates: r.candidates.map(c => ({ period: c.period, phase: c.phase })) };
  }
  prefs.tempo ||= { cand: 0, mult: 1, half: false, meter: 4, bar: 0 };
  applyTempo(target, prefs);
  save();
}

/** Turns the chosen candidate plus the player's adjustments into a single timing point. */
function applyTempo(target, prefs) {
  const t = prefs.tempo, c = prefs.tempoDetect?.candidates[t.cand];
  if (!c) { target.diff.timing = []; return; }
  const P = c.period / t.mult, bar = P * t.meter;
  const downbeat = c.phase + (t.half ? P / 2 : 0) + t.bar * P;
  // start one bar early so the first bar is complete; beats before 0 ms are never played
  target.diff.timing = [{ time: (((downbeat % bar) + bar) % bar) - bar, beatLength: P, meter: t.meter }];
}

function changeTempo(fn) {
  const prefs = songPrefs();
  fn(prefs.tempo);
  applyTempo(song, prefs);
  save();
  renderSongInfo();
  if (session?.preview) {
    // restart the preview with the new grid, a second before where it was, to hear the change
    const from = Math.max(0, session.now - 1000);
    stopSession(false);
    startSession({ preview: true, from });
  }
}

/** The automatic part of the sync: detected, typical fallback, or nothing when auto-sync is off. */
function autoSync() {
  if (!settings.autoSync || !song?.sync) return 0;
  return song.sync.ok ? song.sync.offset : FALLBACK_SYNC;
}

/** Total shift (ms) applied to the map's beats; positive moves them later. */
function totalSync() {
  return autoSync() + settings.syncFineTune + songPrefs().offset;
}

async function handleItems(itemsPromise) {
  const label = $('dropZone').querySelector('strong');
  label.textContent = 'Reading files…';
  const groups = groupItems(await itemsPromise);
  if (!groups.length) { renderSongInfo(); return; }
  if (groups.length > 30 && !confirm(`Add ${groups.length} beatmaps to your songs?`)) { renderSongInfo(); return; }

  // Every song but the last is only parsed and saved; the last one is opened.
  const failed = [];
  for (let k = 0; k < groups.length - 1; k++) {
    label.textContent = `Importing ${k + 1} / ${groups.length}…`;
    try {
      const { diffs, keep } = await readSongSet(groups[k]);
      await library.put(libraryRecord(diffs, keep));
    } catch {
      failed.push(groups[k][0]?.path || '?');
    }
  }
  await loadSong(groups[groups.length - 1]);
  if (failed.length) {
    const msg = `${failed.length} of ${groups.length} beatmaps couldn't be read.`;
    showSongError($('songError').hidden ? msg : `${$('songError').textContent} ${msg}`);
  }
}

const fileItems = files => [...files].map(f => ({ file: f, path: f.webkitRelativePath || f.name }));

function renderSongInfo() {
  const has = !!song?.diff;
  $('songInfo').hidden = !has;
  $('songSettings').hidden = !has || settings.mode !== 'song';
  $('dropZone').querySelector('strong').textContent = 'Add songs';
  const bgCss = has && song.bgUrl ? `url("${song.bgUrl}")` : '';
  $('songBg').style.backgroundImage = bgCss;
  $('stageBg').style.backgroundImage = settings.mode === 'song' ? bgCss : '';
  if (!has) return;

  const d = song.diff, prefs = songPrefs();
  const bpm = v => +v.toFixed(1);
  $('songTitle').textContent = d.title;
  $('songArtist').textContent = d.plain ? (d.artist || 'Audio file · tempo detected') : d.artist + (d.creator ? ` · mapped by ${d.creator}` : '');
  if (d.timing.length) {
    const t = tempoSummary(d.timing, song.durationMs);
    $('songMeta').textContent = [
      t.min === t.max ? `${bpm(t.main)} BPM` : `${bpm(t.min)}–${bpm(t.max)} BPM (mostly ${bpm(t.main)})`,
      t.changes ? `${t.changes} timing change${t.changes > 1 ? 's' : ''}` : 'constant tempo',
      fmtTime(song.durationMs),
    ].join(' · ');
  } else {
    $('songMeta').textContent = `no beat found · ${fmtTime(song.durationMs)}`;
  }
  renderTempo();
  $('tripletRow').hidden = !!d.plain;
  const fills = mergeBeats(song.triplets || []);
  $('tripletInfo').textContent = d.plain ? '' : fills.length
    ? `${fills.length} triplet section${fills.length > 1 ? 's' : ''} found in this beatmap (${fills.map(f => fmtTime(f.start)).join(', ')}).`
    : 'No triplet sections found in this beatmap.';
  renderSync();

  const sel = $('diffSelect');
  sel.innerHTML = song.diffs.map((x, i) => `<option value="${i}">${escapeHtml(x.version)}</option>`).join('');
  sel.value = song.diffIndex;
  // Difficulties almost always share their timing, so the picker stays hidden; the first one is used.
  $('diffField').hidden = true;

  const startAt = $('startAt');
  startAt.max = Math.max(0, Math.floor((song.durationMs - 3000) / 100) * 100);
  startAt.value = prefs.startAt;
  $('startAtLabel').textContent = fmtTime(prefs.startAt);
  $('songOffset').value = prefs.offset;
  $('songOffsetLabel').textContent = fmtMs(prefs.offset);
}

function renderTempo() {
  const plain = !!song?.diff?.plain;
  $('tempoBox').hidden = !plain;
  if (!plain) return;
  const prefs = songPrefs(), det = prefs.tempoDetect, t = prefs.tempo;
  const cands = det?.candidates || [], c = cands[t.cand];
  $('tempoBpm').textContent = c ? `${(60000 / c.period * t.mult).toFixed(2)} BPM` : 'no beat found';
  $('tempoWarn').hidden = !!(c && det.clear);
  $('tempoCands').innerHTML = cands.map((x, i) =>
    `<button type="button" class="pad${i === t.cand ? ' hit' : ''}" data-cand="${i}" title="Option ${i + 1}">${(60000 / x.period).toFixed(2)}</button>`).join('');
  $('tempoMeter').value = t.meter;
  $('tempoHalfState').textContent = t.half ? ' (shifted)' : '';
  for (const id of ['tempoHalve', 'tempoDouble', 'tempoShift', 'tempoBar', 'tempoMeter', 'tempoPreview']) $(id).disabled = !c;
}

function renderSync() {
  const el = $('songSync');
  const sync = song?.sync;
  let main, cls = '';
  if (song?.diff?.plain) {
    main = 'Beat grid detected from the audio. Check it with the preview.';
  } else if (!settings.autoSync) {
    main = 'Auto-sync is off, so the map\'s own timing is used.';
  } else if (!sync) {
    main = 'Analyzing the beat…';
    cls = 'pending';
  } else if (sync.ok) {
    const quality = sync.confidence >= 3 ? 'clear match' : 'fair match';
    main = `Auto-sync <b>${fmtMs(sync.offset, 1)}</b> <span class="hint">(${quality} with the drums)</span>`;
  } else {
    main = `Couldn't detect the beat clearly, so the typical <b>${fmtMs(FALLBACK_SYNC)}</b> is used. Adjust by ear if needed.`;
    cls = 'warn';
  }
  const flags = (settings.autoSync && sync?.ok ? sync.flagged : []).map(f => {
    const d = f.offset - sync.offset;
    return `<li>Section at ${fmtTime(f.time)} (${+f.bpm.toFixed(1)} BPM): the map's beats seem ${Math.abs(d).toFixed(0)} ms ${d > 0 ? 'early' : 'late'} here compared to the rest of the song.</li>`;
  });
  const total = fmtMs(totalSync(), 1);
  el.className = `song-sync ${cls}`;
  el.innerHTML = `<div>${main}</div>`
    + (flags.length ? `<ul class="sync-flags">${flags.join('')}</ul>` : '')
    + `<div class="hint">Total shift applied to the beats: ${total}</div>`;
}

async function renderLibrary() {
  const items = await library.list();
  $('libraryBox').hidden = !items.length;
  const ul = $('libraryList');
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    const load = document.createElement('button');
    load.className = 'load' + (song?.key === it.id ? ' active' : '');
    load.innerHTML = `${escapeHtml(it.title)}<small>${escapeHtml(it.artist)}</small>`;
    load.title = `${it.artist} – ${it.title}`;
    load.onclick = () => loadSong(it.files, { fromLibrary: true });
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Remove from this list';
    del.setAttribute('aria-label', `Remove ${it.title}`);
    del.onclick = async () => { await library.remove(it.id); renderLibrary(); };
    li.append(load, del);
    ul.append(li);
  }
}

const drop = $('dropZone');
$('addSongsBtn').onclick = () => $('addDialog').showModal();
$('addClose').onclick = () => $('addDialog').close();
$('browseBtn').onclick = () => { $('addDialog').close(); $('fileInput').click(); };
$('folderBtn').onclick = () => { $('addDialog').close(); $('folderInput').click(); };
$('fileInput').onchange = e => { handleItems(fileItems(e.target.files)); e.target.value = ''; };
$('folderInput').onchange = e => { handleItems(fileItems(e.target.files)); e.target.value = ''; };
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  drop.classList.remove('over');
  handleItems(droppedItems(e.dataTransfer));
});
// Dropping a beatmap anywhere on the page switches to song mode.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  if (session || !e.dataTransfer?.items?.length) return;
  const items = droppedItems(e.dataTransfer);
  setMode('song');
  handleItems(items);
});

$('diffSelect').onchange = async e => {
  try {
    await selectDifficulty(song, Number(e.target.value));
    startSync(song);
    songPrefs().diff = song.diffIndex;
  } catch (err) { showSongError(err.message); }
  save();
  renderSongInfo();
};
$('tempoCands').onclick = e => {
  const b = e.target.closest('[data-cand]');
  if (b) changeTempo(t => { t.cand = Number(b.dataset.cand); t.mult = 1; t.half = false; });
};
$('tempoHalve').onclick = () => changeTempo(t => { t.mult = Math.max(0.25, t.mult / 2); });
$('tempoDouble').onclick = () => changeTempo(t => { t.mult = Math.min(4, t.mult * 2); });
$('tempoShift').onclick = () => changeTempo(t => { t.half = !t.half; });
$('tempoBar').onclick = () => changeTempo(t => { t.bar = (t.bar + 1) % t.meter; });
$('tempoMeter').onchange = e => changeTempo(t => { t.meter = Number(e.target.value); t.bar %= t.meter; });
$('tempoPreview').onclick = () => { resetLive(); startSession({ preview: true }); };

$('startAt').oninput = e => {
  songPrefs().startAt = Number(e.target.value);
  $('startAtLabel').textContent = fmtTime(songPrefs().startAt);
  save();
};
$('songOffset').oninput = e => {
  songPrefs().offset = Number(e.target.value);
  $('songOffsetLabel').textContent = fmtMs(songPrefs().offset);
  renderSync();
  save();
};

// ================================================================ setup panel controls

function setMode(mode) {
  settings.mode = mode;
  save();
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  $('metronomePane').hidden = mode !== 'metronome';
  $('songPane').hidden = mode !== 'song';
  $('libraryPane').hidden = mode !== 'song';
  syncClickControls();
  renderSongInfo();
  updateStartButton();
}
document.querySelectorAll('.tab').forEach(t => { t.onclick = () => setMode(t.dataset.mode); });

function updateStartButton() {
  $('startBtn').disabled = !session && settings.mode === 'song' && !song?.diff;
}

$('startBtn').onclick = e => {
  e.currentTarget.blur();
  if (session) stopSession(true);
  else { resetLive(); startSession(); }
};

/** Binds an input to a settings key. */
function bind(id, key, { parse = Number, event = 'input', after } = {}) {
  const el = $(id);
  const isCheck = el.type === 'checkbox';
  if (isCheck) el.checked = !!settings[key]; else el.value = settings[key];
  el.addEventListener(event, () => {
    const v = isCheck ? el.checked : parse(el.value);
    if (!isCheck && typeof v === 'number' && !Number.isFinite(v)) return;
    settings[key] = v;
    save();
    after?.(v);
  });
}

const intIn = (lo, hi) => v => { const n = parseInt(v, 10); return Number.isFinite(n) ? clamp(n, lo, hi) : NaN; };

function setBpm(v) {
  settings.bpm = clamp(Math.round(v), 20, 400);
  $('bpm').value = settings.bpm;
  $('bpmRange').value = settings.bpm;
  save();
}
$('bpm').value = settings.bpm;
$('bpmRange').value = settings.bpm;
$('bpm').addEventListener('change', e => setBpm(Number(e.target.value) || settings.bpm));
$('bpmRange').addEventListener('input', e => setBpm(Number(e.target.value)));
document.querySelectorAll('[data-bpm-step]').forEach(b => {
  b.onclick = e => setBpm(settings.bpm + Number(b.dataset.bpmStep) * (e.shiftKey ? 5 : 1));
});

bind('meter', 'meter', { event: 'change' });
bind('countIn', 'countIn', { event: 'change' });
for (const [id, lo, hi] of [['trainerStep', 1, 50], ['trainerBars', 1, 64], ['trainerMax', 30, 400], ['gapPlay', 1, 16], ['gapMute', 1, 16]]) {
  bind(id, id, { parse: intIn(lo, hi), event: 'change' });
}
for (const id of ['trainerOn', 'gapOn']) bind(id, id, { event: 'change', after: syncWhen });
function syncWhen() {
  document.querySelectorAll('[data-when]').forEach(el => { el.hidden = !settings[el.dataset.when]; });
}

bind('rate', 'rate', { after: v => { $('rateLabel').textContent = `${v.toFixed(2)}×`; } });
$('rateLabel').textContent = `${settings.rate.toFixed(2)}×`;
bind('musicVolume', 'musicVolume', { after: v => audio.setMusicVolume(v) });
bind('clickVolume', 'clickVolume', { after: v => audio.setClickVolume(v) });
bind('songClick', 'songClick', { event: 'change', after: syncClickControls });
bind('useTriplets', 'useTriplets', { event: 'change' });
/** Click type and volume only matter in song mode when the click track is on. */
// Collapsible sections remember whether they were open.
for (const id of ['playalongGroup', 'libraryBox']) {
  const el = $(id);
  el.open = settings.openGroups?.[id] ?? true;
  el.addEventListener('toggle', () => { settings.openGroups = { ...settings.openGroups, [id]: el.open }; save(); });
}

function syncClickControls() {
  $('clickRow').hidden = settings.mode === 'song' && !settings.songClick;
}
bind('clickMode', 'clickMode', { parse: String, event: 'change' });

const patternSel = $('pattern');
patternSel.innerHTML = PATTERNS.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
bind('pattern', 'pattern', { parse: String, event: 'change', after: renderPattern });
bind('customSubdiv', 'customSubdiv', { event: 'change', after: renderPattern });
bind('customGrid', 'customGrid', { parse: String, after: renderPattern });

function renderPattern() {
  $('customField').hidden = settings.pattern !== 'custom';
  const p = currentPattern();
  const el = $('patternPreview');
  el.innerHTML = '';
  for (let b = 0; b * p.subdiv < p.grid.length; b++) {
    const beat = document.createElement('div');
    beat.className = 'beat';
    for (let k = 0; k < p.subdiv && b * p.subdiv + k < p.grid.length; k++) {
      const slot = document.createElement('div');
      const idx = b * p.subdiv + k;
      const hit = p.hits.find(h => h.slot === idx);
      slot.className = 'slot' + (hit ? ' on' : '') + (hit && !hit.primary ? ' secondary' : '') + (k === 0 ? ' first' : '');
      beat.append(slot);
    }
    el.append(beat);
  }
}

function renderStrictness() {
  document.querySelectorAll('#strictness button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === settings.strictness)));
  const w = STRICTNESS[settings.strictness];
  $('windowsHint').textContent = `Perfect ±${w.perfect} · Great ±${w.great} · Good ±${w.good} ms (good is narrower on dense, fast grids)`;
}
document.querySelectorAll('#strictness button').forEach(b => {
  b.onclick = () => { settings.strictness = b.dataset.value; save(); renderStrictness(); };
});

// ================================================================ settings dialog

function renderMidiStatus() {
  const chip = $('midiChip'), label = $('midiLabel'), help = $('midiHelp');
  chip.classList.remove('ok', 'warn', 'err');
  const inputs = midi.inputs;
  if (midi.status === 'pending') { label.textContent = 'MIDI…'; return; }
  if (midi.status === 'unsupported') {
    chip.classList.add('err'); label.textContent = 'No Web MIDI';
    help.textContent = "This browser doesn't support Web MIDI. Use Chrome, Edge or Opera on desktop or Android. You can still practice with the keyboard.";
  } else if (midi.status === 'denied') {
    chip.classList.add('err'); label.textContent = 'MIDI blocked';
    help.textContent = `MIDI access was blocked (${midi.error}). Allow it in the site settings (the icon left of the address bar), then reload.`;
  } else if (!inputs.length) {
    chip.classList.add('warn'); label.textContent = 'No kit connected';
    help.textContent = 'No MIDI devices found. Connect your kit over USB and switch it on. It shows up here automatically.';
  } else {
    const active = midi.active;
    chip.classList.add(active.length ? 'ok' : 'warn');
    label.textContent = active.length ? active.map(i => i.name).join(', ') : 'Device not connected';
    help.textContent = `Found ${inputs.length} MIDI input${inputs.length > 1 ? 's' : ''}.`;
  }
  const sel = $('midiInput');
  const known = new Set(inputs.map(i => i.id));
  sel.innerHTML = `<option value="all">All inputs</option>`
    + inputs.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join('')
    + (midi.selected !== 'all' && !known.has(midi.selected) ? `<option value="${escapeHtml(midi.selected)}">(disconnected device)</option>` : '');
  sel.value = midi.selected;
}
$('midiInput').onchange = e => { settings.midiInput = e.target.value; save(); midi.select(e.target.value); };

const padEls = new Map();
function renderPads() {
  const list = $('padList');
  list.innerHTML = '';
  padEls.clear();
  if (!settings.seenPads.length) { list.innerHTML = '<span class="hint">No pads seen yet.</span>'; return; }
  for (const note of [...settings.seenPads].sort((a, b) => a - b)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pad' + (settings.mutedNotes.includes(note) ? ' muted' : '');
    b.innerHTML = `${escapeHtml(drumName(note))}<small>${note}</small>`;
    b.title = settings.mutedNotes.includes(note) ? 'Ignored. Click to count it again.' : 'Counted. Click to ignore this pad.';
    b.onclick = () => {
      const i = settings.mutedNotes.indexOf(note);
      if (i >= 0) settings.mutedNotes.splice(i, 1); else settings.mutedNotes.push(note);
      save();
      renderPads();
    };
    padEls.set(note, b);
    list.append(b);
  }
}

function notePad(ev) {
  if (!settings.seenPads.includes(ev.note)) {
    settings.seenPads.push(ev.note);
    save();
    renderPads();
  }
  const el = padEls.get(ev.note);
  if (el) {
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 120);
  }
  const lh = $('lastHit');
  const ignored = settings.mutedNotes.includes(ev.note) ? ' · ignored (muted)'
    : ev.velocity < settings.minVelocity ? ' · ignored (too soft)' : '';
  const out = audio.outputLatencyMs;
  lh.textContent = `${drumName(ev.note)} (note ${ev.note}) · velocity ${ev.velocity} · ch ${ev.channel} · ${ev.device}${ignored}`
    + `
Delay: MIDI to page ${ev.delay.toFixed(1)} ms`
    + (out != null && audio.ctx.state === 'running' ? ` + audio output ${out.toFixed(0)} ms (reported by your browser)` : '');
  lh.classList.add('live');
}

bind('minVelocity', 'minVelocity', { after: v => { $('minVelocityLabel').textContent = v; } });
$('minVelocityLabel').textContent = settings.minVelocity;
bind('keyboardOn', 'keyboard', { event: 'change' });
bind('padSounds', 'padSounds', { event: 'change' });
bind('keySounds', 'keySounds', { event: 'change' });
bind('autoSyncOn', 'autoSync', { event: 'change', after: () => { if (song?.diff) renderSync(); } });
function setFineTune(v) {
  settings.syncFineTune = clamp(Math.round(v), -60, 60);
  $('syncFineTune').value = settings.syncFineTune;
  $('syncFineTuneLabel').textContent = fmtMs(settings.syncFineTune);
  save();
  if (song?.diff) renderSync();
}
setFineTune(settings.syncFineTune);
$('syncFineTune').addEventListener('input', e => setFineTune(Number(e.target.value)));
function setPadVolume(v) {
  settings.padVolume = clamp(v, 0, 1);
  save();
  if (kit) kit.volume = settings.padVolume;
  $('padVolume').value = settings.padVolume;
  $('calibPadVolume').value = settings.padVolume;
  $('calibPadVolumeLabel').textContent = `${Math.round(settings.padVolume * 100)}%`;
}
setPadVolume(settings.padVolume);
$('padVolume').addEventListener('input', e => setPadVolume(Number(e.target.value)));
$('calibPadVolume').addEventListener('input', e => setPadVolume(Number(e.target.value)));

function setLatency(v) {
  settings.latency = clamp(Math.round(v), -300, 600);
  $('latency').value = settings.latency;
  $('latencyNum').value = settings.latency;
  $('latencyLabel').textContent = `${settings.latency} ms`;
  save();
}
setLatency(settings.latency);
$('latency').addEventListener('input', e => setLatency(Number(e.target.value)));
$('latencyNum').addEventListener('change', e => setLatency(Number(e.target.value) || 0));

$('audioBuffer').value = settings.audioBuffer;
$('audioBuffer').addEventListener('change', async e => {
  const ms = Number(e.target.value);
  if (session) stopSession(false);
  calib?.cancel();
  settings.audioBuffer = ms;
  save();
  kit = null; // drum sounds belong to the old audio context
  await audio.setBuffer(ms);
  await audio.init().catch(() => {}); // the change is a user gesture, so the new context can start now
  $('audioBufferNote').hidden = false;
  updateLatencyInfo();
});

function updateLatencyInfo() {
  const ms = audio.outputLatencyMs;
  $('latencyInfo').textContent = ms == null
    ? 'Start a session once to see the latency your browser reports for audio output.'
    : `Your browser reports ${ms.toFixed(0)} ms of audio output latency. DrumCoach already corrects for this, so the value above only needs to cover what's left.`;
}

function openSettings() {
  updateLatencyInfo();
  renderMidiStatus();
  renderPads();
  $('settingsDialog').showModal();
}
$('settingsBtn').onclick = openSettings;
$('midiChip').onclick = openSettings;
$('openCalibFromSettings').onclick = () => { $('settingsDialog').close(); openCalibration(); };

// ================================================================ calibration dialog

let calibResult = null;
function openCalibration() {
  if (session) stopSession(false);
  calib?.cancel();
  $('calibIntro').hidden = false;
  $('calibRun').hidden = true;
  $('calibResult').hidden = true;
  $('calibStart').hidden = false;
  $('calibStart').textContent = 'Start';
  $('calibApply').hidden = true;
  $('calibPadHint').textContent = settings.padSounds ? '' : 'Drum sounds are turned off in Settings, so this has no effect right now.';
  $('calibDialog').showModal();
}
$('calibBtn').onclick = openCalibration;

$('calibStart').onclick = async e => {
  e.currentTarget.blur();
  $('calibIntro').hidden = true;
  $('calibResult').hidden = true;
  $('calibRun').hidden = false;
  $('calibStart').hidden = true;
  $('calibApply').hidden = true;
  $('calibCount').textContent = 'Get ready…';
  drawCalibStrip($('calibCanvas'), []);
  calib = new Calibration(audio, {
    onBeat(k, countIn) {
      if (k < countIn) {
        $('calibCount').textContent = `Count-in: ${countIn - k}`;
        const p = $('calibPulse');
        p.classList.remove('beat'); void p.offsetWidth; p.classList.add('beat');
      } else if (k === countIn) {
        $('calibCount').textContent = 'Play along on every click';
      }
    },
    onProgress(errors, target) {
      $('calibCount').textContent = `${errors.length} / ${target} hits`;
      drawCalibStrip($('calibCanvas'), errors);
    },
    onDone(res) {
      calibResult = res;
      $('calibRun').hidden = true;
      $('calibResult').hidden = false;
      $('calibStart').hidden = false;
      $('calibStart').textContent = 'Try again';
      if (!res.ok) {
        $('calibResult').innerHTML = `<p>Only ${res.n} usable hits were recorded. Check that your kit is connected (the dot at the top flashes when you hit a pad), then try again.</p>`;
        return;
      }
      const dir = res.offset >= 0 ? 'after' : 'before';
      $('calibResult').innerHTML = `
        <div class="calib-big">${res.offset} ms</div>
        <p>On average, your hits arrived ${Math.abs(res.offset)} ms ${dir} the click (spread σ ${res.sd.toFixed(1)} ms over ${res.n} hits${res.dropped ? `, ${res.dropped} outlier${res.dropped > 1 ? 's' : ''} ignored` : ''}).</p>
        ${res.sd > 25 ? '<p class="hint">That spread is quite wide, so the value may not be reliable. Run it again if you can.</p>' : ''}
        <p class="hint">Current setting: ${settings.latency} ms.</p>`;
      $('calibApply').hidden = false;
      $('calibApply').textContent = `Use ${res.offset} ms`;
    },
  });
  audio.setClickVolume(Math.max(0.5, settings.clickVolume));
  await calib.start();
};
$('calibApply').onclick = () => {
  if (calibResult?.ok) setLatency(calibResult.offset);
  $('calibDialog').close();
};
$('calibCancel').onclick = () => $('calibDialog').close();
$('calibClose').onclick = () => $('calibDialog').close();
$('calibDialog').addEventListener('close', () => { calib?.cancel(); audio.setClickVolume(settings.clickVolume); });

// ================================================================ boot

setMode(settings.mode);
syncWhen();
renderPattern();
renderStrictness();
renderPads();
renderLibrary().then(async () => {
  if (!settings.lastSong) return;
  const items = await library.list();
  const last = items.find(i => i.id === settings.lastSong);
  if (last) loadSong(last.files, { fromLibrary: true });
});

// Handy for debugging from the browser console.
window.drumcoach = { audio, midi, settings, get session() { return session; }, get song() { return song; } };
