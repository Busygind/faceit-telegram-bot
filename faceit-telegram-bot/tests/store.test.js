import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore } from './helpers.js';
import { createSealer } from '../tgcloud/lib/credentials.js';
import { parseTeamspeak, validateAddress } from '../tgcloud/lib/teamspeak.js';
import { DEFAULT_SETTINGS, validateSettings } from '../tgcloud/lib/settings.js';

const sealer = () => createSealer({ keyHex: '11'.repeat(32), keyId: 'testing' });

test('A/B/C credentials are strictly isolated, encrypted, and updates take effect immediately', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  const crypt = sealer();
  await store.saveSettings(-10, { host: 'a.test:9987', password: 'секрет А' }, crypt);
  await store.saveSettings(-20, { host: 'b.test:9987', password: 'секрет Б' }, crypt);
  const a = await store.getSettings(-10); const b = await store.getSettings(-20);
  assert.equal(sealer().open(-10, a.ciphertext).password, 'секрет А');
  assert.equal(crypt.open(-20, b.ciphertext).host, 'b.test:9987');
  assert.equal(await store.getSettings(-30), null);
  const rows = JSON.stringify(await db.all('SELECT * FROM chat_settings'));
  assert.ok(!rows.includes('секрет') && !rows.includes('a.test'));
  assert.throws(() => crypt.open(-20, a.ciphertext));
  await store.saveSettings(-10, { host: 'new.test:9987', password: '' }, crypt);
  assert.equal((await store.getSettings(-10)).version, 2);
  assert.equal(crypt.open(-10, (await store.getSettings(-10)).ciphertext).password, '');
  assert.deepEqual(await store.getSettings(-20), b);
});

test('atomic group migration binds new AAD, retires old id, and never overwrites destination', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  const crypt = sealer();
  await store.saveSettings(-10, { host: 'a.test:1', password: 'pw' }, crypt);
  assert.equal(await store.migrateChat(-10, -100001, crypt), true);
  assert.equal(await store.getSettings(-10), null);
  assert.equal(await store.allowed(-10), false);
  assert.equal(await store.allowed(-100001), true);
  const row = await store.getSettings(-100001);
  assert.equal(crypt.open(-100001, row.ciphertext).password, 'pw');
  assert.throws(() => crypt.open(-10, row.ciphertext));
  await store.saveSettings(-20, { host: 'b.test:2', password: 'keep' }, crypt);
  assert.equal(await store.migrateChat(-100001, -20, crypt), false);
  assert.equal(crypt.open(-20, (await store.getSettings(-20)).ciphertext).password, 'keep');
  assert.equal(await store.migrateChat(-100001, -10, crypt), false, 'a retired destination cannot be re-enabled');
});

test('migration of any unconfigured group and dedup leave no default credentials', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  assert.equal(await store.migrateChat(-10, -1000, sealer()), true);
  assert.equal((await store.getSettings(-1000)).ciphertext, null);
  assert.equal(await store.allowed(-10), false);
  assert.equal(await store.migrateChat(-10, -1000, sealer()), false);
  assert.equal(await store.allowed(-30), true);
  assert.equal(await store.migrateChat(-10, -2000, sealer()), false);
  assert.equal(await store.getSettings(-2000), null);
});

test('group access accepts unknown negative ids, ignores legacy allowlists and rejects invalid ids before storage', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  for (const chatId of [-1004418477887, -4418477887, -1]) {
    assert.equal(await store.allowed(chatId), true);
    assert.equal(await store.allowed(chatId, [-10]), true, 'an obsolete second argument never restricts access');
  }
  const invalidStore = new store.constructor(new Proxy({}, { get() { assert.fail('Invalid ids cannot access storage'); } }));
  for (const chatId of [0, 1, -1.5, NaN, Infinity, Number.MIN_SAFE_INTEGER - 1, '-10', null, undefined]) {
    assert.equal(await invalidStore.allowed(chatId), false);
    assert.equal(await invalidStore.migrateChat(chatId, -1004418477887, sealer()), false);
  }
  for (const chatId of [0, 1, -1.5, NaN, Infinity, Number.MIN_SAFE_INTEGER - 1, '-10']) {
    assert.equal(await store.migrateChat(-4418477887, chatId, sealer()), false);
  }
  assert.equal(await store.migrateChat(-4418477887, -4418477887, sealer()), false);
  assert.equal((await db.all('SELECT * FROM chat_settings')).length, 0);
});

test('job lease, optimistic versions, restart persistence, TTL and delivery dedup', async (t) => {
  let now = 1000;
  const { store, db } = await makeStore(() => now); t.after(() => db.close());
  assert.equal(await store.claimDelivery('u:1', -10, 7, 'poll'), true);
  assert.equal(await store.claimDelivery('u:1', -10, 7, 'poll'), false);
  await store.finishDelivery('u:1', 'outcome_unknown');
  assert.equal(await store.claimDelivery('u:1', -10, 7, 'poll'), false);
  await store.createJob('x', -10, 7, { phase: 'history' });
  assert.equal(await store.leaseJob('x', 0), true);
  assert.equal(await store.leaseJob('x', 0), false);
  now += 121;
  assert.equal(await store.leaseJob('x', 0), true);
  await store.saveJob('x', 0, { phase: 'details' }, 'pending');
  assert.deepEqual((await store.getJob('x')).state, { phase: 'details' });
  await assert.rejects(store.saveJob('x', 0, {}, 'pending'), /JOB_CONFLICT/);
  assert.equal(await store.leaseJob('x', 0), false);
  now += 31 * 86400;
  await store.cleanup();
  assert.equal(await store.getJob('x'), null);
  assert.equal((await db.all('SELECT * FROM deliveries')).length, 0);
});

test('concurrent credential updates fail closed with compare-and-swap', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  const [a, b] = await Promise.allSettled([
    store.saveSettings(-10, { host: 'a.test:1', password: 'a' }, sealer()),
    store.saveSettings(-10, { host: 'b.test:1', password: 'b' }, sealer()),
  ]);
  assert.equal([a, b].filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal([a, b].filter((item) => item.status === 'rejected').length, 1);
});

test('TS parser preserves inner password spaces and requires explicit no-password', () => {
  assert.deepEqual(parseTeamspeak('TS.Example.org:9987 pass with  spaces'), { host: 'ts.example.org:9987', password: 'pass with  spaces' });
  assert.deepEqual(parseTeamspeak('--no-password [2001:db8::1]:65535'), { host: '[2001:db8::1]:65535', password: '' });
  for (const value of ['host:9987', 'host:0 pw', '256.1.1.1:9987 pw', 'http://host:9987 pw', 'x:9987 \nfoo', '--no-password host:9987 extra', 'host:65536 pw']) {
    assert.throws(() => parseTeamspeak(value));
  }
  for (const value of ['[:::]:1', '[1:2:3]:1', '999.0.0.1:2', 'bad_host:1', '-bad.test:1']) assert.throws(() => validateAddress(value));
  assert.equal(validateAddress('127.0.0.1:9987'), '127.0.0.1:9987');
});

test('configuration validates without disclosing values', () => {
  const settings = { faceitKey: 'a'.repeat(32), encryptionKeyHex: '11'.repeat(32), encryptionKeyId: 'key-1', maxRequests: 8 };
  assert.equal(validateSettings(settings), settings);
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS, 'allowedChatIds'), false);
  assert.doesNotThrow(() => validateSettings({ ...settings, allowedChatIds: [1, 'legacy-value'] }));
  for (const change of [{ faceitKey: '' }, { encryptionKeyHex: 'broken' }, { maxRequests: 17 }]) {
    assert.throws(() => validateSettings({ ...settings, ...change }), /^Error: CONFIG_/);
  }
});

test('one active heavy job per chat, independent chats continue concurrently', async (t) => {
  const { store, db } = await makeStore(); t.after(() => db.close());
  await store.createJob('a', -10, 1, {});
  await store.createJob('b', -10, 2, {});
  await store.createJob('c', -20, 1, {});
  assert.equal(await store.leaseJob('a', 0), true);
  assert.equal(await store.leaseJob('b', 0), false);
  assert.equal(await store.leaseJob('c', 0), true);
  await store.saveJob('a', 0, {}, 'pending');
  assert.equal(await store.leaseJob('b', 0), true);
});
