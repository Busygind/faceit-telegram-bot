import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCloudRuntime } from '../bot/webhook.mjs';
import { SQL_SCHEMA } from '../bot/core/store.js';
import { REPORT_CACHE_SCHEMA } from '../bot/report-cache.mjs';
const CHAT = -1004393474895;
function database(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  for (const statement of [...SQL_SCHEMA, ...REPORT_CACHE_SCHEMA]) sql.exec(statement);
  return { sql, binding: { prepare(query) {
    const stmt = sql.prepare(query);
    const bound = (values = []) => ({ bind(...args) { return bound(args); },
      async first() { return stmt.get(...values) ?? null; },
      async all() { return { results: stmt.all(...values) }; },
      async run() { const result = stmt.run(...values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    }); return bound();
  } } };
}
function fixture(kind) {
  const now = Math.floor(Date.now() / 1000);
  const match = (id, time) => ({ match_id: id, game_id: 'cs2', game: 'cs2', status: 'FINISHED', finished_at: time, best_of: 1,
    teams: { faction1: { faction_id: 'a', name: 'Own', roster: [{ player_id: 'p', nickname: 'Player' }] },
      faction2: { faction_id: 'b', name: 'Other', roster: [{ player_id: 'q', nickname: 'Other' }] } },
    results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } } });
  return { elo: 1710, matches: Array.from({ length: kind === 'last' ? 1 : 30 }, (_, i) => match(`fixture-${i}`, now - 1000 - i * 86400)),
    addMatch() { this.matches.unshift(match('new-fixture', now - 100)); } };
}
function transport(data, counters) {
  return async (url, options = {}) => {
    const target = new URL(url);
    assert.equal(options.redirect, 'manual');
    if (target.origin === 'https://api.telegram.org') {
      const method = target.pathname.split('/').at(-1);
      if (method === 'getMe') return Response.json({ ok: true, result: { is_bot: true, id: 999, username: 'road_to_3_elo_bot' } });
      if (method === 'getChatMember') return Response.json({ ok: true, result: { status: 'administrator' } });
      assert.equal(method, 'sendPhoto');
      if (options.body instanceof FormData) { counters.uploads++; assert.equal(options.body.get('caption'), null); }
      else { counters.reuses++; const body = JSON.parse(options.body); assert.equal(body.photo, 'large_fixture'); assert.equal(body.caption, undefined); }
      return Response.json({ ok: true, result: { message_id: 100 + counters.uploads + counters.reuses,
        photo: [{ file_id: 'small_fixture', width: 100, height: 100 }, { file_id: 'large_fixture', width: 864, height: 1360 }] } });
    }
    assert.equal(target.origin, 'https://open.faceit.com'); counters.faceit++;
    if (target.pathname.endsWith('/players')) return Response.json({ player_id: 'p', nickname: 'Player', games: { cs2: { faceit_elo: data.elo, skill_level: 8 } } });
    if (target.pathname.endsWith('/history')) { const from = Number(target.searchParams.get('from')); return Response.json({ items: data.matches.filter(m => m.finished_at >= from) }); }
    counters.matchReads++;
    const match = data.matches.find(m => target.pathname.includes(`/matches/${m.match_id}`)); assert.ok(match);
    if (!target.pathname.endsWith('/stats')) return Response.json(match);
    return Response.json({ rounds: [{ match_id: match.match_id, game_id: 'cs2', match_round: 1,
      round_stats: { Map: 'de_inferno', Rounds: '21', Winner: 'a' }, teams: [
        { team_id: 'a', team_stats: { 'Final Score': '13' }, players: [{ player_id: 'p', nickname: 'Player', player_stats: { Kills: '20', Deaths: '11', Assists: '5', Headshots: '5', 'Total Damage': '2100' } }] },
        { team_id: 'b', team_stats: { 'Final Score': '8' }, players: [{ player_id: 'q', nickname: 'Other', player_stats: { Kills: '11', Deaths: '20', Assists: '1' } }] },
      ] }] });
  };
}
for (const kind of ['last', 'stats']) test(`cloud ${kind} persists reports across cold runtimes and reuses Telegram file_id only after fresh history`, async t => {
  const { sql, binding } = database(t); const data = fixture(kind); const metrics = []; const events = [];
  const env = { BOT_TOKEN: `123456:${'fixture_'.repeat(4)}`, FACEIT_API_KEY: 'fixture-faceit-key-123456', TS_ENCRYPTION_KEY: '12'.repeat(32), WEBHOOK_SECRET: 'fixture_'.repeat(6), DB: binding };
  async function invoke(id) {
    const counts = { faceit: 0, matchReads: 0, uploads: 0, reuses: 0 };
    // A fresh raw fetch function and runtime deliberately eliminate the RAM L1.
    const run = createCloudRuntime({ ...env }, { fetch: transport(data, counts), onDiagnostic: () => {}, onMetrics: value => metrics.push(value), onCacheEvent: value => events.push(value) });
    await run({ update_id: id, message: { message_id: id, chat: { id: CHAT, type: 'supergroup' }, from: { id: 123, is_bot: false }, text: `/${kind} Player` } });
    return counts;
  }
  const cold = await invoke(1); assert.equal(cold.uploads, 1); assert.equal(cold.reuses, 0); assert.equal(cold.matchReads, kind === 'last' ? 2 : 60);
  const warm = await invoke(2); assert.equal(warm.faceit, 2); assert.equal(warm.matchReads, 0); assert.equal(warm.uploads, 0); assert.equal(warm.reuses, 1);
  assert.equal(metrics[1].renderCount, 0); assert.equal(metrics[1].photoFileReuses, 1); assert.equal(metrics[1].photoUploads, 0);
  assert.ok(metrics[1].databaseCalls < metrics[0].databaseCalls); assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM report_jobs').get().n, 1);
  assert.ok(events.some(value => value.event === 'hit' && value.kind === kind));
  data.addMatch(); const changed = await invoke(3); assert.equal(changed.reuses, 0); assert.equal(changed.uploads, 1); assert.ok(changed.matchReads > 0);
  data.elo++; const profileChanged = await invoke(4); assert.equal(profileChanged.reuses, 0); assert.equal(profileChanged.uploads, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind='photo' AND status='sent'").get().n, 4);
});
