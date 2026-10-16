import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, fixtureReport } from './bot-harness.js';

const AUTO = { maxRequests: 4, autoAdvanceBatches: 32, autoAdvanceSeconds: 90 };

function stepsUntilDone(count, observe = () => {}) {
  return {
    start: (nickname, kind) => ({ nickname, kind, phase: 'history', step: 0 }),
    async advance(state, budget) {
      await observe(state, budget);
      const next = state.phase === 'done' ? state : { ...state, step: state.step + 1 };
      const done = next.phase === 'done' || next.step >= count;
      if (done) next.phase = 'done';
      return { done, state: next, progress: {}, ...(done ? { report: fixtureReport(state.kind, state.nickname) } : {}) };
    },
  };
}

function hasContinue(message) {
  return message.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('continue:')) ?? false;
}

test('local stats completes more than eight checkpoints in one slash command and delivers once', async t => {
  let bot;
  bot = await makeHarness(t, {
    settings: AUTO,
    renderCard: () => new Uint8Array([1, 2, 3]),
    faceitOverrides: stepsUntilDone(17, async (state, budget) => {
      const saved = await bot.db.get('SELECT * FROM report_jobs');
      assert.equal(saved.status, 'running');
      assert.equal(saved.version, state.step);
      assert.equal(JSON.parse(saved.state).step, state.step);
      assert.equal(budget.maxRequests, 4);
    }),
  });
  await bot.send('/stats ExplicitNick', { topicId: 7 });
  assert.equal(bot.starts.length, 1);
  assert.equal(bot.advances.length, 17);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.renderedReports.length, 1);
  assert.equal(bot.renderedReports[0].nickname, 'ExplicitNick');
  assert.ok(bot.sent('sendPhoto').every(message => !hasContinue(message)));
  assert.ok(bot.sent('sendPhoto').every(message => message.message_thread_id === 7 && !Object.hasOwn(message, 'caption')));
  const job = await bot.db.get('SELECT * FROM report_jobs');
  assert.equal(job.status, 'ready');
  assert.equal(job.version, 17);
  assert.equal(job.lease_until, 0);
  assert.equal(JSON.parse(job.state).step, 17);
});

test('default Serverless invocation still advances one batch and offers a continuation button', async t => {
  const bot = await makeHarness(t, { faceitOverrides: stepsUntilDone(17) });
  await bot.send('/stats Nick');
  assert.equal(bot.advances.length, 1);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.renderedReports[0].kind, 'notice');
  assert.ok(hasContinue(bot.sent('sendPhoto')[0]));
  assert.equal((await bot.db.get('SELECT * FROM report_jobs')).version, 1);
});

test('FACEIT Retry-After immediately saves progress and pauses without automatically retrying', async t => {
  const now = 1800000000;
  const bot = await makeHarness(t, {
    settings: AUTO,
    faceitOverrides: {
      start: (nickname, kind) => ({ nickname, kind, phase: 'history' }),
      advance: state => ({ done: false, state: { ...state, retryAt: now + 40 }, progress: { retryAt: now + 40 } }),
    },
  });
  await bot.send('/stats Nick');
  assert.equal(bot.advances.length, 1);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.match(bot.renderedReports[0].message, /подождать ещё 40 сек/);
  assert.ok(hasContinue(bot.sent('sendPhoto')[0]));
  const job = await bot.db.get('SELECT * FROM report_jobs');
  assert.equal(job.status, 'pending');
  assert.equal(job.lease_until, 0);
  await bot.click(`continue:${job.job_id}`);
  assert.equal(bot.advances.length, 1);
  assert.equal((await bot.db.get('SELECT * FROM report_jobs')).version, 1);
  assert.match(bot.renderedReports.at(-1).message, /подождать ещё 40 сек/);
  assert.equal(bot.sent().length, 0);
});

test('automatic advancement stops permanently on unresolved dense history', async t => {
  const bot = await makeHarness(t, {
    settings: AUTO,
    faceitOverrides: {
      advance: state => ({ done: false, state: { ...state, blocked: 'HISTORY_DENSITY_UNRESOLVED' }, progress: {} }),
    },
  });
  await bot.send('/stats Nick');
  assert.equal(bot.advances.length, 1);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.match(bot.renderedReports[0].message, /история слишком плотная/);
  assert.ok(!hasContinue(bot.sent('sendPhoto')[0]));
  const job = await bot.db.get('SELECT * FROM report_jobs');
  assert.equal(job.status, 'blocked');
  await bot.click(`continue:${job.job_id}`);
  assert.equal(bot.advances.length, 1);
});

test('automatic batch count is clamped at 32 and leaves a resumable pending checkpoint', async t => {
  const bot = await makeHarness(t, { settings: { ...AUTO, autoAdvanceBatches: 10000 }, faceitOverrides: stepsUntilDone(40) });
  await bot.send('/stats Nick');
  assert.equal(bot.advances.length, 32);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.ok(hasContinue(bot.sent('sendPhoto').at(-1)));
  const job = await bot.db.get('SELECT * FROM report_jobs');
  assert.equal(job.version, 32);
  assert.equal(job.status, 'pending');
  await bot.click(`continue:${job.job_id}`);
  assert.equal(bot.advances.length, 40);
  assert.equal((await bot.db.get('SELECT * FROM report_jobs')).status, 'ready');
});

test('explicit small or invalid automatic batch budgets remain bounded', async t => {
  for (const [budget, expected] of [[2, 2], [0, 1], [-10, 1], ['invalid', 1]]) {
    const bot = await makeHarness(t, { settings: { ...AUTO, autoAdvanceBatches: budget }, faceitOverrides: stepsUntilDone(40) });
    await bot.send('/stats Nick');
    assert.equal(bot.advances.length, expected);
    assert.ok(hasContinue(bot.sent('sendPhoto').at(-1)));
  }
});

test('automatic deadline defaults to 90 seconds and clamps configured time at 120 seconds', async t => {
  for (const [seconds, expected] of [[undefined, 2], [10000, 3], [1, 1]]) {
    let now = 1800000000;
    const bot = await makeHarness(t, {
      settings: { ...AUTO, autoAdvanceSeconds: seconds },
      now: () => now,
      faceitOverrides: stepsUntilDone(40, () => { now += 45; }),
    });
    await bot.send('/stats Nick');
    assert.equal(bot.advances.length, expected);
    assert.ok(hasContinue(bot.sent('sendPhoto').at(-1)));
    assert.equal((await bot.db.get('SELECT * FROM report_jobs')).status, 'pending');
  }
});

test('healthy automatic flow performs no loading-message or intermediate-photo POST', async t => {
  const bot = await makeHarness(t, {
    settings: AUTO,
    faceitOverrides: stepsUntilDone(12),
    apiOverrides: { sendMessage: () => { throw new Error('Loading messages are forbidden'); } },
  });
  await bot.send('/stats Nick');
  assert.equal(bot.advances.length, 12);
  assert.equal(bot.sent().length, 0);
  assert.equal(bot.sent('sendPhoto').length, 1);
  assert.equal(bot.renderedReports[0].kind, 'stats');
});

test('ready callback after automatic completion cannot duplicate its only image', async t => {
  const bot = await makeHarness(t, {
    settings: AUTO, renderCard: () => new Uint8Array([1, 2, 3]), faceitOverrides: stepsUntilDone(10),
  });
  await bot.send('/stats Nick', { topicId: 7 });
  const job = await bot.db.get('SELECT * FROM report_jobs');
  const photos = bot.sent('sendPhoto').length;
  const messages = bot.sent().length;
  await bot.click(`continue:${job.job_id}`, { topicId: 7 });
  assert.equal(bot.sent('sendPhoto').length, photos);
  assert.equal(bot.sent().length, messages);
  assert.equal(bot.starts.length, 1);
  assert.equal(bot.advances.length, 11);
  assert.equal((await bot.db.get('SELECT * FROM report_jobs')).version, 10);
});
