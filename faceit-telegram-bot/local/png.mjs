import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 10_000_000;
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function invalid() { throw new Error('LOCAL_PNG_INVALID'); }
function limit() { throw new Error('LOCAL_PNG_LIMIT'); }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  view.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4)));
  return result;
}

/** Losslessly compress the portable renderer's RGB8 PNG; no pixel conversion. */
export function compressPng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 57) invalid();
  if (bytes.length > MAX_PNG_BYTES) limit();
  if (!SIGNATURE.every((value, index) => bytes[index] === value)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header;
  let width;
  let height;
  let ended = false;
  const idats = [];
  let idatLength = 0;
  let chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > 2048) limit();
    if (offset + 12 > bytes.length || ended) invalid();
    const length = view.getUint32(offset);
    if (length > MAX_PNG_BYTES || offset + length + 12 > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) invalid();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (offset !== 8 || header || length !== 13) invalid();
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (!width || !height || width + height > 10000 || Math.max(width / height, height / width) > 20) limit();
      if ((width * 3 + 1) * height > MAX_RAW_BYTES) limit();
      if (data[8] !== 8 || data[9] !== 2 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) invalid();
      header = data.slice();
    } else if (type === 'IDAT') {
      if (!header) invalid();
      idats.push(data);
      idatLength += length;
    } else if (type === 'IEND') {
      if (!header || !idats.length || length !== 0) invalid();
      ended = true;
    } else invalid(); // Our renderer has no metadata, palette, animation or other chunks.
    offset += length + 12;
  }
  if (!ended) invalid();
  const encoded = new Uint8Array(idatLength);
  offset = 0;
  for (const part of idats) { encoded.set(part, offset); offset += part.length; }
  const expectedLength = (width * 3 + 1) * height;
  let raw;
  try { raw = inflateSync(encoded, { maxOutputLength: expectedLength }); } catch { invalid(); }
  if (raw.length !== expectedLength) invalid();
  for (let row = 0; row < height; row++) if (raw[row * (width * 3 + 1)] > 4) invalid();
  const compressed = deflateSync(raw, { level: 3 });
  const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  if (output.length > MAX_PNG_BYTES) limit();
  return output;
}
