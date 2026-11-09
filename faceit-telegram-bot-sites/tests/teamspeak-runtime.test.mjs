import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCloudRuntime } from '../bot/webhook.mjs';
import { createSealer } from '../bot/core/credentials.js';
import { SQL_SCHEMA } from '../bot/core/store.js';
import { REPORT_CACHE_SCHEMA } from '../bot/report-cache.mjs';

const NOW = 1_800_000_000;
const CHAT = -1001234567890;
const KEY = '12'.repeat(32);
const isMaintenance = query => /^DELETE FROM (?:report_jobs|deliveries|poll_requests)\b/.test(query);

function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const statement of [...SQL_SCHEMA, ...REPORT_CACHE_SCHEMA]) sql.exec(statement);
  const events = [];
  const metrics = [];
  const diagnostics = [];
  const controls = { status: 'member', beforeDatabase: null };
  const DB = { prepare(query) {
    const statement = sql.prepare(query);
    const execute = async (method, values) => {
      events.push({ kind: 'database', query, method });
      await controls.beforeDatabase?.(query);
      if (method === 'first') return statement.get(...values) ?? null;
      if (method === 'all') return { results: statement.all(...values) };
      const result = statement.run(...values);
      return { meta: { changes: Number(result.changes) } };
    };
    const bound = (values = []) => ({
      bind(...args) { return bound(args); },
      first: () => execute('first', values),
      all: () => execute('all', values),
      run: () => execute('run', values),
    });
    return bound();
  } };
  const env = { BOT_TOKEN: `123456:${'synthetic_'.repeat(4)}`, FACEIT_API_KEY: 'synthetic-teamspeak-runtime-key',
    TS_ENCRYPTION_KEY: KEY, WEBHOOK_SECRET: 'synthetic_'.repeat(5), DB };
  const sealer = createSealer({ keyHex: KEY, keyId: 'cloud-v1' });
  let nextUpdate = 0;
  function settings({ chatId = CHAT, origin = chatId, host = 'voice.example.test:9987',
    password = 'synthetic-password', version = 1 } = {}) {
    const ciphertext = sealer.seal(chatId, host, password, version);
    sql.prepare(`INSERT INTO chat_settings(chat_id,origin_chat_id,ciphertext,version,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET origin_chat_id=excluded.origin_chat_id,
      ciphertext=excluded.ciphertext,version=excluded.version,updated_at=excluded.updated_at`)
      .run(chatId, origin, ciphertext, version, NOW);
  }
  async function invoke({ updateId = ++nextUpdate, messageId = updateId, chatId = CHAT, callback = false } = {}) {
    // A new fetch and runtime per update simulate cold invocations sharing only D1.
    const fetch = async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, 'https://api.telegram.org', 'TeamSpeak must not fetch FACEIT or external resources');
      assert.equal(options.redirect, 'manual');
      assert.ok(!(options.body instanceof FormData), 'TeamSpeak does not render or upload an image');
      const method = target.pathname.split('/').at(-1);
      const params = JSON.parse(options.body);
      events.push({ kind: 'telegram', method, params });
      let result;
      if (method === 'getChatMember') result = { status: controls.status };
      else if (method === 'sendMessage') result = { message_id: 1000 + updateId };
      else if (method === 'answerCallbackQuery') result = true;
      else assert.fail(`Unexpected Telegram method ${method}`);
      return Response.json({ ok: true, result });
    };
    const runtime = createCloudRuntime({ ...env }, { fetch, now: () => NOW * 1000,
      onDiagnostic: (code, service) => diagnostics.push({ code, service }),
      onMetrics: value => metrics.push(value), onCacheEvent: () => assert.fail('TeamSpeak must not access report caches') });
    const message = { message_id: messageId, chat: { id: chatId, type: 'supergroup' },
      from: { id: 123, is_bot: false }, message_thread_id: 77, text: '/ts' };
    const update = callback ? { update_id: updateId, callback_query: { id: `callback-${updateId}`, data: 'ts',
      from: message.from, message: { ...message, from: { id: 999, is_bot: true } } } }
      : { update_id: updateId, message };
    await runtime(update);
  }
  return { sql, events, metrics, diagnostics, controls, settings, invoke,
    sends: () => events.filter(event => event.kind === 'telegram' && event.method === 'sendMessage') };
}

function assertNoReportWork(metrics) {
  assert.equal(metrics.faceitReads, 0);
  assert.equal(metrics.renderCount, 0);
  assert.equal(metrics.photoUploads, 0);
  assert.equal(metrics.photoFileReuses, 0);
}

for (const callback of [false, true]) test(`cloud TeamSpeak ${callback ? 'button' : 'command'} sends after three D1 operations and awaits deferred maintenance`, { timeout: 2000 }, async t => {
  const f = fixture(t);
  f.settings();
  let entered;
  let release;
  const maintenanceEntered = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let first = true;
  f.controls.beforeDatabase = async query => {
    if (isMaintenance(query) && first) {
      first = false;
      entered();
      await held;
    }
  };
  let finished = false;
  const pending = f.invoke({ callback, messageId: 1234 }).then(() => { finished = true; });
  try {
    await maintenanceEntered;
    assert.equal(f.sends().length, 1, 'the answer must already be visible while maintenance is blocked');
    const sendIndex = f.events.findIndex(event => event.kind === 'telegram' && event.method === 'sendMessage');
    const beforeSend = f.events.slice(0, sendIndex).filter(event => event.kind === 'database');
    assert.equal(beforeSend.length, 3, 'only retired-chat authorization, delivery claim, and settings lookup precede the answer');
    assert.equal(beforeSend.some(event => isMaintenance(event.query)), false);
    const params = f.sends()[0].params;
    assert.match(params.text, /Адрес: voice\.example\.test\n/);
    assert.doesNotMatch(params.text, /9987|порт/i);
    assert.match(params.text, /synthetic-password/);
    assert.equal(params.chat_id, CHAT);
    assert.equal(params.message_thread_id, 77);
    assert.deepEqual(params.reply_parameters, { message_id: 1234, allow_sending_without_reply: true });
    assert.equal(finished, false, 'the webhook must not acknowledge before awaited maintenance finishes');
    assert.equal(f.metrics.length, 0, 'request metrics are final only after maintenance completes');
  } finally {
    release();
    await pending;
  }
  assert.equal(f.metrics.length, 1);
  assert.equal(f.metrics[0].databaseCalls, 6);
  assert.equal(f.events.filter(event => event.kind === 'database' && isMaintenance(event.query)).length, 3);
  assertNoReportWork(f.metrics[0]);
});

test('cloud TeamSpeak maintenance failures cannot replace a delivered answer or leak diagnostics', async t => {
  const f = fixture(t);
  f.settings();
  f.controls.beforeDatabase = async query => {
    if (isMaintenance(query)) throw new Error('synthetic-private-database-error');
  };
  await f.invoke();
  assert.equal(f.sends().length, 1);
  assert.match(f.sends()[0].params.text, /Адрес: voice\.example\.test\n/);
  assert.doesNotMatch(f.sends()[0].params.text, /synthetic-private-database-error|Не удалось/);
  assert.deepEqual(f.diagnostics, [{ code: 'CLOUD_DATABASE_FAILED', service: 'database' }]);
  assert.equal(f.metrics[0].databaseCalls, 4);
  assertNoReportWork(f.metrics[0]);
});

test('cold cloud TeamSpeak invocations use fresh settings and fresh membership without a plaintext cache', async t => {
  const f = fixture(t);
  f.settings();
  await f.invoke();
  f.settings({ host: 'new.example.test:9987', password: 'synthetic-replacement', version: 2 });
  await f.invoke();
  assert.match(f.sends()[1].params.text, /Адрес: new\.example\.test\n/);
  assert.match(f.sends()[1].params.text, /synthetic-replacement/);
  assert.doesNotMatch(f.sends()[1].params.text, /synthetic-password/);
  f.controls.status = 'left';
  const start = f.events.length;
  await f.invoke();
  const revoked = f.events.slice(start);
  assert.match(f.sends()[2].params.text, /Не могу подтвердить членство/);
  assert.doesNotMatch(f.sends()[2].params.text, /synthetic-replacement|new\.example\.test/);
  assert.equal(revoked.some(event => event.kind === 'database' && /SELECT \* FROM chat_settings/.test(event.query)), false,
    'a revoked member must never read encrypted credentials');
  assert.equal(f.events.filter(event => event.kind === 'telegram' && event.method === 'getChatMember').length, 3);
  for (const metrics of f.metrics) assertNoReportWork(metrics);
});

test('cloud TeamSpeak keeps migrated groups retired and never reads another chat settings', async t => {
  const f = fixture(t);
  const retired = -200;
  f.settings({ origin: retired });
  await f.invoke({ chatId: retired });
  assert.equal(f.sends().length, 0);
  assert.equal(f.events.filter(event => event.kind === 'telegram').length, 0, 'retired groups fail closed before membership lookup');
  assert.equal(f.metrics[0].databaseCalls, 1);
  const start = f.events.length;
  await f.invoke({ chatId: -300 });
  const otherChat = f.events.slice(start);
  assert.equal(f.sends().length, 1);
  assert.match(f.sends()[0].params.text, /ещё не настроен/);
  assert.doesNotMatch(f.sends()[0].params.text, /synthetic-password|voice\.example\.test/);
  assert.equal(otherChat.filter(event => event.kind === 'database' && /SELECT \* FROM chat_settings/.test(event.query)).length, 1);
  for (const metrics of f.metrics) assertNoReportWork(metrics);
});
