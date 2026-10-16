import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, createFetchMock } from 'miniflare';

const NOW = 1_800_000_000;

test('real workerd native D1 persists chat-scoped personal links across requests, replacement, deletion and transient cleanup', async t => {
  const storeSource = await readFile(new URL('../bot/core/store.js', import.meta.url), 'utf8');
  const adapterSource = await readFile(new URL('../bot/d1.mjs', import.meta.url), 'utf8');
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const worker = new Miniflare({
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'player-links-native-d1-fixture' },
    d1Persist: false,
    fetchMock,
    modulesRoot: '/player-links-worker-fixture',
    modules: [{ type: 'ESModule', path: '/player-links-worker-fixture/main.mjs', contents: `
      import { Store, SQL_SCHEMA } from './store.js';
      import { createD1Adapter } from './d1.mjs';
      export default { async fetch(request, env) {
        const { action, now } = await request.json();
        if (action === 'init') {
          for (const statement of SQL_SCHEMA) await env.DB.prepare(statement).run();
        }
        // Every invocation gets a new Store/adapter: only native D1 can keep links.
        const store = new Store(createD1Adapter(env.DB, { onDiagnostic: () => {} }), () => now);
        if (action === 'init') {
          await store.savePlayerLink(-100, 1, { playerId: 'fixture-alpha', nickname: 'Alpha' });
          await store.savePlayerLink(-200, 1, { playerId: 'fixture-beta', nickname: 'Beta' });
          await store.savePlayerLink(-100, 2, { playerId: 'fixture-gamma', nickname: 'Gamma' });
          await store.createJob('fixture-transient-job', -100, null, {});
          await store.claimDelivery('fixture-transient-delivery', -100, null, 'stats');
        }
        if (action === 'replace') {
          await store.savePlayerLink(-100, 1, { playerId: 'fixture-replaced', nickname: 'Replaced' });
        }
        if (action === 'delete') {
          await store.deletePlayerLink(-100, 1);
          await store.deletePlayerLink(-100, 1); // repeated deletion is harmless.
        }
        if (action === 'cleanup') await store.cleanup();
        const links = await Promise.all([
          store.getPlayerLink(-100, 1), store.getPlayerLink(-200, 1), store.getPlayerLink(-100, 2),
          store.getPlayerLink(-200, 2), store.getPlayerLink(-100, 3), store.getPlayerLink(-300, 1),
        ]);
        const deliveries = await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first();
        return Response.json({ links, job: await store.getJob('fixture-transient-job'), deliveries: deliveries.n });
      } };
    ` },
    { type: 'ESModule', path: '/player-links-worker-fixture/store.js', contents: storeSource },
    { type: 'ESModule', path: '/player-links-worker-fixture/d1.mjs', contents: adapterSource }],
  });
  t.after(async () => { await worker.dispose(); await fetchMock.close(); });
  async function invoke(action, now = NOW) {
    const response = await worker.dispatchFetch('https://worker.example/player-links', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, now }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const initialized = await invoke('init');
  assert.deepEqual(initialized.links.slice(0, 3).map(row => row.nickname), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(initialized.links.slice(3), [null, null, null]);
  assert.equal(initialized.deliveries, 1);
  assert.equal(initialized.job.status, 'pending');

  const restarted = await invoke('get', NOW + 1);
  assert.deepEqual(restarted, initialized);
  const replaced = await invoke('replace', NOW + 2);
  assert.deepEqual(replaced.links[0], {
    chat_id: -100, user_id: 1, player_id: 'fixture-replaced', nickname: 'Replaced', updated_at: NOW + 2,
  });
  assert.deepEqual(replaced.links.slice(1), initialized.links.slice(1));
  const deleted = await invoke('delete', NOW + 3);
  assert.equal(deleted.links[0], null);
  assert.deepEqual(deleted.links.slice(1), initialized.links.slice(1));

  const cleaned = await invoke('cleanup', NOW + 40 * 86400);
  assert.deepEqual(cleaned.links, deleted.links);
  assert.equal(cleaned.job, null);
  assert.equal(cleaned.deliveries, 0);
  assert.deepEqual((await invoke('get', NOW + 41 * 86400)).links, cleaned.links);
  fetchMock.assertNoPendingInterceptors();
});
