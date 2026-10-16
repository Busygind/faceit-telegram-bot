import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocal } from '../local/run.mjs';
import { openDatabase } from '../local/database.mjs';

const CHAT = -1004393474895;
const UPDATE_ID = 701;
const TOKEN = `123456:${'stats_flow_fixture_'.repeat(3)}`;
const FACEIT_KEY = 'synthetic-faceit-key-for-local-stats-flow';
const PLAYER_ID = 'stats-flow-player';
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const telegram = (result) => json({ ok: true, result });

function fixtures() {
  const now = Math.floor(Date.now() / 1000);
  const teams = {
    faction1: { faction_id: 'team-a', name: 'Friends', roster: [{ player_id: PLAYER_ID, nickname: 'aghori-' }] },
    faction2: { faction_id: 'team-b', name: 'Opponents', roster: [{ player_id: 'opponent', nickname: 'Opponent' }] },
  };
  const items = Array.from({ length: 30 }, (_, index) => ({
    match_id: `stats-flow-${String(index).padStart(2, '0')}`,
    finished_at: now - 1000 - index * 86400, game_id: 'cs2', status: 'FINISHED', teams,
    results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } },
  }));
  const details = new Map(items.map((item) => [item.match_id, {
    ...item, game: 'cs2', best_of: 1, faceit_url: `https://www.faceit.com/{lang}/cs2/room/${item.match_id}`,
  }]));
  const stats = new Map(items.map((item) => [item.match_id, { rounds: [{
    match_id: item.match_id, match_round: 1, game_id: 'cs2',
    round_stats: { Map: 'de_mirage', Rounds: '23', Winner: 'team-a' },
    teams: [
      { team_id: 'team-a', team_stats: { 'Final Score': '13' }, players: [{
        player_id: PLAYER_ID, nickname: 'aghori-',
        player_stats: { Kills: '20', Deaths: '10', Assists: '5', Headshots: '10', 'Total Damage': '1840' },
      }] },
      { team_id: 'team-b', team_stats: { 'Final Score': '10' }, players: [{
        player_id: 'opponent', nickname: 'Opponent',
        player_stats: { Kills: '10', Deaths: '20', Assists: '2', Headshots: '3', ADR: '50' },
      }] },
    ],
  }] }]));
  return { items, details, stats };
}

test('one local /stats update automatically completes 30 matches, checkpoints SQLite and delivers only one real PNG', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-local-stats-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, '.secrets');
  await mkdir(secrets, { mode: 0o700 });
  await writeFile(join(secrets, 'telegram-bot.token'), `${TOKEN}\n`, { mode: 0o600 });
  await writeFile(join(secrets, 'faceit.key'), `${FACEIT_KEY}\n`, { mode: 0o600 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const fixture = fixtures();
  const calls = [];
  const faceitCalls = [];
  const statuses = [];
  let polls = 0;
  let messageId = 900;
  const update = {
    update_id: UPDATE_ID,
    message: { message_id: 20, text: '/stats aghori-', chat: { id: CHAT, type: 'supergroup' }, from: { id: 123, is_bot: false } },
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
        const from = Number(target.searchParams.get('from'));
        const to = Number(target.searchParams.get('to'));
        const offset = Number(target.searchParams.get('offset'));
        return json({ items: fixture.items.filter((item) => item.finished_at >= from && item.finished_at <= to).slice(offset, offset + 100) });
      }
      const match = /^\/data\/v4\/matches\/([^/]+)(\/stats)?$/.exec(target.pathname);
      assert.ok(match, 'Only documented FACEIT profile/history/details/stats endpoints are expected');
      const value = (match[2] ? fixture.stats : fixture.details).get(decodeURIComponent(match[1]));
      assert.ok(value, 'Requested match must belong to the synthetic history');
      return json(value);
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
        polls++;
        if (polls === 1) return telegram([update]);
        // The second poll proves the original command was handled and acknowledged;
        // no callback or repeated /stats update is supplied by this fixture.
        controller.abort();
        return telegram([]);
      case 'sendMessage': return telegram({ message_id: ++messageId });
      case 'sendPhoto': return telegram({ message_id: ++messageId });
      default: assert.fail(`Unexpected Telegram API method: ${method}`);
    }
  };

  await runLocal({ root, checkOnly: false }, { fetch, signal: controller.signal, onStatus: (status) => statuses.push(status) });

  assert.equal(faceitCalls.filter((url) => url.pathname === '/data/v4/players').length, 1);
  assert.equal(faceitCalls.filter((url) => url.pathname.endsWith('/history')).length, 1);
  assert.equal(faceitCalls.filter((url) => /\/matches\/[^/]+$/.test(url.pathname)).length, 30);
  assert.equal(faceitCalls.filter((url) => url.pathname.endsWith('/stats')).length, 30);
  const pollingCalls = calls.filter(({ method }) => method === 'getUpdates');
  assert.equal(pollingCalls.length, 2);
  assert.deepEqual(pollingCalls.map(({ params }) => params.offset), [0, UPDATE_ID + 1]);
  assert.ok(pollingCalls.every(({ params }) => params.allowed_updates.includes('message')));
  assert.equal(calls.filter(({ method }) => method === 'answerCallbackQuery').length, 0);

  const photos = calls.filter(({ method }) => method === 'sendPhoto');
  assert.equal(photos.length, 1, 'Exactly one final statistics card must be posted');
  const form = photos[0].params;
  assert.ok(form instanceof FormData, 'The real Telegram adapter must encode the card as multipart');
  assert.equal(form.get('chat_id'), String(CHAT));
  assert.equal(form.has('caption'), false, 'FACEIT images must not include captions');
  const photo = form.get('photo');
  assert.equal(photo.name, 'faceit-stats.png');
  assert.equal(photo.type, 'image/png');
  const bytes = new Uint8Array(await photo.arrayBuffer());
  assert.ok(bytes.length > 1000 && bytes.length < 500000, 'The real card must be losslessly compressed for upload, not replaced by a placeholder');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dimensions = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dimensions.getUint32(16), 864);
  assert.equal(dimensions.getUint32(20), 1360);

  assert.equal(calls.filter(({ method }) => method === 'sendMessage').length, 0, 'FACEIT must not send loading messages or text reports');
  const keyboard = JSON.parse(form.get('reply_markup'));
  assert.ok(keyboard.inline_keyboard.flat().every(button => !button.callback_data?.startsWith('continue:')),
    'The healthy local path must not ask the user to press Continue');

  const database = await openDatabase(join(root, '.local-data/bot.sqlite'));
  try {
    assert.equal(await database.getOffset(), UPDATE_ID + 1);
    const jobs = await database.db.all('SELECT * FROM report_jobs');
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    const state = JSON.parse(job.state);
    assert.equal(job.status, 'ready');
    const historyReads = faceitCalls.filter(url => url.pathname.endsWith('/history')).length;
    assert.equal(job.version, Math.ceil((faceitCalls.length - 1 - historyReads) / 4),
      'Fresh profile/history precede cache lookup; each remaining four-request batch persists a checkpoint');
    assert.ok(job.version > 1);
    assert.equal(state.phase, 'done');
    assert.equal(state.kind, 'stats');
    assert.equal(state.matches.length, 30);
    assert.deepEqual(state.matches.map((match) => match.matchId), fixture.items.map((item) => item.match_id));
    assert.ok(state.matches.every((match) => match.statsAvailable && !match.partial));
    assert.equal(state.matches.reduce((sum, match) => sum + match.player.kills, 0), 600);
    assert.equal(state.matches.reduce((sum, match) => sum + match.player.deaths, 0), 300);
    assert.ok(state.matches.every(match => match.player.kd === 2));
    const deliveries = await database.db.all("SELECT * FROM deliveries WHERE kind IN ('photo','text')");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, 'photo');
    assert.ok(deliveries.every((delivery) => delivery.status === 'sent'));
  } finally { database.close(); }
  assert.equal(statuses.at(-1).code, 'POLLING_STOPPED');
  assert.ok(!JSON.stringify(statuses).includes(TOKEN));
  assert.ok(!JSON.stringify(statuses).includes(FACEIT_KEY));
});
