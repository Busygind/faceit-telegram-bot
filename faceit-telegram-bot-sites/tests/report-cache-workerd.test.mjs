import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, createFetchMock } from 'miniflare';

const NOW = 1_800_000_000;
const FILE_ID = 'AgACAgIAAxkBAA_workerd_fixture_file_id';

test('real workerd node:crypto/Buffer and native D1 persist cached reports across requests with fixed TTL', async t => {
  const cacheSource = await readFile(new URL('../bot/report-cache.mjs', import.meta.url), 'utf8');
  const adapterSource = await readFile(new URL('../bot/d1.mjs', import.meta.url), 'utf8');
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const worker = new Miniflare({
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'report-cache-native-d1-fixture' },
    d1Persist: false,
    fetchMock,
    modulesRoot: '/report-cache-worker-fixture',
    modules: [{ type: 'ESModule', path: '/report-cache-worker-fixture/main.mjs', contents: `
      import { createReportCache, REPORT_CACHE_SCHEMA } from './report-cache.mjs';
      import { createD1Adapter } from './d1.mjs';
      export default { async fetch(request, env) {
        const { action, now } = await request.json();
        const state = { kind: 'stats', target: 30, phase: 'details',
          profile: { playerId: 'fixture-player', nickname: 'Fixture', elo: 1710, level: 8 },
          selected: [{ match_id: 'fixture-match', finished_at: ${NOW - 1}, status: 'FINISHED',
            teams: { faction1: { name: 'Fixture team' } }, results: { winner: 'faction1' } }] };
        const report = { kind: 'stats', playerId: 'fixture-player', nickname: 'Fixture', elo: 1710, level: 8,
          requested: 30, count: 1, matches: [{ matchId: 'fixture-match' }], partial: false, updatedAt: ${NOW} };
        if (action === 'put') {
          for (const statement of REPORT_CACHE_SCHEMA) await env.DB.prepare(statement).run();
        }
        // A genuinely new adapter/cache instance is constructed for every HTTP
        // request. Only native D1 can retain data between these invocations.
        const db = createD1Adapter(env.DB, { onDiagnostic: () => {} });
        const cache = createReportCache({ db, botToken: 'synthetic-not-real-bot-token',
          faceitKey: 'synthetic-not-real-faceit-key', now: () => now });
        if (action === 'put') await cache.put(state, report);
        if (action === 'file') {
          const hit = await cache.get(state);
          await cache.put(state, hit.report, '${FILE_ID}');
        }
        const hit = await cache.get(state);
        const row = await env.DB.prepare('SELECT created_at,expires_at,file_id FROM report_cache').first();
        const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM report_cache').first();
        return Response.json({ hit, row, count: count.n });
      } };
    ` },
    { type: 'ESModule', path: '/report-cache-worker-fixture/report-cache.mjs', contents: cacheSource },
    { type: 'ESModule', path: '/report-cache-worker-fixture/d1.mjs', contents: adapterSource }],
  });
  t.after(async () => { await worker.dispose(); await fetchMock.close(); });
  async function invoke(action, now) {
    const response = await worker.dispatchFetch('https://worker.example/report-cache', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, now }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const written = await invoke('put', NOW);
  assert.match(written.hit.key, /^[a-f0-9]{64}$/);
  assert.equal(written.hit.report.nickname, 'Fixture');
  assert.equal(written.hit.fileId, null);
  assert.equal(written.count, 1);
  assert.deepEqual(written.row, { created_at: NOW, expires_at: NOW + 300, file_id: null });

  const secondRequest = await invoke('get', NOW + 1);
  assert.deepEqual(secondRequest.hit, written.hit);
  assert.equal(secondRequest.count, 1);

  const fileSaved = await invoke('file', NOW + 200);
  assert.equal(fileSaved.hit.fileId, FILE_ID);
  assert.equal(fileSaved.hit.report.updatedAt, NOW);
  assert.deepEqual(fileSaved.row, { created_at: NOW, expires_at: NOW + 300, file_id: FILE_ID });

  const beforeExpiry = await invoke('get', NOW + 299);
  assert.equal(beforeExpiry.hit.fileId, FILE_ID);
  const expired = await invoke('get', NOW + 300);
  assert.equal(expired.hit, null);
  assert.equal(expired.count, 1); // cache reads do not mutate/prune native D1.
  assert.equal(expired.row.expires_at, NOW + 300);
  fetchMock.assertNoPendingInterceptors();
});
