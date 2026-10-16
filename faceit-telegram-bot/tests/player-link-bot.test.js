import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './bot-harness.js';

const binding = (bot, chatId = -10, userId = 1) => bot.store.getPlayerLink(chatId, userId);

function imageResponses(bot, before, kind, nickname) {
  assert.equal(bot.sent().length, before, 'last/stats never fall back to text');
  assert.equal(bot.renderedReports.at(-1).kind, kind);
  if (nickname) assert.equal(bot.renderedReports.at(-1).nickname, nickname);
  assert.ok(bot.sent('sendPhoto').every(photo => !Object.hasOwn(photo, 'caption')));
}

test('members bind only themselves; no-argument reports select the user and chat, not the forum topic', async t => {
  const bot = await makeHarness(t);
  await bot.send('/setfaceit PlayerA', { userId: 1, topicId: 7 });
  await bot.send('/setfaceit PlayerB', { userId: 2 });
  await bot.send('/setfaceit PlayerOtherChat', { userId: 1, chatId: -20 });
  assert.equal((await binding(bot)).nickname, 'PlayerA');
  assert.equal((await binding(bot, -10, 2)).nickname, 'PlayerB');
  assert.equal((await binding(bot, -20)).nickname, 'PlayerOtherChat');
  assert.equal((await binding(bot)).player_id, 'fixture-PlayerA');
  assert.equal(bot.advances.length, 0, 'binding validates only the profile, never the history');
  assert.equal((await bot.db.all('SELECT * FROM report_jobs')).length, 0);
  bot.restart();
  const textCount = bot.sent().length;
  for (const [kind, userId, chatId, nickname] of [
    ['last', 1, -10, 'PlayerA'], ['stats', 2, -10, 'PlayerB'], ['last', 1, -20, 'PlayerOtherChat'],
  ]) {
    await bot.send(`/${kind}`, { userId, chatId, topicId: 19 });
    imageResponses(bot, textCount, kind, nickname);
    assert.deepEqual(bot.starts.at(-1), { nickname, kind, options: { playerId: `fixture-${nickname}` } });
    assert.equal(bot.sent('sendPhoto').at(-1).message_thread_id, 19);
  }
  await bot.send('/stats', { userId: 4 });
  imageResponses(bot, textCount, 'notice');
  assert.match(bot.renderedReports.at(-1).message, /\/setfaceit ник.*\/stats ник/);
  assert.equal(bot.starts.length, 6);
  assert.equal(await binding(bot, -10, 4), null);
});

test('explicit nickname overrides a saved player for this request only', async t => {
  const bot = await makeHarness(t);
  await bot.send('/setfaceit Mine');
  const original = await binding(bot);
  const textCount = bot.sent().length;
  await bot.send('/last SomeoneElse');
  assert.deepEqual(bot.starts.at(-1), { nickname: 'SomeoneElse', kind: 'last' });
  imageResponses(bot, textCount, 'last', 'SomeoneElse');
  await bot.send('/stats SomeoneElse');
  assert.deepEqual(bot.starts.at(-1), { nickname: 'SomeoneElse', kind: 'stats' });
  imageResponses(bot, textCount, 'stats', 'SomeoneElse');
  assert.deepEqual(await binding(bot), original);
  await bot.send('/stats');
  assert.deepEqual(bot.starts.at(-1).options, { playerId: original.player_id });
  imageResponses(bot, textCount, 'stats', 'Mine');
});

test('canonical validated FACEIT and stable player ID survive a nickname change', async t => {
  const bot = await makeHarness(t, { faceitOverrides: { start(nickname, kind, options) {
    return { kind, nickname: options ? 'RenamedPlayer' : 'CanonicalNick', phase: 'done',
      profile: { playerId: 'stable-player-id', nickname: options ? 'RenamedPlayer' : 'CanonicalNick' } };
  } } });
  await bot.send('/setfaceit suppliedNick');
  assert.equal((await binding(bot)).nickname, 'CanonicalNick');
  assert.equal((await binding(bot)).player_id, 'stable-player-id');
  const textCount = bot.sent().length;
  await bot.send('/last');
  assert.deepEqual(bot.starts.at(-1), { nickname: 'CanonicalNick', kind: 'last', options: { playerId: 'stable-player-id' } });
  imageResponses(bot, textCount, 'last', 'RenamedPlayer');
});

test('binding view and My FACEIT button show only the requesting user without mutation or FACEIT reads', async t => {
  const bot = await makeHarness(t);
  await bot.send('/setfaceit Mine');
  await bot.send('/setfaceit Other', { userId: 2 });
  const starts = bot.starts.length;
  await bot.send('/setfaceit');
  assert.match(bot.sent().at(-1).text, /Ваш FACEIT в этой группе: Mine/);
  await bot.click('myfaceit', { userId: 2, topicId: 7, messageFields: { from: { id: 999, is_bot: true } } });
  assert.match(bot.sent().at(-1).text, /Ваш FACEIT в этой группе: Other/);
  assert.ok(!bot.sent().at(-1).text.includes('Mine'));
  assert.equal(bot.sent().at(-1).message_thread_id, 7);
  await bot.click('myfaceit', { userId: 4 });
  assert.match(bot.sent().at(-1).text, /ещё не указан/);
  assert.equal(bot.starts.length, starts);
  assert.equal((await binding(bot)).nickname, 'Mine');
  assert.equal((await binding(bot, -10, 2)).nickname, 'Other');
});

test('last/stats menu and legacy hint buttons use callback sender rather than the message author', async t => {
  const bot = await makeHarness(t);
  await bot.send('/setfaceit PlayerA');
  await bot.send('/setfaceit PlayerB', { userId: 2 });
  await bot.send('/menu');
  const buttons = bot.sent().at(-1).reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  for (const name of ['last', 'stats', 'myfaceit']) assert.ok(buttons.includes(name));
  const commands = bot.sent('setMyCommands').at(-1).commands.map(value => value.command);
  for (const name of ['setfaceit', 'unsetfaceit', 'last', 'stats']) assert.ok(commands.includes(name));
  const textCount = bot.sent().length;
  for (const data of ['last', 'stats', 'hint:last', 'hint:stats']) {
    await bot.click(data, { userId: 2, topicId: 7, messageFields: { from: { id: 999, is_bot: true } } });
    imageResponses(bot, textCount, data.replace('hint:', ''), 'PlayerB');
    assert.equal(bot.starts.at(-1).options.playerId, 'fixture-PlayerB');
    assert.equal(bot.sent('sendPhoto').at(-1).message_thread_id, 7);
  }
  const starts = bot.starts.length;
  await bot.click('stats', { userId: 4 });
  imageResponses(bot, textCount, 'notice');
  assert.equal(bot.starts.length, starts);
  assert.match(bot.renderedReports.at(-1).message, /\/setfaceit/);
});

test('replacement and deletion are self-only, chat-scoped and idempotent per update', async t => {
  const bot = await makeHarness(t);
  await bot.send('/setfaceit Mine', {}, 8001);
  await bot.send('/setfaceit DuplicateShouldNotReplace', {}, 8001);
  await bot.send('/setfaceit Other', { userId: 2 }, 8002);
  await bot.send('/setfaceit Elsewhere', { chatId: -20 }, 8003);
  assert.equal(bot.starts.length, 3);
  await bot.send('/setfaceit Replaced', {}, 8004);
  assert.equal((await binding(bot)).nickname, 'Replaced');
  await bot.send('/unsetfaceit @someone', {}, 8005);
  assert.equal((await binding(bot)).nickname, 'Replaced');
  await bot.send('/unsetfaceit', {}, 8006);
  assert.equal(await binding(bot), null);
  assert.equal((await binding(bot, -10, 2)).nickname, 'Other');
  assert.equal((await binding(bot, -20)).nickname, 'Elsewhere');
  await bot.send('/setfaceit SavedAfterDeletion', {}, 8007);
  await bot.send('/unsetfaceit', {}, 8006);
  assert.equal((await binding(bot)).nickname, 'SavedAfterDeletion');
});

test('setting rejects mentions, extra arguments, nonmembers, bots, private/forbidden chats, forwarded and anonymous messages', async t => {
  const bot = await makeHarness(t);
  await bot.send('/setfaceit Mine');
  const original = await binding(bot);
  for (const command of ['/setfaceit @Other', '/setfaceit Other @someone', '/setfaceit Other\nExtra', '/setfaceit ' + 'X'.repeat(65)]) await bot.send(command);
  for (const configuration of [
    { userId: 3 }, { chatId: -999 }, { chatType: 'private' },
    { messageFields: { from: { id: 1, is_bot: true } } },
    { messageFields: { sender_chat: { id: -10 } } },
    { messageFields: { forward_origin: { type: 'user' } } },
    { messageFields: { forward_from: { id: 42 } } },
    { messageFields: { forward_from_chat: { id: -42 } } },
    { messageFields: { forward_sender_name: 'Hidden' } },
    { messageFields: { forward_date: 123 } },
    { messageFields: { is_automatic_forward: true } },
    { messageFields: { edit_date: 123 } },
    { updateFields: { edited_message: {} } },
  ]) {
    await bot.send('/setfaceit Other', configuration);
    await bot.send('/unsetfaceit', configuration);
    assert.deepEqual(await binding(bot), original);
  }
  assert.equal(bot.starts.length, 1);
  assert.equal((await bot.db.all('SELECT * FROM player_links')).length, 1);
});

test('invalid or unavailable FACEIT never replaces the previous validated binding or leaks errors', async t => {
  let failure;
  const bot = await makeHarness(t, { faceitOverrides: { start(nickname, kind) {
    if (failure) throw Object.assign(new Error('PRIVATE_UPSTREAM_ERROR'), { code: failure });
    return { kind, nickname, phase: 'done', profile: { playerId: 'fixture-player', nickname } };
  } } });
  await bot.send('/setfaceit Mine');
  const original = await binding(bot);
  for (const code of ['PLAYER_NOT_FOUND', 'PLAYER_NO_CS2', 'FACEIT_RATE_LIMITED', 'FACEIT_TEMPORARY']) {
    failure = code;
    await bot.send('/setfaceit Missing');
    assert.deepEqual(await binding(bot), original);
    assert.ok(!bot.sent().at(-1).text.includes('PRIVATE_UPSTREAM_ERROR'));
  }
  const textCount = bot.sent().length;
  await bot.send('/last');
  imageResponses(bot, textCount, 'notice');
  assert.match(bot.renderedReports.at(-1).message, /FACEIT временно недоступен/);
  assert.deepEqual(await binding(bot), original);
});

test('unbound, malformed and anonymous default reports remain image-only; forwarded defaults use the current sender', async t => {
  const bot = await makeHarness(t);
  await bot.send('/setfaceit Mine');
  const textCount = bot.sent().length;
  for (const text of ['/last @Other', '/stats Other Person', '/last Other\nPlayer']) {
    await bot.send(text);
    imageResponses(bot, textCount, 'notice');
  }
  await bot.send('/stats', { messageFields: { sender_chat: { id: -10 } } });
  imageResponses(bot, textCount, 'notice');
  assert.match(bot.renderedReports.at(-1).message, /своего аккаунта/);
  assert.equal(bot.starts.length, 1);
  await bot.send('/last', { messageFields: { forward_origin: { type: 'user', sender_user: { id: 42 } } } });
  imageResponses(bot, textCount, 'last', 'Mine');
  assert.equal(bot.starts.at(-1).options.playerId, 'fixture-Mine');
});
