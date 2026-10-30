// Reader for .sng files, the single-file chart container used by Clone Hero and Chorus/Encore.
// Layout: "SNGPKG", version, a 16-byte XOR mask, then metadata (the song.ini keys), a file index and
// the masked file contents. The metadata comes back as a synthesized song.ini entry.

/**
 * @param {Blob} blob
 * @returns {Promise<Array<{name: string, size: number, bytes: () => Promise<Uint8Array>}>>}
 */
export async function readSng(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const decoder = new TextDecoder();
  if (decoder.decode(buf.subarray(0, 6)) !== 'SNGPKG') throw new Error('This file is not a valid .sng chart.');
  const mask = buf.subarray(10, 26);
  const u64 = p => Number(view.getBigUint64(p, true));

  let p = 26;
  const metaEnd = p + 8 + u64(p);
  const ini = ['[song]'];
  p += 16;
  while (p < metaEnd) {
    const kLen = view.getInt32(p, true), key = decoder.decode(buf.subarray(p + 4, p + 4 + kLen));
    p += 4 + kLen;
    const vLen = view.getInt32(p, true), value = decoder.decode(buf.subarray(p + 4, p + 4 + vLen));
    p += 4 + vLen;
    ini.push(`${key} = ${value.replace(/[\r\n]+/g, ' ')}`);
  }

  p = metaEnd;
  const count = u64(p + 8);
  p += 16;
  const entries = [];
  for (let n = 0; n < count; n++) {
    const nameLen = buf[p], name = decoder.decode(buf.subarray(p + 1, p + 1 + nameLen));
    p += 1 + nameLen;
    const size = u64(p), offset = u64(p + 8);
    p += 16;
    if (offset + size > buf.length) throw new Error('The .sng file is truncated.');
    entries.push({
      name,
      size,
      async bytes() {
        const out = buf.slice(offset, offset + size);
        for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 15] ^ (i & 0xff);
        return out;
      },
    });
  }
  const text = new TextEncoder().encode(ini.join('\n'));
  entries.push({ name: 'song.ini', size: text.length, bytes: async () => text });
  return entries;
}
