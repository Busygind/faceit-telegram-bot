import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaceitService } from '../tgcloud/lib/faceit.js';
import { makeHarness } from './bot-harness.js';

const LARGE = 'synthetic_large_photo_file_id_123456';
const SMALL = 'synthetic_small_photo_file_id_123456';
const START = 1800000000;

async function fixture(t, kind, count = kind === 'last' ? 1 : 30) {
  let now = START;
  let sequence = 10000;
  let photoFailure;
  let historyFailure = false;
  const calls = [];
  const entries = new Map();
  const gets = [];
  const puts = [];
  const profile = { player_id: 'p', nickname: 'Player', games: { cs2: { faceit_elo: 1700, skill_level: 8 } } };
  const teams = { faction1: { faction_id: 'a', name: 'Own', roster: [{ player_id: 'p', nickname: 'Player' }] },
    faction2: { faction_id: 'b', name: 'Other', roster: [{ player_id: 'q', nickname: 'Other' }] } };
  const match = (id, finished) => ({ match_id: id, finished_at: finished, game_id: 'cs2', game: 'cs2', status: 'FINISHED', best_of: 1,
    teams, results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } } });
  const items = Array.from({ length: count }, (_, i) => match(`fixture-${i}`, START - 1000 - i * 100));
  const service = createFaceitService({ key: 'fixture-key-never-real', now: () => now, fetch: async url => {
    const target = new URL(url); calls.push(target.pathname);
    if (target.pathname.endsWith('/players')) return Response.json(profile);
    if (target.pathname.endsWith('/history')) {
      if (historyFailure) { historyFailure = false; return Response.json({}, { status: 429, headers: { 'retry-after': '3' } }); }
      const from = Number(target.searchParams.get('from')); const to = Number(target.searchParams.get('to'));
      const offset = Number(target.searchParams.get('offset')); const limit = Number(target.searchParams.get('limit'));
      // Deliberately unordered: cache lookup must wait until all pages are read.
      return Response.json({ items: items.filter(item => item.finished_at >= from && item.finished_at <= to).slice().reverse().slice(offset, offset + limit) });
    }
    const id = target.pathname.split('/')[4]; const item = items.find(value => value.match_id === id); assert.ok(item);
    if (!target.pathname.endsWith('/stats')) return Response.json(item);
    return Response.json({ rounds: [{ match_id: id, match_round: 1, game_id: 'cs2', round_stats: { Map: 'de_inferno', Rounds: '21', Winner: 'a' },
      teams: [{ team_id: 'a', team_stats: { 'Final Score': '13' }, players: [{ player_id: 'p', nickname: 'Player', player_stats: { Kills: '20', Deaths: '11', Assists: '5', Headshots: '5', 'Total Damage': '2000' } }] },
        { team_id: 'b', team_stats: { 'Final Score': '8' }, players: [{ player_id: 'q', nickname: 'Other', player_stats: { Kills: '11', Deaths: '20', Assists: '1' } }] }] }] });
  } });
  const key = state => JSON.stringify([state.kind, state.profile, state.selected.map(item => item.match_id)]);
  const cache = {
    async get(state) {
      gets.push(structuredClone(state)); assert.equal(state.phase, 'details'); assert.equal(state.windows.length, 0); assert.equal(state.matches.length, 0);
      const entry = entries.get(key(state)); return entry && entry.expires > now ? structuredClone(entry) : null;
    },
    async put(state, report, fileId = null) {
      puts.push({ state: structuredClone(state), report: structuredClone(report), fileId });
      entries.set(key(state), { key: key(state), report: structuredClone(report), fileId, expires: report.updatedAt + 300 });
    },
  };
  const bot = await makeHarness(t, { now: () => now, settings: { maxRequests: 4, autoAdvanceBatches: 32, autoAdvanceSeconds: 90 }, apiOverrides: {
    sendPhoto: params => {
      if (photoFailure) return photoFailure(params);
      return { message_id: ++sequence, photo: [{ file_id: LARGE, width: 864, height: 1360, file_size: 123456 }, { file_id: SMALL, width: 100, height: 100, file_size: 999999 }] };
    },
  } });
  bot.dependencies.faceit = service; bot.dependencies.reportCache = cache; bot.restart();
  return { bot, service, calls, entries, gets, puts, profile, cache, items,
    tick: seconds => { now += seconds; },
    addMatch: () => items.unshift(match('new-latest', now - 1)),
    failPhotos: fn => { photoFailure = fn; },
    rateLimitHistory: () => { historyFailure = true; },
  };
}

for (const kind of ['last', 'stats']) {
  test(`${kind} report cache checks fresh history/profile and reuses file_id without jobs, rendering or TTL extension`, async t => {
    const f = await fixture(t, kind); const n = kind === 'last' ? 1 : 30;
    await f.bot.send(`/${kind} Player`);
    assert.equal(f.calls.length, 2 + 2 * n); assert.equal(f.gets.length, 1); assert.equal(f.puts.length, 2);
    assert.equal(f.puts[1].fileId, LARGE, 'largest resolution wins over file_size and array order');
    assert.equal((await f.bot.db.all('SELECT * FROM report_jobs')).length, 1);
    const entry = [...f.entries.values()][0]; const expiry = entry.expires;
    f.calls.length = 0; f.tick(1);
    const warmId = await f.bot.send(`/${kind} Player`);
    assert.equal(f.calls.length, 2, 'profile and complete history remain fresh');
    assert.equal(f.bot.sent('sendPhoto').at(-1).photo, LARGE); assert.equal(f.bot.renderedReports.length, 1);
    assert.equal((await f.bot.db.all('SELECT * FROM report_jobs')).length, 1, 'warm hit skips checkpoint jobs');
    assert.equal(f.puts.length, 2); assert.equal([...f.entries.values()][0].expires, expiry);
    await f.bot.send(`/${kind} Player`, {}, warmId); assert.equal(f.calls.length, 2); assert.equal(f.bot.sent('sendPhoto').length, 2);
    f.calls.length = 0; f.addMatch(); await f.bot.send(`/${kind} Player`);
    assert.equal(f.calls.length, 2 + 2 * n, 'new latest match invalidates cache'); assert.equal(f.bot.renderedReports.length, 2);
    f.calls.length = 0; f.profile.games.cs2.faceit_elo++; await f.bot.send(`/${kind} Player`);
    assert.equal(f.calls.length, 2 + 2 * n, 'current profile changes invalidate cache'); assert.equal(f.bot.renderedReports.length, 3);
    f.calls.length = 0; f.tick(301); await f.bot.send(`/${kind} Player`);
    assert.equal(f.calls.length, 2 + 2 * n, 'expired report is recomputed'); assert.equal(f.bot.renderedReports.length, 4);
    assert.equal(f.bot.sent().length, 0); assert.ok(f.bot.sent('sendPhoto').every(photo => !Object.hasOwn(photo, 'caption')));
  });
}

test('historyOnly settles exact-budget selection without detail/stat HTTP', async t => {
  const f = await fixture(t, 'stats'); const state = await f.service.start('Player', 'stats');
  const history = await f.service.advance(state, { maxRequests: 1, historyOnly: true });
  assert.equal(history.state.phase, 'details'); assert.equal(history.state.selected.length, 30); assert.equal(history.done, false);
  assert.equal(f.calls.length, 2); assert.equal(history.state.windows.length, 0);
  await f.service.advance(history.state, { maxRequests: 1, historyOnly: true }); assert.equal(f.calls.length, 2);
});

test('pagination continuation waits for the full snapshot, checks cache once and remains deduplicated after restart', async t => {
  const f = await fixture(t, 'last', 201); await f.bot.send('/last Player');
  f.calls.length = 0; f.gets.length = 0;
  f.bot.dependencies.settings.maxRequests = 1; f.bot.dependencies.settings.autoAdvanceBatches = 1; f.bot.restart();
  await f.bot.send('/last Player');
  assert.equal(f.gets.length, 0); assert.equal(f.calls.filter(path => path.endsWith('/history')).length, 2);
  const job = (await f.bot.db.all('SELECT * FROM report_jobs')).find(row => row.status === 'pending'); assert.ok(job);
  assert.equal(f.bot.renderedReports.at(-1).kind, 'notice');
  f.bot.restart(); await f.bot.click(`continue:${job.job_id}`);
  assert.equal(f.gets.length, 1); assert.equal(f.calls.filter(path => path.endsWith('/history')).length, 3);
  assert.equal(f.calls.filter(path => path.includes('/matches/')).length, 0); assert.equal(f.bot.sent('sendPhoto').at(-1).photo, LARGE);
  assert.equal((await f.bot.store.getJob(job.job_id)).status, 'ready'); const photos = f.bot.sent('sendPhoto').length;
  f.bot.restart(); await f.bot.click(`continue:${job.job_id}`); assert.equal(f.bot.sent('sendPhoto').length, photos); assert.equal(f.gets.length, 1);
});

test('report cache failures fail open and cached reports without file_id render without match HTTP', async t => {
  const f = await fixture(t, 'last'); await f.bot.send('/last Player');
  [...f.entries.values()][0].fileId = null; f.calls.length = 0; await f.bot.send('/last Player');
  assert.equal(f.calls.length, 2); assert.equal(typeof f.bot.sent('sendPhoto').at(-1).photo, 'object'); assert.equal(f.bot.renderedReports.length, 2);
  f.cache.get = async () => { throw new Error('private cache failure'); }; f.cache.put = async () => { throw new Error('private cache failure'); };
  f.calls.length = 0; await f.bot.send('/last Player'); assert.equal(f.calls.length, 4); assert.equal(f.bot.renderedReports.length, 3); assert.equal(f.bot.sent().length, 0);
});

test('only a definitely invalid cached file_id allows one byte fallback under the same delivery claim', async t => {
  const f = await fixture(t, 'last'); await f.bot.send('/last Player');
  f.failPhotos(params => { if (typeof params.photo === 'string') throw Object.assign(new Error('definitely invalid'), { code: 400, invalidFileId: true }); return { message_id: 500, photo: [{ file_id: 'replacement_photo_file_id_12345', width: 864, height: 1360 }] }; });
  const updateId = await f.bot.send('/last Player');
  assert.equal(f.bot.sent('sendPhoto').length, 3); assert.equal(f.bot.renderedReports.length, 2);
  assert.equal([...f.entries.values()][0].fileId, 'replacement_photo_file_id_12345');
  await f.bot.send('/last Player', {}, updateId); assert.equal(f.bot.sent('sendPhoto').length, 3);
  assert.equal((await f.bot.db.all("SELECT * FROM deliveries WHERE kind='photo'")).length, 2);
});

for (const error of [Object.assign(new Error('other bad request'), { code: 400 }), Object.assign(new Error('flood'), { code: 429 }), new Error('ambiguous transport')]) {
  test(`cached file_id failure ${error.code ?? 'network'} never triggers a fallback or rerender`, async t => {
    const f = await fixture(t, 'last'); await f.bot.send('/last Player'); f.failPhotos(() => { throw error; });
    await f.bot.send('/last Player'); assert.equal(f.bot.sent('sendPhoto').length, 2); assert.equal(f.bot.renderedReports.length, 1); assert.equal(f.bot.sent().length, 0);
    const rows = await f.bot.db.all("SELECT * FROM deliveries WHERE kind='photo'"); assert.equal(rows.at(-1).status, error.code ? 'rejected' : 'outcome_unknown');
  });
}

test('rate-limited history persists without looking up a stale cached report, then resumes safely', async t => {
  const f = await fixture(t, 'last'); await f.bot.send('/last Player'); f.gets.length = 0; f.rateLimitHistory();
  await f.bot.send('/last Player'); assert.equal(f.gets.length, 0); assert.equal(f.bot.renderedReports.at(-1).kind, 'notice');
  const job = (await f.bot.db.all('SELECT * FROM report_jobs')).find(row => row.status === 'pending'); assert.ok(job);
  f.tick(4); await f.bot.click(`continue:${job.job_id}`); assert.equal(f.gets.length, 1); assert.equal(f.bot.sent('sendPhoto').at(-1).photo, LARGE);
});

test('render-error notice is never persisted as a report photo file_id', async t => {
  const f = await fixture(t, 'last');
  f.bot.dependencies.renderCard = report => { if (report.kind !== 'notice') throw new Error('render failed'); return new Uint8Array([1,2,3]); }; f.bot.restart();
  await f.bot.send('/last Player'); assert.equal(f.puts.length, 1); assert.equal(f.puts[0].fileId, null);
  assert.equal([...f.entries.values()][0].fileId, null); assert.equal(f.bot.sent('sendPhoto').length, 1);
});

test('blocked dense history persists an honest terminal checkpoint without cache lookup', async t => {
  const f = await fixture(t, 'last'); let advances = 0;
  f.bot.dependencies.faceit = {
    start: async () => ({ kind: 'last', phase: 'history', blocked: 'HISTORY_DENSITY_UNRESOLVED' }),
    advance: async state => { advances++; return { done: false, state, progress: { reason: 'HISTORY_DENSITY_UNRESOLVED' } }; },
  }; f.bot.restart(); await f.bot.send('/last Player');
  const job = (await f.bot.db.all('SELECT * FROM report_jobs'))[0]; assert.equal(job.status, 'blocked'); assert.equal(f.gets.length, 0);
  const before = advances; await f.bot.click(`continue:${job.job_id}`); assert.equal(advances, before); assert.equal(f.bot.sent().length, 0);
});
