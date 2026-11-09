import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { getLevelBadge, LEVEL_BADGE_SIZE } from '../tgcloud/lib/faceit-levels.js';
import { renderPlayerCard, renderMatchCard } from '../tgcloud/lib/card.js';
import { DEMO_REPORT, DEMO_LAST_REPORT } from '../scripts/render-demo.mjs';
import { buildLevelBadgeModule, decodeBadgePng, resizeBadge } from '../scripts/prepare-level-badges.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const dark = [19, 19, 24];
const invalidLevels = [undefined, null, NaN, Infinity, -1, 0, 11, 1.5, '8', true, {}, Symbol('level')];

function parseRgb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  assert.deepEqual([...bytes.subarray(24, 29)], [8, 2, 0, 0, 0]);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 3 + 1;
  assert.equal(raw.length, stride * height);
  const badgeX = width - 48 - LEVEL_BADGE_SIZE;
  const badgeHash = createHash('sha256');
  const restHash = createHash('sha256');
  for (let y = 0; y < height; y++) {
    const start = y * stride;
    assert.equal(raw[start], 0);
    if (y >= 112 && y < 112 + LEVEL_BADGE_SIZE) {
      const left = start + 1 + badgeX * 3;
      const right = left + LEVEL_BADGE_SIZE * 3;
      restHash.update(raw.subarray(start, left));
      badgeHash.update(raw.subarray(left, right));
      restHash.update(raw.subarray(right, start + stride));
    } else restHash.update(raw.subarray(start, start + stride));
  }
  const pixel = (x, y) => [...raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)];
  return { width, height, badgeX, pixel, badge: badgeHash.digest('hex'), rest: restHash.digest('hex') };
}

test('all ten original transparent PNGs match their pinned provenance and deterministic offline atlas', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/faceit-levels/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.assets.map(entry => entry.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const originals = new Set();
  for (const entry of manifest.assets) {
    const bytes = await readFile(new URL(`../assets/faceit-levels/${entry.file}`, import.meta.url));
    assert.equal(digest(bytes), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    const source = decodeBadgePng(bytes);
    assert.equal(source.width, entry.width); assert.equal(source.height, entry.height);
    const alphas = source.pixels.filter((_, index) => index % 4 === 3);
    assert.ok(alphas.some(alpha => alpha === 0)); assert.ok(alphas.some(alpha => alpha === 255));
    for (const [x, y] of [[0, 0], [source.width - 1, 0], [0, source.height - 1], [source.width - 1, source.height - 1]]) {
      assert.equal(source.pixels[(y * source.width + x) * 4 + 3], 0);
    }
    originals.add(digest(bytes));
  }
  assert.equal(originals.size, 10);
  assert.equal(await buildLevelBadgeModule(), await readFile(new URL('../tgcloud/lib/faceit-levels.js', import.meta.url), 'utf8'));
});

test('prebaked RGBA levels are unique, transparent, and retain one bounded decoded image per valid level', () => {
  const unique = new Set();
  let retainedBytes = 0;
  for (let level = 1; level <= 10; level++) {
    const badge = getLevelBadge(level);
    assert.equal(badge.width, 88); assert.equal(badge.height, 88);
    assert.ok(badge.pixels instanceof Uint8Array); assert.equal(Buffer.isBuffer(badge.pixels), false);
    assert.equal(badge.pixels.length, 88 * 88 * 4);
    assert.ok(Object.isFrozen(badge));
    const before = digest(badge.pixels);
    for (let repeat = 0; repeat < 10; repeat++) assert.equal(getLevelBadge(level), badge);
    assert.equal(digest(badge.pixels), before);
    for (const [x, y] of [[0, 0], [87, 0], [0, 87], [87, 87]]) assert.equal(badge.pixels[(y * 88 + x) * 4 + 3], 0);
    unique.add(before); retainedBytes += badge.pixels.byteLength;
  }
  assert.equal(unique.size, 10);
  assert.equal(retainedBytes, 309760);
  for (const value of invalidLevels) assert.equal(getLevelBadge(value), null);
});

test('build-time scaling preserves color through translucent edges instead of mixing a white background', () => {
  const source = { width: 2, height: 1, pixels: new Uint8Array([255, 107, 43, 255, 255, 255, 255, 0]) };
  const before = source.pixels.slice();
  const scaled = resizeBadge(source, 4);
  assert.deepEqual(source.pixels, before);
  assert.ok(scaled.pixels.some((value, index) => index % 4 === 3 && value > 0 && value < 255));
  for (let offset = 0; offset < scaled.pixels.length; offset += 4) {
    if (scaled.pixels[offset + 3]) assert.deepEqual([...scaled.pixels.subarray(offset, offset + 3)], [255, 107, 43]);
    else assert.deepEqual([...scaled.pixels.subarray(offset, offset + 3)], [0, 0, 0]);
  }
});

test('build-time PNG reader rejects altered/corrupt source bytes rather than silently changing the atlas', async () => {
  const source = await readFile(new URL('../assets/faceit-levels/level-1.png', import.meta.url));
  const corrupted = source.slice(); corrupted[46] ^= 1;
  assert.throws(() => decodeBadgePng(corrupted), /LEVEL_BADGE_PNG_INVALID/);
  assert.throws(() => decodeBadgePng(source.subarray(0, source.length - 1)), /LEVEL_BADGE_PNG_INVALID/);
  assert.throws(() => decodeBadgePng(new Uint8Array(20)), /LEVEL_BADGE_PNG_INVALID/);
});

for (const [kind, render, demo, width] of [
  ['stats', renderPlayerCard, DEMO_REPORT, 864],
  ['last', renderMatchCard, DEMO_LAST_REPORT, 1200],
]) {
  test(`${kind} draws all ten badges on Dark, changes only the badge region, and does not mutate report or cached pixels`, () => {
    const unique = new Set();
    let outside;
    for (let level = 1; level <= 10; level++) {
      const report = { ...structuredClone(demo), level };
      const original = structuredClone(report);
      const assetBefore = digest(getLevelBadge(level).pixels);
      const bytes = render(report);
      assert.ok(bytes.length < 10_000_000);
      const image = parseRgb(bytes);
      assert.equal(image.width, width); assert.equal(image.height, 1360);
      if (outside === undefined) outside = image.rest;
      else assert.equal(image.rest, outside);
      unique.add(image.badge);
      for (const [x, y] of [[0, 0], [87, 0], [0, 87], [87, 87]]) assert.deepEqual(image.pixel(image.badgeX + x, 112 + y), dark);
      assert.deepEqual(report, original);
      assert.equal(digest(getLevelBadge(level).pixels), assetBefore);
    }
    assert.equal(unique.size, 10);
    assert.equal(digest(render(demo)), digest(render(structuredClone(demo))));
  });

  test(`${kind} unknown levels use one neutral fallback, not an existing FACEIT rank`, () => {
    const missing = parseRgb(render({ ...demo, level: null }));
    for (const level of ['8', 0, 11]) {
      const unknown = parseRgb(render({ ...demo, level }));
      assert.equal(unknown.badge, missing.badge);
      assert.equal(unknown.rest, missing.rest);
    }
    assert.notEqual(missing.badge, parseRgb(render({ ...demo, level: 1 })).badge);
    assert.notEqual(missing.badge, parseRgb(render({ ...demo, level: 10 })).badge);
  });
}
