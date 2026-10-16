import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaceitService } from '../tgcloud/lib/faceit.js';
import { createBot } from '../tgcloud/lib/bot.js';
import { renderReportCard } from '../tgcloud/lib/card.js';
import { makeStore } from './helpers.js';

const TIME = 1_800_000_000;
const CHAT = -100123456;
const TOPIC = 77;
const sample = {
  match_id: 'real-core-fixture', game_id: 'cs2', game: 'cs2', status: 'FINISHED', finished_at: TIME - 1000,
  best_of: 1, results: { winner: 'faction1', score: { faction1: 1, faction2: 0 } },
  teams: {
    faction1: { faction_id: 'team-a', name: 'Alpha', roster: [{ player_id: 'p1', nickname: 'ActualPlayer' }] },
    faction2: { faction_id: 'team-b', name: 'Bravo', roster: [{ player_id: 'p2', nickname: 'Opponent' }] },
  },
};
const stats = { rounds: [{ match_id: sample.match_id, match_round: 1, game_id: 'cs2',
  round_stats: { Map: 'de_mirage', Rounds: '23', Winner: 'team-a' }, teams: [
    { team_id: 'team-a', team_stats: { 'Final Score': '13' }, players: [{ player_id: 'p1', nickname: 'ActualPlayer',
      player_stats: { Kills: '20', Deaths: '10', Assists: '5', Headshots: '10', 'Total Damage': '1840' } }] },
    { team_id: 'team-b', team_stats: { 'Final Score': '10' }, players: [{ player_id: 'p2', nickname: 'Opponent',
      player_stats: { Kills: '10', Deaths: '20', Assists: '1' } }] },
  ] }] };
function response(value, status = 200, retry = null) {
  return { status, headers: { get: () => retry }, json: async () => structuredClone(value) };
}

async function harness({ pauseStats = false, photoFailure = false } = {}) {
  let clock = TIME;
  let paused = false;
  let updateId = 100;
  let messageId = 10;
  const calls = [];
  const requests = [];
  const renderedReports = [];
  const { store, db } = await makeStore(() => clock);
  const faceit = createFaceitService({ now: () => clock, key: 'fixture-server-key', fetch: async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname.endsWith('/players')) return response({ player_id: 'p1', nickname: 'ActualPlayer', games: { cs2: { faceit_elo: 1710, skill_level: 8 } } });
    if (parsed.pathname.endsWith('/history')) {
      return response({ items: sample.finished_at >= Number(parsed.searchParams.get('from'))
        && sample.finished_at <= Number(parsed.searchParams.get('to')) ? [sample] : [] });
    }
    if (parsed.pathname.endsWith('/stats')) {
      if (pauseStats && !paused) { paused = true; return response({}, 429, '10'); }
      return response(stats);
    }
    return response(sample);
  } });
  const api = {
    getChatMember: async () => ({ status: 'member' }), getMe: async () => ({ id: 1, username: 'TestFaceitBot' }),
    answerCallbackQuery: async () => {},
    sendMessage: async (payload) => {
      calls.push({ method: 'sendMessage', payload });
      return { message_id: messageId++ };
    },
    sendPhoto: async (payload) => {
      calls.push({ method: 'sendPhoto', payload });
      assert.deepEqual(Array.from(payload.photo.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
      if (photoFailure) throw { code: 400 };
      return { message_id: messageId++ };
    },
  };
  const bot = createBot({ api, store, faceit, settings: { allowedChatIds: [CHAT, -200], maxRequests: 2 },
    sealer: {}, renderCard: report => { renderedReports.push(structuredClone(report)); return renderReportCard(report); },
    inputFile: (bytes) => bytes, now: () => clock });
  const user = { id: 99, is_bot: false };
  const group = { id: CHAT, type: 'supergroup' };
  const message = (text) => ({ text, from: user, chat: group, message_thread_id: TOPIC, message_id: messageId++ });
  const send = async (text) => {
    const update = { update_id: updateId++ };
    await bot.handleMessage(message(text), { update });
    return update;
  };
  const continueJob = async (chatId = CHAT) => {
    const [job] = await db.all('SELECT * FROM report_jobs');
    await bot.handleCallback({ id: `callback-${updateId}`, from: user, data: `continue:${job.job_id}`,
      message: { chat: { ...group, id: chatId }, message_thread_id: TOPIC, message_id: 20 } },
    { update: { update_id: updateId++ } });
    return store.getJob(job.job_id);
  };
  return { db, store, bot, calls, requests, renderedReports, send, continueJob, message, setTime: (value) => { clock = value; } };
}

test('real FACEIT core + SQLite + bot: last resumes after 429 and retains original chat/topic', async (t) => {
  const h = await harness({ pauseStats: true });
  t.after(() => h.db.close());
  await h.send('/last@TESTFACEITBOT ActualPlayer');
  let job = await h.continueJob();
  assert.equal(job.state.phase, 'stats');
  assert.equal(job.state.retryAt, TIME + 10);
  assert.equal(job.status, 'pending');
  const requestCount = h.requests.length;
  job = await h.continueJob();
  assert.equal(h.requests.length, requestCount);
  assert.equal(job.state.phase, 'stats');
  await h.continueJob(-200);
  assert.equal(h.requests.length, requestCount, 'cross-chat callback must not access the job');
  h.setTime(TIME + 11);
  job = await h.continueJob();
  assert.equal(job.status, 'ready');
  assert.equal(job.state.matches[0].matchId, sample.match_id);
  const report = h.renderedReports.find(report => report.kind === 'last');
  assert.ok(report);
  assert.equal(report.nickname, 'ActualPlayer');
  assert.deepEqual([report.match.player.kills, report.match.player.deaths, report.match.player.assists], [20, 10, 5]);
  assert.equal(report.match.player.adr, 80);
  assert.equal(report.match.teams[0].players[0].adr, 80);
  assert.equal(report.match.teams[1].players[0].adr, null, 'Missing source ADR must remain unknown, not become zero');
  const overview = h.calls.at(-1);
  assert.equal(overview.method, 'sendPhoto');
  const dimensions = new DataView(overview.payload.photo.buffer, overview.payload.photo.byteOffset, overview.payload.photo.byteLength);
  assert.equal(dimensions.getUint32(16), 1200);
  assert.equal(dimensions.getUint32(20), 1360);
  assert.equal(overview.payload.chat_id, CHAT);
  assert.equal(overview.payload.message_thread_id, TOPIC);
  assert.equal(h.renderedReports.filter(report => report.kind === 'last').length, 1);
  assert.equal(h.calls.filter(({ method }) => method === 'sendMessage').length, 0);
  assert.ok(h.calls.filter(({ method }) => method === 'sendPhoto').every(({ payload }) => !Object.hasOwn(payload, 'caption')));
  const countAfterDelivery = h.calls.length;
  await h.continueJob();
  assert.equal(h.calls.length, countAfterDelivery, 'ready report delivery is idempotent');
});

test('real stats report generates FACEIT Dark PNG with a rejection tombstone and no text fallback', async (t) => {
  const h = await harness({ photoFailure: true });
  t.after(() => h.db.close());
  await h.send('/stats ActualPlayer');
  let job;
  for (let i = 0; i < 30; i++) {
    job = await h.continueJob();
    if (job.status === 'ready') break;
  }
  assert.equal(job.status, 'ready');
  const report = h.renderedReports.find(report => report.kind === 'stats');
  assert.ok(report);
  assert.equal(report.count, 1);
  assert.equal(report.metrics.kd.value, 2);
  const photos = h.calls.filter(({ method }) => method === 'sendPhoto');
  assert.ok(photos.length > 0);
  assert.equal(h.renderedReports.filter(report => report.kind === 'stats').length, 1);
  assert.equal(photos.at(-1).payload.chat_id, CHAT);
  assert.equal(photos.at(-1).payload.message_thread_id, TOPIC);
  assert.equal(h.calls.filter(({ method }) => method === 'sendMessage').length, 0);
  const { status } = await h.db.get("SELECT status FROM deliveries WHERE kind='photo'");
  assert.equal(status, 'rejected');
  const photoCount = photos.length;
  await h.continueJob();
  assert.equal(h.calls.filter(({ method }) => method === 'sendPhoto').length, photoCount);
  assert.equal(h.calls.filter(({ method }) => method === 'sendMessage').length, 0);
});

test('real core does not call FACEIT without explicit nickname and never stores API key in jobs', async (t) => {
  const h = await harness();
  t.after(() => h.db.close());
  await h.send('/last');
  await h.send('/stats');
  assert.equal(h.requests.length, 0);
  assert.equal((await h.db.all('SELECT * FROM report_jobs')).length, 0);
  await h.send('/last ActualPlayer');
  const rows = await h.db.all('SELECT * FROM report_jobs');
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes('fixture-server-key'), false);
});
