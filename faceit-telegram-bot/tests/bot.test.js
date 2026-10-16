import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeHarness, fixtureReport } from './bot-harness.js';

test('full group path has buttons and slash commands, scoped TS, poll, last and 30-match report', async (t) => {
  const bot = await makeHarness(t, { renderCard: () => Uint8Array.from([137, 80, 78, 71]) });
  await bot.send('/menu', { topicId: 7 });
  const menu = bot.sent()[0];
  assert.equal(menu.chat_id, -10);
  assert.equal(menu.message_thread_id, 7);
  assert.ok(menu.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'poll'));
  const commands = bot.sent('setMyCommands')[0].commands.map((item) => item.command);
  for (const command of ['last', 'stats', 'poll', 'ts', 'setts', 'menu']) assert.ok(commands.includes(command));
  await bot.send('/setts 203.0.113.10:9987 fixture password  spaces', { topicId: 7 });
  assert.ok(!bot.sent().at(-1).text.includes('fixture password'));
  assert.equal(bot.sent('deleteMessage').length, 1);
  await bot.send('/ts', { userId: 2, topicId: 7 });
  assert.match(bot.sent().at(-1).text, /fixture password  spaces/);
  await bot.send('/ts', { chatId: -20 });
  assert.match(bot.sent().at(-1).text, /В этом чате TeamSpeak ещё не настроен/);
  await bot.click('poll', { userId: 2, topicId: 7 });
  assert.equal(bot.sent('sendPoll').length, 1);
  assert.equal(bot.sent('sendPoll')[0].message_thread_id, 7);
  await bot.send('/last@FixtureBot PublicNickname', { userId: 2, topicId: 7 });
  assert.equal(bot.renderedReports.at(-1).kind, 'last');
  assert.equal(bot.renderedReports.at(-1).nickname, 'PublicNickname');
  const textCount = bot.sent().length;
  await bot.send('/stats AnotherNickname', { userId: 2, topicId: 7 });
  assert.equal(bot.sent('sendPhoto').length, 2);
  assert.equal(bot.renderedReports.at(-1).nickname, 'AnotherNickname');
  assert.equal(bot.sent().length, textCount);
  assert.ok(bot.sent('sendPhoto').every(photo => !Object.hasOwn(photo, 'caption')));
  assert.deepEqual(bot.starts, [
    { nickname: 'PublicNickname', kind: 'last' }, { nickname: 'AnotherNickname', kind: 'stats' },
  ]);
  const stored = JSON.stringify(await bot.db.all('SELECT * FROM chat_settings'));
  assert.ok(!stored.includes('fixture password') && !stored.includes('203.0.113.10'));
});

test('TS mutation is admin-only, rejects forwarding/anonymous admins/edits/private chats', async (t) => {
  const bot = await makeHarness(t);
  await bot.send('/setts one.test:9987 original');
  const original = await bot.store.getSettings(-10);
  for (const configuration of [
    { userId: 2 },
    { messageFields: { sender_chat: { id: -10 } } },
    { messageFields: { forward_origin: { type: 'user' } } },
    { messageFields: { forward_from: { id: 42 } } },
    { messageFields: { forward_date: 123 } },
    { messageFields: { is_automatic_forward: true } },
    { messageFields: { edit_date: 123 } },
    { updateFields: { edited_message: {} } },
  ]) {
    await bot.send('/setts changed.test:9987 changed', configuration);
    assert.deepEqual(await bot.store.getSettings(-10), original);
  }
  await bot.send('/setts changed.test:9987 changed', { chatType: 'private' });
  assert.deepEqual(await bot.store.getSettings(-10), original);
  assert.equal(bot.sent('deleteMessage').length, 1);
  const editedHandler = new URL('../tgcloud/handlers/edited_message.js', import.meta.url);
  await assert.rejects(readFile(editedHandler), { code: 'ENOENT' });
});

test('invalid TS changes preserve old credentials and deletion failure does not roll back save', async (t) => {
  const bot = await makeHarness(t, { apiOverrides: { deleteMessage: () => { throw new Error('permission'); } } });
  await bot.send('/setts first.test:9987 old-password');
  assert.match(bot.sent().at(-1).text, /удалите её вручную/);
  assert.ok(!bot.sent().at(-1).text.includes('old-password'));
  const original = await bot.store.getSettings(-10);
  for (const value of ['first.test:9987', 'first.test:0 bad', '--no-password first.test:9987 extra']) {
    await bot.send(`/setts ${value}`);
    assert.deepEqual(await bot.store.getSettings(-10), original);
  }
  await bot.send('/setts --no-password first.test:9987');
  await bot.send('/ts');
  assert.match(bot.sent().at(-1).text, /без пароля/);
});

test('access fails closed for nonmembers, bot senders, forbidden chat and member API failures', async (t) => {
  const bot = await makeHarness(t);
  await bot.send('/poll', { userId: 3 });
  await bot.send('/stats Player', { messageFields: { from: { id: 2, is_bot: true } } });
  await bot.send('/poll', { chatId: -999 });
  await bot.click('poll', { userId: 3 });
  assert.equal(bot.sent('sendPoll').length, 0);
  assert.equal(bot.starts.length, 0);
  const failing = await makeHarness(t, { apiOverrides: { getChatMember: () => { throw new Error('no access'); } } });
  await failing.send('/ts');
  assert.match(failing.sent().at(-1).text, /Не могу подтвердить членство/);
  assert.equal((await failing.db.all('SELECT * FROM deliveries')).length, 0);
});

test('unbound FACEIT commands request a nickname and wrong bot mentions are ignored', async (t) => {
  const bot = await makeHarness(t);
  await bot.send('/last PlayerOne');
  await bot.send('/last');
  await bot.send('/stats');
  await bot.send('/stats Nick WithSpaces');
  await bot.send('/stats@AnotherBot OtherNick');
  await bot.send('/players');
  await bot.send('/addplayer Someone');
  await bot.send('/teamstats');
  assert.deepEqual(bot.starts, [{ nickname: 'PlayerOne', kind: 'last' }]);
  await bot.click('hint:stats');
  assert.equal(bot.renderedReports.at(-1).kind, 'notice');
  assert.match(bot.renderedReports.at(-1).message, /Сначала сохраните свой ник: \/setfaceit/);
  assert.ok(!(await bot.db.all("SELECT name FROM sqlite_master WHERE type='table'"))
    .some((row) => /roster|players|identities/.test(row.name)));
});

test('continuation is persisted across bot invocations and bound to its chat and forum topic', async (t) => {
  const bot = await makeHarness(t, { faceitOverrides: {
    start: (nickname, kind) => ({ nickname, kind, phase: 'history', step: 0 }),
    advance: (state) => state.step === 0
      ? { done: false, state: { ...state, step: 1 }, progress: { message: '1 из 30' } }
      : { done: true, state: { ...state, phase: 'done' }, report: fixtureReport(state.kind, state.nickname) },
  } });
  await bot.send('/stats ExplicitNick', { topicId: 7 });
  const continuation = bot.sent('sendPhoto').at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(continuation, /^continue:/);
  assert.equal((await bot.store.getJob(continuation.slice(9))).state.step, 1);
  await bot.click(continuation, { chatId: -20, topicId: 7 });
  await bot.click(continuation, { chatId: -10, topicId: 8 });
  assert.equal(bot.advances.length, 1);
  bot.restart();
  await bot.click(continuation, { chatId: -10, topicId: 7, userId: 2 });
  assert.equal(bot.starts.length, 1);
  assert.equal(bot.advances.length, 2);
  assert.equal((await bot.store.getJob(continuation.slice(9))).status, 'ready');
  assert.equal(bot.renderedReports.at(-1).nickname, 'ExplicitNick');
  const photoCount = bot.sent('sendPhoto').length;
  await bot.click(continuation, { chatId: -10, topicId: 7 });
  assert.equal(bot.sent('sendPhoto').length, photoCount);
  assert.equal(bot.sent().length, 0);
});

test('ready checkpoint resumes an interrupted delivery without retrying a claimed photo', async (t) => {
  const bot = await makeHarness(t, { renderCard: () => new Uint8Array([1, 2, 3]) });
  await bot.store.createJob('ready-fixture', -10, 7, { kind: 'stats', nickname: 'RecoveredNick', phase: 'done' });
  await bot.store.saveJob('ready-fixture', 0, { kind: 'stats', nickname: 'RecoveredNick', phase: 'done' }, 'ready');
  await bot.store.claimDelivery('photo:ready-fixture', -10, 7, 'photo');
  bot.restart();
  await bot.click('continue:ready-fixture', { topicId: 7 });
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.renderedReports.length, 0);
  assert.equal(bot.starts.length, 0);
});

test('unresolvable dense history stops honestly without an infinite continue button', async (t) => {
  const bot = await makeHarness(t, { faceitOverrides: { advance: (state) => ({
    done: false,
    state: { ...state, phase: 'history', blocked: 'HISTORY_DENSITY_UNRESOLVED' },
    progress: { reason: 'HISTORY_DENSITY_UNRESOLVED' },
  }) } });
  await bot.send('/stats DenseHistory');
  assert.match(bot.renderedReports.at(-1).message, /история слишком плотная/);
  assert.ok(!bot.sent('sendPhoto').at(-1).reply_markup.inline_keyboard.flat()
    .some((button) => button.callback_data.startsWith('continue:')));
  const job = await bot.db.get('SELECT * FROM report_jobs');
  assert.equal(job.status, 'blocked');
  bot.restart();
  await bot.click(`continue:${job.job_id}`);
  assert.equal(bot.advances.length, 1);
  assert.match(bot.renderedReports.at(-1).message, /Неполную выборку не выдаю за полную/);
  assert.equal(bot.sent().length, 0);
});

test('safe FACEIT errors are actionable but do not publish raw exception text', async (t) => {
  const cases = [
    ['PLAYER_NOT_FOUND', /Игрок FACEIT не найден/], ['PLAYER_NO_CS2', /нет профиля FACEIT CS2/],
    ['FACEIT_ACCESS_DENIED', /отклонил ключ API/], ['FACEIT_NOT_CONFIGURED', /пока не настроен/],
    ['FACEIT_RATE_LIMITED', /временно недоступен/], ['FACEIT_TEMPORARY', /временно недоступен/],
  ];
  for (const [code, expected] of cases) {
    const bot = await makeHarness(t, { faceitOverrides: { start: () => {
      throw Object.assign(new Error('SECRET_MUST_NOT_BE_PUBLISHED'), { code });
    } } });
    await bot.send('/last Nick');
    assert.match(bot.renderedReports.at(-1).message, expected);
    assert.ok(!bot.renderedReports.at(-1).message.includes('SECRET_MUST_NOT_BE_PUBLISHED'));
    assert.equal(bot.sent().length, 0);
    assert.equal(bot.sent('sendPhoto').length, 1);
  }
});

test('double card render failure stays image-only; ambiguous photo has no automatic retry', async (t) => {
  const fallback = await makeHarness(t, { renderCard: () => { throw new Error('render'); } });
  await fallback.send('/stats Nick');
  assert.equal(fallback.sent('sendPhoto').length, 0);
  assert.equal(fallback.sent().length, 0);
  assert.deepEqual(fallback.renderedReports.map(report => report.kind), ['stats', 'notice']);
  assert.equal((await fallback.db.get("SELECT * FROM deliveries WHERE kind='photo'")).status, 'rejected');
  const uncertain = await makeHarness(t, {
    renderCard: () => new Uint8Array([1, 2, 3]),
    apiOverrides: { sendPhoto: () => { throw new Error('timeout'); } },
  });
  const updateId = await uncertain.send('/stats Nick');
  await uncertain.send('/stats Nick', {}, updateId);
  assert.equal(uncertain.sent('sendPhoto').length, 1);
  assert.equal(uncertain.sent().length, 0);
  const photo = await uncertain.db.get("SELECT * FROM deliveries WHERE kind='photo'");
  assert.equal(photo.status, 'outcome_unknown');
});
