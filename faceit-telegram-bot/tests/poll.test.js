import test from 'node:test';
import assert from 'node:assert/strict';
import { todayPoll } from '../tgcloud/lib/poll.js';
import { makeHarness } from './bot-harness.js';

const expectedOptions = [
  'да, в 17', 'да, в 18', 'да, в 19', 'да, в 20', 'да, в 21',
  'да, в 22', 'да, в 23', 'да, позже', 'нет',
];

test('poll serialized payload has exact question/options, public multiple revotable answers, all extras off', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(todayPoll(-10, 7))), {
    chat_id: -10, message_thread_id: 7, question: 'Играть сегодня (время по МСК)',
    options: expectedOptions.map((text) => ({ text })), type: 'regular',
    is_anonymous: false, allows_multiple_answers: true, allows_revoting: true,
    shuffle_options: false, allow_adding_options: false, hide_results_until_closes: false,
    is_closed: false, disable_notification: false, protect_content: false, allow_paid_broadcast: false,
  });
  assert.ok(!Object.hasOwn(todayPoll(-10), 'message_thread_id'));
  assert.deepEqual(todayPoll(-10).options.map((option) => option.text), expectedOptions);
});

test('same update creates one poll; explicit new command creates another without one-per-day limit', async (t) => {
  const bot = await makeHarness(t);
  const id = await bot.send('/poll', { userId: 2, topicId: 7 });
  await bot.send('/poll', { userId: 2, topicId: 7 }, id);
  assert.equal(bot.sent('sendPoll').length, 1);
  const delivery = await bot.db.get('SELECT * FROM deliveries WHERE request_id=:id', { ':id': `u:${id}` });
  assert.equal(delivery.status, 'sent');
  assert.equal(delivery.chat_id, -10);
  assert.equal(delivery.topic_id, 7);
  assert.equal(delivery.poll_id, 'fixture-poll');
  await bot.send('/poll', { userId: 2, topicId: 7 });
  assert.equal(bot.sent('sendPoll').length, 2);
  assert.ok(!bot.calls.some(({ method }) => ['pinChatMessage', 'stopPoll'].includes(method)));
});

test('unknown POST outcome is recorded and never automatically retried after duplicate delivery/restart', async (t) => {
  const bot = await makeHarness(t, { apiOverrides: { sendPoll: () => { throw new Error('connection lost'); } } });
  const id = await bot.send('/poll');
  assert.match(bot.sent().at(-1).text, /Возможно, он уже создан/);
  const row = await bot.db.get('SELECT * FROM deliveries WHERE request_id=:id', { ':id': `u:${id}` });
  assert.equal(row.status, 'outcome_unknown');
  bot.restart();
  await bot.send('/poll', {}, id);
  assert.equal(bot.sent('sendPoll').length, 1);
});

test('definite permission/flood failure does not retry and extra poll arguments are rejected', async (t) => {
  for (const code of [403, 429]) {
    const bot = await makeHarness(t, { apiOverrides: { sendPoll: () => {
      throw Object.assign(new Error('rejected'), { code });
    } } });
    const id = await bot.send('/poll');
    assert.equal(bot.sent('sendPoll').length, 1);
    assert.match(bot.sent().at(-1).text, /Не удалось создать опрос/);
    assert.equal((await bot.db.get('SELECT * FROM deliveries WHERE request_id=:id', { ':id': `u:${id}` })).status, 'rejected');
    await bot.send('/poll завтра');
    assert.equal(bot.sent('sendPoll').length, 1);
  }
});
