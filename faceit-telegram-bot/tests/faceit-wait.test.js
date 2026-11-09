import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, fixtureReport } from './bot-harness.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocal } from '../local/run.mjs';
import { openDatabase } from '../local/database.mjs';

const AUTO = { maxRequests: 4, autoAdvanceBatches: 32, autoAdvanceSeconds: 90 };
const INITIAL = 1800000000;

function noContinuation(payload) {
  return !payload.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('continue:'));
}

function retryState(nickname, kind) {
  return { nickname, kind, phase: 'history', step: 0 };
}

for (const delay of [2, 4]) {
  test(`FACEIT Retry-After ${delay}s is silently awaited and resumed in the same command`, async t => {
    let now = INITIAL;
    let bot;
    const waited = [];
    bot = await makeHarness(t, {
      now: () => now, settings: AUTO,
      faceitOverrides: {
        start: retryState,
        advance: state => state.step === 0
          ? { done: false, state: { ...state, step: 1, retryAt: now + delay }, progress: { retryAt: now + delay } }
          : { done: true, state: { ...state, phase: 'done', retryAt: null }, report: fixtureReport(state.kind, state.nickname) },
      },
    });
    bot.dependencies.waitUntil = async retryAt => {
      waited.push(retryAt);
      const job = await bot.db.get('SELECT * FROM report_jobs');
      assert.equal(job.status, 'pending');
      assert.equal(job.lease_until, 0, 'passive Retry-After must not hold an active lease');
      assert.equal(JSON.parse(job.state).step, 1, 'the completed work is persisted before waiting');
      assert.equal(bot.sent('sendPhoto').length, 0);
      assert.equal(bot.sent().length, 0);
      now = retryAt;
      return true;
    };
    bot.restart();
    await bot.send('/stats Nick', { topicId: 7 }, 750);
    assert.deepEqual(waited, [INITIAL + delay]);
    assert.equal(bot.advances.length, 2);
    assert.equal(bot.sent().length, 0);
    assert.equal(bot.sent('sendPhoto').length, 1);
    assert.equal(bot.renderedReports[0].kind, 'stats');
    assert.ok(noContinuation(bot.sent('sendPhoto')[0]));
    assert.deepEqual(bot.sent('sendPhoto')[0].reply_parameters, { message_id: 750, allow_sending_without_reply: true });
    assert.equal(bot.sent('sendPhoto')[0].message_thread_id, 7);
    const ready = await bot.db.get('SELECT * FROM report_jobs');
    assert.equal(ready.status, 'ready');
    assert.equal(ready.lease_until, 0);
    await bot.send('/stats Nick', { topicId: 7 }, 750);
    assert.equal(bot.starts.length, 1, 'Telegram redelivery does not repeat FACEIT work');
    assert.equal(bot.sent('sendPhoto').length, 1);
  });
}

test('Retry-After beyond the request deadline produces one final text without progress images', async t => {
  const bot = await makeHarness(t, {
    now: () => INITIAL, settings: AUTO,
    faceitOverrides: {
      start: retryState,
      advance: state => ({ done: false, state: { ...state, retryAt: INITIAL + 1000 }, progress: { retryAt: INITIAL + 1000 } }),
    },
  });
  bot.dependencies.waitUntil = () => { assert.fail('a retry beyond the deadline must never sleep'); };
  bot.restart();
  await bot.send('/stats Nick', {}, 751);
  assert.equal(bot.advances.length, 1);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.renderedReports.length, 0);
  assert.equal(bot.sent().length, 1);
  assert.equal(bot.sent()[0].reply_markup, undefined);
  assert.deepEqual(bot.sent()[0].reply_parameters, { message_id: 751, allow_sending_without_reply: true });
  assert.match(bot.sent()[0].text, /FACEIT|время|запрос/i);
  assert.doesNotMatch(bot.sent()[0].text, /Продолжить|Сохранила прогресс/);
  const pending = await bot.db.get('SELECT * FROM report_jobs');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.lease_until, 0);
  await bot.send('/stats Nick', {}, 751);
  assert.equal(bot.sent().length, 1);
});

test('repeated short Retry-After remains bounded and ends with only one text refusal', async t => {
  let now = INITIAL;
  const waits = [];
  const bot = await makeHarness(t, {
    now: () => now, settings: AUTO,
    faceitOverrides: {
      start: retryState,
      advance: state => ({ done: false, state: { ...state, retryAt: now + 4 }, progress: { retryAt: now + 4 } }),
    },
  });
  bot.dependencies.waitUntil = async retryAt => { waits.push(retryAt); now = retryAt; return true; };
  bot.restart();
  await bot.send('/stats Nick');
  assert.ok(waits.length > 1);
  assert.ok(waits.length <= 32);
  assert.ok(now < INITIAL + 90, 'the next wait cannot consume the delivery reserve');
  assert.ok(bot.advances.length <= 32);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.renderedReports.length, 0);
  assert.equal(bot.sent().length, 1);
  assert.equal(bot.sent()[0].reply_markup, undefined);
  assert.equal((await bot.db.get('SELECT * FROM report_jobs')).lease_until, 0);
});

test('an interrupted passive wait stops further FACEIT reads and returns one final text', async t => {
  let allowed = true;
  const bot = await makeHarness(t, {
    now: () => INITIAL, settings: AUTO,
    faceitOverrides: {
      start: retryState,
      advance: state => ({ done: false, state: { ...state, retryAt: INITIAL + 2 }, progress: { retryAt: INITIAL + 2 } }),
    },
  });
  bot.dependencies.shouldContinue = () => allowed;
  bot.dependencies.waitUntil = async () => { allowed = false; return false; };
  bot.restart();
  await bot.send('/last Nick');
  assert.equal(bot.advances.length, 1);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 1);
  assert.equal(bot.sent()[0].reply_markup, undefined);
  assert.equal((await bot.db.get('SELECT * FROM report_jobs')).lease_until, 0);
});

test('a legacy continue button silently finishes its checkpoint and preserves the original command reply', async t => {
  let now = INITIAL;
  const bot = await makeHarness(t, {
    now: () => now, settings: AUTO,
    faceitOverrides: {
      advance: state => ({ done: true, state: { ...state, phase: 'done', retryAt: null }, report: fixtureReport(state.kind, state.nickname) }),
    },
  });
  await bot.store.createJob('legacy_wait', -10, 7, {
    ...retryState('Nick', 'stats'), retryAt: INITIAL + 2, replyToMessageId: 133,
  });
  bot.dependencies.waitUntil = async retryAt => { now = retryAt; return true; };
  bot.restart();
  await bot.click('continue:legacy_wait', { topicId: 7 }, 752);
  assert.equal(bot.starts.length, 0);
  assert.equal(bot.advances.length, 1);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.sent('sendPhoto').length, 1);
  const image = bot.sent('sendPhoto')[0];
  assert.equal(image.message_thread_id, 7);
  assert.deepEqual(image.reply_parameters, { message_id: 133, allow_sending_without_reply: true });
  assert.ok(noContinuation(image));
  await bot.click('continue:legacy_wait', { topicId: 7 }, 753);
  assert.equal(bot.sent('sendPhoto').length, 1, 'old buttons cannot duplicate a completed report');
  assert.equal(bot.sent().length, 0);
});

test('legacy continue outside its topic cannot wait or fetch another report', async t => {
  const bot = await makeHarness(t, { settings: AUTO });
  await bot.store.createJob('topic_bound', -10, 7, { ...retryState('Nick', 'stats'), retryAt: INITIAL + 2 });
  bot.dependencies.waitUntil = () => { assert.fail('foreign topic cannot resume passive waiting'); };
  bot.restart();
  await bot.click('continue:topic_bound', { topicId: 8 });
  assert.equal(bot.advances.length, 0);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 1);
  assert.equal(bot.sent()[0].reply_markup, undefined);
  assert.equal((await bot.db.get('SELECT * FROM report_jobs')).version, 0);
});

test('a busy checkpoint is refused as text without image, sleep or duplicate FACEIT execution', async t => {
  const bot = await makeHarness(t, { settings: AUTO });
  await bot.store.createJob('busy_wait', -10, null, retryState('Nick', 'stats'));
  assert.equal(await bot.store.leaseJob('busy_wait', 0), true);
  bot.dependencies.waitUntil = () => { assert.fail('busy jobs cannot wait as if they own the request'); };
  bot.restart();
  await bot.click('continue:busy_wait');
  assert.equal(bot.advances.length, 0);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 1);
  assert.equal(bot.sent()[0].reply_markup, undefined);
  assert.match(bot.sent()[0].text, /обрабатыва|выполня|запрос/i);
});

test('a spent invocation refuses before the initial FACEIT profile request', async t => {
  const bot = await makeHarness(t, { settings: AUTO });
  bot.dependencies.shouldContinue = () => false;
  bot.restart();
  await bot.send('/stats Nick');
  assert.equal(bot.starts.length, 0);
  assert.equal(bot.advances.length, 0);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 1);
  assert.equal(bot.sent()[0].reply_markup, undefined);
});

test('local shutdown interrupts an active FACEIT passive wait but drains its text reply and commits the offset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-retry-stop-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.secrets'), { mode: 0o700 });
  await writeFile(join(root, '.secrets/telegram-bot.token'), `123456:${'local_fixture_'.repeat(3)}\n`, { mode: 0o600 });
  await writeFile(join(root, '.secrets/faceit.key'), 'fixture-faceit-api-key-not-real\n', { mode: 0o600 });
  const controller = new AbortController();
  const update = { update_id: 780, message: { message_id: 880, text: '/stats Nick',
    chat: { id: -10, type: 'supergroup' }, from: { id: 123, is_bot: false } } };
  const sent = [];
  let notified, polls = 0, reads = 0;
  const rateLimited = new Promise(resolve => { notified = resolve; });
  const fetch = async (url, request) => {
    const parsed = new URL(url);
    if (parsed.origin === 'https://open.faceit.com') {
      reads++;
      if (parsed.pathname.endsWith('/players')) {
        return new Response(JSON.stringify({ player_id: 'fixture-player', nickname: 'Nick', games: { cs2: { faceit_elo: 1000, skill_level: 3 } } }));
      }
      assert.ok(parsed.pathname.endsWith('/history'));
      notified();
      return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
    }
    assert.equal(parsed.origin, 'https://api.telegram.org');
    const method = parsed.pathname.split('/').at(-1);
    const params = JSON.parse(request.body);
    let result;
    if (method === 'getMe') result = { id: 999, is_bot: true, username: 'road_to_3_elo_bot' };
    else if (method === 'getWebhookInfo') result = { url: '' };
    else if (method === 'getChatMember') result = { status: 'member' };
    else if (method === 'getUpdates') { polls++; assert.equal(polls, 1); result = [update]; }
    else if (method === 'sendMessage') {
      assert.equal(request.signal.aborted, false, 'graceful stop must not abort the final Telegram reply');
      sent.push(params); result = { message_id: 881 };
    } else assert.fail(`Unexpected Telegram method: ${method}`);
    return new Response(JSON.stringify({ ok: true, result }));
  };
  const running = runLocal({ root }, { fetch, signal: controller.signal });
  await rateLimited;
  // Give the handler time to save its checkpoint and enter the passive wait.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 0);
  controller.abort();
  let timeout;
  try {
    await Promise.race([running, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Local FACEIT wait did not drain on stop')), 2000);
    })]);
  } finally { clearTimeout(timeout); }
  assert.equal(reads, 2, 'no new FACEIT HTTP requests after stop');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reply_markup, undefined);
  assert.deepEqual(sent[0].reply_parameters, { message_id: 880, allow_sending_without_reply: true });
  const database = await openDatabase(join(root, '.local-data/bot.sqlite'));
  try {
    assert.equal(await database.getOffset(), 781);
    const job = await database.db.get('SELECT * FROM report_jobs');
    assert.equal(job.status, 'pending');
    assert.equal(job.lease_until, 0);
  } finally { database.close(); }
});

test('transient profile failures also wait and retry silently within the original command budget', async t => {
  let now = INITIAL, attempts = 0;
  const waits = [];
  const bot = await makeHarness(t, {
    now: () => now, settings: AUTO,
    faceitOverrides: {
      start: (nickname, kind) => {
        attempts++;
        if (attempts <= 2) throw Object.assign(new Error('private upstream detail'), {
          code: attempts === 1 ? 'FACEIT_TEMPORARY' : 'FACEIT_RATE_LIMITED', retryAt: now + attempts * 2,
        });
        return { nickname, kind, phase: 'done' };
      },
    },
  });
  bot.dependencies.waitUntil = async retryAt => { waits.push(retryAt); now = retryAt; return true; };
  bot.restart();
  await bot.send('/last Nick', {}, 790);
  assert.deepEqual(waits, [INITIAL + 2, INITIAL + 6]);
  assert.equal(bot.starts.length, 3);
  assert.equal(bot.advances.length, 1);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.equal(bot.renderedReports[0].kind, 'last');
  assert.deepEqual(bot.sent('sendPhoto')[0].reply_parameters, { message_id: 790, allow_sending_without_reply: true });
});

for (const stage of ['profile', 'history']) {
  test(`an early-waking ${stage} wait returns one text instead of spinning before Retry-After`, async t => {
    let waits = 0;
    const bot = await makeHarness(t, {
      now: () => INITIAL, settings: AUTO,
      faceitOverrides: {
        start: (nickname, kind) => {
          if (stage === 'profile') throw Object.assign(new Error('private upstream detail'), { code: 'FACEIT_RATE_LIMITED', retryAt: INITIAL + 4 });
          return retryState(nickname, kind);
        },
        advance: state => ({ done: false, state: { ...state, retryAt: INITIAL + 4 }, progress: { retryAt: INITIAL + 4 } }),
      },
    });
    bot.dependencies.waitUntil = async () => { waits++; return true; };
    bot.restart();
    await bot.send('/stats Nick');
    assert.equal(waits, 1);
    assert.equal(bot.starts.length, 1);
    assert.equal(bot.advances.length, stage === 'profile' ? 0 : 1);
    assert.equal(bot.sent().length, 1);
    assert.equal(bot.sent()[0].reply_markup, undefined);
    assert.doesNotMatch(bot.sent()[0].text, /private upstream detail/);
    assert.equal(bot.sent('sendPhoto').length, 0);
  });
}

test('profile lookup consumes the same deadline, so a late response cannot start history reads', async t => {
  let now = INITIAL;
  const bot = await makeHarness(t, {
    now: () => now, settings: AUTO,
    faceitOverrides: { start: (nickname, kind) => { now += 91; return retryState(nickname, kind); } },
  });
  bot.dependencies.waitUntil = () => { assert.fail('a consumed command budget cannot begin passive waits'); };
  bot.restart();
  await bot.send('/stats Nick');
  assert.equal(bot.starts.length, 1);
  assert.equal(bot.advances.length, 0);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 1);
  assert.equal(bot.sent()[0].reply_markup, undefined);
});

test('a permanent profile error is not retried or rendered as an image', async t => {
  const bot = await makeHarness(t, {
    now: () => INITIAL, settings: AUTO,
    faceitOverrides: { start: () => { throw Object.assign(new Error('private upstream detail'), { code: 'PLAYER_NOT_FOUND' }); } },
  });
  bot.dependencies.waitUntil = () => { assert.fail('permanent profile errors must not sleep'); };
  bot.restart();
  await bot.send('/stats MissingNick');
  assert.equal(bot.starts.length, 1);
  assert.equal(bot.advances.length, 0);
  assert.equal(bot.sent('sendPhoto').length, 0);
  assert.equal(bot.sent().length, 1);
  assert.match(bot.sent()[0].text, /не найден/);
  assert.doesNotMatch(bot.sent()[0].text, /private upstream detail/);
  assert.equal(bot.sent()[0].reply_markup, undefined);
});
