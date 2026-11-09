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

  test(`${kind} report-render failure sends one safe final text under the same photo tombstone`, async t => {
    const bot = await makeHarness(t, { renderCard: report => {
      if (report.kind !== 'notice') throw new Error('PRIVATE_RENDER_ERROR');
      return IMAGE;
    } });
    await bot.send(`/${kind} Nick`);
    assert.deepEqual(bot.renderedReports.map(report => report.kind), [kind]);
    assert.equal(bot.sent().length, 1);
    assert.match(bot.sent()[0].text, /Не удалось отправить карточку/);
    assert.ok(!bot.sent()[0].text.includes('PRIVATE_RENDER_ERROR'));
    assert.equal(bot.sent()[0].reply_markup, undefined);
    assert.equal(bot.sent('sendPhoto').length, 0);
    const photo = await bot.db.get("SELECT * FROM deliveries WHERE kind='photo'");
    assert.equal(photo.status, 'rejected');
    assert.equal((await bot.db.all("SELECT * FROM deliveries WHERE kind='notice'")).length, 0);
    const job = await bot.db.get('SELECT * FROM report_jobs');
    await bot.click(`continue:${job.job_id}`);
    assert.equal(bot.sent('sendPhoto').length, 0);
    assert.equal(bot.renderedReports.length, 1);
    assert.equal(bot.sent().length, 1);
  });

  test(`${kind} renderer failure records rejection without rendering an intermediate notice`, async t => {
    const bot = await makeHarness(t, { renderCard: () => { throw new Error('PRIVATE_RENDER_ERROR'); } });
    await bot.send(`/${kind} Nick`);
    assert.deepEqual(bot.renderedReports.map(report => report.kind), [kind]);
    assert.equal(bot.sent('sendPhoto').length, 0);
    assert.equal((await bot.db.get("SELECT * FROM deliveries WHERE kind='photo'")).status, 'rejected');
    assert.equal(bot.sent().length, 1);
    assert.ok(!bot.sent()[0].text.includes('PRIVATE_RENDER_ERROR'));
    assert.equal(bot.sent()[0].reply_markup, undefined);
  });

  for (const [failure, status] of [
    [Object.assign(new Error('PRIVATE_API_ERROR'), { code: 403 }), 'rejected'],
    [new Error('PRIVATE_TRANSPORT_ERROR'), 'outcome_unknown'],
  ]) {
    test(`${kind} ${status} photo never retries an uncertain POST or renders another image`, async t => {
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
      assert.equal(bot.sent().length, status === 'rejected' ? 1 : 0);
      for (const message of bot.sent()) {
        assert.equal(message.reply_markup, undefined);
        assert.ok(!message.text.includes('PRIVATE_API_ERROR'));
      }
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

test('FACEIT command syntax, API errors and hints use deduplicated final text, not notice images', async t => {
  const bot = await makeHarness(t, { faceitOverrides: { start: () => {
    throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'PLAYER_NOT_FOUND' });
  } } });
  for (const text of ['/stats', '/last Nick WithSpaces', '/stats MissingNick']) {
    const updateId = await bot.send(text);
    const count = bot.sent().length;
    await bot.send(text, {}, updateId);
    assert.equal(bot.sent().length, count);
  }
  await bot.click('hint:last', {}, 9001);
  await bot.click('hint:last', {}, 9001);
  await bot.click('hint:stats', {}, 9002);
  assert.equal(bot.sent().length, 5);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.renderedReports.length, 0);
  assert.ok(bot.sent().every(message => !message.text.includes('PRIVATE_ERROR') && !message.reply_markup));
  assert.match(bot.sent()[2].text, /Игрок FACEIT не найден/);
});

test('FACEIT membership and private-chat errors are text-only without bypassing group access', async t => {
  const bot = await makeHarness(t);
  const updateId = await bot.send('/stats Nick', { userId: 3 });
  await bot.send('/stats Nick', { userId: 3 }, updateId);
  assert.equal(bot.sent().length, 1);
  assert.match(bot.sent()[0].text, /Не могу подтвердить членство/);
  await bot.send('/last Nick', { chatType: 'private' });
  assert.equal(bot.sent().length, 2);
  assert.match(bot.sent()[1].text, /только в группе/);
  await bot.send('/stats Nick', { chatId: 999 });
  await bot.click('continue:unknown', { chatId: 999 });
  assert.equal(bot.sent().length, 2);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.renderedReports.length, 0);
  assert.equal(bot.starts.length, 0);
  assert.ok(bot.sent().every(message => !message.reply_markup));
});

test('a leased job returns one final busy text without issuing more FACEIT calls or continuation buttons', async t => {
  const bot = await makeHarness(t);
  await bot.store.createJob('busy', -10, 7, { kind: 'stats', nickname: 'Nick', phase: 'history' });
  await bot.store.leaseJob('busy', 0);
  await bot.click('continue:busy', { topicId: 7 });
  assert.equal(bot.advances.length, 0);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 1);
  assert.match(bot.sent()[0].text, /уже обрабатывается/);
  assert.equal(bot.sent()[0].reply_markup, undefined);
});

test('legacy continuation API errors and unavailable jobs use safe final text', async t => {
  const bot = await makeHarness(t, { faceitOverrides: { advance: () => {
    throw Object.assign(new Error('PRIVATE_CALLBACK_ERROR'), { code: 'FACEIT_ACCESS_DENIED' });
  } } });
  await bot.store.createJob('error', -10, 7, { kind: 'stats', nickname: 'Nick', phase: 'history' });
  await bot.click('continue:error', { topicId: 7 });
  assert.match(bot.sent()[0].text, /FACEIT отклонил ключ API/);
  assert.ok(!bot.sent()[0].text.includes('PRIVATE_CALLBACK_ERROR'));
  await bot.click('continue:missing', { topicId: 7 });
  assert.match(bot.sent()[1].text, /недоступен в текущем чате/);
  assert.equal(bot.sent().length, 2);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.renderedReports.length, 0);
  assert.ok(bot.sent().every(message => !message.reply_markup));
});
