import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CLOUD_HANDLER_MS, CLOUD_WORK_MS, createCloudRuntime, createWebhook } from '../bot/webhook.mjs';
import { SQL_SCHEMA } from '../bot/core/store.js';
import { REPORT_CACHE_SCHEMA } from '../bot/report-cache.mjs';

const BASE = 1_800_000_000_000;
const CHAT = -1001234567890;
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { kind = 'last', initialDelay = 0, beforeFaceit } = {}) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const statement of [...SQL_SCHEMA, ...REPORT_CACHE_SCHEMA]) sql.exec(statement);
  const DB = { prepare(query) {
    const statement = sql.prepare(query);
    const bound = (values = []) => ({
      bind(...args) { return bound(args); },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { const result = statement.run(...values); return { meta: { changes: Number(result.changes) } }; },
    });
    return bound();
  } };
  let clock = BASE + initialDelay;
  let sequence = 0;
  const timers = new Map();
  const setTimer = (callback, milliseconds) => {
    const id = ++sequence;
    timers.set(id, { callback, at: clock + milliseconds, milliseconds });
    return id;
  };
  const clearTimer = id => timers.delete(id);
  const tick = milliseconds => {
    clock += milliseconds;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= clock && timers.delete(id)) timer.callback();
    }
  };
  const env = { BOT_TOKEN: `123456:${'synthetic_'.repeat(4)}`, FACEIT_API_KEY: 'synthetic-wait-runtime-key',
    TS_ENCRYPTION_KEY: '12'.repeat(32), WEBHOOK_SECRET: 'synthetic_'.repeat(5), DB };
  const methods = [];
  const reads = [];
  const metrics = [];
  const diagnostics = [];
  const matches = Array.from({ length: kind === 'stats' ? 30 : 1 }, (_, index) => ({
    match_id: `wait-match-${index}`, game_id: 'cs2', game: 'cs2', status: 'FINISHED', finished_at: BASE / 1000 - 1000 - index * 86400,
    best_of: 1, teams: {
      faction1: { faction_id: 'own', name: 'Own', roster: [{ player_id: 'player', nickname: 'Player' }] },
      faction2: { faction_id: 'other', name: 'Other', roster: [{ player_id: 'other', nickname: 'Other' }] },
    }, results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } },
  }));
  const fetch = async (url, options) => {
    const target = new URL(url);
    assert.equal(options.redirect, 'manual');
    if (target.origin === 'https://api.telegram.org') {
      const method = target.pathname.split('/').at(-1);
      const params = options.body instanceof FormData ? options.body : JSON.parse(options.body);
      methods.push({ method, params, started: clock, signalWasAborted: options.signal.aborted });
      let result;
      if (method === 'getChatMember') result = { status: 'member' };
      else if (method === 'sendMessage' || method === 'sendPhoto') result = { message_id: 99 };
      else assert.fail(`Unexpected Telegram method ${method}`);
      return Response.json({ ok: true, result });
    }
    assert.equal(target.origin, 'https://open.faceit.com');
    reads.push({ path: target.pathname, started: clock, signal: options.signal });
    const override = await beforeFaceit?.({ target, options, reads, now: () => clock });
    if (override) return override;
    if (target.pathname.endsWith('/players')) return Response.json({ player_id: 'player', nickname: 'Player', games: { cs2: { faceit_elo: 1710, skill_level: 8 } } });
    if (target.pathname.endsWith('/history')) return Response.json({ items: matches });
    const match = matches.find(item => target.pathname.includes(`/matches/${item.match_id}`));
    assert.ok(match);
    if (!target.pathname.endsWith('/stats')) return Response.json(match);
    return Response.json({ rounds: [{ match_id: match.match_id, game_id: 'cs2', match_round: 1,
      round_stats: { Map: 'de_inferno', Rounds: '21', Winner: 'own' }, teams: [
        { team_id: 'own', team_stats: { 'Final Score': '13' }, players: [{ player_id: 'player', nickname: 'Player',
          player_stats: { Kills: '20', Deaths: '11', Assists: '5', Headshots: '5', 'Total Damage': '2100' } }] },
        { team_id: 'other', team_stats: { 'Final Score': '8' }, players: [{ player_id: 'other', nickname: 'Other', player_stats: { Kills: '11', Deaths: '20' } }] },
      ] }] });
  };
  const runtime = createCloudRuntime(env, { fetch, now: () => clock, setTimer, clearTimer,
    onDiagnostic: (code, service) => diagnostics.push({ code, service }), onMetrics: value => metrics.push(value), onCacheEvent: () => {} });
  const update = { update_id: 751, message: { message_id: 751, message_thread_id: 77,
    chat: { id: CHAT, type: 'supergroup' }, from: { id: 123, is_bot: false }, text: `/${kind} Player` } };
  const invoke = () => runtime(update, { startedAt: BASE });
  const webhook = createWebhook({ getEnv: () => env, getRuntime: () => runtime, now: () => BASE, onDiagnostic: () => {} });
  const request = () => new Request('https://example.test/api/telegram/webhook', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET }, body: JSON.stringify(update) });
  return { sql, timers, methods, reads, metrics, diagnostics, tick, invoke, webhook, request, now: () => clock,
    sends: () => methods.filter(item => ['sendPhoto', 'sendMessage'].includes(item.method)) };
}

function assertFinalReply(f, method) {
  const sends = f.sends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].method, method);
  const params = sends[0].params;
  if (method === 'sendPhoto') {
    assert.ok(params instanceof FormData);
    assert.equal(params.get('chat_id'), String(CHAT));
    assert.equal(params.get('message_thread_id'), '77');
    assert.deepEqual(JSON.parse(params.get('reply_parameters')), { message_id: 751, allow_sending_without_reply: true });
    assert.equal(params.get('caption'), null);
    assert.equal(params.get('photo').type, 'image/png');
  } else {
    assert.equal(params.chat_id, CHAT);
    assert.equal(params.message_thread_id, 77);
    assert.deepEqual(params.reply_parameters, { message_id: 751, allow_sending_without_reply: true });
    assert.doesNotMatch(params.text, /Продолжить|Сохранила прогресс|synthetic|CLOUD_|Bearer|FACEIT_TEMPORARY/);
    assert.doesNotMatch(JSON.stringify(params.reply_markup ?? {}), /continue:/);
  }
  assert.equal(sends[0].signalWasAborted, false);
  assert.equal(f.timers.size, 0, 'all invocation and wait timers must be cleared');
}

for (const kind of ['last', 'stats']) for (const phase of ['profile', 'history', 'details', 'stats']) {
  test(`cloud ${kind} awaits short ${phase} Retry-After without an intermediate response or early webhook ACK`, { timeout: 3000 }, async t => {
    let limited = false;
    let limitedAt;
    const f = fixture(t, { kind, beforeFaceit: ({ target, now }) => {
      const matchesPhase = phase === 'profile' ? target.pathname.endsWith('/players')
        : phase === 'history' ? target.pathname.endsWith('/history')
          : phase === 'stats' ? target.pathname.endsWith('/stats') : /\/matches\/[^/]+$/.test(target.pathname);
      if (!limited && matchesPhase) {
        limited = true;
        limitedAt = now();
        return Response.json({}, { status: 429, headers: { 'retry-after': '2' } });
      }
    } });
    let finished = false;
    const pending = f.webhook(f.request()).then(response => { finished = true; return response; });
    await flush();
    assert.equal(limited, true);
    assert.equal(finished, false);
    assert.equal(f.sends().length, 0, 'waiting must not post a progress card or a text message');
    const readsBefore = f.reads.length;
    f.tick(2999);
    await flush();
    assert.equal(finished, false);
    assert.equal(f.reads.length, readsBefore, 'no request may run before the full Retry-After');
    f.tick(1);
    assert.equal((await pending).status, 200);
    assert.ok(f.reads[readsBefore].started >= limitedAt + 3000);
    assertFinalReply(f, 'sendPhoto');
    const readCount = f.reads.length;
    assert.equal((await f.webhook(f.request())).status, 200);
    assert.equal(f.sends().length, 1, 'redelivery cannot duplicate the final photo');
    assert.equal(f.reads.length, readCount, 'redelivery cannot restart FACEIT reads');
    assert.equal(f.metrics[0].renderCount, 1);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind='notice'").get().n, 0);
  });
}

test('cloud numeric Retry-After never retries early when the response arrives between whole Unix seconds', { timeout: 3000 }, async t => {
  let limited = false;
  const f = fixture(t, { initialDelay: 900, beforeFaceit: () => {
    if (limited) return;
    limited = true;
    return Response.json({}, { status: 429, headers: { 'retry-after': '2' } });
  } });
  const pending = f.invoke();
  await flush();
  assert.equal(f.reads.length, 1);
  f.tick(1999);
  await flush();
  assert.equal(f.reads.length, 1, 'a numeric delay cannot be shortened by flooring the response time');
  f.tick(101);
  await pending;
  assert.ok(f.reads[1].started - f.reads[0].started >= 2000);
  assertFinalReply(f, 'sendPhoto');
});

for (const kind of ['last', 'stats']) test(`cloud ${kind} refuses an over-budget Retry-After once in text without sleeping or rendering`, { timeout: 3000 }, async t => {
  const f = fixture(t, { kind, beforeFaceit: () => Response.json({}, { status: 429, headers: { 'retry-after': '120' } }) });
  await f.invoke();
  assertFinalReply(f, 'sendMessage');
  assert.equal(f.reads.length, 1);
  assert.equal(f.now(), BASE);
  assert.equal(f.metrics[0].renderCount, 0);
  assert.equal(f.metrics[0].photoUploads, 0);
  await f.invoke();
  assert.equal(f.sends().length, 1, 'redelivery cannot repeat a refusal');
});

test('cloud FACEIT work deadline aborts a pending GET but keeps the Telegram response reserve alive', { timeout: 3000 }, async t => {
  let pendingSignal;
  const f = fixture(t, { initialDelay: 60_000, beforeFaceit: ({ options }) => {
    pendingSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Synthetic stop', 'AbortError')), { once: true }));
  } });
  let finished = false;
  const pending = f.invoke().then(() => { finished = true; });
  await flush();
  assert.equal(pendingSignal?.aborted, false);
  assert.equal(f.sends().length, 0);
  f.tick(4999);
  await flush();
  assert.equal(finished, false);
  f.tick(1);
  await pending;
  assert.equal(pendingSignal.aborted, true);
  assertFinalReply(f, 'sendMessage');
  assert.equal(f.sends()[0].started, BASE + CLOUD_WORK_MS);
  assert.ok(f.sends()[0].started < BASE + CLOUD_HANDLER_MS);
  assert.equal(f.metrics[0].renderCount, 0);
  assert.ok(f.diagnostics.some(item => item.code === 'CLOUD_NETWORK_ABORTED' && item.service === 'faceit'));
});

test('cloud aborting the work signal during Retry-After releases the awaited handler with one text refusal', { timeout: 3000 }, async t => {
  const f = fixture(t, { beforeFaceit: () => Response.json({}, { status: 429, headers: { 'retry-after': '2' } }) });
  let finished = false;
  const pending = f.invoke().then(() => { finished = true; });
  await flush();
  assert.equal(finished, false);
  assert.equal(f.sends().length, 0);
  const workTimer = [...f.timers.values()].find(timer => timer.milliseconds === CLOUD_WORK_MS);
  assert.ok(workTimer);
  workTimer.callback();
  await pending;
  assertFinalReply(f, 'sendMessage');
  assert.equal(f.reads.length, 1, 'aborted work cannot retry even when the retry timestamp fits the original deadline');
  assert.equal(f.metrics[0].renderCount, 0);
});

for (const status of [401, 403, 404]) test(`cloud FACEIT permanent HTTP ${status} fails once with safe text`, { timeout: 3000 }, async t => {
  const f = fixture(t, { beforeFaceit: () => Response.json({ private_error: 'synthetic-private-error' }, { status }) });
  await f.invoke();
  assertFinalReply(f, 'sendMessage');
  assert.equal(f.reads.length, 1);
  assert.equal(f.metrics[0].renderCount, 0);
  assert.equal(f.metrics[0].photoUploads, 0);
});
