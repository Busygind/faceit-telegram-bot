import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CLOUD_DRAIN_MS, CLOUD_WEBHOOK, controlBot } from '../local/control.mjs';
import { createLocalProcesses } from '../local/process.mjs';
import { createDrainState } from '../local/drain.mjs';
import { checkCloudReadiness, safeControlError } from '../scripts/bot.mjs';
import { createTelegramApi } from '../local/telegram.mjs';

const SECRET = 'ab'.repeat(32);
const IDENTITY = { pid: 1234, nonce: 'ab'.repeat(16), started: 'fixture-start', command: 'fixture-node local/run.mjs', cwd: '/fixture' };
function fixture({ webhook = '', running = false, ready = true, secret = SECRET, username = 'road_to_3_elo_bot' } = {}) {
  const events = [];
  let active = running;
  let remote = webhook;
  let drain = 0;
  const api = {
    getMe: async () => { events.push('getMe'); return { is_bot: true, username }; },
    getWebhookInfo: async () => { events.push('getWebhookInfo'); return { url: remote }; },
    getUpdates: async payload => { events.push(['ack', payload]); return []; },
    setWebhook: async payload => { events.push(['setWebhook', payload]); remote = payload.url; return true; },
    deleteWebhook: async payload => { events.push(['deleteWebhook', payload]); remote = ''; return true; },
  };
  const local = {
    inspect: async () => { events.push('inspect'); return active ? { state: 'running', identity: IDENTITY } : { state: 'stopped' }; },
    stop: async identity => { assert.deepEqual(identity, IDENTITY); events.push('stop'); active = false; },
    checkpoint: async () => { events.push('checkpoint'); return 456; },
    guard: async () => { events.push('guard'); return async () => { events.push('release'); }; },
    start: async () => { assert.equal(remote, ''); events.push('start'); active = true; },
  };
  return { api, local, events, now: () => 1000,
    readDrain: async () => drain, writeDrain: async value => { events.push(['writeDrain', value]); drain = value; },
    clearDrain: async () => { events.push('clearDrain'); drain = 0; },
    checkCloud: async value => { events.push(['ready', value]); return ready; },
    readSecret: async () => { events.push('readSecret'); return secret; },
    sleep: async value => { events.push(['sleep', value]); },
    onStatus: value => events.push(['status', value]),
  };
}
const mutations = h => h.events.filter(value => value === 'stop' || value === 'start' || Array.isArray(value) && ['setWebhook', 'deleteWebhook'].includes(value[0]));

test('status reads metadata only and never includes a webhook URL or credential', async () => {
  for (const [webhook, running, mode] of [['', true, 'local'], [CLOUD_WEBHOOK, false, 'cloud'], ['', false, 'offline'], [CLOUD_WEBHOOK, true, 'conflict'], ['https://foreign.invalid/private', false, 'foreign-webhook']]) {
    const h = fixture({ webhook, running });
    const result = await controlBot('status', h);
    assert.equal(result.mode, mode);
    assert.deepEqual(mutations(h), []);
    assert.ok(!JSON.stringify(result).includes('https:'));
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test('cloud confirms configuration and secret before stopping, leases polling lock, then preserves queued updates', async () => {
  const h = fixture({ running: true });
  assert.deepEqual(await controlBot('cloud', h), { mode: 'cloud', localPid: null, cloudReady: true });
  const readiness = h.events.findIndex(value => Array.isArray(value) && value[0] === 'ready');
  assert.ok(readiness < h.events.indexOf('stop'));
  assert.equal(h.events[readiness][1], SECRET);
  const set = h.events.findIndex(value => Array.isArray(value) && value[0] === 'setWebhook');
  assert.ok(h.events.indexOf('guard') < set && set < h.events.indexOf('release'));
  assert.deepEqual(h.events[set][1], { url: CLOUD_WEBHOOK, secret_token: SECRET, max_connections: 1,
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  assert.ok(!h.events.includes('start'));
});

test('cloud readiness, secret, foreign webhook and identity errors leave running poller untouched', async () => {
  for (const [options, code] of [[{ ready: false }, 'SWITCH_CLOUD_NOT_READY'], [{ secret: '' }, 'SWITCH_SECRET_INVALID'],
    [{ webhook: 'https://foreign.invalid' }, 'SWITCH_FOREIGN_WEBHOOK'], [{ username: 'wrong_bot' }, 'SWITCH_BOT_MISMATCH']]) {
    const h = fixture({ running: true, ...options });
    await assert.rejects(controlBot('cloud', h), new RegExp(code));
    assert.deepEqual(mutations(h), []);
  }
});

test('cloud failure restores local only after an authoritative empty webhook response', async () => {
  const h = fixture({ running: true });
  h.api.setWebhook = async () => { h.events.push(['setWebhook']); throw new Error('private token must not propagate'); };
  await assert.rejects(controlBot('cloud', h), /SWITCH_CLOUD_FAILED_LOCAL_RESTORED/);
  assert.ok(h.events.indexOf('release') < h.events.indexOf('start'));
});

test('uncertain webhook state fails closed and never resumes local polling', async () => {
  const h = fixture({ running: true });
  h.api.setWebhook = async () => { h.api.getWebhookInfo = async () => { throw new Error(SECRET); }; throw new Error(SECRET); };
  await assert.rejects(controlBot('cloud', h), /SWITCH_CLOUD_UNCERTAIN/);
  assert.ok(!h.events.includes('start'));
  assert.ok(h.events.includes('release'));
});

test('local removes only our webhook, retains queue, drains accepted handler and verifies again before spawn', async () => {
  const h = fixture({ webhook: CLOUD_WEBHOOK });
  assert.deepEqual(await controlBot('local', h), { mode: 'local', localPid: IDENTITY.pid });
  const deleted = h.events.findIndex(value => Array.isArray(value) && value[0] === 'deleteWebhook');
  const drained = h.events.findIndex(value => Array.isArray(value) && value[0] === 'sleep');
  assert.deepEqual(h.events[deleted][1], { drop_pending_updates: false });
  assert.deepEqual(h.events[drained], ['sleep', CLOUD_DRAIN_MS]);
  assert.ok(h.events.indexOf('guard') < deleted && deleted < drained && drained < h.events.indexOf('release')
    && h.events.indexOf('release') < h.events.indexOf('start'));
});

test('local is idempotent, refuses conflict or foreign webhook and does not start after uncertain deletion', async () => {
  const active = fixture({ running: true });
  assert.equal((await controlBot('local', active)).mode, 'local');
  assert.deepEqual(mutations(active), []);
  for (const [webhook, code] of [[CLOUD_WEBHOOK, 'SWITCH_ACTIVE_CONFLICT'], ['https://foreign.invalid', 'SWITCH_FOREIGN_WEBHOOK']]) {
    const h = fixture({ webhook, running: true });
    await assert.rejects(controlBot('local', h), new RegExp(code));
    assert.deepEqual(mutations(h), []);
  }
  const uncertain = fixture({ webhook: CLOUD_WEBHOOK });
  uncertain.api.deleteWebhook = async () => { throw new Error(SECRET); };
  await assert.rejects(controlBot('local', uncertain));
  assert.ok(!uncertain.events.includes('start'));
  assert.ok(uncertain.events.includes('release'));
});

test('management Telegram adapter explicitly opts in and redacts token-bearing transport errors', async () => {
  const token = `123:${'fixture_'.repeat(5)}`;
  const base = createTelegramApi({ token, fetch: async () => { throw new Error(token); } });
  assert.equal(base.setWebhook, undefined);
  assert.equal(base.deleteWebhook, undefined);
  const admin = createTelegramApi({ token, webhookManagement: true, fetch: async () => { throw new Error(`https://api.telegram.org/bot${token}`); } });
  await assert.rejects(admin.setWebhook({ url: CLOUD_WEBHOOK }), error => !String(error.stack).includes(token));
  assert.equal(safeControlError(new Error(token)), 'SWITCH_FAILED');
  assert.equal(safeControlError(new Error('SWITCH_CLOUD_UNCERTAIN')), 'SWITCH_CLOUD_UNCERTAIN');
});

async function processFixture(t, inspectProcess) {
  const root = await mkdtemp(join(tmpdir(), 'faceit-control-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.local-data'), { mode: 0o700 });
  const path = join(root, '.local-data/polling.lock');
  const content = JSON.stringify({ pid: IDENTITY.pid, nonce: IDENTITY.nonce });
  await writeFile(path, content, { mode: 0o600 });
  const signals = [];
  return { root, path, content, signals, local: createLocalProcesses({ root, inspectProcess,
    kill: (pid, signal) => signals.push([pid, signal]), sleep: async () => {} }) };
}

test('a stale or unverified process lock is not removed and is never signalled', async t => {
  for (const inspectProcess of [async () => null, async () => { throw new Error('SWITCH_PROCESS_UNVERIFIED'); }]) {
    const f = await processFixture(t, inspectProcess);
    await assert.rejects(f.local.inspect(), /SWITCH_(?:STALE_LOCK|PROCESS_UNVERIFIED)/);
    assert.equal(await readFile(f.path, 'utf8'), f.content);
    assert.deepEqual(f.signals, []);
  }
});

test('process replacement between inspect and stop fails without sending a signal', async t => {
  let generation = 0;
  const f = await processFixture(t, async (pid, root) => ({ pid, cwd: root, command: 'fixture', started: `generation-${generation++}` }));
  const before = await f.local.inspect();
  await assert.rejects(f.local.stop(before.identity), /SWITCH_PROCESS_CHANGED/);
  assert.deepEqual(f.signals, []);
});

test('detached operator startup waits for IPC readiness and stops only the verified disposable child', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-managed-child-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'local'), { mode: 0o700 });
  await writeFile(join(root, 'local/run.mjs'), `
import { writeFileSync, unlinkSync } from 'node:fs';
const lock = new URL('../.local-data/polling.lock', import.meta.url);
writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'ab'.repeat(16) }), { mode: 0o600, flag: 'wx' });
process.once('SIGTERM', () => { unlinkSync(lock); process.exit(0); });
const hold = setInterval(() => {}, 1000);
process.send({ event: 'POLLING_READY' });
`, { mode: 0o600 });
  const local = createLocalProcesses({ root });
  let running;
  t.after(async () => {
    if (running) {
      try { await local.stop(running.identity); } catch {}
    }
  });
  await local.start();
  running = await local.inspect();
  assert.equal(running.state, 'running');
  assert.equal(running.identity.cwd, root);
  assert.ok(running.identity.started);
  await local.stop(running.identity);
  running = null;
  assert.deepEqual(await local.inspect(), { state: 'stopped' });
});


test('interrupted drain releases polling guard, persists deadline and the next local command resumes the wait', async () => {
  const h = fixture({ webhook: CLOUD_WEBHOOK });
  h.sleep = async () => { throw new Error('SWITCH_INTERRUPTED'); };
  await assert.rejects(controlBot('local', h), /SWITCH_INTERRUPTED/);
  assert.ok(h.events.includes('release'));
  assert.ok(!h.events.includes('start'));
  assert.equal(await h.readDrain(), 1000 + CLOUD_DRAIN_MS);
  h.now = () => 61_000;
  h.sleep = async value => h.events.push(['resumedSleep', value]);
  assert.equal((await controlBot('local', h)).mode, 'local');
  assert.deepEqual(h.events.find(value => Array.isArray(value) && value[0] === 'resumedSleep'), ['resumedSleep', 90_000]);
  assert.equal(await h.readDrain(), 0);
});

test('private drain marker persists across instances, is removed safely and leaves no temporary files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-drain-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.local-data'), { mode: 0o700 });
  const state = createDrainState(root);
  assert.equal(await state.readDrain(), 0);
  await state.writeDrain(123456);
  assert.equal(await createDrainState(root).readDrain(), 123456);
  await state.writeDrain(456789);
  assert.equal(await state.readDrain(), 456789);
  await state.clearDrain();
  assert.equal(await state.readDrain(), 0);
});


test('cloud acknowledges only persisted next_offset after stop, preserves new updates and skips ACK for an existing webhook', async () => {
  const h = fixture({ running: true });
  h.api.getUpdates = async payload => { h.events.push(['ack', payload]); return [{ update_id: 900, message: { text: 'new queued update' } }]; };
  await controlBot('cloud', h);
  const ack = h.events.findIndex(value => Array.isArray(value) && value[0] === 'ack');
  const set = h.events.findIndex(value => Array.isArray(value) && value[0] === 'setWebhook');
  assert.ok(h.events.indexOf('stop') < h.events.indexOf('guard') && h.events.indexOf('guard') < ack && ack < set);
  assert.deepEqual(h.events[ack][1], { offset: 456, timeout: 0, limit: 1, allowed_updates: ['message', 'callback_query'] });
  const alreadyCloud = fixture({ webhook: CLOUD_WEBHOOK });
  await controlBot('cloud', alreadyCloud);
  assert.ok(!alreadyCloud.events.some(value => Array.isArray(value) && value[0] === 'ack'));
});

test('checkpoint reads SQLite offset in read-only mode and never invents a missing checkpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-offset-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.local-data'), { mode: 0o700 });
  const local = createLocalProcesses({ root });
  await assert.rejects(local.checkpoint(), /SWITCH_OFFSET_UNAVAILABLE/);
  const path = join(root, '.local-data/bot.sqlite');
  await writeFile(path, '', { mode: 0o600 });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE polling_state(singleton INTEGER PRIMARY KEY, next_offset INTEGER); INSERT INTO polling_state VALUES(1,789);');
  db.close();
  const before = await readFile(path);
  assert.equal(await local.checkpoint(), 789);
  assert.deepEqual(await readFile(path), before);
});

test('root wrapper accepts commands without Node PATH setup and rejects invalid input before network', async () => {
  const { spawnSync } = await import('node:child_process');
  const wrapper = new URL('../bot', import.meta.url).pathname;
  const result = spawnSync(wrapper, ['invalid'], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SWITCH_ARGUMENTS/);
  assert.ok(!result.stderr.includes(' at '));
});


test('configured cloud with a failed Telegram dependency leaves the local poller untouched', async () => {
  const h = fixture({ running: true });
  const probes = [];
  h.checkCloud = secret => checkCloudReadiness({ secret, fetch: async (url, request) => {
    probes.push({ path: new URL(url).pathname, method: request.method });
    assert.equal(request.headers['X-Telegram-Bot-Api-Secret-Token'], SECRET);
    if (request.method === 'GET') return new Response(JSON.stringify({ configured: true, database: true }), { status: 200 });
    return new Response(JSON.stringify({ ready: false, database: true, telegram: false, expectedBot: false }), { status: 503 });
  } });
  await assert.rejects(controlBot('cloud', h), /SWITCH_CLOUD_NOT_READY/);
  assert.deepEqual(mutations(h), []);
  assert.deepEqual(probes, [{ path: '/api/health', method: 'POST' }]);
});

test('readiness requires all protected dependency flags and status does not claim readiness without the secret', async () => {
  for (const body of [
    { ready: true, database: true, telegram: true, expectedBot: true },
    { ready: true, database: false, telegram: true, expectedBot: true },
    { ready: true, database: true, telegram: false, expectedBot: true },
    { ready: true, database: true, telegram: true, expectedBot: false },
    { configured: true, database: true },
  ]) {
    const ready = await checkCloudReadiness({ secret: SECRET, fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
    assert.equal(ready, body.ready === true && body.database === true && body.telegram === true && body.expectedBot === true);
  }
  const missing = fixture({ webhook: CLOUD_WEBHOOK, secret: undefined });
  missing.readSecret = async () => { throw new Error('SWITCH_SECRET_INVALID'); };
  const result = await controlBot('status', missing);
  assert.equal(result.mode, 'cloud');
  assert.equal(result.cloudReady, false);
  assert.deepEqual(mutations(missing), []);
});
