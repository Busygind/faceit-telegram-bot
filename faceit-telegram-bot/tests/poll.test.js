import test from 'node:test';
import assert from 'node:assert/strict';
import { todayPoll } from '../tgcloud/lib/poll.js';
import { makeHarness } from './bot-harness.js';

const expectedOptions = [
  'да, в 14', 'да, в 15', 'да, в 16',
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
  assert.equal(todayPoll(-10).options.length, 12);
  assert.ok(!todayPoll(-10).options.some(option => option.text === 'да, в 13'));
});

test('same update is deduplicated and a new command within the Moscow poll window forwards and repins the same poll', async (t) => {
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
  assert.equal(bot.sent('sendPoll').length, 1);
  assert.equal(bot.sent('forwardMessage').length, 1);
  assert.equal(bot.sent('pinChatMessage').length, 2);
  assert.equal(bot.sent('unpinChatMessage').length, 1);
  assert.equal(bot.sent('forwardMessage')[0].message_id, delivery.message_id);
  assert.ok(!bot.calls.some(({ method }) => ['unpinAllChatMessages', 'stopPoll'].includes(method)));
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


test('poll commands reuse one vote per fixed Moscow window across bot restarts, even when it is older than three hours', async t => {
  const at = value => Date.parse(value) / 1000;
  let now = at('2026-11-08T02:59:59+03:00');
  const bot = await makeHarness(t, { now: () => now });
  const run = async value => {
    now = at(value);
    bot.restart();
    await bot.send('/poll', { userId: 2, topicId: 7 });
    return bot.store.getPollState(-10);
  };
  const night = await run('2026-11-08T02:59:59+03:00');
  const morning = await run('2026-11-08T03:00:00+03:00');
  assert.equal(bot.sent('sendPoll').length, 2, '03:00 starts a new period even if the preceding poll is one second old');
  assert.notEqual(morning.original_message_id, night.original_message_id);
  await run('2026-11-08T03:00:01+03:00');
  await run('2026-11-08T08:59:59+03:00');
  assert.equal(bot.sent('sendPoll').length, 2, '03:00–09:00 shares a separate morning poll');
  assert.equal(bot.sent('forwardMessage').at(-1).message_id, morning.original_message_id);
  const day = await run('2026-11-08T09:00:00+03:00');
  assert.equal(bot.sent('sendPoll').length, 3);
  await run('2026-11-08T13:00:00+03:00');
  await run('2026-11-09T02:59:59+03:00');
  assert.equal(bot.sent('sendPoll').length, 3, 'four and almost eighteen hours old is still the same fixed daytime poll');
  assert.equal(bot.sent('forwardMessage').at(-1).message_id, day.original_message_id);
  assert.equal((await bot.store.getPollState(-10)).created_at, at('2026-11-08T09:00:00+03:00'), 'forwards never slide the cutoff');
  await run('2026-11-09T03:00:00+03:00');
  assert.equal(bot.sent('sendPoll').length, 4);
});


test('new poll options do not replace an existing legacy vote in the same Moscow window', async t => {
  let now = Date.parse('2026-11-07T09:00:00+03:00') / 1000;
  const bot = await makeHarness(t, { now: () => now });
  // The previous bot version accepted this nine-option poll; do not split its votes.
  await bot.store.claimDelivery('u:previous-version', -10, 7, 'poll');
  await bot.store.finishDelivery('u:previous-version', 'sent', { message_id: 42, poll: { id: 'legacy-nine-options' } });
  now += 4 * 3600;
  bot.restart();
  await bot.send('/poll', { userId: 2, topicId: 7 });
  assert.equal(bot.sent('sendPoll').length, 0);
  assert.equal(bot.sent('forwardMessage').length, 1);
  assert.equal(bot.sent('forwardMessage')[0].message_id, 42);
  assert.equal((await bot.store.getPollState(-10)).poll_id, 'legacy-nine-options');
  now = Date.parse('2026-11-08T03:00:00+03:00') / 1000;
  bot.restart();
  await bot.send('/poll', { userId: 2, topicId: 7 });
  assert.equal(bot.sent('sendPoll').length, 1);
  assert.deepEqual(bot.sent('sendPoll')[0].options.map(option => option.text), expectedOptions);
  assert.equal(bot.sent('sendPoll')[0].options.length, 12);
});
