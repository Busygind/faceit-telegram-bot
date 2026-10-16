import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaceitService } from '../tgcloud/lib/faceit.js';

const playerId = 'fixture-player-1';
const profile = { player_id: playerId, nickname: 'RenamedPlayer', games: { cs2: { faceit_elo: 1710, skill_level: 8 } } };
function fixture(body = profile, status = 200) {
  const calls = [];
  const service = createFaceitService({ key: 'synthetic-profile-key', now: () => 1800000000, fetch: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return { status, headers: { get: () => null }, json: async () => structuredClone(body) };
  } });
  return { service, calls };
}

test('personal binding refreshes one immutable player ID and picks the current nickname/ELO without reading history', async () => {
  const { service, calls } = fixture();
  const state = await service.start('OldNickname', 'stats', { playerId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, `/data/v4/players/${playerId}`);
  assert.equal(calls[0].url.search, '');
  assert.deepEqual(state.profile, { playerId, nickname: 'RenamedPlayer', elo: 1710, level: 8 });
  assert.equal(state.requests, 1); assert.equal(state.phase, 'history');
});

test('explicit nickname lookup remains independent of an existing binding', async () => {
  const { service, calls } = fixture();
  await service.start('OtherPlayer', 'last');
  assert.equal(calls[0].url.pathname, '/data/v4/players');
  assert.equal(calls[0].url.searchParams.get('nickname'), 'OtherPlayer');
});

test('invalid stored identity cannot inject a path or fall back to a possibly reassigned nickname', async () => {
  const { service, calls } = fixture();
  for (const id of ['', null, 1, '../other', 'x/y', 'https://example.org', 'p?nickname=x', 'x'.repeat(129), 'x\n']) {
    await assert.rejects(service.start('OldNickname', 'last', { playerId: id }), { code: 'INVALID_PLAYER_ID' });
  }
  assert.equal(calls.length, 0);
  const missing = fixture({}, 404);
  await assert.rejects(missing.service.start('OldNickname', 'last', { playerId }), { code: 'PLAYER_NOT_FOUND' });
  assert.equal(missing.calls.length, 1);
});

test('mismatched player identity and absent CS2 profile fail without starting a report', async () => {
  const mismatch = fixture({ ...profile, player_id: 'other-player' });
  await assert.rejects(mismatch.service.start('OldNickname', 'last', { playerId }), { code: 'FACEIT_INVALID_RESPONSE' });
  const noGame = fixture({ ...profile, games: {} });
  await assert.rejects(noGame.service.start('OldNickname', 'last', { playerId }), { code: 'PLAYER_NO_CS2' });
});
