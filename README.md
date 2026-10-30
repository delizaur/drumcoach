# DrumCoach

A browser-based timing trainer for electronic drum kits. Connect your kit over USB, play along to a metronome, an [osu!](https://osu.ppy.sh) beatmap, a [Clone Hero](https://clonehero.net) chart or any audio file, and see exactly how early or late every hit is.

It's a fully static site: no backend, no build step, no dependencies. Everything runs locally in the browser.

## Features

- **USB MIDI input** through the Web MIDI API. Note-on events from any kit, with per-pad muting and a velocity threshold to filter out crosstalk.
- **Drum sounds:** pads trigger a kit synthesized in the browser (kick, snare, rimshot, side stick, toms, hi-hat with pedal choke, crash, splash, china, ride, bell), mapped from General MIDI notes and following velocity. You can switch it off in Settings if you monitor through your kit's module.
- **Metronome mode** with any tempo and time signature, a count-in, a **speed trainer** (+N BPM every M bars) and a **gap trainer** (the click and the notes go silent for some bars, so you have to keep time on your own).
- **Song mode with osu! beatmaps.** Drop an `.osz` file, an unpacked beatmap folder (or several, even your whole osu! `Songs` folder), or an `.osu` plus its audio. The app plays the song and follows every uninherited timing point (BPM, offset, meter). Hit objects are ignored. You can choose the start position and playback speed, and set a timing offset for each song.
- **Clone Hero charts.** Drop a `.sng` or `.zip` file, or a chart folder (several at once, or your whole Clone Hero `songs` folder). Both `notes.chart` and `notes.mid` are read, with the metadata from `song.ini` (`js/clonehero.js`, `js/sng.js`). The grid follows the chart's tempo map, including tempo changes in the middle of a bar and odd meters (a 7/8 bar is 3½ quarter notes), and the chart's offset and `delay`. Audio stems are mixed together; when the chart has separate drum stems you can switch the drums off and play along without the original drummer. The difficulties of the drum part take the place of a beatmap's difficulties in finding triplet fills and sextuplets.
- **Difficulty selector** (next to the Start button): **Free play** is the jam-along mode described here, on a rhythm grid. Clone Hero charts also list their drum difficulties (Expert+ when the chart has 2x kick notes): pick one and the timeline shows the chart's notes in their drums' lanes. Each stroke plays the closest unplayed note of its drum; cymbal notes take the hi-hat or any cymbal (plain 4-lane charts, which don't mark cymbals, take any cymbal or tom), and the hi-hat pedal is ignored. Strokes far from any note of their drum are misses as usual (on time on another drum's note: "wrong drum"), and notes you don't play are counted as **skipped** (grey cross), which breaks the streak and counts against the accuracy.
- **Triplet fills from beatmaps:** the hit objects of all difficulties are checked for how they are snapped. Beats where at least two difficulties use triplet snaps (1/3, 1/6, 1/12) and outvote straight snaps get a triplet grid instead of your chosen one; on the timeline they are shaded and labelled. Can be switched off in the playalong settings (`js/triplets.js`).
- **Any audio file, no map needed:** drop an MP3 (or OGG, WAV, ...) without an `.osu` and the tempo is detected from the audio (`js/tempo.js`). You get the best three tempo options, ×2 / ÷2, a half-beat shift, beats per bar and bar start, plus a preview with the click track to confirm by ear. Works for songs with a steady beat; tested on 99 constant-tempo osu! maps, the right grid was among the options for 97, typically within 1 ms. Live recordings that speed up or slow down are followed in chunks of 16 beats, adding a timing change wherever the beat drifts more than 3 ms from a straight tempo.
- **Automatic rhythm grid (default):** 8ths with 16ths allowed in straight sections (only 8ths above 200 BPM), triplets in the triplet sections, and sextuplets inside them wherever at least two of the detailed difficulties (60%+ of the most detailed one's off-beat notes) agree (`js/autogrid.js`). Straight sections never switch to 32nds: beatmaps often have short 1/8 bursts that follow guitar or vocals, and a grid that changes every few beats is hard to read.
- **Rhythm grids:** hybrid grids (the default is 8ths with 16ths allowed, plus quarters with 8ths, and 8ths with triplets), quarters, halves, 8ths, off-beats, triplets, swing, 16ths, gallops, sextuplets, backbeat, son clave, or your own grid (for example `x..x..x.` in 16ths).
- **Feedback:** a scrolling timeline with a lane per drum (cymbals, hi-hat, toms, snare, kick, top to bottom as in drum notation), an osu!-style hit-error meter, live accuracy / mean offset / consistency (σ and UR), a timing-over-time chart, and an end-of-session report broken down by drum, subdivision and tempo.
- **Latency calibration:** tap along to a click and the app measures your whole setup's offset (kit → USB → browser → speakers → ears).
- Loaded songs are kept in your browser (IndexedDB), so you don't have to drop them again.

## Running locally

ES modules don't load from `file://`, so serve the folder:

```sh
python -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>. Web MIDI only works in a secure context, and `localhost` counts as one.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, and pick your branch with the `/ (root)` folder.
3. The site goes live at `https://<user>.github.io/<repo>/`. Pages serves over HTTPS, which Web MIDI requires.

## Browser support

Web MIDI works in Chrome, Edge and Opera (desktop and Android). Firefox supports it behind a site-permission prompt. Safari doesn't support Web MIDI, but you can still practice there with the keyboard (Space = kick, F/J = snare, D/K = hi-hat).

## How the timing works

- The `AudioContext` is the master clock. Music and clicks are scheduled on it with sample accuracy.
- MIDI and keyboard events carry `performance.now()` timestamps. `AudioContext.getOutputTimestamp()` maps those onto the audio timeline *as it is heard*, which corrects for the output latency the browser reports. The mapping is median-filtered every frame to remove jitter.
- **Audio buffer:** 10 ms by default for the lowest latency; it can be raised to 20/40/80 ms in Settings if the audio stutters (recalibrate afterwards). Dropouts are counted during each session, from `AudioContext.playbackStats` where the browser supports it, otherwise from sudden jumps of the audio clock, and the results screen warns when there were any.
- Whatever latency is left (USB polling, the kit's own processing, Bluetooth, the browser under-reporting) is covered by the **latency compensation** value, which you measure with the calibration.
- **Auto-sync:** osu! maps often put their beats a little ahead of the music (around 20-25 ms on average across 56 maps measured, with per-map variation). When a song loads, `js/beatsync.js` finds the drums in the audio (kick band below 150 Hz, snare/cymbal band above 2.5 kHz, onset strength at 1 ms resolution) and picks the shift of the map's beat grid (within ±60 ms) that lines up best with them, averaged over every beat in the song. Sections with 32+ beats are also checked on their own and flagged if they disagree with the rest by 10 ms or more. Songs without clear percussion fall back to a typical +22 ms (Clone Hero charts, which charters sync to the audio themselves, fall back to none). On top of that come a global fine-tune (Settings) and a per-song adjustment. Results are cached per difficulty.
- **The rhythm is a quantization grid.** Each stroke snaps to the nearest grid note and is judged by its distance to it. A stroke more than the *good* window away (60 ms at Normal) counts as a miss. Grid notes you don't play aren't counted at all, so an 8th-note grid lets you play quarters, 8ths or any mix of them. **Hybrid grids** snap a stroke to the nearest coarse note (an 8th) whenever it is within the good window, or 65% of the gap to the neighbouring fine note if that is smaller, and only fall back to the fine notes (16ths) otherwise. On a plain 16th grid, a loose 8th more than half a 16th off gets snapped to the wrong note and judged with the wrong sign, which shows up as two peaks in the distribution; the hybrid grid avoids most of that. Off-grid misses lower your accuracy but are left out of the average offset and σ. Strokes on different pads are scored separately, so kick + snare or snare + hi-hat on the same note are two hits. On the same pad, strokes within 35 ms count as one (to filter double triggers), and a second stroke on a grid note that pad already played counts as *doubled*.

## Project layout

```
index.html        markup
css/style.css     styles
js/main.js        app wiring, UI, session lifecycle
js/audio.js       AudioContext clock, music playback, metronome clicks
js/midi.js        Web MIDI input
js/drums.js       synthesized drum kit for pad sounds
js/zip.js         minimal .osz/.zip reader using DecompressionStream
js/osu.js         .osu parsing (metadata, red-line timing points)
js/clonehero.js   Clone Hero charts (.chart, notes.mid, song.ini, audio stems)
js/sng.js         .sng chart container reader
js/beatsync.js    automatic beat-grid alignment from the audio
js/tempo.js       tempo and beat-grid detection for songs without a map
js/timing.js      tempo sections, rhythm patterns, expected-note grid
js/triplets.js    triplet fills from beatmap hit objects
js/autogrid.js    sextuplet beats for the automatic grid
js/scorer.js      hit matching, judgments, statistics
js/render.js      canvas views (timeline, error meter, charts)
js/calibration.js latency calibration
js/library.js     IndexedDB song storage
```

For debugging, `window.drumcoach` in the browser console exposes the audio engine, the MIDI input, the settings and the current session.
