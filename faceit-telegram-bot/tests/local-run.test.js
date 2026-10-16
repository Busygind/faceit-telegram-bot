import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, loadCredentials, loadEncryptionKey, secureDirectory } from '../local/config.mjs';
import { parseOptions, runLocal, safeFailure } from '../local/run.mjs';
import { openDatabase } from '../local/database.mjs';

const TOKEN = `123456:${'local_fixture_'.repeat(3)}`;
const FACEIT = 'fixture-faceit-api-key-not-real';
const CHAT = -1004393474895;
const ok = (result) => new Response(JSON.stringify({ ok: true, result }));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'faceit-local-run-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, '.secrets');
  await mkdir(secrets, { mode: 0o700 });
  const tokenFile = join(secrets, 'telegram-bot.token');
  const faceitFile = join(secrets, 'faceit.key');
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  await writeFile(faceitFile, `${FACEIT}\n`, { mode: 0o600 });
  return { root, secrets, tokenFile, faceitFile };
}

function fakeTelegram({ override = {}, batches = [], stop } = {}) {
  const calls = [];
  const defaults = {
    getMe: () => ({ id: 999, is_bot: true, username: 'road_to_3_elo_bot' }),
    getWebhookInfo: () => ({ url: '' }),
    getChat: (params) => ({ id: params.chat_id, type: 'supergroup' }),
    getChatMember: () => ({ status: 'administrator', can_delete_messages: true }),
    setMyCommands: () => true,
    sendMessage: () => ({ message_id: 501 }),
    getUpdates: () => {
      if (batches.length) return batches.shift();
      stop?.();
      return [];
    },
  };
  const fetch = async (url, request) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.telegram.org');
    assert.equal(request.redirect, 'error');
    const method = parsed.pathname.split('/').at(-1);
    const params = JSON.parse(request.body);
    calls.push({ method, params });
    const implementation = override[method] ?? defaults[method];
    assert.equal(typeof implementation, 'function', `Unexpected API method: ${method}`);
    return ok(await implementation(params));
  };
  return { calls, fetch };
}

test('local credentials read only protected files, trim input and deduplicate negative chat IDs', async (t) => {
  const f = await fixture(t);
  const credentials = await loadCredentials({ root: f.root, chatIds: [CHAT, CHAT, -42] });
  assert.equal(credentials.token, TOKEN);
  assert.equal(credentials.faceitKey, FACEIT);
  assert.deepEqual(credentials.chatIds, [CHAT, -42]);
  const explicit = await loadCredentials({ root: f.root, telegramTokenFile: f.tokenFile, faceitKeyFile: f.faceitFile });
  assert.deepEqual(explicit.chatIds, []);
});

test('local credential files reject insecure modes, links and missing files without revealing contents', async (t) => {
  const f = await fixture(t);
  await chmod(f.tokenFile, 0o644);
  await assert.rejects(loadCredentials({ root: f.root }), /LOCAL_TOKEN_FILE/);
  await chmod(f.tokenFile, 0o600);
  await chmod(f.faceitFile, 0o644);
  await assert.rejects(loadCredentials({ root: f.root }), /LOCAL_FACEIT_FILE/);
  await chmod(f.faceitFile, 0o600);
  const tokenLink = join(f.root, 'token-link');
  const faceitLink = join(f.root, 'faceit-link');
  await symlink(f.tokenFile, tokenLink);
  await symlink(f.faceitFile, faceitLink);
  await assert.rejects(loadCredentials({ root: f.root, telegramTokenFile: tokenLink }), /LOCAL_TOKEN_FILE/);
  await assert.rejects(loadCredentials({ root: f.root, faceitKeyFile: faceitLink }), /LOCAL_FACEIT_FILE/);
  await rm(f.tokenFile);
  await assert.rejects(loadCredentials({ root: f.root }), (error) => {
    assert.equal(error.message, 'LOCAL_TOKEN_FILE');
    assert.ok(!String(error.stack).includes(TOKEN));
    return true;
  });
});

test('local credential formats and optional diagnostic chat IDs fail closed', async (t) => {
  const f = await fixture(t);
  for (const chatIds of [[1], [0], ['-42'], [-1.2], [Number.MIN_SAFE_INTEGER - 1], null]) {
    await assert.rejects(loadCredentials({ root: f.root, chatIds }), /LOCAL_CHAT_IDS/);
  }
  await writeFile(f.tokenFile, 'not-a-bot-token');
  await assert.rejects(loadCredentials({ root: f.root }), /LOCAL_TOKEN_FORMAT/);
  await writeFile(f.tokenFile, TOKEN);
  await writeFile(f.faceitFile, 'bad key with spaces long enough');
  await assert.rejects(loadCredentials({ root: f.root }), /LOCAL_FACEIT_FORMAT/);
});

test('private directories reject existing public directories and symbolic links', async (t) => {
  const f = await fixture(t);
  const fresh = join(f.root, 'fresh');
  await secureDirectory(fresh);
  assert.equal((await lstat(fresh)).mode & 0o777, 0o700);
  await secureDirectory(fresh);
  const publicDir = join(f.root, 'public');
  await mkdir(publicDir, { mode: 0o755 });
  await chmod(publicDir, 0o755);
  await assert.rejects(secureDirectory(publicDir), /LOCAL_DIRECTORY_UNSAFE/);
  const link = join(f.root, 'link');
  await symlink(fresh, link);
  await assert.rejects(secureDirectory(link), /LOCAL_DIRECTORY_UNSAFE/);
});

test('local encryption key is private, persists across restarts and never silently regenerates after database creation', async (t) => {
  const f = await fixture(t);
  const first = await loadEncryptionKey(f.root);
  const keyFile = join(f.secrets, 'local-encryption.json');
  assert.equal(first.version, 1);
  assert.match(first.keyHex, /^[a-f0-9]{64}$/);
  assert.match(first.keyId, /^[a-f0-9]{16}$/);
  assert.equal((await lstat(keyFile)).mode & 0o777, 0o600);
  assert.deepEqual(await loadEncryptionKey(f.root), first);
  await mkdir(join(f.root, '.local-data'), { mode: 0o700 });
  await writeFile(join(f.root, '.local-data/bot.sqlite'), 'fixture-database', { mode: 0o600 });
  await rm(keyFile);
  await assert.rejects(loadEncryptionKey(f.root), /LOCAL_KEY_MISSING/);
  await assert.rejects(lstat(keyFile), { code: 'ENOENT' });
});

test('an invalid, insecure or symlinked encryption key must be restored rather than replaced', async (t) => {
  const f = await fixture(t);
  const key = await loadEncryptionKey(f.root);
  const keyFile = join(f.secrets, 'local-encryption.json');
  await chmod(keyFile, 0o644);
  await assert.rejects(loadEncryptionKey(f.root), /LOCAL_KEY_INVALID/);
  await chmod(keyFile, 0o600);
  await writeFile(keyFile, '{broken-json');
  await assert.rejects(loadEncryptionKey(f.root), /LOCAL_KEY_INVALID/);
  assert.equal(await readFile(keyFile, 'utf8'), '{broken-json');
  const original = join(f.secrets, 'saved-key.json');
  await writeFile(original, JSON.stringify(key), { mode: 0o600 });
  await rm(keyFile);
  await symlink(original, keyFile);
  await assert.rejects(loadEncryptionKey(f.root), /LOCAL_KEY_INVALID/);
  assert.equal((await lstat(keyFile)).isSymbolicLink(), true);
});

test('polling lock blocks another live owner and release is idempotent', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'polling.lock');
  const release = await acquireLock(path, { pid: 123, isAlive: () => true });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const lock = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(lock.pid, 123);
  assert.match(lock.nonce, /^[a-f0-9]{32}$/);
  await assert.rejects(acquireLock(path, { pid: 456, isAlive: () => true }), /LOCAL_ALREADY_RUNNING/);
  await release();
  await release();
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('stale polling lock fails closed for manual review and is not automatically deleted', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'polling.lock');
  const content = `${JSON.stringify({ pid: 987654, nonce: 'fixture-stale' })}\n`;
  await writeFile(path, content, { mode: 0o600 });
  await assert.rejects(acquireLock(path, { pid: 123, isAlive: () => false }), /LOCAL_STALE_LOCK/);
  assert.equal(await readFile(path, 'utf8'), content);
});

test('lock release cannot unlink a replaced lock owned by another process', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'polling.lock');
  const release = await acquireLock(path, { pid: 123 });
  await rm(path);
  const replacement = `${JSON.stringify({ pid: 456, nonce: 'another-owner' })}\n`;
  await writeFile(path, replacement, { mode: 0o600 });
  await release();
  assert.equal(await readFile(path, 'utf8'), replacement);
});

test('locks reject unsafe permissions, malformed contents and symlinks', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'polling.lock');
  await writeFile(path, '{}', { mode: 0o600 });
  await chmod(path, 0o644);
  await assert.rejects(acquireLock(path), /LOCAL_LOCK_UNSAFE/);
  await chmod(path, 0o600);
  await assert.rejects(acquireLock(path), /LOCAL_LOCK_UNSAFE/);
  await writeFile(path, 'not-json');
  await assert.rejects(acquireLock(path), /LOCAL_LOCK_UNSAFE/);
  await rm(path);
  await symlink(f.tokenFile, path);
  await assert.rejects(acquireLock(path), /LOCAL_LOCK_UNSAFE/);
});

test('local parser accepts explicit paths and rejects missing values, unknown flags and mistaken options', () => {
  const parsed = parseOptions(['--check', '--chat-id', `${CHAT}`, '--telegram-token-file', '/tmp/token', '--faceit-key-file', '/tmp/faceit'], '/tmp/root');
  assert.equal(parsed.root, '/tmp/root');
  assert.equal(parsed.checkOnly, true);
  assert.deepEqual(parsed.chatIds, [CHAT]);
  assert.equal(parsed.telegramTokenFile, '/tmp/token');
  assert.equal(parsed.faceitKeyFile, '/tmp/faceit');
  assert.deepEqual(parseOptions([], '/tmp/root').chatIds, []);
  for (const args of [
    ['--unknown'], ['--chat-id'], ['--telegram-token-file'], ['--faceit-key-file'],
    ['--chat-id', `${CHAT}`], ['--chat-id', '--check'], ['--telegram-token-file', '--check'], ['--faceit-key-file', '--check'],
  ]) assert.throws(() => parseOptions(args), /LOCAL_ARGUMENTS/);
});

test('default local --check discovers no chats and reports unknown deletion permission', async (t) => {
  const f = await fixture(t);
  const h = fakeTelegram();
  const statuses = [];
  const before = await readdir(f.secrets);
  const summary = await runLocal({ root: f.root, checkOnly: true }, { fetch: h.fetch, onStatus: (status) => statuses.push(status) });
  assert.deepEqual(summary, { username: 'road_to_3_elo_bot', chatIds: [], canDeleteMessages: null });
  assert.deepEqual(h.calls.map(({ method }) => method), ['getMe', 'getWebhookInfo']);
  assert.deepEqual(await readdir(f.secrets), before);
  await assert.rejects(lstat(join(f.root, '.local-data')), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(statuses).includes(TOKEN));
  assert.ok(!JSON.stringify(statuses).includes(FACEIT));
});

test('preflight mismatched bot, active webhook, wrong chat and missing admin fail before local state or polling', async (t) => {
  const f = await fixture(t);
  for (const [override, code] of [
    [{ getMe: () => ({ id: 999, is_bot: true, username: 'another_bot' }) }, 'LOCAL_BOT_MISMATCH'],
    [{ getMe: () => ({ id: 999, is_bot: false, username: 'road_to_3_elo_bot' }) }, 'LOCAL_BOT_MISMATCH'],
    [{ getWebhookInfo: () => ({ url: `https://private.test/${TOKEN}` }) }, 'WEBHOOK_ACTIVE'],
    [{ getWebhookInfo: () => ({}) }, 'LOCAL_WEBHOOK_CHECK'],
    [{ getChat: () => ({ id: -42, type: 'supergroup' }) }, 'LOCAL_GROUP_UNAVAILABLE'],
    [{ getChat: () => ({ id: CHAT, type: 'private' }) }, 'LOCAL_GROUP_UNAVAILABLE'],
    [{ getChatMember: () => ({ status: 'member' }) }, 'LOCAL_BOT_NOT_ADMIN'],
  ]) {
    const h = fakeTelegram({ override });
    await assert.rejects(runLocal({ root: f.root, chatIds: [CHAT], checkOnly: true }, { fetch: h.fetch }), (error) => {
      assert.equal(error.message, code);
      assert.ok(!String(error.stack).includes(TOKEN));
      return true;
    });
    assert.ok(!h.calls.some(({ method }) => ['getUpdates', 'deleteWebhook', 'setMyCommands'].includes(method)));
    await assert.rejects(lstat(join(f.root, '.local-data')), { code: 'ENOENT' });
  }
});

test('preflight permits operation without deletion permission but reports its absence', async (t) => {
  const f = await fixture(t);
  const h = fakeTelegram({ override: { getChatMember: () => ({ status: 'administrator', can_delete_messages: false }) } });
  const summary = await runLocal({ root: f.root, chatIds: [CHAT], checkOnly: true }, { fetch: h.fetch });
  assert.equal(summary.canDeleteMessages, false);
});

test('safe startup errors and malformed CLI input never print raw exceptions or token material', () => {
  assert.equal(safeFailure(Object.assign(new Error(TOKEN), { code: 401 })), 'TELEGRAM_AUTH');
  assert.equal(safeFailure(Object.assign(new Error(TOKEN), { code: 403 })), 'TELEGRAM_FORBIDDEN');
  assert.equal(safeFailure(Object.assign(new Error(TOKEN), { code: 409 })), 'POLLING_CONFLICT');
  assert.equal(safeFailure(new Error(TOKEN)), 'LOCAL_START_FAILED');
  assert.equal(safeFailure(new Error('LOCAL_ARGUMENTS')), 'LOCAL_ARGUMENTS');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../local/run.mjs', import.meta.url)), '--telegram-token-file'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOCAL_ARGUMENTS/);
  assert.ok(!result.stderr.includes(' at '));
  assert.ok(!result.stderr.includes(TOKEN));
});

test('local polling works in a previously unknown chat without enumeration and retains SQLite dedup', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const newChat = -1004418477887;
  const update = { update_id: 77, message: { message_id: 20, text: '/menu', chat: { id: newChat, type: 'supergroup' }, from: { id: 123, is_bot: false } } };
  const h = fakeTelegram({ batches: [[update]], stop: () => controller.abort() });
  const statuses = [];
  await runLocal({ root: f.root, checkOnly: false }, { fetch: h.fetch, signal: controller.signal, onStatus: (status) => statuses.push(status) });
  const polls = h.calls.filter(({ method }) => method === 'getUpdates');
  assert.equal(polls.length, 2);
  assert.equal(polls[0].params.offset, 0);
  assert.equal(polls[1].params.offset, 78);
  const sent = h.calls.filter(({ method }) => method === 'sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.chat_id, newChat);
  assert.equal(h.calls.filter(({ method }) => method === 'getChat').length, 0);
  assert.equal(h.calls.filter(({ method }) => method === 'getChatMember').length, 1); // Runtime caller membership only.
  assert.ok(sent[0].params.reply_markup.inline_keyboard.length > 0);
  assert.equal(h.calls.filter(({ method }) => method === 'setMyCommands').length, 1);
  await assert.rejects(lstat(join(f.root, '.local-data/polling.lock')), { code: 'ENOENT' });
  const database = await openDatabase(join(f.root, '.local-data/bot.sqlite'));
  try {
    assert.equal(await database.getOffset(), 78);
    assert.equal((await database.db.get('SELECT * FROM deliveries WHERE request_id=:id', { ':id': 'u:77' })).chat_id, newChat);
    assert.equal((await database.db.all('SELECT * FROM chat_settings')).length, 0);
  } finally { database.close(); }
  assert.equal(statuses.at(-1).code, 'POLLING_STOPPED');
  assert.ok(!JSON.stringify(statuses).includes(TOKEN));
  assert.ok(!JSON.stringify(statuses).includes(FACEIT));
});

test('explicit --check diagnostics retain strict per-chat identity, admin and deletion checks', async (t) => {
  const f = await fixture(t); const h = fakeTelegram();
  const summary = await runLocal({ root: f.root, chatIds: [CHAT, -42, CHAT], checkOnly: true }, { fetch: h.fetch });
  assert.deepEqual(summary, { username: 'road_to_3_elo_bot', chatIds: [CHAT, -42], canDeleteMessages: true });
  assert.deepEqual(h.calls.map(({ method }) => method), ['getMe', 'getWebhookInfo', 'getChat', 'getChatMember', 'getChat', 'getChatMember']);
  const noDiagnosticsWhileRunning = fakeTelegram();
  await assert.rejects(runLocal({ root: f.root, chatIds: [CHAT], checkOnly: false }, { fetch: noDiagnosticsWhileRunning.fetch }), /LOCAL_ARGUMENTS/);
  assert.deepEqual(noDiagnosticsWhileRunning.calls, []);
});
