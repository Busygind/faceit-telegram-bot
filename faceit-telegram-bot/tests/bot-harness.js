import { createBot } from '../tgcloud/lib/bot.js';
import { createSealer } from '../tgcloud/lib/credentials.js';
import { makeStore } from './helpers.js';

export function fixtureReport(kind = 'stats', nickname = 'PlayerOne') {
  const match = { id: 'match-1', url: 'https://www.faceit.com/en/cs2/room/match-1',
    finishedAt: 1800000000, result: 'W', score: { own: 13, opponent: 7 },
    player: { kills: 20, deaths: 10, assists: 3, kd: 2, kr: 1, adr: 90, hs: 50 },
    maps: [{ name: 'de_mirage', ownScore: 13, opponentScore: 7 }], teams: [], statsAvailable: true };
  return { kind, nickname, count: 1, requested: kind === 'last' ? 1 : 30,
    wins: 1, losses: 0, winRate: 100, recent: ['W'], metrics: {}, maps: [],
    range: { from: 1800000000, to: 1800000000 }, updatedAt: 1800000100,
    matches: [match], ...(kind === 'last' ? { match } : {}) };
}

export async function makeHarness(t, options = {}) {
  const { store, db } = await makeStore();
  t.after(() => db.close());
  const calls = [];
  const starts = [];
  const advances = [];
  const renderedReports = [];
  let id = 100;
  const defaults = {
    getMe: () => ({ id: 999, username: 'FixtureBot' }),
    getChatMember: ({ user_id }) => ({ status: user_id === 1 ? 'administrator' : user_id === 3 ? 'left' : 'member' }),
    sendMessage: () => ({ message_id: ++id }),
    sendPhoto: () => ({ message_id: ++id }),
    sendPoll: () => ({ message_id: ++id, poll: { id: 'fixture-poll' } }),
    deleteMessage: () => true,
    answerCallbackQuery: () => true,
    setMyCommands: () => true,
  };
  const api = Object.fromEntries(Object.entries(defaults).map(([method, implementation]) => [method,
    async (params) => {
      calls.push({ method, params });
      return (options.apiOverrides?.[method] ?? implementation)(params);
    },
  ]));
  const faceit = {
    async start(nickname, kind) {
      starts.push({ nickname, kind });
      if (options.faceitOverrides?.start) return options.faceitOverrides.start(nickname, kind);
      return { version: 1, nickname, kind, phase: 'done' };
    },
    async advance(state, budget) {
      advances.push({ state: structuredClone(state), budget });
      if (options.faceitOverrides?.advance) return options.faceitOverrides.advance(state, budget);
      return { done: true, state, report: fixtureReport(state.kind, state.nickname) };
    },
  };
  const dependencies = {
    api, store, faceit, now: options.now ?? (() => 1800000000),
    sealer: createSealer({ keyHex: '12'.repeat(32), keyId: 'fixture-key' }),
    settings: { allowedChatIds: [-10, -20, -30], maxRequests: 8, ...options.settings },
    renderCard: report => {
      renderedReports.push(structuredClone(report));
      return options.renderCard ? options.renderCard(report) : Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    },
    inputFile: (bytes, name) => ({ bytes, name }),
  };
  let bot = createBot(dependencies);
  const message = (text, configuration, updateId) => ({
    message_id: updateId,
    chat: { id: configuration.chatId ?? -10, type: configuration.chatType ?? 'supergroup' },
    from: { id: configuration.userId ?? 1, is_bot: false },
    ...(configuration.topicId == null ? {} : { message_thread_id: configuration.topicId }),
    text, ...configuration.messageFields,
  });
  return {
    calls, starts, advances, renderedReports, store, db, dependencies,
    restart() { bot = createBot(dependencies); },
    sent(method = 'sendMessage') { return calls.filter((call) => call.method === method).map((call) => call.params); },
    async send(text, configuration = {}, updateId = ++id) {
      const value = message(text, configuration, updateId);
      await bot.handleMessage(value, { update: { update_id: updateId, message: value, ...configuration.updateFields } });
      return updateId;
    },
    async click(data, configuration = {}, updateId = ++id) {
      const query = { id: `callback-${updateId}`, from: { id: configuration.userId ?? 1, is_bot: false },
        data, message: message('', configuration, 50) };
      await bot.handleCallback(query, { update: { update_id: updateId, callback_query: query } });
      return updateId;
    },
  };
}
