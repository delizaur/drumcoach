// Minimal ZIP reader (stored + deflate entries) for .osz files, and writer (stored entries) for
// replays bundled with their song. Uses the browser's native DecompressionStream, so no library is needed.

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * @param {Blob} blob
 * @returns {Promise<Array<{name: string, size: number, bytes: () => Promise<Uint8Array>}>>}
 */
export async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The end-of-central-directory record sits at the end, followed by an optional comment (≤ 64 KiB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid .osz/.zip archive.');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('The archive is corrupt (bad central directory).');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory

    entries.push({
      name,
      size,
      async bytes() {
        if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`Corrupt entry: ${name}`);
        // Sizes in the local header may be zero (data descriptor), so use the central directory's.
        const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const data = buf.subarray(start, start + compSize);
        if (method === 0) return data.slice();
        if (method === 8) {
          const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        throw new Error(`Unsupported compression method ${method} for ${name}`);
      },
    });
  }
  return entries;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Packs files into a ZIP without compression (songs are already compressed audio).
 * @param {Array<{path: string, data: Uint8Array}>} files
 * @returns {Blob}
 */
export function writeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0, centralSize = 0;
  for (const { path, data } of files) {
    const name = enc.encode(path), crc = crc32(data);
    // the fields local and central headers share, from "version needed" on
    const common = (v, p) => {
      v.setUint16(p, 20, true);          // version needed
      v.setUint16(p + 2, 0x0800, true);  // flags: UTF-8 names
      v.setUint16(p + 4, 0, true);       // stored
      v.setUint16(p + 6, time, true);
      v.setUint16(p + 8, date, true);
      v.setUint32(p + 10, crc, true);
      v.setUint32(p + 14, data.length, true);
      v.setUint32(p + 18, data.length, true);
      v.setUint16(p + 22, name.length, true);
    };
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    common(local, 4);
    parts.push(local, name, data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, SIG_CENTRAL, true);
    c.setUint16(4, 20, true); // version made by
    common(c, 6);
    c.setUint32(42, offset, true);
    central.push(c, name);
    offset += 30 + name.length + data.length;
    centralSize += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_EOCD, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
