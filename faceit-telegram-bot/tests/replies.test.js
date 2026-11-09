import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, fixtureReport } from './bot-harness.js';
import { createTelegramApi, createInputFile } from '../local/telegram.mjs';

const reply = message_id => ({ message_id, allow_sending_without_reply: true });

test('text replies and image-only FACEIT replies are anchored to their command in the same chat/topic', async t => {
  const bot = await makeHarness(t);
  for (const command of ['/menu', '/setup', '/ts', '/setfaceit MyNick', '/setfaceit', '/unsetfaceit']) {
    const id = await bot.send(command, { topicId: 7 });
    assert.deepEqual(bot.sent().at(-1).reply_parameters, reply(id));
    assert.equal(bot.sent().at(-1).chat_id, -10);
    assert.equal(bot.sent().at(-1).message_thread_id, 7);
  }
  for (const command of ['/last Nick', '/stats Nick']) {
    const before = bot.sent().length;
    const id = await bot.send(command, { topicId: 7 });
    const image = bot.sent('sendPhoto').at(-1);
    assert.deepEqual(image.reply_parameters, reply(id));
    assert.equal(image.message_thread_id, 7);
    assert.equal(image.caption, undefined);
    assert.equal(bot.sent().length, before);
  }
  const invalid = await bot.send('/stats', { topicId: 7 });
  assert.deepEqual(bot.sent().at(-1).reply_parameters, reply(invalid));
  assert.equal(bot.sent().at(-1).message_thread_id, 7);
  assert.equal(bot.sent().at(-1).reply_markup, undefined);
});

test('button replies target the clicked bot message, while resumed FACEIT jobs keep the original command anchor', async t => {
  let advances = 0;
  const bot = await makeHarness(t, { settings: { autoAdvanceBatches: 1 }, faceitOverrides: { advance(state) {
    advances++;
    return advances === 1 ? { done: false, state: { ...state, phase: 'details' }, progress: { message: 'Загрузка' } }
      : { done: true, state, report: fixtureReport(state.kind, state.nickname) };
  } } });
  await bot.click('help', { topicId: 7 });
  assert.deepEqual(bot.sent().at(-1).reply_parameters, reply(50));
  const commandId = await bot.send('/stats Nick', { topicId: 7 });
  const refusal = bot.sent().at(-1);
  assert.deepEqual(refusal.reply_parameters, reply(commandId));
  assert.equal(refusal.reply_markup, undefined);
  assert.equal(bot.sent('sendPhoto').length, 0);
  const job = await bot.db.get('SELECT * FROM report_jobs');
  const callback = `continue:${job.job_id}`;
  bot.restart();
  await bot.click(callback, { topicId: 7 });
  assert.equal(bot.renderedReports.at(-1).kind, 'stats');
  assert.deepEqual(bot.sent('sendPhoto').at(-1).reply_parameters, reply(commandId));
});

test('successful TeamSpeak setup does not reply to the deleted credentials message or repeat its password', async t => {
  const bot = await makeHarness(t);
  const commandId = await bot.send('/setts ts.example.org private-fixture-password');
  assert.equal(bot.sent('deleteMessage').at(-1).message_id, commandId);
  const confirmation = bot.sent().at(-1);
  assert.equal(confirmation.reply_parameters, undefined);
  assert.ok(!confirmation.text.includes('private-fixture-password'));
  const id = await bot.send('/ts');
  assert.deepEqual(bot.sent().at(-1).reply_parameters, reply(id));
});

test('Telegram adapter serializes reply parameters for JSON and multipart without adding cross-chat targets', async () => {
  const calls = [];
  const api = createTelegramApi({ token: '123456:' + 'fixture_'.repeat(4), fetch: async (url, options) => {
    calls.push({ ...options, method: new URL(url).pathname.split('/').at(-1) });
    return Response.json({ ok: true, result: { message_id: 99 } });
  } });
  await api.sendMessage({ chat_id: -10, text: 'reply', reply_parameters: reply(5) });
  assert.deepEqual(JSON.parse(calls.at(-1).body).reply_parameters, reply(5));
  await api.sendPhoto({ chat_id: -10, photo: createInputFile(new Uint8Array([1, 2]), 'fixture.png'), reply_parameters: reply(5) });
  assert.deepEqual(JSON.parse(calls.at(-1).body.get('reply_parameters')), reply(5));
  for (const [method, params] of [
    ['forwardMessage', { chat_id: -10, from_chat_id: -10, message_id: 1 }],
    ['pinChatMessage', { chat_id: -10, message_id: 2, disable_notification: true }],
    ['unpinChatMessage', { chat_id: -10, message_id: 1 }],
  ]) { await api[method](params); assert.equal(calls.at(-1).method, method); assert.deepEqual(JSON.parse(calls.at(-1).body), params); }
  assert.equal(api.unpinAllChatMessages, undefined);
  assert.equal(api.stopPoll, undefined);
});


test('a failed legacy FACEIT callback still replies to the original command without repeating the refusal', async t => {
  let calls = 0;
  const bot = await makeHarness(t, { settings: { autoAdvanceBatches: 1 }, faceitOverrides: { advance(state) {
    if (++calls === 1) return { done: false, state: { ...state, phase: 'details' } };
    throw Object.assign(new Error('synthetic-upstream-private-detail'), { code: 'FACEIT_ACCESS_DENIED' });
  } } });
  const commandId = await bot.send('/stats Nick', { topicId: 7 });
  const job = await bot.db.get('SELECT job_id FROM report_jobs');
  await bot.click(`continue:${job.job_id}`, { topicId: 7 }, 900);
  assert.deepEqual(bot.sent().at(-1).reply_parameters, reply(commandId));
  assert.equal(bot.sent().at(-1).message_thread_id, 7);
  assert.equal(bot.sent().at(-1).reply_markup, undefined);
  assert.doesNotMatch(bot.sent().at(-1).text, /synthetic-upstream-private-detail/);
  assert.equal(bot.sent('sendPhoto').length, 0);
  const count = bot.sent().length;
  await bot.click(`continue:${job.job_id}`, { topicId: 7 }, 900);
  assert.equal(bot.sent().length, count);
});
