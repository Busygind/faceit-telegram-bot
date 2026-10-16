import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../local/database.mjs';
import { runPolling } from '../local/polling.mjs';
import { Store } from '../tgcloud/lib/store.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faceit-polling-test-'));
  const path = join(dir, 'local.sqlite');
  let database;
  t.after(async () => { database?.close(); await rm(dir, { recursive: true, force: true }); });
  database = await openDatabase(path);
  return { dir, path, database };
}

function harness(database, batches = []) {
  const controller = new AbortController();
  const calls = [];
  const handled = [];
  const waits = [];
  const statuses = [];
  const api = {
    async getWebhookInfo() { calls.push(['getWebhookInfo']); return { url: '' }; },
    async getUpdates(payload, { signal }) {
      calls.push(['getUpdates', payload]);
      assert.equal(signal, controller.signal);
      if (!batches.length) { controller.abort(); return []; }
      const batch = batches.shift();
      if (batch instanceof Error) throw batch;
      return batch;
    },
  };
  const bot = {
    async handleMessage(message, context) { handled.push(['message', message, context]); },
    async handleCallback(query, context) { handled.push(['callback', query, context]); },
  };
  return {
    controller, calls, handled, waits, statuses, api, bot,
    options: { api, bot, database, signal: controller.signal,
      sleep: async ms => { waits.push(ms); }, onStatus: status => statuses.push(status) },
  };
}

function apiError(status, parameters) {
  return Object.assign(new Error('never-print-this-secret'), { code: status, status, parameters });
}

test('SQLite adapter initializes shared schema, supports Store, and persists monotonically across reopen', async t => {
  const { database, path } = await fixture(t);
  assert.equal(await database.getOffset(), 0);
  const store = new Store(database.db, () => 1234);
  assert.equal(await store.claimDelivery('u:100', -1004393474895, 2, 'poll'), true);
  assert.equal(await store.claimDelivery('u:100', -1004393474895, 2, 'poll'), false);
  await database.setOffset(101);
  await database.setOffset(99);
  assert.equal(await database.getOffset(), 101);
  assert.equal((await database.db.all('SELECT request_id FROM deliveries')).length, 1);
  const returning = await database.db.run('UPDATE polling_state SET next_offset=102 WHERE singleton=1 RETURNING next_offset');
  assert.equal(returning.rowsAffected, 1);
  assert.equal(returning.rows[0].next_offset, 102);
  assert.equal(Object.isFrozen(database.db), true);
  database.close();
  database.close();
  const reopened = await openDatabase(path);
  try {
    assert.equal(await reopened.getOffset(), 102);
    assert.equal(await new Store(reopened.db).claimDelivery('u:100', -1, null, 'poll'), false);
  } finally { reopened.close(); }
});

test('SQLite rejects unsafe offsets and filesystem links; database and WAL are private', async t => {
  const { database, path, dir } = await fixture(t);
  for (const invalid of [-1, 1.1, NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
    await assert.rejects(database.setOffset(invalid), /LOCAL_DATABASE_INVALID_OFFSET/);
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(`${path}-wal`)).mode & 0o777, 0o600);
  assert.equal((await stat(`${path}-shm`)).mode & 0o777, 0o600);
  const link = join(dir, 'alias.sqlite');
  await symlink(path, link);
  await assert.rejects(openDatabase(link), /LOCAL_DATABASE_UNSAFE_PATH/);
  await assert.rejects(openDatabase(':memory:'), /LOCAL_DATABASE_UNSAFE_PATH/);
  const other = join(dir, 'other.sqlite');
  await symlink(path, `${other}-wal`);
  await assert.rejects(openDatabase(other), /LOCAL_DATABASE_UNSAFE_PATH/);
});

test('polling processes message/callback sequentially, sorts IDs, ignores duplicate/other events, preserves raw context', async t => {
  const { database, path } = await fixture(t);
  const sensitive = '/setts example.org:9987 synthetic-test-password-not-to-persist';
  const message = { text: sensitive, message_id: 1, chat: { id: -1, type: 'group' } };
  const query = { id: 'callback-id', data: 'poll', message };
  const h = harness(database, [[
    { update_id: 13, callback_query: query },
    { update_id: 11, message },
    { update_id: 12, edited_message: message },
    { update_id: 13, callback_query: query },
    { update_id: 10, poll_answer: { options: [1] } },
  ]]);
  await runPolling(h.options);
  assert.deepEqual(h.handled.map(value => [value[0], value[2].update.update_id]), [['message', 11], ['callback', 13]]);
  assert.equal(h.handled[0][1], message);
  assert.equal(h.handled[0][2].update.message, message);
  assert.equal(await database.getOffset(), 14);
  const request = h.calls.find(value => value[0] === 'getUpdates')[1];
  assert.deepEqual(request, { offset: 0, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query'] });
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    assert.equal((await readFile(file)).includes(Buffer.from('synthetic-test-password-not-to-persist')), false);
  }
});

test('restart uses persisted offset and never reprocesses already acknowledged callbacks', async t => {
  const { database } = await fixture(t);
  await database.setOffset(51);
  const h = harness(database, [[{ update_id: 50, callback_query: { id: 'old' } }, { update_id: 51, callback_query: { id: 'new' } }]]);
  await runPolling(h.options);
  assert.equal(h.calls[1][1].offset, 51);
  assert.deepEqual(h.handled.map(value => value[1].id), ['new']);
  assert.equal(await database.getOffset(), 52);
});

test('active webhook stops before getUpdates and never calls deleteWebhook', async t => {
  const { database } = await fixture(t);
  const h = harness(database);
  h.api.getWebhookInfo = async () => ({ url: 'https://private.example/token-not-for-log' });
  h.api.deleteWebhook = async () => { assert.fail('must never remove webhook'); };
  await assert.rejects(runPolling(h.options), error => error.message === 'WEBHOOK_ACTIVE');
  assert.equal(h.calls.length, 0);
  assert.equal(await database.getOffset(), 0);
});

for (const [status, code] of [[401, 'TELEGRAM_AUTH'], [403, 'TELEGRAM_FORBIDDEN'], [409, 'POLLING_CONFLICT']]) {
  test(`fatal Telegram ${status} stops safely without retry or acknowledgment`, async t => {
    const { database } = await fixture(t);
    const h = harness(database, [apiError(status)]);
    await assert.rejects(runPolling(h.options), error => error.message === code && !error.stack.includes('never-print-this-secret'));
    assert.equal(h.waits.length, 0);
    assert.equal(await database.getOffset(), 0);
  });
}

test('getUpdates transient errors retry with exponential backoff and Retry-After', async t => {
  const { database } = await fixture(t);
  const h = harness(database, [apiError(500), apiError(429, { retry_after: 8 }), [{ update_id: 3, message: { text: 'ok' } }]]);
  await runPolling(h.options);
  assert.deepEqual(h.waits, [1000, 8000]);
  assert.equal(await database.getOffset(), 4);
  assert.equal(JSON.stringify(h.statuses).includes('never-print-this-secret'), false);
});

test('webhook lookup also retries temporary failure, but never skips the check', async t => {
  const { database } = await fixture(t);
  const h = harness(database);
  let attempt = 0;
  h.api.getWebhookInfo = async () => {
    if (++attempt === 1) throw apiError(503);
    return { url: '' };
  };
  await runPolling(h.options);
  assert.equal(attempt, 2);
  assert.deepEqual(h.waits, [1000]);
});

test('failed handler is retried only three times, preserves offset and hides error', async t => {
  const { database } = await fixture(t);
  await database.setOffset(8);
  const h = harness(database, [[{ update_id: 8, message: { text: 'ok' } }, { update_id: 9, message: { text: 'later' } }]]);
  let attempts = 0;
  h.bot.handleMessage = async () => { attempts++; throw new Error('private-text-not-for-log'); };
  await assert.rejects(runPolling(h.options), error => error.message === 'POLLING_HANDLER_FAILED' && !error.stack.includes('private-text-not-for-log'));
  assert.equal(attempts, 3);
  assert.deepEqual(h.waits, [1000, 2000]);
  assert.equal(await database.getOffset(), 8);
});

test('temporary handler failure succeeds before acknowledging, without dropping next update', async t => {
  const { database } = await fixture(t);
  const h = harness(database, [[{ update_id: 3, message: {} }, { update_id: 4, callback_query: {} }]]);
  let attempts = 0;
  h.bot.handleMessage = async () => {
    assert.equal(await database.getOffset(), 0);
    if (++attempts === 1) throw new Error('temporary');
  };
  await runPolling(h.options);
  assert.equal(attempts, 2);
  assert.equal(h.handled.length, 1);
  assert.equal(await database.getOffset(), 5);
});

test('abort interrupts long getUpdates promptly and never acknowledges in-flight update', async t => {
  const { database } = await fixture(t);
  const h = harness(database);
  h.api.getUpdates = async () => {
    setTimeout(() => h.controller.abort(), 5);
    return new Promise(() => {});
  };
  await runPolling(h.options);
  assert.equal(await database.getOffset(), 0);
  assert.equal(h.statuses.at(-1).code, 'POLLING_STOPPED');
});

test('shutdown waits for in-flight handler to settle and leaves its update unacknowledged', async t => {
  const { database } = await fixture(t);
  const h = harness(database, [[{ update_id: 7, message: {} }]]);
  let finish;
  let settled = false;
  h.bot.handleMessage = async () => {
    setTimeout(() => h.controller.abort(), 5);
    await new Promise(resolve => { finish = resolve; });
    // The runner must keep SQLite open until all handler writes have settled.
    await database.db.get('SELECT next_offset FROM polling_state WHERE singleton=1');
  };
  const polling = runPolling(h.options).then(() => { settled = true; });
  await new Promise(resolve => h.controller.signal.addEventListener('abort', resolve, { once: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  await polling;
  assert.equal(settled, true);
  assert.equal(await database.getOffset(), 0);
});

test('abort before startup does not issue any API request', async t => {
  const { database } = await fixture(t);
  const h = harness(database);
  h.controller.abort();
  await runPolling(h.options);
  assert.deepEqual(h.calls, []);
});

test('abort interrupts retry wait even if injected sleep never returns', async t => {
  const { database } = await fixture(t);
  const h = harness(database, [apiError(429, { retry_after: 100 })]);
  h.options.sleep = async () => {
    setTimeout(() => h.controller.abort(), 5);
    return new Promise(() => {});
  };
  await runPolling(h.options);
  assert.equal(await database.getOffset(), 0);
});

test('malformed update IDs cannot rewind or acknowledge the queue', async t => {
  const { database } = await fixture(t);
  for (const id of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER, '7']) {
    const h = harness(database, [[{ update_id: id, message: {} }]]);
    await assert.rejects(runPolling(h.options), /INVALID_UPDATE/);
    assert.equal(await database.getOffset(), 0);
  }
});
