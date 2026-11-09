import test from 'node:test';
import assert from 'node:assert/strict';
import { createPollService } from '../tgcloud/lib/poll-service.js';
import { pollWindow } from '../tgcloud/lib/poll-window.js';
import { Store } from '../tgcloud/lib/store.js';
import { makeStore } from './helpers.js';

const NOW = Date.parse('2026-11-07T09:00:00+03:00') / 1000;
const DAY_WINDOW_SECONDS = 18 * 3600;
const moscowTime = value => Date.parse(value) / 1000;

async function fixture(t) {
  let time = NOW;
  let id = 100;
  const { store, db } = await makeStore(() => time);
  t.after(() => db.close());
  const calls = [];
  const overrides = {};
  const methods = {
    sendPoll: () => ({ message_id: ++id, poll: { id: `poll-${id}` }, date: time }),
    forwardMessage: () => ({ message_id: ++id, poll: { id: 'same-poll' }, date: time }),
    pinChatMessage: () => true,
    unpinChatMessage: () => true,
  };
  const api = Object.fromEntries(Object.entries(methods).map(([method, impl]) => [method, async params => {
    calls.push({ method, params });
    return (overrides[method] ?? impl)(params);
  }]));
  const service = () => createPollService({ api, store: new Store(db, () => time), now: () => time });
  return { api, store, db, calls, overrides, service,
    run: (request, ctx = {}) => service().run({ chatId: -10, topicId: null, replyToMessageId: 50, ...ctx }, request),
    setTime: value => { time = value; },
    advance: seconds => { time += seconds; },
    sent: method => calls.filter(c => c.method === method).map(c => c.params),
  };
}
const denied = code => Object.assign(new Error('Rejected by Telegram'), { code });

test('new poll replies to its command, pins silently, preserves unrelated pins and complete poll options', async t => {
  const f = await fixture(t);
  const r = await f.run('u:1', { topicId: 7 });
  assert.equal(r.status, 'sent');
  assert.equal(r.warning, undefined);
  assert.deepEqual(f.sent('sendPoll')[0].reply_parameters, { message_id: 50, allow_sending_without_reply: true });
  assert.equal(f.sent('sendPoll')[0].message_thread_id, 7);
  assert.equal(f.sent('sendPoll')[0].is_anonymous, false);
  assert.equal(f.sent('sendPoll')[0].allows_multiple_answers, true);
  assert.equal(f.sent('sendPoll')[0].allows_revoting, true);
  assert.deepEqual(f.sent('pinChatMessage'), [{ chat_id: -10, message_id: r.message.message_id, disable_notification: true }]);
  assert.equal(f.sent('unpinChatMessage').length, 0);
  assert.deepEqual(f.calls.map(c => c.method), ['sendPoll', 'pinChatMessage']);
});

test('within the Moscow day window another topic forwards the original shared poll and never refreshes original creation', async t => {
  const f = await fixture(t);
  const first = await f.run('u:1', { topicId: 7 });
  const original = await f.store.getPollState(-10);
  f.advance(DAY_WINDOW_SECONDS - 1);
  const second = await f.run('u:2', { topicId: 9 });
  assert.equal(second.status, 'sent');
  assert.deepEqual(f.sent('forwardMessage'), [{ chat_id: -10, from_chat_id: -10,
    message_id: first.message.message_id, message_thread_id: 9, disable_notification: false }]);
  assert.ok(!Object.hasOwn(f.sent('forwardMessage')[0], 'reply_parameters'));
  const state = await f.store.getPollState(-10);
  assert.equal(state.created_at, original.created_at);
  assert.equal(state.original_message_id, first.message.message_id);
  assert.equal(state.poll_id, first.message.poll.id);
  assert.equal(state.pinned_message_id, second.message.message_id);
  assert.deepEqual(f.sent('unpinChatMessage'), [{ chat_id: -10, message_id: first.message.message_id }]);
  assert.equal(f.sent('sendPoll').length, 1);
  assert.deepEqual(f.calls.slice(-3).map(c => c.method), ['forwardMessage', 'pinChatMessage', 'unpinChatMessage']);
});

test('at exactly 03:00 Moscow a new poll is created and the last forwarded bot pin is removed after new pin', async t => {
  const f = await fixture(t);
  const first = await f.run('u:1');
  f.advance(100);
  const second = await f.run('u:2');
  f.advance(DAY_WINDOW_SECONDS - 100);
  const third = await f.run('u:3');
  assert.equal(third.status, 'sent');
  assert.equal(f.sent('sendPoll').length, 2);
  assert.equal(f.sent('forwardMessage').length, 1);
  const state = await f.store.getPollState(-10);
  assert.equal(state.original_message_id, third.message.message_id);
  assert.equal(state.created_at, first.message.date + DAY_WINDOW_SECONDS);
  assert.deepEqual(f.sent('unpinChatMessage').at(-1), { chat_id: -10, message_id: second.message.message_id });
});

test('other groups are independent while duplicate update cannot send or forward again after restart', async t => {
  const f = await fixture(t);
  await f.run('u:1');
  assert.equal((await f.run('u:1')).status, 'busy');
  assert.equal((await f.run('u:2', { chatId: -20 })).status, 'sent');
  assert.equal(f.sent('sendPoll').length, 2);
  assert.equal(f.sent('forwardMessage').length, 0);
  assert.notEqual((await f.store.getPollState(-10)).poll_id, (await f.store.getPollState(-20)).poll_id);
});

test('cold runtimes serialize different /poll update requests and never concurrently sendPoll', async t => {
  const f = await fixture(t);
  let accepted;
  let started;
  const signal = new Promise(resolve => { started = resolve; });
  f.overrides.sendPoll = async () => { started(); return new Promise(resolve => { accepted = resolve; }); };
  const first = f.run('u:1');
  await signal;
  const second = await f.run('u:2');
  assert.equal(second.status, 'busy');
  assert.equal(f.sent('sendPoll').length, 1);
  accepted({ message_id: 999, poll: { id: 'original' } });
  assert.equal((await first).status, 'sent');
  assert.equal((await f.run('u:3')).status, 'sent');
  assert.equal(f.sent('sendPoll').length, 1);
  assert.equal(f.sent('forwardMessage').length, 1);
});

test('unknown network send is fenced until the Moscow window ends despite lease expiry and process restart', async t => {
  const f = await fixture(t);
  f.overrides.sendPoll = () => { throw new Error('Connection lost after POST'); };
  assert.equal((await f.run('u:1')).status, 'outcome_unknown');
  f.advance(181);
  assert.equal((await f.run('u:2')).status, 'outcome_unknown');
  f.advance(DAY_WINDOW_SECONDS - 182);
  assert.equal((await f.run('u:3')).status, 'outcome_unknown');
  assert.equal(f.sent('sendPoll').length, 1);
  f.advance(1);
  delete f.overrides.sendPoll;
  assert.equal((await f.run('u:4')).status, 'sent');
  assert.equal(f.sent('sendPoll').length, 2);
});

test('known 400/403/429 send rejection clears unknown fence for a later explicit new command only', async t => {
  for (const code of [400, 403, 429]) {
    const f = await fixture(t);
    f.overrides.sendPoll = () => { throw denied(code); };
    assert.equal((await f.run('u:1')).status, 'rejected');
    assert.equal((await f.store.getPollState(-10)).unknown_until, 0);
    assert.equal((await f.run('u:1')).status, 'busy');
    delete f.overrides.sendPoll;
    assert.equal((await f.run('u:2')).status, 'sent');
    assert.equal(f.sent('sendPoll').length, 2);
  }
});

test('deleted/protected poll forwarding never silently creates a duplicate voting poll within its Moscow window', async t => {
  for (const description of ['Bad Request: message to forward not found', "Bad Request: message can't be forwarded"]) {
    const f = await fixture(t);
    await f.run('u:1');
    f.overrides.forwardMessage = () => { throw Object.assign(denied(400), { description }); };
    const result = await f.run('u:2');
    assert.equal(result.status, 'rejected');
    assert.match(result.warning, /новый опрос не создаю/);
    assert.equal(f.sent('sendPoll').length, 1);
    assert.equal((await f.run('u:3')).status, 'rejected');
    assert.equal(f.sent('sendPoll').length, 1);
    f.advance(DAY_WINDOW_SECONDS);
    assert.equal((await f.run('u:4')).status, 'sent');
    assert.equal(f.sent('sendPoll').length, 2);
  }
});

test('unknown forward preserves original and suppresses blind forward retries', async t => {
  const f = await fixture(t);
  await f.run('u:1');
  f.overrides.forwardMessage = () => { throw new Error('Lost POST response'); };
  assert.equal((await f.run('u:2')).status, 'outcome_unknown');
  f.advance(181);
  assert.equal((await f.run('u:3')).status, 'outcome_unknown');
  assert.equal(f.sent('sendPoll').length, 1);
  assert.equal(f.sent('forwardMessage').length, 1);
  assert.ok((await f.store.getPollState(-10)).original_message_id);
});

test('accepted send followed by database failure stays fenced and never blindly recreates poll', async t => {
  const f = await fixture(t);
  const dbRun = f.db.run.bind(f.db);
  let failed = false;
  f.db.run = async (sql, params) => {
    if (!failed && sql.includes('SET latest_message_id=')) { failed = true; throw new Error('Storage unavailable'); }
    return dbRun(sql, params);
  };
  const first = await f.run('u:1');
  assert.equal(first.status, 'outcome_unknown');
  f.advance(181);
  assert.equal((await f.run('u:2')).status, 'outcome_unknown');
  assert.equal(f.sent('sendPoll').length, 1);
  assert.equal(f.sent('pinChatMessage').length, 0);
});

test('database outage before send fails closed without Telegram side effects', async t => {
  const f = await fixture(t);
  f.db.run = async () => { throw new Error('Unavailable'); };
  assert.equal((await f.run('u:1')).status, 'rejected');
  assert.equal(f.calls.length, 0);
});

test('failed new pin keeps previous bot pin, persists original and retries pin without a new voting poll', async t => {
  const f = await fixture(t);
  const first = await f.run('u:1');
  f.advance(DAY_WINDOW_SECONDS);
  f.overrides.pinChatMessage = () => { throw denied(403); };
  const second = await f.run('u:2');
  assert.equal(second.status, 'sent');
  assert.match(second.warning, /Выдайте боту право закреплять/);
  let state = await f.store.getPollState(-10);
  assert.equal(state.pinned_message_id, first.message.message_id);
  assert.equal(state.original_message_id, second.message.message_id);
  assert.equal(f.sent('unpinChatMessage').length, 0);
  delete f.overrides.pinChatMessage;
  assert.equal((await f.run('u:3')).status, 'sent');
  state = await f.store.getPollState(-10);
  assert.equal(f.sent('sendPoll').length, 2);
  assert.deepEqual(state.pending_unpin_ids, []);
  assert.ok(f.sent('unpinChatMessage').some(p => p.message_id === first.message.message_id));
});

test('unpin failure is tracked and retried by explicit bot message ID only, unrelated pins are untouched', async t => {
  const f = await fixture(t);
  const first = await f.run('u:1');
  f.overrides.unpinChatMessage = () => { throw denied(403); };
  const second = await f.run('u:2');
  assert.equal(second.status, 'sent');
  assert.match(second.warning, /Не удалось открепить/);
  assert.deepEqual((await f.store.getPollState(-10)).pending_unpin_ids, [first.message.message_id]);
  delete f.overrides.unpinChatMessage;
  await f.run('u:3');
  assert.deepEqual((await f.store.getPollState(-10)).pending_unpin_ids, []);
  assert.ok(f.sent('unpinChatMessage').every(p => Number.isSafeInteger(p.message_id)));
  assert.ok(!Object.hasOwn(f.api, 'unpinAllChatMessages'));
});

test('already deleted pending old bot pin is treated as cleaned, not as permission success', async t => {
  const f = await fixture(t);
  await f.run('u:1');
  f.overrides.unpinChatMessage = () => { throw Object.assign(denied(400), { description: 'Bad Request: message to unpin not found' }); };
  const result = await f.run('u:2');
  assert.equal(result.status, 'sent');
  assert.equal(result.warning, undefined);
  assert.deepEqual((await f.store.getPollState(-10)).pending_unpin_ids, []);
});

test('malformed send success response cannot erase unknown delivery fence', async t => {
  const f = await fixture(t);
  f.overrides.sendPoll = () => ({ message_id: 123 });
  assert.equal((await f.run('u:1')).status, 'outcome_unknown');
  f.advance(181);
  assert.equal((await f.run('u:2')).status, 'outcome_unknown');
  assert.equal(f.sent('sendPoll').length, 1);
});

test('safe explicit unpinTargetMissing adapter flag cleans a removed bot message without raw Telegram text', async t => {
  const f = await fixture(t);
  await f.run('u:1');
  f.overrides.unpinChatMessage = () => {
    throw Object.assign(new Error('Telegram request rejected'), { code: 400, unpinTargetMissing: true });
  };
  const result = await f.run('u:2');
  assert.equal(result.status, 'sent');
  assert.equal(result.warning, undefined);
  assert.deepEqual((await f.store.getPollState(-10)).pending_unpin_ids, []);
});

test('unpin cleanup has at most four attempts per command and never drops deferred known bot pin IDs', async t => {
  const f = await fixture(t);
  await f.run('u:1');
  f.overrides.unpinChatMessage = () => { throw denied(403); };
  for (let n = 2; n <= 9; n += 1) await f.run(`u:${n}`);
  const before = await f.store.getPollState(-10);
  assert.equal(before.pending_unpin_ids.length, 8);
  const startCalls = f.sent('unpinChatMessage').length;
  const result = await f.run('u:10');
  assert.equal(result.status, 'sent');
  assert.equal(f.sent('unpinChatMessage').length - startCalls, 4);
  const after = await f.store.getPollState(-10);
  assert.equal(after.pending_unpin_ids.length, 9);
  assert.ok(before.pending_unpin_ids.every(id => after.pending_unpin_ids.includes(id)));
  assert.ok(after.pending_unpin_ids.includes(before.pinned_message_id));
  delete f.overrides.unpinChatMessage;
  const recoveryStart = f.sent('unpinChatMessage').length;
  await f.run('u:11');
  assert.equal(f.sent('unpinChatMessage').length - recoveryStart, 4);
  assert.equal((await f.store.getPollState(-10)).pending_unpin_ids.length, 6);
});

test('unknown pin followed by failed repair retains and unpins both known predecessors, without touching unrelated pins', async t => {
  const f = await fixture(t);
  const first = await f.run('u:1');
  const unrelatedId = 77777;
  const actualPins = new Set([unrelatedId, first.message.message_id]);
  f.overrides.pinChatMessage = ({ message_id }) => {
    actualPins.add(message_id);
    throw new Error('Pin accepted but HTTP response lost');
  };
  const ambiguous = await f.run('u:2');
  assert.equal(ambiguous.status, 'sent');
  assert.ok(actualPins.has(ambiguous.message.message_id));
  assert.equal((await f.store.getPollState(-10)).pinned_message_id, first.message.message_id);
  let attempts = 0;
  f.overrides.pinChatMessage = ({ message_id }) => {
    attempts += 1;
    if (attempts === 1) throw denied(403); // repair of the ambiguous pin also fails
    actualPins.add(message_id);
    return true;
  };
  f.overrides.unpinChatMessage = ({ message_id }) => { actualPins.delete(message_id); return true; };
  const beforeUnpins = f.sent('unpinChatMessage').length;
  const latest = await f.run('u:3');
  assert.equal(latest.status, 'sent');
  assert.equal(attempts, 2);
  const cleanedIds = f.sent('unpinChatMessage').slice(beforeUnpins).map(p => p.message_id);
  assert.deepEqual(new Set(cleanedIds), new Set([first.message.message_id, ambiguous.message.message_id]));
  assert.ok(cleanedIds.length <= 4);
  assert.deepEqual(actualPins, new Set([unrelatedId, latest.message.message_id]));
  assert.deepEqual((await f.store.getPollState(-10)).pending_unpin_ids, []);
  assert.equal((await f.store.getPollState(-10)).pinned_message_id, latest.message.message_id);
  assert.equal(f.sent('sendPoll').length, 1, 'pin errors never create another voting poll');
  assert.equal(f.sent('forwardMessage').length, 2);
});


test('Moscow poll windows have exact 03:00/09:00 boundaries without using the host time zone', () => {
  const previousTimeZone = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      for (const [at, start, end] of [
        ['2026-11-08T02:59:59+03:00', '2026-11-07T09:00:00+03:00', '2026-11-08T03:00:00+03:00'],
        ['2026-11-08T03:00:00+03:00', '2026-11-08T03:00:00+03:00', '2026-11-08T09:00:00+03:00'],
        ['2026-11-08T08:59:59+03:00', '2026-11-08T03:00:00+03:00', '2026-11-08T09:00:00+03:00'],
        ['2026-11-08T09:00:00+03:00', '2026-11-08T09:00:00+03:00', '2026-11-09T03:00:00+03:00'],
        ['2027-01-01T02:59:59+03:00', '2026-12-31T09:00:00+03:00', '2027-01-01T03:00:00+03:00'],
        ['2028-03-01T02:59:59+03:00', '2028-02-29T09:00:00+03:00', '2028-03-01T03:00:00+03:00'],
      ]) {
        assert.deepEqual(pollWindow(moscowTime(at)), { start: moscowTime(start), end: moscowTime(end) }, `${zone}: ${at}`);
      }
    }
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test('a poll created before 03:00 is replaced at 03:00, and the morning poll is replaced at 09:00', async t => {
  const f = await fixture(t);
  f.setTime(moscowTime('2026-11-08T02:59:59+03:00'));
  const previousDay = await f.run('u:night');
  f.setTime(moscowTime('2026-11-08T03:00:00+03:00'));
  const morning = await f.run('u:morning');
  assert.equal(f.sent('sendPoll').length, 2);
  assert.notEqual(morning.message.poll.id, previousDay.message.poll.id);
  f.setTime(moscowTime('2026-11-08T08:59:59+03:00'));
  await f.run('u:morning-again');
  assert.equal(f.sent('sendPoll').length, 2);
  assert.equal(f.sent('forwardMessage').at(-1).message_id, morning.message.message_id);
  f.setTime(moscowTime('2026-11-08T09:00:00+03:00'));
  const daytime = await f.run('u:day');
  assert.equal(f.sent('sendPoll').length, 3);
  assert.notEqual(daytime.message.poll.id, morning.message.poll.id);
  assert.equal((await f.store.getPollState(-10)).created_at, moscowTime('2026-11-08T09:00:00+03:00'));
});

test('the reuse deadline is the fixed next 03:00, not eighteen sliding hours after a late command', async t => {
  const f = await fixture(t);
  f.setTime(moscowTime('2026-11-07T23:30:00+03:00'));
  const first = await f.run('u:late');
  f.setTime(moscowTime('2026-11-08T02:59:59+03:00'));
  await f.run('u:last-second');
  assert.equal(f.sent('sendPoll').length, 1);
  assert.equal(f.sent('forwardMessage').at(-1).message_id, first.message.message_id);
  f.setTime(moscowTime('2026-11-08T03:00:00+03:00'));
  await f.run('u:next-window');
  assert.equal(f.sent('sendPoll').length, 2);
});
