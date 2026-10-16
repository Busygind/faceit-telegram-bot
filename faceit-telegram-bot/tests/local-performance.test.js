import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { compressPng } from '../local/png.mjs';
import { createCachedFaceitFetch } from '../local/faceit-cache.mjs';
import { renderReportCard } from '../tgcloud/lib/card.js';
import { createFaceitService } from '../tgcloud/lib/faceit.js';
import { DEMO_REPORT, DEMO_LAST_REPORT } from '../scripts/render-demo.mjs';

const ORIGIN = 'https://open.faceit.com';
const path = (id, stats = false) => `${ORIGIN}/data/v4/matches/${id}${stats ? '/stats' : ''}`;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const finished = (id, extra = {}) => ({ match_id: id, status: 'FINISHED', ...extra });
const stats = (id) => ({ rounds: [{ match_id: id, teams: [{ team_id: 'synthetic-team' }] }] });
const request = { method: 'GET', headers: { Authorization: 'Bearer synthetic-fixture-not-real' } };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
  return bytes;
}
function parsePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  let header;
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), view.getUint32(offset + 8 + length));
    if (type === 'IHDR') header = data;
    if (type === 'IDAT') parts.push(data);
    offset += length + 12;
  }
  return { header, raw: inflateSync(Buffer.concat(parts)) };
}
function packPng(header, raw, middle = []) {
  return new Uint8Array(Buffer.concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...middle, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array()),
  ]));
}

for (const report of [DEMO_REPORT, DEMO_LAST_REPORT]) {
  test(`local ${report.kind} PNG shrinks losslessly, deterministically and without mutating the portable image`, () => {
    const original = renderReportCard(report);
    const snapshot = original.slice();
    const compressed = compressPng(original);
    assert.equal(Buffer.isBuffer(compressed), false);
    assert.ok(compressed instanceof Uint8Array);
    assert.ok(original.length > 3_000_000);
    assert.ok(compressed.length < 250_000);
    assert.ok(compressed.length < original.length / 10);
    assert.deepEqual(compressPng(original), compressed);
    const parsed = parsePng(compressed);
    const dimensions = new DataView(parsed.header.buffer, parsed.header.byteOffset, parsed.header.byteLength);
    assert.equal(dimensions.getUint32(0), report.kind === 'last' ? 1200 : 864);
    assert.equal(dimensions.getUint32(4), 1360);
    assert.deepEqual(parsed, parsePng(original));
    assert.deepEqual(original, snapshot);
  });
}

test('PNG compression rejects invalid signature, CRC, ordering, unknown chunks and trailing bytes', () => {
  const valid = renderReportCard(DEMO_REPORT);
  const { header, raw } = parsePng(valid);
  const badSignature = valid.slice(); badSignature[0] = 0;
  const badCrc = valid.slice(); badCrc[33] ^= 1;
  const unknown = packPng(header, raw, [chunk('tEXt', new Uint8Array([1]))]);
  const cases = [null, new Uint8Array(8), badSignature, badCrc, unknown,
    valid.subarray(0, valid.length - 12), new Uint8Array([...valid, 0]),
    new Uint8Array(Buffer.concat([valid.subarray(0, 8), chunk('IEND', new Uint8Array()), valid.subarray(8)]))];
  for (const bytes of cases) assert.throws(() => compressPng(bytes), /LOCAL_PNG_INVALID/);
});

test('PNG compression validates dimensions, format, decompressed bounds and scanline filters', () => {
  const { header, raw } = parsePng(renderReportCard(DEMO_REPORT));
  const tooWide = header.slice(); new DataView(tooWide.buffer).setUint32(0, 10001);
  assert.throws(() => compressPng(packPng(tooWide, raw)), /LOCAL_PNG_LIMIT/);
  const rawBomb = header.slice();
  new DataView(rawBomb.buffer).setUint32(0, 4000); new DataView(rawBomb.buffer).setUint32(4, 4000);
  assert.throws(() => compressPng(packPng(rawBomb, raw)), /LOCAL_PNG_LIMIT/);
  const wrongFormat = header.slice(); wrongFormat[9] = 6;
  assert.throws(() => compressPng(packPng(wrongFormat, raw)), /LOCAL_PNG_INVALID/);
  assert.throws(() => compressPng(packPng(header, raw.subarray(1))), /LOCAL_PNG_INVALID/);
  assert.throws(() => compressPng(packPng(header, Buffer.concat([raw, Buffer.from([0])]))), /LOCAL_PNG_INVALID/);
  const wrongFilter = raw.slice(); wrongFilter[0] = 5;
  assert.throws(() => compressPng(packPng(header, wrongFilter)), /LOCAL_PNG_INVALID/);
  assert.throws(() => compressPng(new Uint8Array(10_000_001)), /LOCAL_PNG_LIMIT/);
  // Filter bytes 1–4 are valid PNG even though our current renderer emits filter 0.
  const validFilters = raw.slice(); validFilters[0] = 4;
  assert.deepEqual(parsePng(compressPng(packPng(header, validFilters))).raw, validFilters);
});

test('PNG compression joins multiple consecutive IDAT chunks without changing pixels', () => {
  const { header, raw } = parsePng(renderReportCard(DEMO_REPORT));
  const encoded = deflateSync(raw);
  const half = Math.floor(encoded.length / 2);
  const split = new Uint8Array(Buffer.concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', encoded.subarray(0, half)), chunk('IDAT', encoded.subarray(half)), chunk('IEND', new Uint8Array()),
  ]));
  assert.deepEqual(parsePng(compressPng(split)).raw, raw);
});

test('finished match details and nonempty stats are cached with fresh immutable Response bodies and no headers', async () => {
  const calls = [];
  const cached = createCachedFaceitFetch({ fetch: async (url) => {
    calls.push(url);
    return json(url.endsWith('/stats') ? stats('match') : finished('match'), 200,
      { authorization: 'synthetic-private-response-header', 'set-cookie': 'synthetic-private-cookie' });
  } });
  const original = await cached(path('match'), request);
  assert.equal(original.headers.get('authorization'), 'synthetic-private-response-header');
  await original.json();
  const first = await cached(path('match'), request);
  const value = await first.json(); value.status = 'CORRUPTED';
  const second = await cached(path('match'), request);
  assert.equal((await second.json()).status, 'FINISHED');
  assert.equal(second.headers.get('authorization'), null);
  assert.equal(second.headers.get('set-cookie'), null);
  assert.notEqual(first, second);
  await (await cached(path('match', true), request)).json();
  await (await cached(path('match', true), request)).json();
  assert.deepEqual(calls, [path('match'), path('match', true)]);
});

test('cache TTL expires without stale fallback on network errors', async () => {
  let time = 0;
  let calls = 0;
  const failure = new Error('synthetic-network-failure');
  const cached = createCachedFaceitFetch({ now: () => time, ttlMs: 50, fetch: async () => {
    calls++;
    if (calls > 1) throw failure;
    return json(finished('match'));
  } });
  await cached(path('match'), request);
  time = 49;
  await cached(path('match'), request);
  assert.equal(calls, 1);
  time = 50;
  await assert.rejects(cached(path('match'), request), (error) => error === failure);
  await assert.rejects(cached(path('match'), request), (error) => error === failure);
  assert.equal(calls, 3);
});

test('profile, history, query URLs, non-GET methods and other origins always bypass match cache', async () => {
  const calls = [];
  const cached = createCachedFaceitFetch({ fetch: async (url) => { calls.push(url); return json(finished('match')); } });
  const cases = [
    [`${ORIGIN}/data/v4/players?nickname=PlayerOne`, request],
    [`${ORIGIN}/data/v4/players/player/history?game=cs2`, request],
    [`${path('match')}?extra=1`, request], [`${path('match')}#extra`, request],
    [path('match'), { ...request, method: 'POST' }],
    [path('match'), { ...request, body: 'synthetic-body' }],
    ['https://example.invalid/data/v4/matches/match', request],
  ];
  for (const [url, options] of cases) { await cached(url, options); await cached(url, options); }
  assert.equal(calls.length, cases.length * 2);
});

test('auth scopes never share cached bodies and aborted requests do not hit cache', async () => {
  let calls = 0;
  const cached = createCachedFaceitFetch({ fetch: async () => { calls++; return json(finished('match')); } });
  await cached(path('match'), request);
  const other = { ...request, headers: { authorization: 'Bearer other-synthetic-fixture' } };
  await cached(path('match'), other);
  await cached(path('match'), request);
  assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort('synthetic-sensitive-abort-reason');
  await assert.rejects(cached(path('match'), { ...request, signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(String(error).includes('sensitive'), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('errors, malformed JSON, mismatched IDs and unfinished details are never cached', async () => {
  const responses = [
    () => json({}, 401), () => json({}, 403), () => json({}, 404), () => json({}, 429), () => json({}, 500),
    () => new Response('{malformed', { status: 200 }),
    () => json(finished('other-match')), () => json(finished('match', { status: 'ONGOING' })),
    () => json(finished('match', { game: 'csgo' })),
  ];
  for (const response of responses) {
    let calls = 0;
    const cached = createCachedFaceitFetch({ fetch: async () => { calls++; return response(); } });
    await cached(path('match'), request); await cached(path('match'), request);
    assert.equal(calls, 2);
  }
});

test('stats require a live cached FINISHED detail and nonempty rounds', async () => {
  let calls = 0;
  let empty = true;
  let time = 0;
  const cached = createCachedFaceitFetch({ now: () => time, ttlMs: 100, fetch: async (url) => {
    calls++;
    return json(url.endsWith('/stats') ? empty ? { rounds: [] } : stats('match') : finished('match'));
  } });
  await cached(path('match', true), request); await cached(path('match', true), request);
  assert.equal(calls, 2);
  await cached(path('match'), request);
  await cached(path('match', true), request); await cached(path('match', true), request);
  assert.equal(calls, 5);
  empty = false;
  time = 50;
  await cached(path('match', true), request); await cached(path('match', true), request);
  assert.equal(calls, 6);
  time = 101; // Stats would still be fresh, but the FINISHED detail is no longer fresh.
  await cached(path('match', true), request);
  assert.equal(calls, 7);
});

test('pending, mismatched and unsuccessful statistics are never cached despite a known finished match', async () => {
  const responses = [
    () => json({}, 404), () => json({}, 429), () => json({ rounds: [] }),
    () => json({ rounds: [{}] }), () => json({ rounds: [{ match_id: 'match', teams: [] }] }),
    () => json(stats('other-match')),
  ];
  for (const response of responses) {
    let calls = 0;
    const cached = createCachedFaceitFetch({ fetch: async (url) => {
      calls++;
      return url.endsWith('/stats') ? response() : json(finished('match'));
    } });
    await cached(path('match'), request);
    await cached(path('match', true), request); await cached(path('match', true), request);
    assert.equal(calls, 3);
  }
});

test('cache evicts least recently used entries and enforces a total response-byte bound', async () => {
  const calls = [];
  const cached = createCachedFaceitFetch({ maxEntries: 2, fetch: async (url) => {
    calls.push(url); return json(finished(url.split('/').at(-1)));
  } });
  for (const id of ['a', 'b', 'a', 'c', 'a', 'b']) await cached(path(id), request);
  assert.deepEqual(calls.map((url) => url.split('/').at(-1)), ['a', 'b', 'c', 'b']);
  let bytesCalls = 0;
  const oneSize = new TextEncoder().encode(JSON.stringify(finished('a'))).length;
  const bounded = createCachedFaceitFetch({ maxBytes: oneSize * 2 - 1, fetch: async (url) => {
    bytesCalls++; return json(finished(url.split('/').at(-1)));
  } });
  for (const id of ['a', 'b', 'a']) await bounded(path(id), request);
  assert.equal(bytesCalls, 3);
  let oversizedCalls = 0;
  const oversized = createCachedFaceitFetch({ maxBytes: 20, fetch: async () => {
    oversizedCalls++; return json(finished('a', { payload: 'x'.repeat(100) }));
  } });
  assert.equal((await (await oversized(path('a'), request)).json()).status, 'FINISHED');
  await (await oversized(path('a'), request)).json();
  assert.equal(oversizedCalls, 2);
});

test('cache options reject unbounded configurations', () => {
  for (const options of [{ fetch: null }, { ttlMs: 0 }, { ttlMs: 300001 }, { maxEntries: 257 }, { maxEntries: 0 },
    { maxBytes: 0 }, { maxBytes: 16 * 1024 * 1024 + 1 }, { now: null }]) {
    assert.throws(() => createCachedFaceitFetch(options), /LOCAL_CACHE_OPTIONS/);
  }
});

test('repeated real FACEIT service reports refresh profile/history and include a newly finished latest match', async () => {
  const now = 1_800_000_000;
  const playerId = 'synthetic-player';
  const teams = {
    faction1: { faction_id: 'team-a', name: 'Alpha', roster: [{ player_id: playerId, nickname: 'PlayerOne' }] },
    faction2: { faction_id: 'team-b', name: 'Beta', roster: [{ player_id: 'opponent', nickname: 'Opponent' }] },
  };
  const history = (id, finishedAt) => ({ match_id: id, status: 'FINISHED', finished_at: finishedAt, game_id: 'cs2', teams,
    results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } } });
  const items = Array.from({ length: 30 }, (_, index) => history(`match-${index}`, now - 1000 - index * 86400));
  const calls = [];
  let elo = 1710;
  const fetch = async (url) => {
    const parsed = new URL(url); calls.push(parsed.pathname);
    if (parsed.pathname.endsWith('/players')) return json({ player_id: playerId, nickname: 'PlayerOne', games: { cs2: { faceit_elo: elo, skill_level: 8 } } });
    if (parsed.pathname.endsWith('/history')) return json({ items });
    const id = parsed.pathname.split('/')[4];
    const item = items.find((row) => row.match_id === id);
    assert.ok(item);
    if (parsed.pathname.endsWith('/stats')) return json({ rounds: [{
      match_id: id, match_round: 1, game_id: 'cs2', round_stats: { Map: 'de_mirage', Rounds: '23', Winner: 'team-a' },
      teams: [
        { team_id: 'team-a', team_stats: { 'Final Score': '13' }, players: [{ player_id: playerId, nickname: 'PlayerOne',
          player_stats: { Kills: '20', Deaths: '10', Assists: '5', Headshots: '10', 'Total Damage': '1840' } }] },
        { team_id: 'team-b', team_stats: { 'Final Score': '10' }, players: [{ player_id: 'opponent', nickname: 'Opponent',
          player_stats: { Kills: '10', Deaths: '20', Assists: '2', Headshots: '3', ADR: '50' } }] },
      ],
    }] });
    return json({ ...item, game: 'cs2', best_of: 1 });
  };
  const service = createFaceitService({ fetch: createCachedFaceitFetch({ fetch }), key: 'synthetic-fixture-api-key', now: () => now });
  const report = async () => {
    let state = await service.start('PlayerOne', 'stats');
    for (let iteration = 0; iteration < 100; iteration++) {
      const result = await service.advance(state, { maxRequests: 4 });
      assert.ok(result.state.requests - state.requests <= 4, 'Request budget remains intact on cached hits');
      if (result.done) return result.report;
      assert.equal(result.state.retryAt, null);
      state = JSON.parse(JSON.stringify(result.state));
    }
    assert.fail('Synthetic report did not finish');
  };
  const first = await report();
  assert.equal(first.count, 30); assert.equal(first.metrics.kd.value, 2);
  assert.equal(calls.length, 62);
  const second = await report();
  assert.equal(second.count, 30); assert.equal(calls.length, 64, 'Only profile and history are requested again');
  elo = 1735;
  items.unshift(history('brand-new-match', now - 10));
  const third = await report();
  assert.equal(calls.length, 68, 'Only fresh profile/history and two new match endpoints hit the network');
  assert.equal(third.elo, 1735);
  assert.equal(third.matches[0].matchId, 'brand-new-match');
  assert.equal(third.count, 30);
  assert.ok(!third.matches.some((match) => match.matchId === 'match-29'));
  assert.equal(calls.filter((value) => value.endsWith('/players')).length, 3);
  assert.equal(calls.filter((value) => value.endsWith('/history')).length, 3);
});
