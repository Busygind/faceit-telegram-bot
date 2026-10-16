import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SQL_SCHEMA } from '../tgcloud/lib/store.js';
import { createSealer } from '../tgcloud/lib/credentials.js';
import { makeStore } from './helpers.js';

const profile = (nickname, playerId = `player-${nickname}`) => ({ playerId, nickname });
const plain = (row) => row && { ...row };

test('player links belong to exactly one chat and sender, with no implicit defaults', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  await store.savePlayerLink(-10, 1, profile('Alpha'));
  await store.savePlayerLink(-10, 2, profile('Beta'));
  await store.savePlayerLink(-20, 1, profile('Gamma'));
  assert.equal((await store.getPlayerLink(-10, 1)).nickname, 'Alpha');
  assert.equal((await store.getPlayerLink(-10, 2)).nickname, 'Beta');
  assert.equal((await store.getPlayerLink(-20, 1)).nickname, 'Gamma');
  assert.equal(await store.getPlayerLink(-10, 3), null);
  assert.equal(await store.getPlayerLink(-20, 2), null);
  assert.equal(await store.getPlayerLink(-30, 1), null);
  // FACEIT ownership is not authenticated: friends may legitimately use the same public profile.
  await store.savePlayerLink(-10, 3, profile('Alpha'));
  assert.equal((await db.all('SELECT * FROM player_links')).length, 4);
});

test('setting again replaces only the same sender link, and deletion is scoped and idempotent', async (t) => {
  let now = 1000;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.savePlayerLink(-10, 1, profile('Before'));
  await store.savePlayerLink(-10, 2, profile('Other'));
  now++;
  await store.savePlayerLink(-10, 1, profile("O'Brien", 'uuid-safe_123'));
  assert.deepEqual(plain(await store.getPlayerLink(-10, 1)), {
    chat_id: -10, user_id: 1, player_id: 'uuid-safe_123', nickname: "O'Brien", updated_at: 1001,
  });
  assert.equal((await db.all('SELECT * FROM player_links')).length, 2);
  await store.deletePlayerLink(-10, 1);
  await store.deletePlayerLink(-10, 1);
  assert.equal(await store.getPlayerLink(-10, 1), null);
  assert.equal((await store.getPlayerLink(-10, 2)).nickname, 'Other');
});

test('player links survive database close/reopen and a new Store instance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'faceit-player-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'bot.sqlite');
  let sqlite;
  const open = () => {
    sqlite = new DatabaseSync(filename);
    for (const sql of SQL_SCHEMA) sqlite.exec(sql);
    return new Store({
      async run(sql, params) { const result = sqlite.prepare(sql).run(params); return { rowsAffected: Number(result.changes) }; },
      async get(sql, params) { return sqlite.prepare(sql).get(params); },
    }, () => 1700);
  };
  try {
    await open().savePlayerLink(-10, 1, profile('Persisted'));
    sqlite.close(); sqlite = null;
    const restarted = open();
    assert.equal((await restarted.getPlayerLink(-10, 1)).nickname, 'Persisted');
    await restarted.deletePlayerLink(-10, 1);
    assert.equal(await restarted.getPlayerLink(-10, 1), null);
  } finally { sqlite?.close(); }
});

test('cleanup expires transient jobs and delivery records, never persistent player links', async (t) => {
  let now = 1000;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  await store.savePlayerLink(-10, 1, profile('Keep'));
  const original = plain(await store.getPlayerLink(-10, 1));
  await store.createJob('transient', -10, null, {});
  await store.claimDelivery('transient', -10, null, 'stats');
  now += 40 * 86400;
  await store.cleanup();
  assert.deepEqual(plain(await store.getPlayerLink(-10, 1)), original);
  assert.equal(await store.getJob('transient'), null);
  assert.equal((await db.all('SELECT * FROM deliveries')).length, 0);
});

test('group migration does not copy personal links to a different chat id or overwrite existing destination links', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  await store.savePlayerLink(-10, 1, profile('Old'));
  await store.savePlayerLink(-10, 2, profile('OldTwo'));
  await store.savePlayerLink(-100001, 1, profile('Destination'));
  const crypt = createSealer({ keyHex: '11'.repeat(32), keyId: 'testing' });
  assert.equal(await store.migrateChat(-10, -100001, crypt), true);
  assert.equal(await store.allowed(-10), false);
  assert.equal(await store.allowed(-100001), true);
  assert.equal((await store.getPlayerLink(-100001, 1)).nickname, 'Destination');
  assert.equal(await store.getPlayerLink(-100001, 2), null);
  // The retired chat remains inaccessible through the bot; no unrequested alias or fallback is introduced.
  assert.equal((await store.getPlayerLink(-10, 2)).nickname, 'OldTwo');
});

test('all player-link methods reject invalid owner identifiers before querying storage', async () => {
  const store = new Store(new Proxy({}, { get() { assert.fail('Invalid input must not access storage'); } }));
  for (const [chat, user] of [[0, 1], [1, 1], [-1.5, 1], [NaN, 1], [-1, 0], [-1, -1], [-1, 1.5], [-1, Infinity], [-1, Number.MAX_SAFE_INTEGER + 1], ['-1', 1], [-1, '1']]) {
    await assert.rejects(store.getPlayerLink(chat, user), /PLAYER_LINK_INVALID/);
    await assert.rejects(store.savePlayerLink(chat, user, profile('Safe')), /PLAYER_LINK_INVALID/);
    await assert.rejects(store.deletePlayerLink(chat, user), /PLAYER_LINK_INVALID/);
  }
});

test('invalid player profiles are rejected without changing an existing link or exposing values', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  await store.savePlayerLink(-10, 1, profile('Keep'));
  const before = plain(await store.getPlayerLink(-10, 1));
  for (const invalid of [null, {}, profile('', 'valid'), profile('x'.repeat(65), 'valid'), profile('two names', 'valid'), profile('line\nname', 'valid'), profile('null\0name', 'valid'), profile('control\u0085name', 'valid'), profile('format\u200bname', 'valid'), profile('Good', ''), profile('Good', 'x'.repeat(129)), profile('Good', "bad';DROP"), profile('Good', 1)]) {
    await assert.rejects(store.savePlayerLink(-10, 1, invalid), { message: 'PLAYER_LINK_INVALID' });
  }
  assert.deepEqual(plain(await store.getPlayerLink(-10, 1)), before);
});

test('composite unique index rejects duplicate owners while accepting another chat or sender', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  await store.savePlayerLink(-10, 1, profile('Alpha'));
  await assert.rejects(db.run("INSERT INTO player_links VALUES(-10,1,'other','Other',1000)"), /UNIQUE constraint failed/);
  const index = (await db.all('PRAGMA index_list(player_links)')).find((item) => item.name === 'idx_player_links_chat_user');
  assert.equal(index.unique, 1);
  assert.deepEqual((await db.all('PRAGMA index_info(idx_player_links_chat_user)')).map((item) => item.name), ['chat_id', 'user_id']);
});
