import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { SQL_SCHEMA, Store } from '../bot/core/store.js';
import { createD1Adapter } from '../bot/d1.mjs';

function binding(sqlite) {
  return { prepare(query) {
    const statement = sqlite.prepare(query);
    const bind = (values = []) => ({
      bind: (...next) => bind(next),
      async run() { const result = statement.run(...values); return { meta: { changes: Number(result.changes) } }; },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
    });
    return bind();
  } };
}

test('applied cloud migrations and portable SQLite schema declare matching player-link tables and composite uniqueness', async (t) => {
  const cloud = new DatabaseSync(':memory:'); const portable = new DatabaseSync(':memory:');
  t.after(() => { cloud.close(); portable.close(); });
  for (const name of ['0000_sturdy_agent_brand.sql', '0001_smooth_sunset_bain.sql', '0002_player_links.sql']) {
    cloud.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  }
  for (const statement of SQL_SCHEMA) portable.exec(statement);
  assert.deepEqual(cloud.prepare('PRAGMA table_info(player_links)').all(), portable.prepare('PRAGMA table_info(player_links)').all());
  for (const database of [cloud, portable]) {
    const index = database.prepare('PRAGMA index_list(player_links)').all().find((item) => item.name === 'idx_player_links_chat_user');
    assert.equal(index.unique, 1);
    assert.deepEqual(database.prepare('PRAGMA index_info(idx_player_links_chat_user)').all().map((item) => item.name), ['chat_id', 'user_id']);
  }
  const adapter = createD1Adapter(binding(cloud));
  await new Store(adapter, () => 1800000000).savePlayerLink(-100, 12, { playerId: 'fixture-id', nickname: 'Fixture' });
  const restarted = new Store(createD1Adapter(binding(cloud)));
  assert.deepEqual({ ...await restarted.getPlayerLink(-100, 12) }, { chat_id: -100, user_id: 12, player_id: 'fixture-id', nickname: 'Fixture', updated_at: 1800000000 });
  assert.equal(await restarted.getPlayerLink(-200, 12), null);
  assert.equal(await restarted.getPlayerLink(-100, 13), null);
  await restarted.deletePlayerLink(-100, 12);
  assert.equal(await restarted.getPlayerLink(-100, 12), null);
});
