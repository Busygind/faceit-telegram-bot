import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, fixtureReport } from './bot-harness.js';

const IMAGE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function imageOnly(bot) {
  assert.equal(bot.sent().length, 0, 'FACEIT must not send separate text messages');
  assert.ok(bot.sent('sendPhoto').every(photo => !Object.hasOwn(photo, 'caption')), 'FACEIT images must not have captions');
}

for (const kind of ['last', 'stats']) {
  test(`${kind} sends only its named image in the original chat and topic`, async t => {
    const bot = await makeHarness(t);
    await bot.send(`/${kind} ExplicitNick`, { topicId: 19 });
    assert.equal(bot.renderedReports.length, 1);
    assert.equal(bot.renderedReports[0].kind, kind);
    assert.equal(bot.renderedReports[0].nickname, 'ExplicitNick');
    const photos = bot.sent('sendPhoto');
    assert.equal(photos.length, 1);
    assert.equal(photos[0].photo.name, kind === 'last' ? 'faceit-last-match.png' : 'faceit-stats.png');
    assert.deepEqual(photos[0].photo.bytes, IMAGE);
    assert.equal(photos[0].chat_id, -10);
    assert.equal(photos[0].message_thread_id, 19);
    assert.ok(photos[0].reply_markup.inline_keyboard.flat().some(button => button.url?.startsWith('https://www.faceit.com/')));
    assert.ok(photos[0].reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'help'));
    imageOnly(bot);
    assert.equal((await bot.db.all("SELECT * FROM deliveries WHERE kind='text'")).length, 0);
    assert.equal((await bot.db.get("SELECT * FROM deliveries WHERE kind='photo'")).status, 'sent');
  });

  test(`${kind} empty report still sends one no-matches image without caption or text`, async t => {
    const bot = await makeHarness(t, { faceitOverrides: { advance: state => ({ done: true, state,
      report: { ...fixtureReport(state.kind, state.nickname), count: 0, wins: 0, losses: 0,
        winRate: null, recent: [], range: { from: null, to: null }, matches: [], match: null },
    }) } });
    await bot.send(`/${kind} EmptyNick`);
    assert.equal(bot.sent('sendPhoto').length, 1);
    assert.equal(bot.renderedReports[0].count, 0);
    assert.deepEqual(bot.renderedReports[0].matches, []);
    assert.ok(!bot.sent('sendPhoto')[0].reply_markup.inline_keyboard.flat().some(button => button.url));
    imageOnly(bot);
  });

  test(`${kind} report-render failure sends one notice image under the same photo tombstone`, async t => {
    const bot = await makeHarness(t, { renderCard: report => {
      if (report.kind !== 'notice') throw new Error('PRIVATE_RENDER_ERROR');
      return IMAGE;
    } });
    await bot.send(`/${kind} Nick`);
    assert.deepEqual(bot.renderedReports.map(report => report.kind), [kind, 'notice']);
    assert.match(bot.renderedReports[1].message, /Не удалось создать карточку/);
    assert.ok(!bot.renderedReports[1].message.includes('PRIVATE_RENDER_ERROR'));
    assert.equal(bot.sent('sendPhoto').length, 1);
    assert.equal(bot.sent('sendPhoto')[0].photo.name, 'faceit-status.png');
    const photo = await bot.db.get("SELECT * FROM deliveries WHERE kind='photo'");
    assert.equal(photo.status, 'sent');
    assert.equal((await bot.db.all("SELECT * FROM deliveries WHERE kind='notice'")).length, 0);
    const job = await bot.db.get('SELECT * FROM report_jobs');
    await bot.click(`continue:${job.job_id}`);
    assert.equal(bot.sent('sendPhoto').length, 1);
    assert.equal(bot.renderedReports.length, 2);
    imageOnly(bot);
  });

  test(`${kind} double render failure records rejection and never falls back to text`, async t => {
    const bot = await makeHarness(t, { renderCard: () => { throw new Error('PRIVATE_RENDER_ERROR'); } });
    await bot.send(`/${kind} Nick`);
    assert.deepEqual(bot.renderedReports.map(report => report.kind), [kind, 'notice']);
    assert.equal(bot.sent('sendPhoto').length, 0);
    assert.equal((await bot.db.get("SELECT * FROM deliveries WHERE kind='photo'")).status, 'rejected');
    imageOnly(bot);
  });

  for (const [failure, status] of [
    [Object.assign(new Error('PRIVATE_API_ERROR'), { code: 403 }), 'rejected'],
    [new Error('PRIVATE_TRANSPORT_ERROR'), 'outcome_unknown'],
  ]) {
    test(`${kind} ${status} photo is not followed by text, another notice or a retry`, async t => {
      const bot = await makeHarness(t, { apiOverrides: { sendPhoto: () => { throw failure; } } });
      const updateId = await bot.send(`/${kind} Nick`, { topicId: 7 });
      assert.equal(bot.sent('sendPhoto').length, 1);
      assert.equal(bot.renderedReports.length, 1);
      assert.equal(bot.renderedReports[0].kind, kind);
      const photo = await bot.db.get("SELECT * FROM deliveries WHERE kind='photo'");
      assert.equal(photo.status, status);
      await bot.send(`/${kind} Nick`, { topicId: 7 }, updateId);
      const job = await bot.db.get('SELECT * FROM report_jobs');
      bot.restart();
      await bot.click(`continue:${job.job_id}`, { topicId: 7 });
      await bot.click(`continue:${job.job_id}`, { topicId: 7 });
      assert.equal(bot.sent('sendPhoto').length, 1);
      assert.equal(bot.renderedReports.length, 1);
      imageOnly(bot);
    });
  }
}

test('last with delayed detailed stats sends one honest report image without text fallback', async t => {
  const bot = await makeHarness(t, { faceitOverrides: { advance: state => {
    const report = fixtureReport(state.kind, state.nickname);
    report.match.statsAvailable = false;
    report.match.partial = true;
    report.match.player = { kills: null, deaths: null, assists: null, kd: null, kr: null, hs: null, adr: null };
    return { done: true, state, report };
  } } });
  await bot.send('/last Nick');
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.equal(bot.renderedReports[0].kind, 'last');
  assert.equal(bot.renderedReports[0].match.statsAvailable, false);
  assert.equal(bot.renderedReports[0].match.player.kills, null);
  imageOnly(bot);
});

test('FACEIT command syntax, API errors and hints use deduplicated notice images', async t => {
  const bot = await makeHarness(t, { faceitOverrides: { start: () => {
    throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'PLAYER_NOT_FOUND' });
  } } });
  for (const text of ['/stats', '/last Nick WithSpaces', '/stats MissingNick']) {
    const updateId = await bot.send(text);
    const count = bot.sent('sendPhoto').length;
    await bot.send(text, {}, updateId);
    assert.equal(bot.sent('sendPhoto').length, count);
  }
  await bot.click('hint:last', {}, 9001);
  await bot.click('hint:last', {}, 9001);
  await bot.click('hint:stats', {}, 9002);
  assert.equal(bot.sent('sendPhoto').length, 5);
  assert.ok(bot.renderedReports.every(report => report.kind === 'notice'));
  assert.ok(bot.renderedReports.every(report => !report.message.includes('PRIVATE_ERROR')));
  assert.match(bot.renderedReports[2].message, /Игрок FACEIT не найден/);
  imageOnly(bot);
});

test('FACEIT membership and private-chat errors are image-only without bypassing group access', async t => {
  const bot = await makeHarness(t);
  const updateId = await bot.send('/stats Nick', { userId: 3 });
  await bot.send('/stats Nick', { userId: 3 }, updateId);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.match(bot.renderedReports[0].message, /Не могу подтвердить членство/);
  await bot.send('/last Nick', { chatType: 'private' });
  assert.equal(bot.sent('sendPhoto').length, 2);
  assert.match(bot.renderedReports[1].message, /только в группе/);
  await bot.send('/stats Nick', { chatId: 999 });
  await bot.click('continue:unknown', { chatId: 999 });
  assert.equal(bot.sent('sendPhoto').length, 2);
  assert.equal(bot.starts.length, 0);
  imageOnly(bot);
});

test('a leased job uses a notice image and continuation button without advancing FACEIT', async t => {
  const bot = await makeHarness(t);
  await bot.store.createJob('busy', -10, 7, { kind: 'stats', nickname: 'Nick', phase: 'history' });
  await bot.store.leaseJob('busy', 0);
  await bot.click('continue:busy', { topicId: 7 });
  assert.equal(bot.advances.length, 0);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.match(bot.renderedReports[0].title, /уже обрабатывается/);
  assert.ok(bot.sent('sendPhoto')[0].reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'continue:busy'));
  imageOnly(bot);
});

test('continuation API errors and unavailable jobs use safe notice images', async t => {
  const bot = await makeHarness(t, { faceitOverrides: { advance: () => {
    throw Object.assign(new Error('PRIVATE_CALLBACK_ERROR'), { code: 'FACEIT_ACCESS_DENIED' });
  } } });
  await bot.store.createJob('error', -10, 7, { kind: 'stats', nickname: 'Nick', phase: 'history' });
  await bot.click('continue:error', { topicId: 7 });
  assert.match(bot.renderedReports[0].message, /FACEIT отклонил ключ API/);
  assert.ok(!bot.renderedReports[0].message.includes('PRIVATE_CALLBACK_ERROR'));
  await bot.click('continue:missing', { topicId: 7 });
  assert.match(bot.renderedReports[1].message, /недоступен в текущем чате/);
  assert.equal(bot.sent('sendPhoto').length, 2);
  imageOnly(bot);
});
