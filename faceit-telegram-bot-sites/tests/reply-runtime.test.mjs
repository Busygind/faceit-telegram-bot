import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCloudRuntime } from '../bot/webhook.mjs';
import { SQL_SCHEMA } from '../bot/core/store.js';
import { REPORT_CACHE_SCHEMA } from '../bot/report-cache.mjs';

const NOW = 1_800_000_000;
const CHAT = -1001234567890;

function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const statement of [...SQL_SCHEMA, ...REPORT_CACHE_SCHEMA]) sql.exec(statement);
  const DB = { prepare(query) {
    const statement = sql.prepare(query);
    const bound = (values = []) => ({ bind(...args) { return bound(args); },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { const result = statement.run(...values); return { meta: { changes: Number(result.changes) } }; },
    });
    return bound();
  } };
  const env = { BOT_TOKEN: `123456:${'synthetic_'.repeat(4)}`, FACEIT_API_KEY: 'synthetic-reply-runtime-key',
    TS_ENCRYPTION_KEY: '12'.repeat(32), WEBHOOK_SECRET: 'synthetic_'.repeat(5), DB };
  const match = { match_id: 'fixture-match', game_id: 'cs2', game: 'cs2', status: 'FINISHED', finished_at: NOW - 1000,
    best_of: 1, teams: { faction1: { faction_id: 'a', name: 'Own', roster: [{ player_id: 'p', nickname: 'Player' }] },
      faction2: { faction_id: 'b', name: 'Other', roster: [{ player_id: 'q', nickname: 'Other' }] } },
    results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } } };
  const calls = [];
  let clock = NOW;
  let nextUpdate = 0;
  let nextMessage = 1000;
  const controls = { historyRateLimited: 0, deleteDenied: false };
  async function invoke(text, { updateId = ++nextUpdate, messageId = updateId, callback = null,
    topicId = 77, chatId = CHAT, at = clock, messageFields = {} } = {}) {
    clock = at;
    const message = { message_id: messageId, chat: { id: chatId, type: 'supergroup' }, from: { id: 123, is_bot: false },
      ...(topicId == null ? {} : { message_thread_id: topicId }), text, ...messageFields };
    const fetch = async (url, options) => {
      assert.equal(options.redirect, 'manual');
      const target = new URL(url);
      if (target.origin === 'https://api.telegram.org') {
        const method = target.pathname.split('/').at(-1);
        const multipart = options.body instanceof FormData;
        const params = multipart ? Object.fromEntries([...options.body.entries()].map(([key, value]) => {
          if (['reply_parameters', 'reply_markup'].includes(key)) return [key, JSON.parse(value)];
          if (['chat_id', 'message_thread_id'].includes(key)) return [key, Number(value)];
          return [key, value];
        })) : JSON.parse(options.body);
        calls.push({ method, params, multipart });
        let result;
        if (method === 'getMe') result = { id: 999, is_bot: true, username: 'road_to_3_elo_bot' };
        else if (method === 'getChatMember') result = { status: 'administrator' };
        else if (method === 'sendPhoto') result = { message_id: ++nextMessage,
          photo: [{ file_id: 'large_synthetic_report', width: 864, height: 1360 }] };
        else if (method === 'deleteMessage' && controls.deleteDenied) {
          return Response.json({ ok: false, error_code: 400, description: 'Bad Request: not enough rights to delete a message' }, { status: 400 });
        } else if (['sendMessage', 'deleteMessage', 'answerCallbackQuery', 'setMyCommands'].includes(method)) result = { message_id: ++nextMessage };
        else assert.fail(`Unexpected Telegram method ${method}`);
        return Response.json({ ok: true, result });
      }
      assert.equal(target.origin, 'https://open.faceit.com');
      if (target.pathname.endsWith('/history')) {
        if (controls.historyRateLimited > 0) {
          controls.historyRateLimited--;
          return Response.json({ error: 'synthetic rate limit' }, { status: 429, headers: { 'retry-after': '120' } });
        }
        return Response.json({ items: match.finished_at >= Number(target.searchParams.get('from')) ? [match] : [] });
      }
      if (target.pathname.endsWith('/players') || target.pathname.endsWith('/players/p')) {
        return Response.json({ player_id: 'p', nickname: 'Player', games: { cs2: { faceit_elo: 1710, skill_level: 8 } } });
      }
      assert.ok(target.pathname.includes('/matches/fixture-match'));
      if (!target.pathname.endsWith('/stats')) return Response.json(match);
      return Response.json({ rounds: [{ match_id: match.match_id, game_id: 'cs2', match_round: 1,
        round_stats: { Map: 'de_inferno', Rounds: '21', Winner: 'a' }, teams: [
          { team_id: 'a', team_stats: { 'Final Score': '13' }, players: [{ player_id: 'p', nickname: 'Player',
            player_stats: { Kills: '20', Deaths: '11', Assists: '5', Headshots: '5', 'Total Damage': '2100' } }] },
          { team_id: 'b', team_stats: { 'Final Score': '8' }, players: [{ player_id: 'q', nickname: 'Other',
            player_stats: { Kills: '11', Deaths: '20', Assists: '1' } }] },
        ] }] });
    };
    // Fresh fetch/runtime emulates a cold cloud invocation with only D1 shared.
    const runtime = createCloudRuntime({ ...env }, { fetch, now: () => clock * 1000,
      onDiagnostic: () => {}, onMetrics: () => {}, onCacheEvent: () => {} });
    const payload = callback ? { update_id: updateId, callback_query: { id: `callback-${updateId}`, data: callback,
      from: message.from, message: { ...message, from: { id: 999, is_bot: true } } } }
      : { update_id: updateId, message };
    await runtime(payload);
  }
  return { sql, calls, controls, invoke, callsFor: method => calls.filter(call => call.method === method) };
}

function assertReply(params, messageId, topicId = 77, chatId = CHAT) {
  assert.equal(params.chat_id, chatId);
  assert.deepEqual(params.reply_parameters, { message_id: messageId, allow_sending_without_reply: true });
  if (topicId == null) assert.equal(Object.hasOwn(params, 'message_thread_id'), false);
  else assert.equal(params.message_thread_id, topicId);
}

for (const kind of ['last', 'stats']) test(`cloud ${kind} replies to each command for both uploaded and cached image-only cards`, async t => {
  const f = fixture(t);
  await f.invoke(`/${kind} Player`, { messageId: 100 });
  await f.invoke(`/${kind} Player`, { messageId: 200 });
  const [uploaded, cached] = f.callsFor('sendPhoto');
  assert.ok(uploaded.multipart);
  assertReply(uploaded.params, 100);
  assert.ok(uploaded.params.photo instanceof File);
  assert.equal(uploaded.params.photo.type, 'image/png');
  assert.equal(cached.multipart, false, 'Telegram file_id reuse is JSON, but still needs the current reply anchor');
  assert.equal(cached.params.photo, 'large_synthetic_report');
  assertReply(cached.params, 200);
  assert.equal(f.callsFor('sendPhoto').length, 2);
  assert.equal(f.callsFor('sendMessage').length, 0);
  assert.equal(Object.hasOwn(uploaded.params, 'caption'), false);
  assert.equal(Object.hasOwn(cached.params, 'caption'), false);
});

test('cloud legacy continuation keeps the original command anchor after a final text timeout, without a new Continue button', async t => {
  const f = fixture(t);
  f.controls.historyRateLimited = 1;
  await f.invoke('/stats Player', { messageId: 321 });
  const refusal = f.callsFor('sendMessage')[0];
  assertReply(refusal.params, 321);
  assert.doesNotMatch(JSON.stringify(refusal.params), /continue:|Продолжить|Сохранила прогресс/);
  assert.equal(f.callsFor('sendPhoto').length, 0);
  const job = f.sql.prepare('SELECT job_id,state FROM report_jobs').get();
  assert.equal(JSON.parse(job.state).replyToMessageId, 321);
  const legacyCallback = `continue:${job.job_id}`;
  await f.invoke('', { messageId: 9999, callback: legacyCallback, at: NOW + 121 });
  const completed = f.callsFor('sendPhoto').at(-1);
  assert.equal(f.callsFor('sendPhoto').length, 1);
  assertReply(completed.params, 321, 77);
  assert.equal(f.callsFor('sendMessage').length, 1);
  assert.equal(f.callsFor('answerCallbackQuery').length, 1);
});

test('cloud menu and TeamSpeak text responses use replies without quoting a deleted password command', async t => {
  const f = fixture(t);
  await f.invoke('/menu', { messageId: 10 });
  assertReply(f.callsFor('sendMessage').at(-1).params, 10);
  await f.invoke('/ts', { messageId: 11 });
  assertReply(f.callsFor('sendMessage').at(-1).params, 11);
  await f.invoke('/setts voice.example.test synthetic-password', { messageId: 12 });
  assert.deepEqual(f.callsFor('deleteMessage').at(-1).params, { chat_id: CHAT, message_id: 12 });
  const configured = f.callsFor('sendMessage').at(-1).params;
  assert.match(configured.text, /обновлён/);
  assert.equal(Object.hasOwn(configured, 'reply_parameters'), false, 'password command is deleted, so its confirmation must not quote it');
  assert.equal(configured.message_thread_id, 77);
  await f.invoke('/ts', { messageId: 13 });
  const shown = f.callsFor('sendMessage').at(-1).params;
  assertReply(shown, 13);
  assert.match(shown.text, /Адрес: voice\.example\.test\n/);
  assert.match(shown.text, /synthetic-password/);
  await f.invoke('/ts', { messageId: 14, chatId: -200, topicId: null });
  const otherChat = f.callsFor('sendMessage').at(-1).params;
  assertReply(otherChat, 14, null, -200);
  assert.match(otherChat.text, /ещё не настроен/);
  assert.doesNotMatch(otherChat.text, /synthetic-password/);
});

test('cloud callbacks reply to their visible menu, while failed TeamSpeak command deletion is explicitly reported', async t => {
  const f = fixture(t);
  await f.invoke('/setfaceit Player', { messageId: 100 });
  assertReply(f.callsFor('sendMessage').at(-1).params, 100);
  await f.invoke('', { callback: 'last', messageId: 700, topicId: 88 });
  assertReply(f.callsFor('sendPhoto').at(-1).params, 700, 88);
  f.controls.deleteDenied = true;
  await f.invoke('/setts 192.0.2.10 synthetic-other-password', { messageId: 800 });
  const warning = f.callsFor('sendMessage').at(-1).params;
  assertReply(warning, 800);
  assert.match(warning.text, /удалите её вручную/);
  assert.doesNotMatch(warning.text, /synthetic-other-password/);
});
