import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCloudRuntime } from '../bot/webhook.mjs';
import { SQL_SCHEMA } from '../bot/core/store.js';
import { REPORT_CACHE_SCHEMA } from '../bot/report-cache.mjs';

test('cloud personal FACEIT survives cold invocations, uses the caller binding and preserves image-only reports', async t => {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  for (const statement of [...SQL_SCHEMA, ...REPORT_CACHE_SCHEMA]) sql.exec(statement);
  const DB = { prepare(query) {
    const stmt = sql.prepare(query);
    const bound = (values = []) => ({ bind(...args) { return bound(args); },
      async first() { return stmt.get(...values) ?? null; },
      async all() { return { results: stmt.all(...values) }; },
      async run() { const r = stmt.run(...values); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    }); return bound();
  } };
  const calls = []; const profiles = [];
  const env = { BOT_TOKEN: `123456:${'synthetic_'.repeat(4)}`, FACEIT_API_KEY: 'synthetic-personal-faceit-key',
    TS_ENCRYPTION_KEY: '12'.repeat(32), WEBHOOK_SECRET: 'synthetic_'.repeat(5), ALLOWED_CHAT_IDS: '[-10,-20]', DB };
  let update = 0;
  async function invoke(text, { userId = 1, chatId = -10, callback, messageFields = {} } = {}) {
    const id = ++update;
    const message = { message_id: id, chat: { id: chatId, type: 'supergroup' }, message_thread_id: 77,
      from: { id: userId, is_bot: false }, text, ...messageFields };
    const fetch = async (url, options) => {
      assert.equal(options.redirect, 'manual'); const target = new URL(url);
      if (target.origin === 'https://api.telegram.org') {
        const method = target.pathname.split('/').at(-1);
        const params = options.body instanceof FormData ? options.body : JSON.parse(options.body);
        calls.push({ method, params });
        const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'road_to_3_elo_bot' }
          : method === 'getChatMember' ? { status: 'member' } : { message_id: id + 100 };
        if (method === 'sendPhoto') { assert.equal(params.get('caption'), null); assert.equal(params.get('message_thread_id'), '77'); }
        return Response.json({ ok: true, result });
      }
      assert.equal(target.origin, 'https://open.faceit.com');
      if (target.pathname.endsWith('/history')) return Response.json({ items: [] });
      const explicit = target.searchParams.get('nickname'); const playerId = explicit ? `player-${explicit}` : target.pathname.split('/').at(-1);
      profiles.push({ explicit, playerId });
      return Response.json({ player_id: playerId, nickname: explicit ?? `Renamed-${playerId}`, games: { cs2: { faceit_elo: 1710, skill_level: 8 } } });
    };
    const runtime = createCloudRuntime({ ...env }, { fetch, onDiagnostic: () => {}, onMetrics: () => {}, onCacheEvent: () => {} });
    const payload = callback ? { update_id: id, callback_query: { id: `query-${id}`, data: callback, from: message.from,
      message: { ...message, from: { id: 999, is_bot: true } } } } : { update_id: id, message };
    await runtime(payload);
  }
  await invoke('/setfaceit Alpha');
  await invoke('/setfaceit Beta', { userId: 2 });
  assert.equal(profiles.length, 2); // One profile request per setting, no history/details.
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM player_links').get().n, 2);
  for (const [text, userId, expected] of [['/last', 1, 'player-Alpha'], ['/stats', 2, 'player-Beta']]) {
    const before = calls.length; await invoke(text, { userId });
    assert.equal(profiles.at(-1).playerId, expected); assert.equal(profiles.at(-1).explicit, null);
    assert.equal(calls.slice(before).filter(c => c.method === 'sendPhoto').length, 1);
    assert.equal(calls.slice(before).filter(c => c.method === 'sendMessage').length, 0);
  }
  await invoke('', { userId: 2, callback: 'hint:last' });
  assert.equal(profiles.at(-1).playerId, 'player-Beta'); // Clicker, never menu author/bot.
  const beforeMissing = profiles.length;
  await invoke('/last', { userId: 1, chatId: -20 });
  assert.equal(profiles.length, beforeMissing); // Other chat has no personal default.
  await invoke('/last Other', { userId: 1 });
  assert.equal(profiles.at(-1).explicit, 'Other');
  assert.equal(sql.prepare('SELECT nickname FROM player_links WHERE chat_id=-10 AND user_id=1').get().nickname, 'Alpha');
  await invoke('/unsetfaceit');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM player_links WHERE user_id=1').get().n, 0);
  const beforeDeleted = profiles.length; await invoke('/stats'); assert.equal(profiles.length, beforeDeleted);
  assert.equal(sql.prepare('SELECT nickname FROM player_links WHERE user_id=2').get().nickname, 'Beta');
});
