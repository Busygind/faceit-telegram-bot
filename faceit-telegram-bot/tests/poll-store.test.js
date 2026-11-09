import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../tgcloud/lib/store.js';
import { makeStore } from './helpers.js';

const NOW = Date.parse('2026-11-07T09:00:00+03:00') / 1000;
const DAY_WINDOW_SECONDS = 18 * 3600;
const moscowTime = value => Date.parse(value) / 1000;

test('poll storage claims are cross-instance CAS, isolate chats and persist only identifiers', async t => {
  let now = NOW;
  const { store, db } = await makeStore(() => now);
  t.after(() => db.close());
  const restarted = new Store(db, () => now);
  const claims = await Promise.all([store.claimPollRun(-10, 'u:1'), restarted.claimPollRun(-10, 'u:2')]);
  assert.equal(claims.filter(c => c.status === 'claimed').length, 1);
  const owner = (await store.getPollState(-10)).owner_request_id;
  assert.equal((await restarted.claimPollRun(-20, 'u:3')).status, 'claimed');
  await store.preparePollPost(-10, owner);
  now += 181;
  assert.equal((await restarted.claimPollRun(-10, 'u:4')).status, 'outcome_unknown');
  await store.recordPollPost(-10, owner, true, { message_id: 101, poll: { id: 'public-poll' } });
  await store.updatePollPins(-10, owner, 101, [99, 99]);
  await store.finishPollRun(-10, owner, 'sent');
  assert.equal((await restarted.claimPollRun(-10, 'u:5')).status, 'claimed');
  const state = await restarted.getPollState(-10);
  assert.deepEqual(state.pending_unpin_ids, [99]);
  assert.equal(state.original_message_id, 101);
  const columns = (await db.all('PRAGMA table_info(poll_state)')).map(c => c.name);
  assert.ok(!columns.some(c => /update_json|password|nickname|content|text/.test(c)));
});

test('expired preparation lease can recover, expired sending lease cannot until its fixed Moscow window ends', async t => {
  let now = NOW;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimPollRun(-10, 'u:1');
  now += 181;
  assert.equal((await store.claimPollRun(-10, 'u:2')).status, 'claimed');
  await assert.rejects(store.preparePollPost(-10, 'u:1'), /POLL_CONFLICT/);
  await store.preparePollPost(-10, 'u:2');
  now = NOW + DAY_WINDOW_SECONDS - 1;
  assert.equal((await store.claimPollRun(-10, 'u:3')).status, 'outcome_unknown');
  now += 1;
  assert.equal((await store.claimPollRun(-10, 'u:4')).status, 'claimed');
});

test('cleanup expires poll request dedup tombstones but never poll state or pending unknown delivery fence', async t => {
  let now = NOW;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimPollRun(-10, 'u:1');
  await store.preparePollPost(-10, 'u:1');
  await store.cleanup();
  assert.ok((await store.getPollState(-10)).unknown_until > now);
  now += 31 * 86400;
  await store.cleanup();
  assert.equal((await db.all('SELECT * FROM poll_requests')).length, 0);
  assert.ok(await store.getPollState(-10));
});

test('poll claims reject invalid inputs before any database operation', async () => {
  const store = new Store(new Proxy({}, { get() { assert.fail('Invalid input reached storage'); } }));
  for (const chatId of [1, 0, NaN, -1.5, '-10']) await assert.rejects(store.claimPollRun(chatId, 'u:1'), /POLL_INPUT_INVALID/);
  for (const id of [null, '', 'x'.repeat(161), 'u:1\n']) await assert.rejects(store.claimPollRun(-10, id), /POLL_INPUT_INVALID/);
});

test('first upgraded call adopts last confirmed legacy poll by chat, never assumes legacy pin or overwrites new state', async t => {
  let now = NOW;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimDelivery('u:old', -10, 1, 'poll');
  await store.finishDelivery('u:old', 'sent', { message_id: 101, poll: { id: 'legacy-poll' } });
  now += 600;
  await store.claimDelivery('u:other', -20, 2, 'poll');
  await store.finishDelivery('u:other', 'sent', { message_id: 201, poll: { id: 'other-chat' } });
  const adopted = await store.claimPollRun(-10, 'u:new');
  assert.equal(adopted.status, 'claimed');
  assert.equal(adopted.state.original_message_id, 101);
  assert.equal(adopted.state.poll_id, 'legacy-poll');
  assert.equal(adopted.state.created_at, now - 600);
  assert.equal(adopted.state.pinned_message_id, null);
  assert.equal(adopted.state.latest_message_id, null);
  await store.finishPollRun(-10, 'u:new', 'sent');
  await store.claimDelivery('u:newer-legacy', -10, 1, 'poll');
  await store.finishDelivery('u:newer-legacy', 'sent', { message_id: 301, poll: { id: 'not-adopted' } });
  assert.equal((await store.claimPollRun(-10, 'u:again')).state.original_message_id, 101);
});

test('cold upgraded storage adopts latest button-created legacy poll and ignores newer non-poll deliveries', async t => {
  let now = NOW;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimDelivery('u:old-command', -10, 1, 'poll');
  await store.finishDelivery('u:old-command', 'sent', { message_id: 101, poll: { id: 'old-command-poll' } });
  now += 100;
  await store.claimDelivery('u:old-button', -10, 9, 'callback');
  await store.finishDelivery('u:old-button', 'sent', { message_id: 102, poll: { id: 'latest-button-poll' } });
  now += 100;
  await store.claimDelivery('u:new-photo', -10, 1, 'photo');
  await store.finishDelivery('u:new-photo', 'sent', { message_id: 103 });
  await store.claimDelivery('u:failed-poll', -10, 1, 'poll');
  await store.finishDelivery('u:failed-poll', 'outcome_unknown', { message_id: 104, poll: { id: 'not-confirmed' } });
  const coldStore = new Store(db, () => now);
  const adopted = await coldStore.claimPollRun(-10, 'u:after-upgrade');
  assert.equal(adopted.status, 'claimed');
  assert.equal(adopted.state.original_message_id, 102);
  assert.equal(adopted.state.poll_id, 'latest-button-poll');
  assert.equal(adopted.state.created_at, now - 100);
  assert.equal(adopted.state.pinned_message_id, null);
});

test('recording a new poll delivery atomically retains any previous unconfirmed pin candidate exactly once', async t => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  await store.claimPollRun(-10, 'u:1');
  await store.preparePollPost(-10, 'u:1');
  await store.recordPollPost(-10, 'u:1', true, { message_id: 101, poll: { id: 'original-poll' } });
  await store.updatePollPins(-10, 'u:1', 101, []);
  await store.recordPollPost(-10, 'u:1', false, { message_id: 102 });
  assert.deepEqual((await store.getPollState(-10)).pending_unpin_ids, []);
  await store.recordPollPost(-10, 'u:1', false, { message_id: 103 });
  assert.deepEqual((await store.getPollState(-10)).pending_unpin_ids, [102]);
  await store.recordPollPost(-10, 'u:1', false, { message_id: 103 });
  assert.deepEqual((await store.getPollState(-10)).pending_unpin_ids, [102]);
  await store.recordPollPost(-10, 'u:1', false, { message_id: 104 });
  assert.deepEqual((await store.getPollState(-10)).pending_unpin_ids, [102, 103]);
  const coldState = await new Store(db).getPollState(-10);
  assert.equal(coldState.latest_message_id, 104);
  assert.equal(coldState.pinned_message_id, 101);
});


test('legacy three-hour uncertainty from 02:00 is normalized to 03:00 and unlocks exactly at that boundary', async t => {
  let now = moscowTime('2026-11-08T02:00:00+03:00');
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimPollRun(-10, 'u:legacy');
  const rawFence = now + 3 * 3600;
  await db.run("UPDATE poll_state SET owner_request_id=NULL,lease_until=0,phase='unknown',unknown_until=:fence WHERE chat_id=-10", { ':fence': rawFence });
  assert.equal((await store.getPollState(-10)).unknown_until, moscowTime('2026-11-08T03:00:00+03:00'));
  assert.equal((await db.get('SELECT unknown_until FROM poll_state WHERE chat_id=-10')).unknown_until, rawFence, 'read normalization needs no data migration');
  now = moscowTime('2026-11-08T02:59:59+03:00');
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:before')).status, 'outcome_unknown');
  now += 1;
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:boundary')).status, 'claimed');
  await store.finishPollRun(-10, 'u:boundary', 'rejected');
  assert.equal((await store.getPollState(-10)).phase, 'idle', 'expired legacy fence must not retain the unknown phase');
});

test('legacy three-hour uncertainty from 09:00 stays fenced past noon until the next 03:00', async t => {
  let now = NOW;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimPollRun(-10, 'u:legacy');
  await db.run("UPDATE poll_state SET owner_request_id=NULL,lease_until=0,phase='unknown',unknown_until=:fence WHERE chat_id=-10", { ':fence': NOW + 3 * 3600 });
  const end = moscowTime('2026-11-08T03:00:00+03:00');
  assert.equal((await store.getPollState(-10)).unknown_until, end);
  now = moscowTime('2026-11-07T13:00:00+03:00');
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:after-noon')).status, 'outcome_unknown');
  now = end - 1;
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:before')).status, 'outcome_unknown');
  now = end;
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:boundary')).status, 'claimed');
  await store.finishPollRun(-10, 'u:boundary', 'rejected');
  assert.equal((await store.getPollState(-10)).phase, 'idle', 'expired legacy fence must not retain the unknown phase');
});

test('new uncertainty fences persist the window end and are not extended by later rejected requests', async t => {
  let now = moscowTime('2026-11-07T22:00:00+03:00');
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimPollRun(-10, 'u:1');
  await store.preparePollPost(-10, 'u:1');
  const end = moscowTime('2026-11-08T03:00:00+03:00');
  assert.equal((await db.get('SELECT unknown_until FROM poll_state WHERE chat_id=-10')).unknown_until, end);
  assert.equal((await store.getPollState(-10)).unknown_until, end);
  now = end - 1;
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:2')).status, 'outcome_unknown');
  assert.equal((await store.getPollState(-10)).unknown_until, end);
  now = end;
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:3')).status, 'claimed');
});

test('a still-active owner lease prevents a second POST even when the Moscow window changes', async t => {
  let now = moscowTime('2026-11-08T02:59:59+03:00');
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.claimPollRun(-10, 'u:1');
  await store.preparePollPost(-10, 'u:1');
  now += 1;
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:2')).status, 'busy');
  now += 180;
  assert.equal((await new Store(db, () => now).claimPollRun(-10, 'u:3')).status, 'claimed');
});
