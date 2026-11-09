import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './bot-harness.js';

const credentials = (password = 'synthetic-ts-password') => ({ host: 'voice.example.test', password });
const reply = message_id => ({ message_id, allow_sending_without_reply: true });

async function configured(t, options = {}) {
  const bot = await makeHarness(t, options);
  await bot.store.saveSettings(-10, credentials(), bot.dependencies.sealer);
  return bot;
}

function observeDatabase(bot) {
  const queries = [];
  for (const method of ['run', 'get', 'all']) {
    const original = bot.db[method].bind(bot.db);
    bot.db[method] = async (...args) => {
      queries.push(args[0]);
      return original(...args);
    };
  }
  return queries;
}

for (const callback of [false, true]) {
  const source = callback ? 'button' : 'slash command';

  test(`TeamSpeak ${source} sends its reply before awaited retention cleanup and checks eligibility only once`, async t => {
    const bot = await configured(t);
    const queries = observeDatabase(bot);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const cleanup = bot.store.cleanup.bind(bot.store);
    bot.store.cleanup = async () => {
      entered.resolve();
      await release.promise;
      await cleanup();
    };
    let finished = false;
    const pending = (callback
      ? bot.click('ts', { userId: 2, topicId: 7 }, 900)
      : bot.send('/ts', { userId: 2, topicId: 7 }, 900))
      .then(() => { finished = true; });
    try {
      await Promise.race([entered.promise, pending.then(() => {
        assert.fail('the handler completed without awaited retention cleanup');
      })]);
      assert.equal(finished, false, 'maintenance is awaited before acknowledging the update');
      assert.equal(bot.sent().length, 1, 'maintenance cannot delay the visible TeamSpeak response');
      assert.match(bot.sent()[0].text, /synthetic-ts-password/);
      assert.deepEqual(bot.sent()[0].reply_parameters, reply(callback ? 50 : 900));
      assert.equal(bot.sent()[0].chat_id, -10);
      assert.equal(bot.sent()[0].message_thread_id, 7);
      assert.equal(queries.length, 3, 'only eligibility, deduplication and current settings precede the response');
      assert.equal(queries.filter(sql => sql.includes('origin_chat_id = :id')).length, 1);
      assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
      assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 1);
    } finally {
      release.resolve();
      await pending;
    }
    assert.equal(queries.filter(sql => sql.startsWith('DELETE')).length, 3, 'all retention rules still run');
    assert.equal(queries.length, 6);
  });

  test(`TeamSpeak ${source} cleanup failure after delivery cannot emit another response or expose the exception`, async t => {
    const bot = await configured(t);
    let attempts = 0;
    bot.store.cleanup = async () => {
      attempts++;
      assert.equal(bot.sent().length, 1, 'the action reply must already be sent');
      throw new Error('synthetic-private-maintenance-detail');
    };
    if (callback) await bot.click('ts', { userId: 2 });
    else await bot.send('/ts', { userId: 2 });
    assert.equal(attempts, 1);
    assert.equal(bot.sent().length, 1);
    assert.match(bot.sent()[0].text, /synthetic-ts-password/);
    assert.doesNotMatch(bot.sent()[0].text, /synthetic-private-maintenance-detail|Не удалось выполнить запрос/);
  });
}

test('TeamSpeak authorization stays fresh after membership revocation and prevents settings reads or decryption', async t => {
  let member = { status: 'member' };
  const bot = await configured(t, { apiOverrides: { getChatMember: () => member } });
  let reads = 0;
  let decryptions = 0;
  const getSettings = bot.store.getSettings.bind(bot.store);
  bot.store.getSettings = async (...args) => { reads++; return getSettings(...args); };
  const open = bot.dependencies.sealer.open.bind(bot.dependencies.sealer);
  bot.dependencies.sealer = { ...bot.dependencies.sealer, open(...args) { decryptions++; return open(...args); } };
  bot.restart();
  await bot.send('/ts', { userId: 2 });
  member = { status: 'left' };
  await bot.send('/ts', { userId: 2 });
  member = { status: 'kicked' };
  await bot.click('ts', { userId: 2 });
  member = { status: 'restricted', is_member: false };
  await bot.send('/ts', { userId: 2 });
  assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 4);
  assert.equal(reads, 1, 'unauthorized updates cannot read encrypted credentials');
  assert.equal(decryptions, 1, 'only the authorized request decrypts TeamSpeak settings');
  assert.equal(bot.sent().filter(message => message.text.includes('synthetic-ts-password')).length, 1);
});

test('TeamSpeak replies read the latest saved settings instead of caching an earlier password', async t => {
  const bot = await configured(t);
  await bot.send('/ts', { userId: 2 });
  assert.match(bot.sent().at(-1).text, /synthetic-ts-password/);
  await bot.store.saveSettings(-10, credentials('synthetic-replaced-password'), bot.dependencies.sealer);
  await bot.send('/ts', { userId: 2 });
  const changed = bot.sent().at(-1).text;
  assert.match(changed, /synthetic-replaced-password/);
  assert.doesNotMatch(changed, /synthetic-ts-password/);
  await bot.store.saveSettings(-10, credentials('synthetic-latest-password'), bot.dependencies.sealer);
  await bot.click('ts', { userId: 2 });
  const latest = bot.sent().at(-1).text;
  assert.match(latest, /synthetic-latest-password/);
  assert.doesNotMatch(latest, /synthetic-replaced-password|synthetic-ts-password/);
  assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 3);
});

test('TeamSpeak deduplicates retried slash and button updates without losing per-chat topic or reply isolation', async t => {
  const bot = await configured(t);
  await bot.store.saveSettings(-20, credentials('synthetic-other-chat-password'), bot.dependencies.sealer);
  for (let attempt = 0; attempt < 2; attempt++) {
    await bot.send('/ts', { userId: 2, topicId: 7 }, 900);
    await bot.click('ts', { chatId: -20, userId: 2, topicId: 88 }, 901);
  }
  assert.equal(bot.sent().length, 2);
  const [first, second] = bot.sent();
  assert.equal(first.chat_id, -10);
  assert.equal(first.message_thread_id, 7);
  assert.deepEqual(first.reply_parameters, reply(900));
  assert.match(first.text, /synthetic-ts-password/);
  assert.doesNotMatch(first.text, /synthetic-other-chat-password/);
  assert.equal(second.chat_id, -20);
  assert.equal(second.message_thread_id, 88);
  assert.deepEqual(second.reply_parameters, reply(50));
  assert.match(second.text, /synthetic-other-chat-password/);
  assert.doesNotMatch(second.text, /synthetic-ts-password/);
  assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 4, 'membership is not cached even for retries');
});

test('retired chats and failed live membership lookups cannot read or decrypt TeamSpeak settings', async t => {
  const bot = await configured(t, { apiOverrides: { getChatMember: () => { throw new Error('synthetic-lookup-failure'); } } });
  await bot.store.migrateChat(-10, -10010, bot.dependencies.sealer);
  let reads = 0;
  bot.store.getSettings = async () => { reads++; throw new Error('unauthorized-settings-read'); };
  bot.dependencies.sealer = { ...bot.dependencies.sealer, open() { assert.fail('must not decrypt without live membership'); } };
  bot.restart();
  await bot.send('/ts', { userId: 2 });
  await bot.click('ts', { userId: 2 });
  assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 0, 'retired chat IDs are rejected before Telegram authorization');
  assert.equal(bot.sent().length, 0);
  await bot.send('/ts', { chatId: -10010, userId: 2 });
  await bot.click('ts', { chatId: -10010, userId: 2 });
  assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 2);
  assert.equal(reads, 0);
  assert.ok(bot.sent().every(message => !message.text.includes('synthetic-ts-password')));
});

test('TeamSpeak mutation still rechecks live administrator privileges before saving or deleting its command', async t => {
  let statuses = ['administrator', 'member'];
  const bot = await configured(t, { apiOverrides: { getChatMember: () => ({ status: statuses.shift() ?? 'member' }) } });
  const before = await bot.store.getSettings(-10);
  await bot.send('/setts changed.example.test synthetic-new-password');
  assert.deepEqual(await bot.store.getSettings(-10), before);
  assert.equal(bot.sent('deleteMessage').length, 0);
  assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 2);
  assert.doesNotMatch(bot.sent().at(-1).text, /synthetic-new-password/);
  statuses = ['administrator', 'administrator'];
  await bot.send('/setts changed.example.test synthetic-new-password');
  assert.notEqual((await bot.store.getSettings(-10)).ciphertext, before.ciphertext);
  assert.equal(bot.sent('deleteMessage').length, 1);
  assert.equal(bot.calls.filter(call => call.method === 'getChatMember').length, 4);
});
