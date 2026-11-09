import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pollWindow, normalizePollFence } from '../tgcloud/lib/poll-window.js';

const seconds = (iso) => Date.parse(iso) / 1000;
function expectWindow(at, start, end) {
  assert.deepEqual(pollWindow(seconds(at)), { start: seconds(start), end: seconds(end) });
}

test('poll day starts exactly at 09:00 Moscow and ends at next 03:00', () => {
  expectWindow('2026-11-07T09:00:00+03:00', '2026-11-07T09:00:00+03:00', '2026-11-08T03:00:00+03:00');
  expectWindow('2026-11-08T02:59:59+03:00', '2026-11-07T09:00:00+03:00', '2026-11-08T03:00:00+03:00');
});

test('03:00 expires the previous poll and begins the separate early window', () => {
  expectWindow('2026-11-08T03:00:00+03:00', '2026-11-08T03:00:00+03:00', '2026-11-08T09:00:00+03:00');
  expectWindow('2026-11-08T08:59:59+03:00', '2026-11-08T03:00:00+03:00', '2026-11-08T09:00:00+03:00');
  expectWindow('2026-11-08T09:00:00+03:00', '2026-11-08T09:00:00+03:00', '2026-11-09T03:00:00+03:00');
});

test('Moscow midnight still belongs to the preceding day 09:00 window', () => {
  expectWindow('2026-11-08T00:00:00+03:00', '2026-11-07T09:00:00+03:00', '2026-11-08T03:00:00+03:00');
  expectWindow('2026-11-07T23:59:59+03:00', '2026-11-07T09:00:00+03:00', '2026-11-08T03:00:00+03:00');
});

test('a daytime poll keeps the same window after more than three hours', () => {
  const morning = pollWindow(seconds('2026-11-07T09:00:00+03:00'));
  for (const at of ['2026-11-07T13:00:00+03:00', '2026-11-07T23:00:00+03:00', '2026-11-08T02:00:00+03:00']) {
    assert.deepEqual(pollWindow(seconds(at)), morning);
  }
  assert.equal(morning.end - morning.start, 18 * 60 * 60);
  const early = pollWindow(seconds('2026-11-08T04:00:00+03:00'));
  assert.equal(early.end - early.start, 6 * 60 * 60);
});

test('poll windows cross month, year and leap-day boundaries', () => {
  for (const [at, start, end] of [
    ['2026-12-01T01:00:00+03:00', '2026-11-30T09:00:00+03:00', '2026-12-01T03:00:00+03:00'],
    ['2027-01-01T00:00:00+03:00', '2026-12-31T09:00:00+03:00', '2027-01-01T03:00:00+03:00'],
    ['2028-02-29T02:00:00+03:00', '2028-02-28T09:00:00+03:00', '2028-02-29T03:00:00+03:00'],
    ['2028-03-01T02:00:00+03:00', '2028-02-29T09:00:00+03:00', '2028-03-01T03:00:00+03:00'],
  ]) expectWindow(at, start, end);
});

test('poll windows support epoch fixtures and future dates without reading the clock', () => {
  assert.deepEqual(pollWindow(0), { start: 0, end: 21_600 });
  assert.deepEqual(pollWindow(1000), { start: 0, end: 21_600 });
  expectWindow('2100-01-01T09:00:00+03:00', '2100-01-01T09:00:00+03:00', '2100-01-02T03:00:00+03:00');
  const nearLimit = Number.MAX_SAFE_INTEGER - 86_400;
  const window = pollWindow(nearLimit);
  assert.ok(Number.isSafeInteger(window.start) && Number.isSafeInteger(window.end));
  assert.ok(window.start <= nearLimit && nearLimit < window.end);
});

test('host timezone does not affect Moscow window arithmetic', () => {
  const moduleUrl = new URL('../tgcloud/lib/poll-window.js', import.meta.url).href;
  const sample = seconds('2026-11-08T02:59:59+03:00');
  const source = `import { pollWindow } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(pollWindow(${sample})));`;
  for (const timezone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), pollWindow(sample));
  }
});

test('invalid epochs and unrepresentable window bounds fail closed', () => {
  for (const value of [undefined, null, '1000', true, {}, new Date(0), NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => pollWindow(value), RangeError);
  }
});

test('an empty poll fence remains empty', () => {
  assert.equal(normalizePollFence(0), 0);
});

test('legacy three-hour poll fences normalize to their original calendar window', () => {
  for (const [deadline, expected] of [
    ['2026-11-08T05:00:00+03:00', '2026-11-08T03:00:00+03:00'],
    ['2026-11-08T06:00:00+03:00', '2026-11-08T09:00:00+03:00'],
    ['2026-11-08T11:59:59+03:00', '2026-11-08T09:00:00+03:00'],
    ['2026-11-08T12:00:00+03:00', '2026-11-09T03:00:00+03:00'],
    ['2026-11-07T20:00:00+03:00', '2026-11-08T03:00:00+03:00'],
  ]) assert.equal(normalizePollFence(seconds(deadline)), seconds(expected));
});

test('calendar fences remain idempotent at both 03:00 and 09:00', () => {
  for (const end of ['2026-11-08T03:00:00+03:00', '2026-11-08T09:00:00+03:00', '2027-01-01T03:00:00+03:00', '2028-03-01T03:00:00+03:00']) {
    const deadline = seconds(end);
    assert.equal(normalizePollFence(deadline), deadline);
    assert.equal(normalizePollFence(normalizePollFence(deadline)), deadline);
  }
});

test('invalid or pre-epoch legacy fence anchors fail closed', () => {
  for (const value of [undefined, null, '0', -1, 0.5, NaN, Infinity, 1, 10_799, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizePollFence(value), RangeError);
  }
  assert.equal(normalizePollFence(10_800), 21_600);
  assert.ok(Number.isSafeInteger(normalizePollFence(Number.MAX_SAFE_INTEGER)));
});
