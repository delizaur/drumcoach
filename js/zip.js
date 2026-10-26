// Minimal ZIP reader (stored + deflate entries) for .osz files.
// Uses the browser's native DecompressionStream, so no library is needed.

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
