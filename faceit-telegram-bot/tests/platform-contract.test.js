import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { makeStore } from './helpers.js';

// Local contract double, not an emulator or proof of Telegram platform support.
// Resolve the exact deployed imports, including entrypoints and schema DSL.
const column = (type) => (name) => {
  const descriptor = { name, type };
  for (const method of ['primaryKey', 'notNull', 'default']) descriptor[method] = () => descriptor;
  return descriptor;
};
const tables = [];
globalThis.__faceitTestSchema = {
  table(name, columns, extras) { const table = { name, columns }; if (extras) extras(columns); tables.push(table); return table; },
  integer: column('INTEGER'), text: column('TEXT'), index: () => ({ on: () => ({}) }),
};
const fakeSettings = {
  allowedChatIds: [-100], faceitKey: 'synthetic-local-faceit-test-key',
  encryptionKeyHex: '42'.repeat(32), encryptionKeyId: 'tests', maxRequests: 8,
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sdk' || specifier === 'sdk/db') return { url: `test:${specifier}`, shortCircuit: true };
    if (specifier === './private-settings.js') return { url: 'test:settings', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const source = url === 'test:sdk' ? 'export const {api,db,fetch,InputFile} = globalThis.__faceitTestSdk;'
      : url === 'test:sdk/db' ? 'export const {table,integer,text,index}=globalThis.__faceitTestSchema;'
        : url === 'test:settings' ? `export default ${JSON.stringify(fakeSettings)};` : null;
    return source == null ? next(url, context) : { format: 'module', source, shortCircuit: true };
  },
});

test('deployed schema and local SQLite contract have exactly matching tables/columns/types', async (t) => {
  const { db } = await makeStore(); t.after(() => db.close());
  await import('../tgcloud/schema.js');
  assert.equal(tables.length, 3);
  for (const table of tables) {
    const actual = await db.all(`PRAGMA table_info(${table.name})`);
    assert.deepEqual(actual.map(({ name, type }) => ({ name, type })), Object.values(table.columns).map(({ name, type }) => ({ name, type })));
  }
});

test('actual deployed message/callback entrypoints load and use only the SDK contract', async (t) => {
  const { db } = await makeStore(); t.after(() => db.close());
  const calls = [];
  globalThis.__faceitTestSdk = {
    db,
    fetch: async () => { throw new Error('Unexpected network'); },
    InputFile: class { constructor(bytes, name, options) { Object.assign(this, { bytes, name, options }); } },
    api: {
      getMe: async () => ({ id: 77, username: 'test_bot' }),
      getChatMember: async () => ({ status: 'member' }),
      sendMessage: async (payload) => { calls.push(payload); return { message_id: 99 }; },
      sendPhoto: async (payload) => { calls.push(payload); return { message_id: 100 }; },
      answerCallbackQuery: async () => {},
    },
  };
  const handler = (await import('../tgcloud/handlers/message.js')).default;
  await handler({ chat: { id: -100, type: 'supergroup' }, from: { id: 1 }, text: '/stats@test_bot', message_id: 1 }, { update: { update_id: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, undefined);
  assert.equal(calls[0].caption, undefined);
  assert.equal(calls[0].photo.name, 'faceit-status.png');
  assert.deepEqual([...calls[0].photo.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const callback = (await import('../tgcloud/handlers/callback_query.js')).default;
  await callback({ id: 'q', from: { id: 1 }, data: 'hint:setts', message: { chat: { id: -100, type: 'supergroup' } } }, { update: { update_id: 2 } });
  assert.match(calls.at(-1).text, /Настройка только для этой группы/);
});
