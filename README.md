# DrumCoach

A browser-based timing trainer for electronic drum kits. Connect your kit over USB, play along to a metronome or to an [osu!](https://osu.ppy.sh) beatmap, and see exactly how early or late every hit is.

It's a fully static site: no backend, no build step, no dependencies. Everything runs locally in the browser.

## Features

- **USB MIDI input** through the Web MIDI API. Note-on events from any kit, with per-pad muting and a velocity threshold to filter out crosstalk.
- **Metronome mode** with any tempo and time signature, a count-in, a **speed trainer** (+N BPM every M bars) and a **gap trainer** (the click and the notes go silent for some bars, so you have to keep time on your own).
- **Song mode with osu! beatmaps.** Drop an `.osz` file (or an `.osu` plus its audio). The app plays the song and follows every uninherited timing point (BPM, offset, meter). Hit objects are ignored. You can choose the start position and playback speed, and set a timing offset for each song.
- **Rhythms:** quarters, halves, 8ths, off-beats, triplets, swing, 16ths, gallops, sextuplets, backbeat, son clave, or your own grid (for example `x..x..x.` in 16ths).
- **Feedback:** a scrolling note highway, an osu!-style hit-error meter, live accuracy / mean offset / consistency (σ and UR), a timing-over-time chart, and an end-of-session report broken down by subdivision and tempo.
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

Web MIDI works in Chrome, Edge and Opera (desktop and Android). Firefox supports it behind a site-permission prompt. Safari doesn't support Web MIDI, but you can still practice there with the keyboard (Space / F / J / D / K).

## How the timing works

- The `AudioContext` is the master clock. Music and clicks are scheduled on it with sample accuracy.
- MIDI and keyboard events carry `performance.now()` timestamps. `AudioContext.getOutputTimestamp()` maps those onto the audio timeline *as it is heard*, which corrects for the output latency the browser reports. The mapping is median-filtered every frame to remove jitter.
- Whatever latency is left (USB polling, the kit's own processing, Bluetooth, the browser under-reporting) is covered by the **latency compensation** value, which you measure with the calibration.
- Each hit is matched to the nearest expected note within ±150 ms, or half the gap to the neighbouring note if that's smaller. Hits within 35 ms of each other count as one stroke, so a kick + crash or a flam isn't penalised. Notes whose window passes without a hit count as misses.

## Project layout

```
index.html        markup
css/style.css     styles
js/main.js        app wiring, UI, session lifecycle
js/audio.js       AudioContext clock, music playback, metronome clicks
js/midi.js        Web MIDI input
js/zip.js         minimal .osz (zip) reader using DecompressionStream
js/osu.js         .osu parsing (metadata, red-line timing points)
js/timing.js      tempo sections, rhythm patterns, expected-note grid
js/scorer.js      hit matching, judgments, statistics
js/render.js      canvas views (timeline, error meter, charts)
js/calibration.js latency calibration
js/library.js     IndexedDB song storage
```

For debugging, `window.drumcoach` in the browser console exposes the audio engine, the MIDI input, the settings and the current session.
