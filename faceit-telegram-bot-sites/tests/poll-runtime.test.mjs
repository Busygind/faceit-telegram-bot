import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCloudRuntime } from '../bot/webhook.mjs';
import { SQL_SCHEMA } from '../bot/core/store.js';
import { REPORT_CACHE_SCHEMA } from '../bot/report-cache.mjs';

const NOW = Date.parse('2026-11-07T09:00:00+03:00') / 1000;
const DAY_WINDOW_SECONDS = 18 * 3600;
const moscowTime = value => Date.parse(value) / 1000;
const CHAT = -1001234567890;

function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const statement of [...SQL_SCHEMA, ...REPORT_CACHE_SCHEMA]) sql.exec(statement);
  const DB = { prepare(query) {
    const statement = sql.prepare(query);
    const bound = (values = []) => ({
      bind(...args) { return bound(args); },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
      async run() {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    });
    return bound();
  } };
  const env = { BOT_TOKEN: `123456:${'synthetic_'.repeat(4)}`, FACEIT_API_KEY: 'synthetic-poll-runtime-key',
    TS_ENCRYPTION_KEY: '12'.repeat(32), WEBHOOK_SECRET: 'synthetic_'.repeat(5), DB };
  const calls = [];
  const polls = new Map();
  let clock = NOW;
  let nextUpdate = 0;
  let nextMessage = 1000;
  let nextPoll = 0;
  const controls = { pinDenied: false, unpinDenied: false, forwardDeleted: false, postUnknown: false, beforeSendPoll: null };
  async function invoke({ at = clock, chatId = CHAT, type = 'supergroup', topicId = 77,
    updateId = ++nextUpdate, messageId = updateId, callback = null } = {}) {
    clock = at;
    const command = { message_id: messageId, chat: { id: chatId, type }, from: { id: 123, is_bot: false },
      ...(topicId == null ? {} : { message_thread_id: topicId }), text: '/poll' };
    // A new transport and runtime on every invocation forbid accidental RAM state.
    const fetch = async (url, options) => {
      assert.equal(options.redirect, 'manual');
      const target = new URL(url);
      assert.equal(target.origin, 'https://api.telegram.org');
      assert.ok(!(options.body instanceof FormData));
      const method = target.pathname.split('/').at(-1);
      const params = JSON.parse(options.body);
      calls.push({ method, params });
      const reject = description => Response.json({ ok: false, error_code: 400, description }, { status: 400 });
      let result;
      if (method === 'getMe') result = { id: 999, is_bot: true, username: 'road_to_3_elo_bot' };
      else if (method === 'getChatMember') result = { status: 'member' };
      else if (method === 'sendPoll') {
        await controls.beforeSendPoll?.();
        if (controls.postUnknown) throw new Error('synthetic transport outcome unknown');
        result = { message_id: ++nextMessage, date: clock, poll: { id: `poll-${++nextPoll}` } };
        polls.set(`${chatId}:${result.message_id}`, result);
      } else if (method === 'forwardMessage') {
        assert.equal(Object.hasOwn(params, 'reply_parameters'), false, 'Bot API forwardMessage has no reply_parameters');
        assert.equal(Object.hasOwn(params, 'reply_to_message_id'), false);
        if (controls.forwardDeleted) return reject('Bad Request: message to forward not found');
        const original = polls.get(`${params.from_chat_id}:${params.message_id}`);
        assert.ok(original, 'forward the stored original poll, never a replacement or unrelated message');
        result = { ...original, message_id: ++nextMessage, date: clock };
        polls.set(`${chatId}:${result.message_id}`, result);
      } else if (method === 'pinChatMessage') {
        assert.equal(params.disable_notification, true);
        assert.ok(Number.isSafeInteger(params.message_id));
        if (controls.pinDenied) return reject('Bad Request: not enough rights to pin a message');
        result = true;
      } else if (method === 'unpinChatMessage') {
        assert.ok(Number.isSafeInteger(params.message_id), 'unpin one recorded bot poll, never all chat pins');
        if (controls.unpinDenied) return reject('Bad Request: not enough rights to unpin a message');
        result = true;
      } else if (method === 'sendMessage') result = { message_id: ++nextMessage, date: clock };
      else if (method === 'answerCallbackQuery') result = true;
      else assert.fail(`Unexpected Telegram method ${method}`);
      return Response.json({ ok: true, result });
    };
    const runtime = createCloudRuntime({ ...env }, { fetch, now: () => clock * 1000,
      onDiagnostic: () => {}, onMetrics: () => {}, onCacheEvent: () => {} });
    const update = callback ? { update_id: updateId, callback_query: { id: `callback-${updateId}`, data: callback,
      from: command.from, message: { ...command, from: { id: 999, is_bot: true } } } }
      : { update_id: updateId, message: command };
    await runtime(update);
    return { updateId, messageId };
  }
  return { sql, calls, controls, invoke,
    state: (chatId = CHAT) => sql.prepare('SELECT * FROM poll_state WHERE chat_id=?').get(chatId),
    callsFor: method => calls.filter(call => call.method === method),
  };
}

function assertReply(params, messageId, topicId = 77) {
  assert.deepEqual(params.reply_parameters, { message_id: messageId, allow_sending_without_reply: true });
  if (topicId == null) assert.equal(Object.hasOwn(params, 'message_thread_id'), false);
  else assert.equal(params.message_thread_id, topicId);
}

test('cloud poll reuses the original shared vote for one fixed 09:00–03:00 Moscow window across cold runtimes and chat topics', async t => {
  const f = fixture(t);
  await f.invoke();
  const first = f.state();
  const initial = f.callsFor('sendPoll')[0].params;
  assertReply(initial, 1);
  assert.equal(initial.question, 'Играть сегодня (время по МСК)');
  assert.deepEqual(initial.options.map(option => option.text), [
    'да, в 14', 'да, в 15', 'да, в 16',
    'да, в 17', 'да, в 18', 'да, в 19', 'да, в 20', 'да, в 21', 'да, в 22', 'да, в 23', 'да, позже', 'нет',
  ]);
  assert.equal(initial.options.length, 12);
  assert.ok(!initial.options.some(option => option.text === 'да, в 13'));
  assert.equal(initial.type, 'regular');
  assert.equal(initial.is_anonymous, false);
  assert.equal(initial.allows_multiple_answers, true);
  assert.equal(initial.allows_revoting, true);
  for (const key of ['shuffle_options', 'allow_adding_options', 'hide_results_until_closes', 'is_closed', 'protect_content', 'allow_paid_broadcast']) {
    assert.equal(initial[key], false);
  }
  assert.equal(first.created_at, NOW);
  assert.equal(first.pinned_message_id, first.original_message_id);
  await f.invoke({ at: NOW + 3600, topicId: 88, callback: 'poll', messageId: 500 });
  let state = f.state();
  assert.equal(f.callsFor('sendPoll').length, 1);
  assert.deepEqual(f.callsFor('forwardMessage')[0].params, { chat_id: CHAT, from_chat_id: CHAT,
    message_id: first.original_message_id, message_thread_id: 88, disable_notification: false });
  assert.equal(state.poll_id, first.poll_id, 'a forward preserves the vote rather than creating a new poll');
  assert.equal(state.created_at, NOW, 'forwarding does not extend the reuse window');
  assert.notEqual(state.pinned_message_id, first.pinned_message_id);
  assert.deepEqual(f.callsFor('unpinChatMessage')[0].params, { chat_id: CHAT, message_id: first.pinned_message_id });
  const pinIndex = f.calls.findIndex(call => call.method === 'pinChatMessage' && call.params.message_id === state.pinned_message_id);
  const unpinIndex = f.calls.findIndex(call => call.method === 'unpinChatMessage' && call.params.message_id === first.pinned_message_id);
  assert.ok(pinIndex < unpinIndex, 'pin replacement before removing the previous bot poll');
  await f.invoke({ at: NOW + 4 * 3600 });
  assert.equal(f.callsFor('sendPoll').length, 1, 'the old rolling three-hour expiry must not create a new poll');
  await f.invoke({ at: NOW + DAY_WINDOW_SECONDS - 1 });
  assert.equal(f.callsFor('sendPoll').length, 1);
  assert.equal(f.callsFor('forwardMessage').at(-1).params.message_id, first.original_message_id);
  await f.invoke({ at: NOW + DAY_WINDOW_SECONDS });
  state = f.state();
  assert.equal(f.callsFor('sendPoll').length, 2);
  assert.notEqual(state.poll_id, first.poll_id);
  assert.equal(state.created_at, NOW + DAY_WINDOW_SECONDS);
  assert.equal(f.callsFor('sendMessage').length, 0, 'successful poll lifecycle adds no status chatter');
});

test('cloud poll state is scoped by chat, not member, and duplicate Telegram updates never send or pin twice', async t => {
  const f = fixture(t);
  await f.invoke({ updateId: 20, messageId: 200, topicId: null, type: 'group' });
  await f.invoke({ chatId: -200, updateId: 21, messageId: 201, topicId: null, type: 'group' });
  assert.equal(f.callsFor('sendPoll').length, 2);
  assert.notEqual(f.state().poll_id, f.state(-200).poll_id);
  assertReply(f.callsFor('sendPoll')[0].params, 200, null);
  assertReply(f.callsFor('sendPoll')[1].params, 201, null);
  const mutations = f.calls.filter(call => ['sendPoll', 'forwardMessage', 'pinChatMessage', 'unpinChatMessage'].includes(call.method)).length;
  await f.invoke({ updateId: 20, messageId: 200, topicId: null, type: 'group' });
  assert.equal(f.calls.filter(call => ['sendPoll', 'forwardMessage', 'pinChatMessage', 'unpinChatMessage'].includes(call.method)).length, mutations);
  await f.invoke({ updateId: 22, messageId: 202 });
  assert.equal(f.callsFor('forwardMessage').at(-1).params.message_id, f.state().original_message_id);
  assert.equal(f.callsFor('sendPoll').length, 2);
});

test('concurrent cold cloud poll requests create only one poll and report that the other request is busy', async t => {
  const f = fixture(t);
  let release;
  let reached;
  const held = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { reached = resolve; });
  f.controls.beforeSendPoll = async () => { reached(); await held; };
  const first = f.invoke({ updateId: 30, messageId: 300 });
  t.after(() => release());
  await sending;
  await f.invoke({ updateId: 31, messageId: 301 });
  assert.equal(f.callsFor('sendPoll').length, 1);
  assert.equal(f.callsFor('forwardMessage').length, 0);
  const busy = f.callsFor('sendMessage').at(-1).params;
  assert.match(busy.text, /уже обрабатывается/i);
  assertReply(busy, 301);
  release();
  await first;
  assert.equal(f.callsFor('sendPoll').length, 1);
  assert.equal(f.callsFor('pinChatMessage').length, 1);
  assert.equal(f.state().phase, 'idle');
});

test('missing cloud pin rights warns without losing the accepted poll or creating a replacement', async t => {
  const f = fixture(t);
  f.controls.pinDenied = true;
  await f.invoke({ updateId: 40, messageId: 400 });
  const original = f.state();
  assert.ok(original.original_message_id);
  assert.equal(original.pinned_message_id, null);
  const warning = f.callsFor('sendMessage').at(-1).params;
  assert.match(warning.text, /закрепить.*не удалось/i);
  assertReply(warning, 400);
  assert.equal(f.callsFor('unpinChatMessage').length, 0);
  f.controls.pinDenied = false;
  await f.invoke({ updateId: 41, messageId: 401, at: NOW + 60 });
  assert.equal(f.callsFor('sendPoll').length, 1);
  assert.equal(f.callsFor('forwardMessage').length, 1);
  assert.equal(f.state().original_message_id, original.original_message_id);
  assert.equal(f.state().poll_id, original.poll_id);
  assert.equal(f.state().created_at, NOW);
  assert.ok(f.state().pinned_message_id);
});

test('cloud poll retries only recorded failed unpins and preserves unrelated chat pins', async t => {
  const f = fixture(t);
  await f.invoke();
  const first = f.state().pinned_message_id;
  f.controls.unpinDenied = true;
  await f.invoke({ at: NOW + 60 });
  const second = f.state().pinned_message_id;
  assert.deepEqual(JSON.parse(f.state().pending_unpin_ids), [first]);
  assert.match(f.callsFor('sendMessage').at(-1).params.text, /открепить предыдущий опрос/i);
  f.controls.unpinDenied = false;
  await f.invoke({ at: NOW + 120 });
  assert.deepEqual(JSON.parse(f.state().pending_unpin_ids), []);
  assert.deepEqual(f.callsFor('unpinChatMessage').map(call => call.params.message_id), [first, first, second]);
  assert.ok(f.callsFor('unpinChatMessage').every(call => call.params.chat_id === CHAT && Object.hasOwn(call.params, 'message_id')));
  assert.equal(f.callsFor('sendPoll').length, 1);
});

test('cloud poll never splits voting when the stored original was deleted or forwarding is forbidden', async t => {
  const f = fixture(t);
  await f.invoke();
  const first = f.state();
  f.controls.forwardDeleted = true;
  await f.invoke({ at: NOW + 60, updateId: 50, messageId: 500 });
  assert.equal(f.callsFor('sendPoll').length, 1);
  assert.equal(f.state().original_message_id, first.original_message_id);
  assert.equal(f.state().poll_id, first.poll_id);
  assert.equal(f.state().pinned_message_id, first.pinned_message_id);
  const warning = f.callsFor('sendMessage').at(-1).params;
  assert.match(warning.text, /новый опрос не создаю/i);
  assertReply(warning, 500);
  await f.invoke({ at: NOW + DAY_WINDOW_SECONDS });
  assert.equal(f.callsFor('sendPoll').length, 2);
});

test('an ambiguous cloud poll POST keeps a persistent duplicate fence until the Moscow window ends beyond the runtime lease', async t => {
  const f = fixture(t);
  f.controls.postUnknown = true;
  await f.invoke({ updateId: 60 });
  assert.equal(f.callsFor('sendPoll').length, 1);
  assert.equal(f.state().phase, 'unknown');
  assert.equal(f.state().unknown_until, NOW + DAY_WINDOW_SECONDS);
  f.controls.postUnknown = false;
  await f.invoke({ updateId: 61, at: NOW + 181 });
  await f.invoke({ updateId: 62, at: NOW + DAY_WINDOW_SECONDS - 1 });
  assert.equal(f.callsFor('sendPoll').length, 1, 'fresh runtime and expired lock must not blindly retry an uncertain send');
  assert.equal(f.callsFor('forwardMessage').length, 0);
  await f.invoke({ updateId: 63, at: NOW + DAY_WINDOW_SECONDS });
  assert.equal(f.callsFor('sendPoll').length, 2);
  assert.ok(f.state().poll_id);
  assert.equal(f.state().unknown_until, 0);
});


test('cloud polls change at exact 03:00 and 09:00 Moscow boundaries across cold runtimes', async t => {
  const f = fixture(t);
  await f.invoke({ at: moscowTime('2026-11-08T02:59:59+03:00') });
  const previous = f.state();
  await f.invoke({ at: moscowTime('2026-11-08T03:00:00+03:00') });
  const morning = f.state();
  assert.equal(f.callsFor('sendPoll').length, 2);
  assert.notEqual(morning.poll_id, previous.poll_id);
  await f.invoke({ at: moscowTime('2026-11-08T08:59:59+03:00'), topicId: 88 });
  assert.equal(f.callsFor('sendPoll').length, 2);
  assert.equal(f.callsFor('forwardMessage').at(-1).params.message_id, morning.original_message_id);
  await f.invoke({ at: moscowTime('2026-11-08T09:00:00+03:00') });
  assert.equal(f.callsFor('sendPoll').length, 3);
  assert.notEqual(f.state().poll_id, morning.poll_id);
  assert.equal(f.state().created_at, moscowTime('2026-11-08T09:00:00+03:00'));
});

test('cloud legacy unknown fences require no migration and unlock at the old request Moscow window boundary', async t => {
  for (const [sentAt, stillBlockedAt, nextWindowAt] of [
    ['2026-11-08T02:00:00+03:00', '2026-11-08T02:59:59+03:00', '2026-11-08T03:00:00+03:00'],
    ['2026-11-07T09:00:00+03:00', '2026-11-08T02:59:59+03:00', '2026-11-08T03:00:00+03:00'],
  ]) {
    const f = fixture(t);
    const sent = moscowTime(sentAt);
    f.sql.prepare("INSERT INTO poll_state(chat_id,owner_request_id,lease_until,phase,unknown_until,updated_at) VALUES(?,NULL,0,'unknown',?,?)")
      .run(CHAT, sent + 3 * 3600, sent);
    await f.invoke({ at: moscowTime(stillBlockedAt) });
    assert.equal(f.callsFor('sendPoll').length, 0);
    assert.equal(f.callsFor('forwardMessage').length, 0);
    await f.invoke({ at: moscowTime(nextWindowAt) });
    assert.equal(f.callsFor('sendPoll').length, 1);
    assert.ok(f.state().poll_id);
  }
});
