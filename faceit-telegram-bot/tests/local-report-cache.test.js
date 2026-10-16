import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReportCache, REPORT_CACHE_SCHEMA } from '../local/report-cache.mjs';
import { openDatabase } from '../local/database.mjs';
import { buildReport } from '../tgcloud/lib/faceit.js';

const NOW = 1_800_000_000;
const BOT = 'fixture-bot-token-not-real';
const FACEIT = 'fixture-faceit-key-not-real';
const FILE_ID = 'AgACAgIAAxkBAA_fixture_file_id';
function adapter(sqlite) {
  return {
    async run(sql, params) { return params === undefined ? sqlite.prepare(sql).run() : sqlite.prepare(sql).run(params); },
    async get(sql, params) { return params === undefined ? sqlite.prepare(sql).get() : sqlite.prepare(sql).get(params); },
  };
}
function state(kind = 'stats', count = kind === 'last' ? 1 : 2) {
  const selected = Array.from({ length: count }, (_, index) => ({ match_id: `match-${index}`, finished_at: NOW - index - 1,
    status: 'FINISHED', game_id: 'cs2', teams: { faction1: { name: 'A', players: [{ nickname: 'Player', player_id: 'player-1' }] } },
    results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } } }));
  return { version: 1, kind, target: kind === 'last' ? 1 : 30, phase: 'done',
    profile: { playerId: 'player-1', nickname: 'Player', elo: 1710, level: 8 }, selected,
    matches: selected.map(item => ({ matchId: item.match_id, finishedAt: item.finished_at,
      result: 'W', expectedMaps: 0, maps: [], partial: false })) };
}
function memory(t, options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const sql of REPORT_CACHE_SCHEMA) sqlite.exec(sql);
  const db = adapter(sqlite);
  const events = [];
  let clock = NOW;
  const config = { db, botToken: BOT, faceitKey: FACEIT, now: () => clock, onEvent: event => events.push(event), ...options };
  return { sqlite, db, config, events, cache: createReportCache(config), tick: time => { clock = time; } };
}

test('report cache persists across instances and a private SQLite close/reopen without retaining secret strings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-report-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.local-data'), { mode: 0o700 });
  const path = join(root, '.local-data/bot.sqlite');
  let database = await openDatabase(path);
  const s = state('last');
  const report = buildReport(s, NOW);
  const config = () => ({ db: database.db, botToken: BOT, faceitKey: FACEIT, now: () => NOW });
  try {
    await createReportCache(config()).put(s, report, FILE_ID);
    const first = await createReportCache(config()).get(s);
    assert.equal(first.fileId, FILE_ID);
    assert.deepEqual(first.report, report);
    assert.match(first.key, /^[a-f0-9]{64}$/);
    const rows = await database.db.all('SELECT * FROM report_cache');
    assert.ok(!JSON.stringify(rows).includes(BOT));
    assert.ok(!JSON.stringify(rows).includes(FACEIT));
    database.close();
    database = await openDatabase(path);
    assert.deepEqual(await createReportCache(config()).get(s), first);
  } finally { database.close(); }
});

test('fresh nickname, ELO, level, player, complete selected metadata/order, kind, token and renderer scope invalidate cache', async t => {
  const h = memory(t);
  const s = state();
  await h.cache.put(s, buildReport(s, NOW), FILE_ID);
  const edits = [
    value => { value.profile.nickname = 'Renamed'; }, value => { value.profile.elo++; }, value => { value.profile.level++; },
    value => { value.profile.playerId = 'player-2'; }, value => { value.selected[0].teams.faction1.name = 'Changed'; },
    value => { value.selected[0].results.score.faction1 = 2; }, value => { value.selected[0].finished_at--; },
    value => { value.selected[0].match_id = 'new-match'; }, value => { value.selected.reverse(); },
    value => { value.kind = 'last'; value.target = 1; value.selected = value.selected.slice(0, 1); },
  ];
  for (const edit of edits) {
    const fresh = structuredClone(s); edit(fresh);
    assert.equal(await h.cache.get(fresh), null);
  }
  for (const options of [{ botToken: 'different-token' }, { faceitKey: 'different-key' }, { rendererScope: 'faceit-dark-v2/core-schema-v1' }]) {
    assert.equal(await createReportCache({ ...h.config, ...options }).get(s), null);
  }
  const equivalent = structuredClone(s);
  equivalent.phase = 'details';
  equivalent.selected[0].results.score = { faction2: 0, faction1: 1 };
  assert.ok(await h.cache.get(equivalent));
});

test('complete TTL is anchored to updatedAt and never slides on hits or file_id saves', async t => {
  const h = memory(t);
  const s = state(); const report = buildReport(s, NOW);
  await h.cache.put(s, report);
  h.tick(NOW + 200);
  assert.ok(await h.cache.get(s));
  await h.cache.put(s, report, FILE_ID);
  const row = h.sqlite.prepare('SELECT * FROM report_cache').get();
  assert.equal(row.created_at, NOW);
  assert.equal(row.expires_at, NOW + 300);
  h.tick(NOW + 299); assert.ok(await h.cache.get(s));
  h.tick(NOW + 300); assert.equal(await h.cache.get(s), null);
  await h.cache.put(s, report, FILE_ID);
  assert.equal(h.sqlite.prepare('SELECT expires_at FROM report_cache').get().expires_at, NOW + 300);
  // get is SELECT-only: an expired row is not deleted by a cache read.
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM report_cache').get().n, 1);
});

test('partial statistics expire after 60 seconds and a fresh put with null clears the prior file_id', async t => {
  const h = memory(t);
  const s = state(); s.matches[0].partial = true;
  const report = buildReport(s, NOW);
  assert.equal(report.partial, true);
  await h.cache.put(s, report, FILE_ID);
  await h.cache.put(s, report, null);
  assert.equal((await h.cache.get(s)).fileId, null);
  h.tick(NOW + 59); assert.ok(await h.cache.get(s));
  h.tick(NOW + 60); assert.equal(await h.cache.get(s), null);
});

test('history, empty selection, invalid target/profile and unmatched report count or ordered IDs cannot be cached', async t => {
  const h = memory(t); const s = state(); const report = buildReport(s, NOW);
  for (const edit of [value => { value.phase = 'history'; }, value => { value.selected = []; }, value => { value.target = 29; },
    value => { delete value.profile.elo; }, value => { value.profile.level = NaN; }, value => { value.selected.push(value.selected[0]); }]) {
    const invalid = structuredClone(s); edit(invalid);
    assert.equal(await h.cache.get(invalid), null);
    await assert.rejects(h.cache.put(invalid, report), /REPORT_CACHE_INVALID/);
  }
  for (const edit of [value => { value.count--; }, value => { value.matches.reverse(); }, value => { value.nickname = 'wrong'; },
    value => { value.requested = 1; }, value => { value.updatedAt = NOW + 1; }, value => { value.stale = true; }]) {
    const invalid = structuredClone(report); edit(invalid);
    await assert.rejects(h.cache.put(s, invalid), /REPORT_CACHE_INVALID/);
  }
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM report_cache').get().n, 0);
});

test('corrupt JSON, identity, expiry, file_id and report coverage rows fail closed as a cache miss', async t => {
  const h = memory(t); const s = state(); const report = buildReport(s, NOW);
  const corrupt = [
    ['report_json', '{broken'], ['kind', 'other'], ['created_at', NOW + 1], ['expires_at', NOW + 301],
    ['file_id', 'https://secret.invalid/x'], ['report_json', JSON.stringify({ ...report, count: 1 })],
    ['report_json', JSON.stringify({ ...report, matches: report.matches.slice().reverse() })],
    ['report_json', JSON.stringify({ ...report, updatedAt: NOW + 1 })], ['report_json', 'x'.repeat(1024 * 1024 + 1)],
  ];
  for (const [column, value] of corrupt) {
    await h.cache.put(s, report, FILE_ID);
    h.sqlite.prepare(`UPDATE report_cache SET ${column}=?`).run(value);
    assert.equal(await h.cache.get(s), null);
  }
});

test('invalid file IDs, report size overflow and cyclic selected metadata are rejected safely', async t => {
  const h = memory(t); const s = state(); const report = buildReport(s, NOW);
  for (const fileId of ['', 'https://private.invalid', 'attach://photo', 'a'.repeat(1025), 'фото']) {
    await assert.rejects(h.cache.put(s, report, fileId), /REPORT_CACHE_INVALID/);
  }
  await assert.rejects(h.cache.put(s, { ...report, padding: 'x'.repeat(1024 * 1024) }), /REPORT_CACHE_INVALID/);
  const cycle = structuredClone(s); cycle.selected[0].cycle = cycle.selected;
  assert.equal(await h.cache.get(cycle), null);
  await assert.rejects(h.cache.put(cycle, report), /REPORT_CACHE_INVALID/);
});

test('one write prunes expired rows and caps persistent storage at 256 oldest-first entries', async t => {
  const h = memory(t);
  for (let index = 0; index < 260; index++) {
    const s = state('last'); s.profile.playerId = `player-${index}`;
    await h.cache.put(s, buildReport(s, NOW));
  }
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM report_cache').get().n, 256);
  h.tick(NOW + 301);
  const fresh = state('last'); fresh.profile.playerId = 'new-player';
  await h.cache.put(fresh, buildReport(fresh, NOW + 301));
  assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM report_cache').get().n, 1);
  assert.ok(await h.cache.get(fresh));
});

test('cache events contain only allowed tags/age and storage failures never leak raw exception material', async t => {
  const h = memory(t); const s = state();
  await h.cache.get(s); await h.cache.put(s, buildReport(s, NOW)); await h.cache.get(s);
  assert.deepEqual(h.events, [{ event: 'miss', kind: 'stats' }, { event: 'write', kind: 'stats' }, { event: 'hit', kind: 'stats', ageSeconds: 0 }]);
  assert.ok(!JSON.stringify(h.events).includes('Player'));
  for (const action of ['get', 'put']) {
    const failed = createReportCache({ ...h.config, db: { get: async () => { throw new Error(BOT); }, run: async () => { throw new Error(FACEIT); } } });
    await assert.rejects(failed[action](s, buildReport(s, NOW)), error => {
      assert.ok(/^REPORT_CACHE_(?:READ|WRITE)_FAILED$/.test(error.message));
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(BOT));
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(FACEIT));
      return true;
    });
  }
});

test('a database read crossing the expiration boundary does not serve an already-expired report', async t => {
  const h = memory(t);
  const s = state();
  await h.cache.put(s, buildReport(s, NOW), FILE_ID);
  h.tick(NOW + 299);
  const delayed = createReportCache({ ...h.config, db: { ...h.db, async get(...args) {
    const row = await h.db.get(...args);
    h.tick(NOW + 300);
    return row;
  } } });
  assert.equal(await delayed.get(s), null);
  assert.deepEqual(h.events.at(-1), { event: 'miss', kind: 'stats' });
});
