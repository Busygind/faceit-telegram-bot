import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, createFetchMock } from 'miniflare';
import { SQL_SCHEMA } from '../bot/core/store.js';

const NOW = Date.parse('2026-11-07T09:00:00+03:00') / 1000;
const DAILY_WINDOW_SECONDS = 18 * 60 * 60;
const MIGRATIONS = ['0000_sturdy_agent_brand.sql', '0001_smooth_sunset_bain.sql', '0002_player_links.sql', '0003_chat_poll_lifecycle.sql'];

async function migrationStatements() {
  return (await Promise.all(MIGRATIONS.map(name => readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'))))
    .flatMap(source => source.split('--> statement-breakpoint').map(statement => statement.trim()).filter(Boolean));
}

// Drizzle spells key nullability explicitly; the portable schema validates
// owners before SQL. Compare column types/defaults and primary-key identity.
function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map(row => ({
    name: row.name, type: row.type, default: row.dflt_value, primary: row.pk,
  }));
}

test('poll migration matches the portable state schema and leaves pre-existing bot data intact', async t => {
  const cloud = new DatabaseSync(':memory:');
  const portable = new DatabaseSync(':memory:');
  t.after(() => { cloud.close(); portable.close(); });
  const statements = await migrationStatements();
  const newMigration = await readFile(new URL('../drizzle/0003_chat_poll_lifecycle.sql', import.meta.url), 'utf8');
  const newStatements = newMigration.split('--> statement-breakpoint').map(statement => statement.trim()).filter(Boolean);
  for (const statement of statements.slice(0, -newStatements.length)) cloud.exec(statement);
  cloud.exec("INSERT INTO deliveries(request_id,chat_id,kind,status,message_id,poll_id,updated_at) VALUES('legacy',-100,'poll','sent',500,'legacy-poll',1800000000)");
  cloud.exec("INSERT INTO player_links(chat_id,user_id,player_id,nickname,updated_at) VALUES(-100,1,'player','Player',1800000000)");
  for (const statement of newStatements) cloud.exec(statement);
  for (const statement of SQL_SCHEMA) portable.exec(statement);
  for (const table of ['poll_state', 'poll_requests']) assert.deepEqual(columns(cloud, table), columns(portable, table));
  const index = cloud.prepare('PRAGMA index_info(idx_poll_requests_updated)').all();
  assert.deepEqual(index.map(row => row.name), ['updated_at']);
  assert.equal(cloud.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 1);
  assert.equal(cloud.prepare('SELECT nickname FROM player_links').get().nickname, 'Player');
});

test('real workerd native D1 keeps the original poll, chat isolation and pin replacement across fresh Store instances', async t => {
  const [storeSource, adapterSource, serviceSource, pollSource, windowSource, statements] = await Promise.all([
    readFile(new URL('../bot/core/store.js', import.meta.url), 'utf8'),
    readFile(new URL('../bot/d1.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../bot/core/poll-service.js', import.meta.url), 'utf8'),
    readFile(new URL('../bot/core/poll.js', import.meta.url), 'utf8'),
    readFile(new URL('../bot/core/poll-window.js', import.meta.url), 'utf8'),
    migrationStatements(),
  ]);
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const worker = new Miniflare({
    compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'poll-lifecycle-native-d1-fixture' }, d1Persist: false, fetchMock,
    modulesRoot: '/poll-lifecycle-worker-fixture',
    modules: [{ type: 'ESModule', path: '/poll-lifecycle-worker-fixture/main.mjs', contents: `
      import { Store } from './store.js';
      import { createD1Adapter } from './d1.mjs';
      import { createPollService } from './poll-service.js';
      export default { async fetch(request, env) {
        const input = await request.json();
        const { action, now, chatId = -100, topicId = 77, messageId = 1000, id = 'request' } = input;
        if (action === 'init') {
          for (const statement of ${JSON.stringify(statements)}) await env.DB.prepare(statement).run();
        }
        const store = new Store(createD1Adapter(env.DB, { onDiagnostic: () => {} }), () => now);
        if (action === 'legacy') {
          await store.claimDelivery('legacy-poll', chatId, topicId, 'poll');
          await store.finishDelivery('legacy-poll', 'sent', { message_id: 500, poll: { id: 'legacy-shared-poll' } });
        }
        const before = await store.getPollState(chatId);
        const calls = [];
        const api = Object.fromEntries(['sendPoll', 'forwardMessage', 'pinChatMessage', 'unpinChatMessage'].map(method => [method, async params => {
          calls.push({ method, params });
          if (method === 'sendPoll') return { message_id: messageId, date: now, poll: { id: 'poll-' + id } };
          if (method === 'forwardMessage') return { message_id: messageId, date: now,
            poll: { id: before?.poll_id ?? 'legacy-shared-poll' } };
          return true;
        }]));
        const service = createPollService({ api, store, now: () => now });
        const result = action === 'get' || action === 'init' ? null
          : await service.run({ chatId, topicId, replyToMessageId: messageId - 1 }, id);
        return Response.json({ result, calls, state: await store.getPollState(chatId) });
      } };
    ` },
    { type: 'ESModule', path: '/poll-lifecycle-worker-fixture/store.js', contents: storeSource },
    { type: 'ESModule', path: '/poll-lifecycle-worker-fixture/d1.mjs', contents: adapterSource },
    { type: 'ESModule', path: '/poll-lifecycle-worker-fixture/poll-service.js', contents: serviceSource },
    { type: 'ESModule', path: '/poll-lifecycle-worker-fixture/poll.js', contents: pollSource },
    { type: 'ESModule', path: '/poll-lifecycle-worker-fixture/poll-window.js', contents: windowSource }],
  });
  t.after(async () => { await worker.dispose(); await fetchMock.close(); });
  async function invoke(action, rest = {}) {
    const response = await worker.dispatchFetch('https://worker.example/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, now: NOW, ...rest }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  await invoke('init');
  const first = await invoke('run', { id: 'first', messageId: 1000 });
  assert.equal(first.result.status, 'sent');
  assert.deepEqual(first.calls.map(call => call.method), ['sendPoll', 'pinChatMessage']);
  assert.deepEqual(first.calls[0].params.reply_parameters, { message_id: 999, allow_sending_without_reply: true });
  assert.equal(first.state.original_message_id, 1000);
  assert.equal(first.state.created_at, NOW);
  assert.equal(first.state.pinned_message_id, 1000);
  assert.deepEqual((await invoke('get')).state, first.state);
  const reused = await invoke('run', { id: 'second', messageId: 2000, now: NOW + 60, topicId: 88 });
  assert.equal(reused.result.status, 'sent');
  assert.deepEqual(reused.calls.map(call => call.method), ['forwardMessage', 'pinChatMessage', 'unpinChatMessage']);
  assert.deepEqual(reused.calls[0].params, { chat_id: -100, from_chat_id: -100, message_id: 1000,
    message_thread_id: 88, disable_notification: false });
  assert.deepEqual(reused.calls[2].params, { chat_id: -100, message_id: 1000 });
  assert.equal(reused.state.poll_id, first.state.poll_id);
  assert.equal(reused.state.created_at, NOW);
  const duplicate = await invoke('run', { id: 'second', messageId: 2000, now: NOW + 61 });
  assert.equal(duplicate.calls.length, 0);
  const other = await invoke('run', { id: 'other-chat', chatId: -200, messageId: 3000, now: NOW + 62 });
  assert.deepEqual(other.calls.map(call => call.method), ['sendPoll', 'pinChatMessage']);
  assert.notEqual(other.state.poll_id, first.state.poll_id);
  const beforeBoundary = await invoke('run', { id: 'before-03', messageId: 3500, now: NOW + DAILY_WINDOW_SECONDS - 1 });
  assert.deepEqual(beforeBoundary.calls.map(call => call.method), ['forwardMessage', 'pinChatMessage', 'unpinChatMessage']);
  assert.equal(beforeBoundary.state.original_message_id, first.state.original_message_id);
  assert.equal(beforeBoundary.state.created_at, NOW, 'reuse lasts until 03:00 Moscow, not three hours from creation');
  const expired = await invoke('run', { id: 'expired', messageId: 4000, now: NOW + DAILY_WINDOW_SECONDS });
  assert.deepEqual(expired.calls.map(call => call.method), ['sendPoll', 'pinChatMessage', 'unpinChatMessage']);
  assert.equal(expired.state.original_message_id, 4000);
  assert.equal(expired.state.created_at, NOW + DAILY_WINDOW_SECONDS);
  assert.notEqual(expired.state.poll_id, first.state.poll_id);
  const legacy = await invoke('legacy', { chatId: -300, id: 'after-upgrade', messageId: 5000, now: NOW + DAILY_WINDOW_SECONDS + 1 });
  assert.deepEqual(legacy.calls.map(call => call.method), ['forwardMessage', 'pinChatMessage']);
  assert.equal(legacy.calls[0].params.message_id, 500);
  assert.equal(legacy.state.poll_id, 'legacy-shared-poll');
  assert.equal(legacy.state.original_message_id, 500);
  fetchMock.assertNoPendingInterceptors();
});
