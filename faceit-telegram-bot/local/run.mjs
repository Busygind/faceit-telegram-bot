import { createReportCache } from './report-cache.mjs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBot } from '../tgcloud/lib/bot.js';
import { createSealer } from '../tgcloud/lib/credentials.js';
import { createFaceitService } from '../tgcloud/lib/faceit.js';
import { renderReportCard } from '../tgcloud/lib/card.js';
import { Store } from '../tgcloud/lib/store.js';
import { createTelegramApi, createInputFile } from './telegram.mjs';
import { openDatabase } from './database.mjs';
import { runPolling } from './polling.mjs';
import { loadCredentials, loadEncryptionKey, secureDirectory, acquireLock } from './config.mjs';
import { compressPng } from './png.mjs';
import { createCachedFaceitFetch } from './faceit-cache.mjs';

export function parseOptions(args, root = resolve(import.meta.dirname, '..')) {
  const options = { root, chatIds: [], expectedUsername: 'road_to_3_elo_bot', checkOnly: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--check' && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error('LOCAL_ARGUMENTS');
    if (args[i] === '--check') options.checkOnly = true;
    else if (args[i] === '--chat-id') options.chatIds.push(Number(args[++i]));
    else if (args[i] === '--telegram-token-file') options.telegramTokenFile = args[++i];
    else if (args[i] === '--faceit-key-file') options.faceitKeyFile = args[++i];
    else throw new Error('LOCAL_ARGUMENTS');
  }
  if (!options.chatIds.length) options.chatIds = [-1004393474895];
  return options;
}

export async function runLocal(options, { fetch = globalThis.fetch, signal, onStatus = () => {} } = {}) {
  const { root, expectedUsername = 'road_to_3_elo_bot', checkOnly } = options;
  const credentials = await loadCredentials(options);
  const networkFetch = (url, request = {}) => {
    const target = new URL(url);
    if (!['https://open.faceit.com', 'https://api.telegram.org'].includes(target.origin) || target.username || target.password) {
      throw new Error('LOCAL_NETWORK_ORIGIN');
    }
    const signals = [AbortSignal.timeout(target.origin === 'https://open.faceit.com' ? 20000 : 120000)];
    if (signal) signals.push(signal);
    if (request.signal) signals.push(request.signal);
    return fetch(url, { ...request, signal: AbortSignal.any(signals), redirect: 'error' });
  };
  const api = createTelegramApi({ token: credentials.token, fetch: networkFetch });
  const me = await api.getMe();
  if (me?.is_bot !== true || me.username?.toLowerCase() !== expectedUsername.toLowerCase()) throw new Error('LOCAL_BOT_MISMATCH');
  const webhook = await api.getWebhookInfo();
  if (!webhook || typeof webhook.url !== 'string') throw new Error('LOCAL_WEBHOOK_CHECK');
  if (webhook.url) throw new Error('WEBHOOK_ACTIVE');
  let canDelete = true;
  for (const chatId of credentials.chatIds) {
    let chat, member;
    try {
      chat = await api.getChat({ chat_id: chatId });
      member = await api.getChatMember({ chat_id: chatId, user_id: me.id });
    } catch { throw new Error('LOCAL_GROUP_UNAVAILABLE'); }
    if (chat.id !== chatId || !['group', 'supergroup'].includes(chat.type)) throw new Error('LOCAL_GROUP_UNAVAILABLE');
    if (!['administrator', 'creator'].includes(member?.status)) throw new Error('LOCAL_BOT_NOT_ADMIN');
    canDelete &&= chat.type === 'group' || member.status === 'creator' || member.can_delete_messages === true;
  }
  const summary = { username: me.username, chatIds: credentials.chatIds, canDeleteMessages: canDelete };
  onStatus({ code: 'LOCAL_PREFLIGHT_OK', ...summary });
  if (checkOnly) return summary;
  const folder = join(root, '.local-data');
  await secureDirectory(folder);
  const release = await acquireLock(join(folder, 'polling.lock'));
  let database;
  try {
    const key = await loadEncryptionKey(root);
    database = await openDatabase(join(folder, 'bot.sqlite'));
    const settings = { allowedChatIds: credentials.chatIds, maxRequests: 4, autoAdvanceBatches: 32, autoAdvanceSeconds: 90 };
    const bot = createBot({
      api, store: new Store(database.db), settings,
      reportCache: createReportCache({ db: database.db, botToken: credentials.token, faceitKey: credentials.faceitKey }),
      sealer: createSealer({ keyHex: key.keyHex, keyId: key.keyId }),
      faceit: createFaceitService({ fetch: createCachedFaceitFetch({ fetch: networkFetch }), key: credentials.faceitKey }),
      renderCard: (report) => compressPng(renderReportCard(report)), inputFile: createInputFile,
    });
    await runPolling({ api, bot, database, signal, onStatus });
    return summary;
  } finally {
    try { database?.close(); } finally { await release(); }
  }
}

const SAFE_CODES = new Set([
  'LOCAL_ARGUMENTS', 'LOCAL_CHAT_IDS', 'LOCAL_TOKEN_FILE', 'LOCAL_FACEIT_FILE', 'LOCAL_TOKEN_FORMAT', 'LOCAL_FACEIT_FORMAT',
  'LOCAL_BOT_MISMATCH', 'LOCAL_WEBHOOK_CHECK', 'WEBHOOK_ACTIVE', 'LOCAL_GROUP_UNAVAILABLE', 'LOCAL_BOT_NOT_ADMIN',
  'LOCAL_DIRECTORY_UNSAFE', 'LOCAL_KEY_INVALID', 'LOCAL_KEY_MISSING', 'LOCAL_LOCK_UNSAFE', 'LOCAL_LOCK_RELEASE', 'LOCAL_ALREADY_RUNNING', 'LOCAL_STALE_LOCK',
  'LOCAL_DATABASE_OPEN_FAILED', 'TELEGRAM_AUTH', 'TELEGRAM_FORBIDDEN', 'POLLING_CONFLICT', 'POLLING_HANDLER_FAILED',
  'TELEGRAM_POLLING_FAILED', 'TELEGRAM_POLLING_PROTOCOL', 'INVALID_UPDATE',
]);
export function safeFailure(error) {
  if (error?.code === 401) return 'TELEGRAM_AUTH';
  if (error?.code === 403) return 'TELEGRAM_FORBIDDEN';
  if (error?.code === 409) return 'POLLING_CONFLICT';
  return SAFE_CODES.has(error?.message) ? error.message : 'LOCAL_START_FAILED';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  Promise.resolve().then(() => runLocal(parseOptions(process.argv.slice(2)), {
    signal: controller.signal,
    onStatus: (status) => {
      console.log(JSON.stringify({ event: status.code, ...Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'code')) }));
      if (status.code === 'POLLING_READY' && process.connected) process.send({ event: 'POLLING_READY' }, () => {});
    },
  })).catch((error) => {
    if (!controller.signal.aborted) { console.error(JSON.stringify({ event: 'LOCAL_STOPPED', code: safeFailure(error) })); process.exitCode = 1; }
  }).finally(() => {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  });
}
