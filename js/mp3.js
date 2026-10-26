// MP3 decoder-delay compensation.
//
// osu! decodes audio with BASS. BASS always skips the MP3 decoder delay (529 samples) and, when the
// file has a Xing/Info header, the encoder delay too (from the LAME tag, or LAME's default of 576).
// Browsers only trim when the file carries LAME gapless info. For other files the decoded buffer
// starts a little later than in osu!, so the map's beats would come early. We work out how much
// the browser trimmed (by comparing the decoded length to the frame count) and shift the map by
// the difference.

const DECODER_DELAY = 529;
const DEFAULT_ENCODER_DELAY = 576;

const BITRATES = {
  // [MPEG-1 layer III, MPEG-2/2.5 layer III] in kbit/s
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseHeader(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3;       // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[i + 1] >> 1) & 3;         // 1 = layer III
  const brIndex = b[i + 2] >> 4;
  const srIndex = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = BITRATES[mpeg1 ? 1 : 2][brIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][srIndex];
  const padding = (b[i + 2] >> 1) & 1;
  const samples = mpeg1 ? 1152 : 576;
  const size = Math.floor((samples / 8) * bitrate / sampleRate) + padding;
  const mono = (b[i + 3] >> 6) === 3;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  return { sampleRate, samples, size, sideInfo };
}

function skipId3(b) {
  let i = 0;
  while (b.length >= i + 10 && b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x33) { // "ID3"
    const size = ((b[i + 6] & 127) << 21) | ((b[i + 7] & 127) << 14) | ((b[i + 8] & 127) << 7) | (b[i + 9] & 127);
    i += 10 + size + (b[i + 5] & 0x10 ? 10 : 0);
  }
  return i;
}

const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/** Frame count and header info of an MP3 file, or null if it doesn't look like one. */
export function mp3Info(b) {
  let i = skipId3(b);
  // find the first frame that is followed by another valid frame
  let first = null;
  for (; i < Math.min(b.length, i + 65536); i++) {
    const h = parseHeader(b, i);
    if (h && parseHeader(b, i + h.size)) { first = h; break; }
  }
  if (!first) return null;

  let header = null, gapless = null;
  const tagAt = i + 4 + first.sideInfo;
  const tag = ascii(b, tagAt, 4);
  if (tag === 'Xing' || tag === 'Info') {
    header = tag;
    // The LAME extension sits 120 bytes into the Xing tag; delay/padding are 12 bits each at +21.
    const lame = tagAt + 120;
    if (/^(LAME|Lavf|Lavc|GOGO)/.test(ascii(b, lame, 4))) {
      const x = lame + 21;
      gapless = { delay: (b[x] << 4) | (b[x + 1] >> 4), padding: ((b[x + 1] & 15) << 8) | b[x + 2] };
    }
  } else if (ascii(b, i + 36, 4) === 'VBRI') {
    header = 'VBRI';
  }

  // count audio frames (the Xing/Info/VBRI frame itself decodes to nothing)
  let frames = header ? -1 : 0;
  while (i < b.length) {
    const h = parseHeader(b, i);
    if (!h) {
      if (ascii(b, i, 3) === 'TAG' || ascii(b, i, 8) === 'APETAGEX') break;
      i++; // resync over garbage
      continue;
    }
    frames++;
    i += h.size;
  }
  return { sampleRate: first.sampleRate, samplesPerFrame: first.samples, frames, header, gapless };
}

/**
 * Milliseconds by which the browser-decoded audio runs late compared to osu! for this file.
 * Add it to the map's timing to line the two up. Returns 0 when unsure.
 */
export function decoderOffsetMs(bytes, decodedSeconds) {
  const info = mp3Info(bytes);
  if (!info || info.frames <= 0) return 0;
  const untrimmed = info.frames * info.samplesPerFrame;
  const decoded = decodedSeconds * info.sampleRate;
  const tolerance = info.sampleRate * 0.002 + 2; // decodeAudioData may resample

  const bassTrim = DECODER_DELAY + (info.gapless ? info.gapless.delay : info.header === 'Xing' || info.header === 'Info' ? DEFAULT_ENCODER_DELAY : 0);
  let browserTrim;
  if (info.gapless && Math.abs(decoded - (untrimmed - info.gapless.delay - info.gapless.padding)) <= tolerance) {
    browserTrim = info.gapless.delay + DECODER_DELAY;
  } else if (Math.abs(decoded - untrimmed) <= tolerance) {
    browserTrim = 0;
  } else {
    return 0; // the browser did something we can't identify; don't guess
  }
  return ((bassTrim - browserTrim) / info.sampleRate) * 1000;
}
