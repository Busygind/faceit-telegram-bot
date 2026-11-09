import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, fixtureReport } from './bot-harness.js';
import { REPORT_CACHE_SCOPE } from '../local/report-cache.mjs';

for (const scope of [undefined, 'faceit-dark-v1/core-schema-v1', REPORT_CACHE_SCOPE]) {
  test('ready checkpoint file_id reuse requires current renderer scope: ' + String(scope), async t => {
    const bot = await makeHarness(t);
    bot.dependencies.reportCache = { rendererScope: REPORT_CACHE_SCOPE, async get() { return null; }, async put() {} };
    bot.restart();
    const state = { kind: 'stats', cachedReport: { ...fixtureReport(), updatedAt: 1800000000 },
      cachedFileId: 'AgAC_fixture_template', ...(scope == null ? {} : { cachedRendererScope: scope }) };
    await bot.store.createJob('cached', -10, null, state);
    await bot.store.saveJob('cached', 0, state, 'ready');
    await bot.click('continue:cached');
    const photo = bot.sent('sendPhoto').at(-1);
    if (scope === REPORT_CACHE_SCOPE) {
      assert.equal(photo.photo, state.cachedFileId);
      assert.equal(bot.renderedReports.length, 0);
    } else {
      assert.ok(photo.photo.bytes instanceof Uint8Array);
      assert.equal(bot.renderedReports.at(-1).kind, 'stats');
    }
    assert.equal(photo.caption, undefined);
    assert.equal(bot.advances.length, 0);
  });
}
