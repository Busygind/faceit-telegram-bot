// Development-only, deterministic prepacker for the original FACEIT RGBA PNGs.
// Uses only Node builtins. Runtime uses the generated RGBA data, never PNG/fetch.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BADGE_SIZE = 88;
const ROOT = new URL('../', import.meta.url);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => { throw new Error('LEVEL_BADGE_PNG_INVALID'); };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Bounded PNG8/RGBA/non-interlaced decoder for the checked-in build inputs. */
export function decodeBadgePng(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > 131072 || !bytes.subarray(0, 8).equals(signature)) invalid();
  let width, height, ended = false;
  const parts = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length || ended) invalid();
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13 || width !== undefined) invalid();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (width < 1 || height < 1 || width > 512 || height > 512
        || !data.subarray(8).equals(Buffer.from([8, 6, 0, 0, 0]))) invalid();
    } else if (type === 'IDAT') {
      if (width === undefined) invalid();
      parts.push(data);
    } else if (type === 'IEND') {
      if (length || !parts.length || offset + 12 !== bytes.length) invalid();
      ended = true;
    } else if (type[0] === type[0]?.toUpperCase()) invalid();
    offset += length + 12;
  }
  if (!ended || width === undefined) invalid();
  const stride = width * 4;
  const expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected });
  if (raw.length !== expected) invalid();
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) invalid();
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0;
      const up = y ? pixels[index - stride] : 0;
      const upperLeft = y && x >= 4 ? pixels[index - stride - 4] : 0;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      pixels[index] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, pixels };
}

/** Premultiplied-alpha bilinear scaling avoids white/black transparent halos. */
export function resizeBadge(source, size = BADGE_SIZE) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.max(0, Math.min(source.width - 1, (x + 0.5) * source.width / size - 0.5));
    const sy = Math.max(0, Math.min(source.height - 1, (y + 0.5) * source.height / size - 0.5));
    const ix = Math.floor(sx), iy = Math.floor(sy);
    const channels = [0, 0, 0];
    let alpha = 0;
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const offset = (Math.min(source.height - 1, iy + dy) * source.width + Math.min(source.width - 1, ix + dx)) * 4;
      const weight = (dx ? sx - ix : 1 - sx + ix) * (dy ? sy - iy : 1 - sy + iy);
      const contribution = source.pixels[offset + 3] * weight;
      alpha += contribution;
      for (let c = 0; c < 3; c++) channels[c] += source.pixels[offset + c] * contribution;
    }
    const offset = (y * size + x) * 4;
    pixels[offset + 3] = Math.round(alpha);
    if (pixels[offset + 3]) for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(channels[c] / alpha);
  }
  return { width: size, height: size, pixels };
}

function packPixels(pixels) {
  const packed = [];
  for (let index = 0; index < pixels.length;) {
    let run = 1;
    while (run < 255 && index + run * 4 < pixels.length
      && [0, 1, 2, 3].every(c => pixels[index + c] === pixels[index + run * 4 + c])) run++;
    packed.push(run, ...pixels.subarray(index, index + 4));
    index += run * 4;
  }
  return Buffer.from(packed).toString('base64');
}

export async function buildLevelBadgeModule(root = ROOT) {
  const folder = new URL('assets/faceit-levels/', root);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', folder), 'utf8'));
  if (manifest.assets?.length !== 10) throw new Error('LEVEL_BADGE_MANIFEST_INVALID');
  const encoded = {};
  for (let level = 1; level <= 10; level++) {
    const entry = manifest.assets[level - 1];
    if (entry.level !== level || entry.file !== `level-${level}.png`) throw new Error('LEVEL_BADGE_MANIFEST_INVALID');
    const bytes = await readFile(new URL(entry.file, folder));
    const source = decodeBadgePng(bytes);
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes
      || source.width !== entry.width || source.height !== entry.height) throw new Error('LEVEL_BADGE_SOURCE_CHANGED');
    encoded[level] = packPixels(resizeBadge(source).pixels);
  }
  return `// Generated by scripts/prepare-level-badges.mjs. Do not edit packed pixels.
// Official FACEIT artwork; provenance and original PNGs: assets/faceit-levels/.
// Portable runtime: bounded lazy cache (10 x 88 x 88 RGBA), no remote fetch/decode.
export const LEVEL_BADGE_SIZE = ${BADGE_SIZE};
const ENCODED = ${JSON.stringify(encoded)};
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const cache = new Array(11);

function decode(encoded) {
  const packed = new Uint8Array(encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0));
  let bits = 0, value = 0, position = 0;
  for (const character of encoded) {
    value = (value << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) { bits -= 8; packed[position++] = (value >>> bits) & 255; }
  }
  const pixels = new Uint8Array(LEVEL_BADGE_SIZE * LEVEL_BADGE_SIZE * 4);
  let output = 0;
  for (let index = 0; index < packed.length; index += 5) {
    const run = packed[index];
    if (!run || index + 5 > packed.length || output + run * 4 > pixels.length) throw new Error('LEVEL_BADGE_DATA_INVALID');
    for (let repeat = 0; repeat < run; repeat++) {
      for (let channel = 0; channel < 4; channel++) pixels[output++] = packed[index + 1 + channel];
    }
  }
  if (output !== pixels.length) throw new Error('LEVEL_BADGE_DATA_INVALID');
  return Object.freeze({ width: LEVEL_BADGE_SIZE, height: LEVEL_BADGE_SIZE, pixels });
}

/** Internal borrowed, read-only pixels. Each valid level is decoded at most once. */
export function getLevelBadge(level) {
  if (!Number.isInteger(level) || level < 1 || level > 10) return null;
  if (!cache[level]) cache[level] = decode(ENCODED[level]);
  return cache[level];
}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL('tgcloud/lib/faceit-levels.js', ROOT);
  const module = await buildLevelBadgeModule();
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== module) throw new Error('LEVEL_BADGE_MODULE_OUTDATED');
    console.log('Checked 10 original FACEIT badges and deterministic portable atlas.');
  } else {
    await writeFile(target, module);
    console.log(`Prepared 10 transparent ${BADGE_SIZE}x${BADGE_SIZE} badges: ${fileURLToPath(target)} (${Buffer.byteLength(module)} bytes).`);
  }
}
