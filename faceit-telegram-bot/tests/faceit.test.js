import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, createFaceitService, FaceitError, normalizeMatch } from '../tgcloud/lib/faceit.js';

const NOW = 1_800_000_000;
const DAY = 86400;
const PLAYER = { player_id: 'player-1', nickname: 'PlayerOne', games: { cs2: { faceit_elo: 1710, skill_level: 8 } } };
const profile = () => structuredClone(PLAYER);
const roster = () => ({
  faction1: { faction_id: 'team-a', name: 'Alpha', roster: [{ player_id: 'player-1', nickname: 'PlayerOne' }] },
  faction2: { faction_id: 'team-b', name: 'Bravo', roster: [{ player_id: 'player-2', nickname: 'Opponent' }] },
});
function history(id = 'match-1', finished = NOW - 1000) {
  return { match_id: id, finished_at: finished, game_id: 'cs2', status: 'FINISHED',
    teams: roster(), results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } } };
}
function detail(item) {
  return { ...structuredClone(item), game: 'cs2', best_of: 1, faceit_url: `https://www.faceit.com/{lang}/cs2/room/${item.match_id}` };
}
function round({ map = 'de_mirage', index = 1, kills = '20', deaths = '10', assists = '5', rounds = '23',
  headshots = '10', damage = '1840', adr, playerId = 'player-1', winner = 'team-a' } = {}) {
  return { match_id: 'fixture', match_round: index, game_id: 'cs2', round_stats: { Map: map, Rounds: rounds, Winner: winner },
    teams: [{ team_id: 'team-a', team_stats: { 'Final Score': '13' }, players: [{ player_id: playerId, nickname: 'PlayerOne',
      player_stats: { Kills: kills, Deaths: deaths, Assists: assists, Headshots: headshots, 'Total Damage': damage, ADR: adr } }] },
    { team_id: 'team-b', team_stats: { 'Final Score': '10' }, players: [{ player_id: 'player-2', nickname: 'Opponent',
      player_stats: { Kills: '10', Deaths: '20', Assists: '2', Headshots: '3', ADR: '50' } }] }] };
}
function response(value, status = 200, headers = {}) {
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => structuredClone(value) };
}
function fixture(items, { player = profile(), intercept, order = (rows) => rows, stats } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    const intercepted = await intercept?.(parsed, calls);
    if (intercepted) return intercepted;
    if (parsed.pathname.endsWith('/players')) return response(player);
    if (parsed.pathname.endsWith('/history')) {
      const from = Number(parsed.searchParams.get('from'));
      const to = Number(parsed.searchParams.get('to'));
      const offset = Number(parsed.searchParams.get('offset'));
      const limit = Number(parsed.searchParams.get('limit'));
      return response({ items: order(items.filter((item) => item.finished_at >= from && item.finished_at <= to)).slice(offset, offset + limit) });
    }
    const id = decodeURIComponent(parsed.pathname.split('/')[4]);
    const item = items.find((row) => row.match_id === id);
    if (!item) return response({}, 404);
    if (parsed.pathname.endsWith('/stats')) return stats ? stats(item) : response({ rounds: [round()] });
    return response(detail(item));
  };
  return { calls, service: createFaceitService({ fetch, key: 'fixture-api-key', now: () => NOW }) };
}
async function complete(service, state, maxRequests = 8) {
  for (let index = 0; index < 1000; index += 1) {
    const result = await service.advance(JSON.parse(JSON.stringify(state)), { maxRequests });
    assert.ok(result.progress.requests - state.requests <= maxRequests);
    if (result.done) return result;
    assert.equal(result.progress.reason, null);
    assert.equal(result.progress.retryAt, null);
    state = result.state;
  }
  throw new Error('Fixture did not complete');
}

for (const count of [0, 1, 29, 30, 31]) {
  test(`stats selects ${Math.min(count, 30)} of ${count} completed matches`, async () => {
    const items = Array.from({ length: count }, (_, index) => history(`match-${String(index).padStart(3, '0')}`, NOW - 1000 - index * DAY));
    const { service, calls } = fixture(items);
    const initial = await service.start('PlayerOne', 'stats');
    const { report } = await complete(service, initial);
    assert.equal(report.count, Math.min(count, 30));
    assert.equal(report.requested, 30);
    assert.deepEqual(report.matches.map((match) => match.matchId), items.slice(0, 30).map((item) => item.match_id));
    assert.equal(report.kind, 'stats');
    assert.equal(report.elo, 1710);
    assert.equal(report.level, 8);
    assert.equal(JSON.stringify(initial).includes('fixture-api-key'), false);
    assert.ok(calls.every(({ url }) => url.origin === 'https://open.faceit.com'));
    for (const { url } of calls.filter(({ url }) => url.pathname.endsWith('/history'))) {
      assert.equal(url.searchParams.get('game'), 'cs2');
      assert.ok(url.searchParams.has('from'));
      assert.ok(url.searchParams.has('to'));
      assert.ok(Number(url.searchParams.get('to')) <= NOW + 1);
      assert.ok(Number(url.searchParams.get('limit')) <= 100);
    }
  });
}

test('last requires nickname for every request and never uses a stored player', async () => {
  const { service, calls } = fixture([history()]);
  for (const value of ['', ' ', null, 'two names', 'a\nname']) {
    await assert.rejects(service.start(value, 'last'), { code: 'INVALID_NICKNAME' });
  }
  assert.equal(calls.length, 0);
  const { report } = await complete(service, await service.start('PlayerOne', 'last'), 1);
  assert.equal(report.count, 1);
  assert.equal(report.match.matchId, 'match-1');
  assert.equal(report.match.url, 'https://www.faceit.com/en/cs2/room/match-1');
  await assert.rejects(service.start('', 'stats'), { code: 'INVALID_NICKNAME' });
});

test('scan all unordered pages before choosing latest, including final page', async () => {
  const items = Array.from({ length: 151 }, (_, index) => history(`m-${index}`, NOW - index - 1));
  const { service, calls } = fixture(items, { order: (rows) => rows.slice().reverse() });
  const first = await service.advance(await service.start('PlayerOne', 'last'), { maxRequests: 1 });
  assert.equal(first.done, false);
  assert.equal(first.state.phase, 'history');
  assert.equal(first.state.windows[0].offset, 100);
  const { report } = await complete(service, first.state);
  assert.equal(report.match.matchId, 'm-0');
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/history')).length, 2);
});

test('extends search beyond 90 days and does not treat the first empty window as lifetime empty', async () => {
  const item = history('older', NOW - 500 * DAY);
  const { service, calls } = fixture([item]);
  const { report } = await complete(service, await service.start('PlayerOne', 'last'));
  assert.equal(report.match.matchId, 'older');
  assert.ok(calls.filter(({ url }) => url.pathname.endsWith('/history')).length >= 3);
});

test('splits saturated windows, honors offset cap, and deduplicates overlapping bounds', async () => {
  const items = Array.from({ length: 1250 }, (_, index) => history(`dense-${index}`, NOW - 1250 + index));
  const { service, calls } = fixture(items);
  const { report } = await complete(service, await service.start('PlayerOne', 'stats'), 4);
  assert.equal(report.count, 30);
  assert.equal(report.matches[0].matchId, 'dense-1249');
  assert.equal(new Set(report.matches.map((item) => item.matchId)).size, 30);
  const historyCalls = calls.filter(({ url }) => url.pathname.endsWith('/history'));
  assert.ok(historyCalls.some(({ url }) => Number(url.searchParams.get('offset')) === 1000));
  assert.ok(historyCalls.every(({ url }) => Number(url.searchParams.get('offset')) <= 1000));
  assert.ok(new Set(historyCalls.map(({ url }) => url.searchParams.get('from'))).size > 1);
});

test('excludes current/canceled/other-game/future matches and uses stable finished-at tie break', async () => {
  const items = [history('a'), history('b'), { ...history('current'), status: 'ONGOING' },
    { ...history('canceled'), status: 'CANCELLED' }, { ...history('csgo'), game_id: 'csgo' }, history('future', NOW + 1)];
  const { service } = fixture(items);
  const { report } = await complete(service, await service.start('PlayerOne', 'stats'));
  assert.deepEqual(report.matches.map((match) => match.matchId), ['b', 'a']);
});

test('missing latest stats does not replace latest match or fill to 30 with an older one', async () => {
  const items = [history('latest', NOW - 1), history('older', NOW - 2)];
  const { service } = fixture(items, { stats: (item) => item.match_id === 'latest' ? response({}, 404) : response({ rounds: [round()] }) });
  const { report } = await complete(service, await service.start('PlayerOne', 'last'));
  assert.equal(report.match.matchId, 'latest');
  assert.equal(report.partial, true);
  assert.equal(report.match.statsAvailable, false);
  assert.equal(report.metrics.kd.value, null);
});

test('a match rejected by detail status is removed and selection refilled from the same scanned window', async () => {
  const items = [history('changed', NOW - 1), history('actual', NOW - 2)];
  const { service } = fixture(items, { intercept: (url) => url.pathname.endsWith('/matches/changed')
    ? response({ ...detail(items[0]), status: 'CANCELLED' }) : null });
  const { report } = await complete(service, await service.start('PlayerOne', 'last'));
  assert.equal(report.match.matchId, 'actual');
});

test('429 pauses at history/detail/stats without losing checkpoint or leaking key/response', async () => {
  for (const suffix of ['/history', '/matches/match-1', '/stats']) {
    let blocked = false;
    let clock = NOW;
    const items = [history()];
    const service = createFaceitService({ fetch: async (...args) => {
      const url = new URL(args[0]);
      if (url.pathname.endsWith('/players')) return response(profile());
      if (url.pathname.endsWith(suffix) && !blocked) { blocked = true; return response({}, 429, { 'retry-after': '7' }); }
      if (url.pathname.endsWith('/history')) return response({ items });
      if (url.pathname.endsWith('/stats')) return response({ rounds: [round()] });
      return response(detail(items[0]));
    }, key: 'private-fixture-key', now: () => clock });
    const initial = await service.start('PlayerOne', 'last');
    const result = await service.advance(initial);
    assert.equal(result.done, false);
    assert.equal(result.progress.retryAt, NOW + 7);
    assert.equal(JSON.stringify(result.state).includes('private-fixture-key'), false);
    assert.deepEqual(initial.matches, []);
    const stillPaused = await service.advance(result.state);
    assert.equal(stillPaused.state.requests, result.state.requests);
    clock += 8;
    const { report } = await complete(service, result.state);
    assert.equal(report.match.matchId, 'match-1');
  }
});

test('safe API errors distinguish player missing, no CS2, auth, bad JSON and transport failures', async () => {
  const make = (fetch) => createFaceitService({ fetch, key: 'DO-NOT-LEAK', now: () => NOW });
  await assert.rejects(make(async () => response({}, 404)).start('user', 'last'), { code: 'PLAYER_NOT_FOUND' });
  await assert.rejects(make(async () => response({ ...profile(), games: {} })).start('user', 'last'), { code: 'PLAYER_NO_CS2' });
  for (const status of [401, 403]) {
    await assert.rejects(make(async () => response({ token: 'DO-NOT-LEAK' }, status)).start('user', 'last'), (error) => {
      assert.equal(error.code, 'FACEIT_ACCESS_DENIED');
      assert.ok(!String(error).includes('DO-NOT-LEAK'));
      return true;
    });
  }
  await assert.rejects(make(async () => ({ status: 200, json() { throw new Error('raw-body'); } })).start('user', 'last'), { code: 'FACEIT_INVALID_RESPONSE' });
  await assert.rejects(make(async () => { throw new Error('Authorization: DO-NOT-LEAK'); }).start('user', 'last'), (error) => {
    assert.equal(error.code, 'FACEIT_TEMPORARY');
    assert.ok(error.retryAt > NOW);
    assert.ok(!String(error).includes('DO-NOT-LEAK'));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.throws(() => createFaceitService({ fetch: () => {}, key: 'x\r\ny' }), FaceitError);
});

test('series is one match; metric ratios use paired map sums, not mean ready ratios', () => {
  const item = history();
  const match = normalizeMatch(item, { ...detail(item), best_of: 3,
    results: { winner: 'faction1', score: { faction1: 2, faction2: 0 } } }, { rounds: [
    round({ kills: '10', deaths: '1', rounds: '20', headshots: '2', damage: '1000' }),
    round({ map: 'de_nuke', index: 2, kills: '30', deaths: '19', rounds: '30', headshots: '18', damage: null, adr: '100' }),
  ] }, 'player-1');
  const report = buildReport({ kind: 'stats', profile: { nickname: 'PlayerOne' }, target: 30, phase: 'done', matches: [match] }, NOW);
  assert.equal(report.count, 1);
  assert.equal(report.metrics.kd.value, 2);
  assert.equal(report.metrics.kr.value, 0.8);
  assert.equal(report.metrics.avgKills.value, 40);
  assert.equal(report.metrics.hs.value, 50);
  assert.equal(report.metrics.adr.value, 80);
  assert.equal(report.metrics.adr.approximate, true);
  assert.deepEqual({ matches: report.metrics.kd.matches, maps: report.metrics.kd.maps }, { matches: 1, maps: 2 });
  assert.equal(report.maps.length, 2);
  assert.equal(match.player.kills, 40);
  assert.equal(match.teams[0].players[0].kills, 40);
});

test('each metric has its own paired coverage; missing fields/division by zero are not manufactured zeros', () => {
  const item = history();
  const match = normalizeMatch(item, { ...detail(item), best_of: 3,
    results: { winner: 'faction1', score: { faction1: 2, faction2: 0 } } }, { rounds: [
    round({ kills: '10', deaths: '0', rounds: '20', headshots: null, damage: null, adr: null }),
    round({ index: 2, kills: null, deaths: '5', rounds: '30', headshots: '4', damage: '1800' }),
  ] }, 'player-1');
  const report = buildReport({ kind: 'stats', profile: {}, target: 30, phase: 'done', matches: [match] }, NOW);
  assert.equal(report.metrics.kd.value, null);
  assert.equal(report.metrics.kd.maps, 1);
  assert.equal(report.metrics.kr.value, 0.5);
  assert.equal(report.metrics.hs.value, null);
  assert.equal(report.metrics.hs.maps, 0);
  assert.equal(report.metrics.adr.value, 60);
  assert.equal(report.metrics.avgKills.value, null);
  assert.equal(report.metrics.kills.value, 10);
  assert.equal(report.metrics.deaths.value, 5);
  assert.equal(match.player.kills, null);
});

test('own faction2 perspective is preserved, unknown winner stays unknown, invalid numeric strings omitted', () => {
  const item = history();
  const stats = { rounds: [round({ kills: 'NaN', deaths: '-1', headshots: ' ', damage: 'Infinity' })] };
  const own = normalizeMatch(item, detail(item), stats, 'player-2');
  assert.equal(own.result, 'L');
  assert.deepEqual(own.score, { own: 0, opponent: 1 });
  assert.equal(own.player.kills, 10);
  const unknown = normalizeMatch(item, { ...detail(item), results: { winner: 'unrecognized', score: {} } }, stats, 'player-1');
  assert.equal(unknown.result, '?');
  assert.equal(unknown.player.kills, null);
  assert.equal(unknown.player.deaths, null);
  assert.equal(unknown.player.hs, null);
});

test('incomplete BO3 stats are not reported as a complete average-kills match', () => {
  const item = history();
  const match = normalizeMatch(item, { ...detail(item), best_of: 3,
    results: { winner: 'faction1', score: { faction1: 2, faction2: 1 } } }, { rounds: [round()] }, 'player-1');
  const report = buildReport({ kind: 'stats', profile: {}, target: 30, phase: 'done', matches: [match] }, NOW);
  assert.equal(report.partial, true);
  assert.equal(report.metrics.avgKills.value, null);
  assert.equal(report.metrics.avgKills.matches, 0);
  assert.equal(match.player.kills, null);
});

test('wrong-player stat dictionaries never become requested player statistics', () => {
  const item = history();
  const match = normalizeMatch(item, detail(item), { rounds: [round({ playerId: 'unrelated' })] }, 'player-1');
  assert.equal(match.statsAvailable, false);
  assert.equal(match.player.kills, null);
});

test('unplayed and duplicate map entries never double-count raw map statistics', () => {
  const item = history();
  const played = round();
  const unplayed = { ...round({ index: 2, kills: '100' }), played: false };
  const match = normalizeMatch(item, detail(item), { rounds: [played, structuredClone(played), unplayed] }, 'player-1');
  assert.equal(match.maps.length, 1);
  assert.equal(match.player.kd, 2);
  assert.equal(match.player.kills, 20);
  assert.equal(match.partial, false);
});

test('unsplittable dense second yields explicit incomplete selection, not fabricated latest', async () => {
  const items = Array.from({ length: 100 }, (_, index) => history(`same-${index}`, NOW - 1));
  const { service } = fixture(items);
  const state = await service.start('PlayerOne', 'last');
  state.windows = [{ from: NOW - 1, to: NOW, offset: 1000 }];
  const custom = createFaceitService({ key: 'fixture', now: () => NOW,
    fetch: async () => response({ items }) });
  const result = await custom.advance(state, { maxRequests: 1 });
  assert.equal(result.done, false);
  assert.equal(result.report, null);
  assert.equal(result.progress.reason, 'HISTORY_DENSITY_UNRESOLVED');
  assert.equal((await custom.advance(result.state)).state.requests, result.state.requests);
});

test('ready checkpoints preserve report update time and explicitly mark stale results', async () => {
  const { service } = fixture([history()]);
  const finished = await complete(service, await service.start('PlayerOne', 'last'));
  assert.equal(finished.state.completedAt, NOW);
  assert.equal(finished.report.stale, false);
  const later = createFaceitService({ key: 'fixture', now: () => NOW + DAY,
    fetch() { throw new Error('Ready checkpoints must not call FACEIT'); } });
  const resumed = await later.advance(finished.state);
  assert.equal(resumed.report.updatedAt, NOW);
  assert.equal(resumed.report.stale, true);
  assert.equal(resumed.state.requests, finished.state.requests);
});

test('different series maps are not discarded solely because a provider reused match_round', () => {
  const item = history();
  const match = normalizeMatch(item, { ...detail(item), best_of: 3,
    results: { winner: 'faction1', score: { faction1: 2, faction2: 0 } } }, { rounds: [
    round({ map: 'de_mirage', index: 1 }), round({ map: 'de_nuke', index: 1 }),
  ] }, 'player-1');
  assert.equal(match.maps.length, 2);
  assert.equal(match.player.kills, 40);
});

test('strict API bounds retain the 90-day boundary and fixed-snapshot second', async () => {
  for (const finished of [NOW - 90 * DAY, NOW]) {
    const item = history('boundary', finished);
    const { service } = fixture([item], { intercept: (url) => {
      if (!url.pathname.endsWith('/history')) return null;
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      return response({ items: item.finished_at > from && item.finished_at < to ? [item] : [] });
    } });
    const { report } = await complete(service, await service.start('PlayerOne', 'last'));
    assert.equal(report.match.matchId, 'boundary');
    assert.equal(report.match.finishedAt, finished);
  }
});

test('strict API bounds retain a saturated-window midpoint not seen on original pages', async () => {
  const middle = NOW - 45 * DAY;
  // History ordering is unspecified: place the newest midpoint match outside
  // the first 1100 results so only correctly overlapping split windows find it.
  const items = Array.from({ length: 1100 }, (_, index) => history(`older-${index}`, middle - index - 1));
  items.push(history('midpoint-latest', middle));
  const { service } = fixture(items, { intercept: (url) => {
    if (!url.pathname.endsWith('/history')) return null;
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const offset = Number(url.searchParams.get('offset'));
    return response({ items: items.filter((item) => item.finished_at > from && item.finished_at < to).slice(offset, offset + 100) });
  } });
  const { report } = await complete(service, await service.start('PlayerOne', 'last'));
  assert.equal(report.match.matchId, 'midpoint-latest');
});

test('headshot counts stay distinct from percentages regardless of dynamic field order', () => {
  for (const fields of [
    { 'Headshots %': '25', Headshots: '5' },
    { Headshots: '5', 'Headshots %': '25' },
  ]) {
    const item = history();
    const map = round({ rounds: '21' });
    map.teams[0].players[0].player_stats = { Kills: '20', Deaths: '11', Assists: '5', Damage: '2101', ADR: '100', ...fields };
    const match = normalizeMatch(item, detail(item), { rounds: [map] }, 'player-1');
    const report = buildReport({ kind: 'stats', profile: {}, target: 30, phase: 'done', matches: [match] }, NOW);
    assert.equal(match.maps[0].headshots, 5);
    assert.equal(match.player.hs, 25);
    assert.equal(report.metrics.hs.value, 25);
    assert.equal(report.metrics.hs.matches, 1);
    assert.equal(report.metrics.hs.maps, 1);
    assert.equal(report.metrics.adr.value, 2101 / 21);
  }
});

test('a percentage alone never becomes a headshot count or a synthetic HS ratio', () => {
  const item = history();
  const map = round();
  map.teams[0].players[0].player_stats = { Kills: '20', 'Headshots %': '25' };
  const match = normalizeMatch(item, detail(item), { rounds: [map] }, 'player-1');
  const report = buildReport({ kind: 'stats', profile: {}, target: 30, phase: 'done', matches: [match] }, NOW);
  assert.equal(match.maps[0].headshots, null);
  assert.equal(match.player.hs, null);
  assert.equal(report.metrics.hs.value, null);
  assert.equal(report.metrics.hs.matches, 0);
  assert.equal(report.metrics.hs.maps, 0);
});

test('invocation guard pauses before a GET without consuming requests or altering the input checkpoint', async () => {
  const { service, calls } = fixture([history()]);
  const initial = await service.start('PlayerOne', 'last');
  const frozen = structuredClone(initial);
  const result = await service.advance(initial, { maxRequests: 8, shouldContinue: () => false });
  assert.equal(result.done, false);
  assert.deepEqual(result.state, initial);
  assert.deepEqual(initial, frozen);
  assert.equal(result.progress.requests, 1);
  assert.equal(result.progress.retryAt, null);
  assert.equal(calls.length, 1);
  const resumed = await complete(service, JSON.parse(JSON.stringify(result.state)));
  assert.equal(resumed.report.match.matchId, 'match-1');
  assert.equal(calls.length, 4);
});

test('invocation guard preserves a fetched detail and resumes at stats without repeating a GET', async () => {
  let allowed = true;
  const { service, calls } = fixture([history()], {
    intercept: url => { if (url.pathname.endsWith('/matches/match-1')) allowed = false; },
  });
  const result = await service.advance(await service.start('PlayerOne', 'last'), { maxRequests: 20, shouldContinue: () => allowed });
  assert.equal(result.done, false);
  assert.equal(result.state.phase, 'stats');
  assert.equal(result.state.detail.match_id, 'match-1');
  assert.equal(result.progress.requests, 3);
  assert.equal(result.progress.retryAt, null);
  assert.equal(calls.length, 3);
  allowed = true;
  const resumed = await service.advance(JSON.parse(JSON.stringify(result.state)), { maxRequests: 20, shouldContinue: () => allowed });
  assert.equal(resumed.done, true);
  assert.equal(resumed.report.match.matchId, 'match-1');
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/matches/match-1')).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/stats')).length, 1);
  const ready = await service.advance(resumed.state, { shouldContinue: () => false });
  assert.equal(ready.done, true, 'a ready checkpoint needs no HTTP and remains deliverable after the read budget');
  assert.equal(calls.length, 4);
});

test('history-only selection settles after the last allowed GET without reading detail or stats', async () => {
  let allowed = true;
  const { service, calls } = fixture([history()], {
    intercept: url => { if (url.pathname.endsWith('/history')) allowed = false; },
  });
  const result = await service.advance(await service.start('PlayerOne', 'last'), { maxRequests: 8, historyOnly: true, shouldContinue: () => allowed });
  assert.equal(result.state.phase, 'details');
  assert.equal(result.state.selected.length, 1);
  assert.equal(result.state.windows.length, 0);
  assert.equal(result.state.requests, 2);
  assert.equal(calls.length, 2);
  assert.equal(result.progress.retryAt, null);
  assert.equal(JSON.stringify(result.state).includes('shouldContinue'), false);
});
