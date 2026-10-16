import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocal } from '../local/run.mjs';
import { openDatabase } from '../local/database.mjs';

const CHAT = -1004393474895;
const UPDATE_ID = 801;
const TOKEN = `123456:${'last_flow_fixture_'.repeat(3)}`;
const FACEIT_KEY = 'synthetic-faceit-key-for-local-last-flow';
const PLAYER_ID = 'last-flow-player';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const telegram = (result) => json({ ok: true, result });

function matchFixture() {
  const now = Math.floor(Date.now() / 1000);
  const friends = Array.from({ length: 5 }, (_, index) => ({
    player_id: index ? `friend-${index}` : PLAYER_ID, nickname: index ? `Friend${index}` : 'aghori-',
  }));
  const opponents = Array.from({ length: 5 }, (_, index) => ({ player_id: `opponent-${index}`, nickname: `Opponent${index}` }));
  const latest = {
    match_id: 'latest-local-match', finished_at: now - 1000, game_id: 'cs2', status: 'FINISHED',
    teams: {
      faction1: { faction_id: 'team-a', name: 'Friends', roster: friends },
      faction2: { faction_id: 'team-b', name: 'Opponents', roster: opponents },
    },
    results: { winner: 'faction1', score: { faction1: 13, faction2: 10 } },
  };
  const older = { ...latest, match_id: 'older-local-match', finished_at: now - 86400 };
  const detail = { ...latest, game: 'cs2', best_of: 1, faceit_url: `https://www.faceit.com/{lang}/cs2/room/${latest.match_id}` };
  const statistics = { rounds: [{
    match_id: latest.match_id, match_round: 1, game_id: 'cs2',
    round_stats: { Map: 'de_mirage', Rounds: '23', Winner: 'team-a' },
    teams: [
      { team_id: 'team-a', team_stats: { 'Final Score': '13' }, players: friends.map((player, index) => ({
        ...player, player_stats: { Kills: String(20 + index), Deaths: '10', Assists: '5', Headshots: '10', 'Total Damage': String(1840 + index * 230) },
      })) },
      { team_id: 'team-b', team_stats: { 'Final Score': '10' }, players: opponents.map((player, index) => ({
        ...player, player_stats: { Kills: String(10 + index), Deaths: '20', Assists: '2', Headshots: '3', ADR: String(50 + index * 5) },
      })) },
    ],
  }] };
  return { latest, older, detail, statistics, players: [...friends, ...opponents] };
}

async function runFixture(t, { missingStats = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faceit-local-last-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, '.secrets');
  await mkdir(secrets, { mode: 0o700 });
  await writeFile(join(secrets, 'telegram-bot.token'), `${TOKEN}\n`, { mode: 0o600 });
  await writeFile(join(secrets, 'faceit.key'), `${FACEIT_KEY}\n`, { mode: 0o600 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const fixture = matchFixture();
  const calls = [];
  const faceitCalls = [];
  const statuses = [];
  let poll = 0;
  let messageId = 950;
  const update = {
    update_id: UPDATE_ID,
    message: { message_id: 30, text: '/last aghori-', chat: { id: CHAT, type: 'supergroup' }, from: { id: 123, is_bot: false } },
  };
  const fetch = async (url, request) => {
    const target = new URL(url);
    assert.equal(request.redirect, 'error');
    if (target.origin === 'https://open.faceit.com') {
      faceitCalls.push(target);
      assert.equal(request.headers.Authorization, `Bearer ${FACEIT_KEY}`);
      if (target.pathname === '/data/v4/players') {
        assert.equal(target.searchParams.get('nickname'), 'aghori-');
        return json({ player_id: PLAYER_ID, nickname: 'aghori-', games: { cs2: { faceit_elo: 1952, skill_level: 9 } } });
      }
      if (target.pathname === `/data/v4/players/${PLAYER_ID}/history`) {
        assert.equal(target.searchParams.get('game'), 'cs2');
        assert.equal(target.searchParams.get('limit'), '100');
        return json({ items: [fixture.older, fixture.latest] });
      }
      if (target.pathname === `/data/v4/matches/${fixture.latest.match_id}`) return json(fixture.detail);
      if (target.pathname === `/data/v4/matches/${fixture.latest.match_id}/stats`) {
        return missingStats ? json({}, 404) : json(fixture.statistics);
      }
      assert.fail('Only the actual latest match may be loaded; missing stats must not substitute an older match');
    }
    assert.equal(target.origin, 'https://api.telegram.org');
    const method = target.pathname.split('/').at(-1);
    const params = request.body instanceof FormData ? request.body : JSON.parse(request.body);
    calls.push({ method, params });
    switch (method) {
      case 'getMe': return telegram({ id: 999, is_bot: true, username: 'road_to_3_elo_bot' });
      case 'getWebhookInfo': return telegram({ url: '' });
      case 'getChat': return telegram({ id: CHAT, type: 'supergroup' });
      case 'getChatMember': return telegram({ status: 'administrator', can_delete_messages: true });
      case 'getUpdates':
        poll++;
        if (poll === 1) return telegram([update]);
        if (poll === 2) return telegram([update]); // Telegram may redeliver; offset/dedup must prevent another photo.
        controller.abort();
        return telegram([]);
      case 'sendMessage': return telegram({ message_id: ++messageId });
      case 'sendPhoto': return telegram({ message_id: ++messageId });
      default: assert.fail(`Unexpected Telegram API method: ${method}`);
    }
  };
  await runLocal({ root, checkOnly: false }, { fetch, signal: controller.signal, onStatus: (status) => statuses.push(status) });
  return { root, fixture, calls, faceitCalls, statuses };
}

async function verifyDelivery(result) {
  const { calls, faceitCalls, statuses, root } = result;
  assert.equal(faceitCalls.length, 4, 'One profile/history/details/stats sequence must complete the one-command report');
  const polls = calls.filter(({ method }) => method === 'getUpdates');
  assert.deepEqual(polls.map(({ params }) => params.offset), [0, UPDATE_ID + 1, UPDATE_ID + 1]);
  assert.equal(calls.filter(({ method }) => method === 'answerCallbackQuery').length, 0);
  const photos = calls.filter(({ method }) => method === 'sendPhoto');
  assert.equal(photos.length, 1, 'A redelivered update must not post the match card twice');
  const form = photos[0].params;
  assert.ok(form instanceof FormData, 'The real adapter must send rendered bytes through multipart');
  assert.equal(form.get('chat_id'), String(CHAT));
  assert.equal(form.has('caption'), false, 'FACEIT images must not include captions');
  const photo = form.get('photo');
  assert.equal(photo.name, 'faceit-last-match.png');
  assert.equal(photo.type, 'image/png');
  const bytes = new Uint8Array(await photo.arrayBuffer());
  assert.ok(bytes.length > 1000 && bytes.length < 500000, 'The real card must be losslessly compressed for upload, not replaced by a placeholder');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(16), 1200);
  assert.equal(view.getUint32(20), 1360);
  assert.equal(calls.filter(({ method }) => method === 'sendMessage').length, 0, 'FACEIT output must be image-only');
  const keyboard = JSON.parse(form.get('reply_markup'));
  assert.ok(keyboard.inline_keyboard.flat().every(button => !button.callback_data?.startsWith('continue:')));
  assert.ok(keyboard.inline_keyboard.flat().some(button => button.url?.endsWith('/latest-local-match')));
  const database = await openDatabase(join(root, '.local-data/bot.sqlite'));
  let state;
  try {
    assert.equal(await database.getOffset(), UPDATE_ID + 1);
    const jobs = await database.db.all('SELECT * FROM report_jobs');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'ready');
    assert.equal(jobs[0].version, 1);
    state = JSON.parse(jobs[0].state);
    assert.equal(state.kind, 'last');
    assert.equal(state.phase, 'done');
    assert.equal(state.matches.length, 1);
    assert.equal(state.matches[0].matchId, 'latest-local-match');
    const deliveries = await database.db.all("SELECT * FROM deliveries WHERE kind IN ('photo','text')");
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries.map((row) => row.kind), ['photo']);
    assert.ok(deliveries.every((row) => row.status === 'sent'));
  } finally { database.close(); }
  assert.equal(statuses.at(-1).code, 'POLLING_STOPPED');
  assert.ok(!JSON.stringify(statuses).includes(TOKEN));
  assert.ok(!JSON.stringify(statuses).includes(FACEIT_KEY));
  return { state };
}

test('one local /last command delivers only a real match PNG with persisted roster data and delivery dedup', { timeout: 15000 }, async t => {
  const result = await runFixture(t);
  const { state } = await verifyDelivery(result);
  const match = state.matches[0];
  assert.equal(match.maps[0].name, 'de_mirage');
  assert.deepEqual([match.maps[0].ownScore, match.maps[0].opponentScore], [13, 10]);
  assert.deepEqual([match.player.kills, match.player.deaths, match.player.assists], [20, 10, 5]);
  assert.equal(match.player.kd, 2);
  assert.equal(match.player.adr, 80);
  for (const team of match.teams) {
    const own = team.id === match.ownTeamId;
    assert.equal(team.players.length, 5);
    for (let index = 0; index < team.players.length; index++) {
      assert.equal(team.players[index].adr, own ? 80 + index * 10 : 50 + index * 5,
        'Every roster ADR must survive FACEIT normalization and SQLite checkpointing without being recomputed by the renderer');
    }
  }
  assert.equal(match.result, 'W');
  assert.deepEqual([match.score.own, match.score.opponent], [13, 10]);
  assert.equal(match.teams.find(team => team.id === match.ownTeamId).name, 'Friends');
  assert.equal(match.teams.find(team => team.id !== match.ownTeamId).name, 'Opponents');
  const nicknames = match.teams.flatMap(team => team.players).map(player => player.nickname);
  for (const player of result.fixture.players) assert.ok(nicknames.includes(player.nickname), 'Persisted report must retain every roster nickname');
  assert.equal(match.statsAvailable, true);
  assert.equal(match.partial, false);
});

test('missing latest stats still delivers one overview image without inventing zero metrics or sending text', { timeout: 15000 }, async t => {
  const result = await runFixture(t, { missingStats: true });
  const { state } = await verifyDelivery(result);
  const match = state.matches[0];
  assert.equal(match.statsAvailable, false);
  assert.equal(match.partial, true);
  for (const key of ['kills', 'deaths', 'assists', 'kd', 'kr', 'hs', 'adr']) assert.equal(match.player[key], null);
  assert.equal(match.maps.length, 0);
  assert.ok(match.teams.flatMap(team => team.players).every(player => player.kills === null && player.deaths === null && player.adr === null));
});
