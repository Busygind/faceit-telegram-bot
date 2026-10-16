export const CLOUD_WEBHOOK = 'https://road-to-3-elo-bot.aghori-db.chatgpt.site/api/telegram/webhook';
export const CLOUD_DRAIN_MS = 150_000;
const USERNAME = 'road_to_3_elo_bot';

function webhookMode(info) {
  if (!info || typeof info.url !== 'string') throw new Error('SWITCH_WEBHOOK_CHECK');
  if (info.url === '') return 'none';
  return info.url === CLOUD_WEBHOOK ? 'cloud' : 'foreign';
}

/** Dependencies isolate process control and all Telegram mutations from tests. */
export async function controlBot(command, {
  api, local, checkCloud, readSecret, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onStatus = () => {},
  readDrain = async () => 0, writeDrain = async () => {}, clearDrain = async () => {}, now = Date.now, signal,
}) {
  const checkAbort = () => { if (signal?.aborted) throw new Error('SWITCH_INTERRUPTED'); };
  checkAbort();
  if (!['status', 'cloud', 'local'].includes(command)) throw new Error('SWITCH_ARGUMENTS');
  const me = await api.getMe();
  if (me?.is_bot !== true || me.username?.toLowerCase() !== USERNAME) throw new Error('SWITCH_BOT_MISMATCH');
  const remote = webhookMode(await api.getWebhookInfo());
  const process = await local.inspect();
  if (command === 'status') {
    let ready = false;
    try {
      const secret = await readSecret();
      if (typeof secret === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(secret)) ready = await checkCloud(secret);
    } catch {}
    return { mode: remote === 'foreign' ? 'foreign-webhook' : process.state === 'running'
      ? remote === 'none' ? 'local' : 'conflict' : remote === 'cloud' ? 'cloud' : 'offline',
    localPid: process.identity?.pid ?? null, cloudReady: ready === true };
  }
  if (remote === 'foreign') throw new Error('SWITCH_FOREIGN_WEBHOOK');

  if (command === 'cloud') {
    const secret = await readSecret();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new Error('SWITCH_SECRET_INVALID');
    if (await checkCloud(secret) !== true) throw new Error('SWITCH_CLOUD_NOT_READY');
    checkAbort();
    if (process.state === 'running') {
      onStatus('STOPPING_LOCAL');
      await local.stop(process.identity);
    }
    const release = await local.guard();
    let failure;
    try {
      if (process.state === 'running' && remote === 'none') {
        const offset = await local.checkpoint();
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('SWITCH_OFFSET_UNAVAILABLE');
        // getUpdates acknowledges only IDs below the persisted next_offset.
        // Returned new updates are deliberately neither handled nor acknowledged.
        const pending = await api.getUpdates({ offset, timeout: 0, limit: 1, allowed_updates: ['message', 'callback_query'] });
        if (!Array.isArray(pending)) throw new Error('SWITCH_WEBHOOK_CHECK');
      }
      await api.setWebhook({ url: CLOUD_WEBHOOK, secret_token: secret,
        max_connections: 1, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      if (webhookMode(await api.getWebhookInfo()) !== 'cloud') throw new Error('SWITCH_WEBHOOK_CHECK');
    } catch {
      let observed = 'unknown';
      try { observed = webhookMode(await api.getWebhookInfo()); } catch {}
      failure = observed === 'none' ? 'SWITCH_CLOUD_FAILED' : 'SWITCH_CLOUD_UNCERTAIN';
    } finally { await release(); }
    if (failure) {
      // Only a confirmed empty webhook permits rollback to polling. Never guess
      // after a timeout, an unreadable response or a foreign/active webhook.
      if (failure === 'SWITCH_CLOUD_FAILED' && process.state === 'running') {
        try { await local.start(); } catch { throw new Error('SWITCH_CLOUD_FAILED_LOCAL_OFFLINE'); }
        throw new Error('SWITCH_CLOUD_FAILED_LOCAL_RESTORED');
      }
      throw new Error(failure);
    }
    await clearDrain();
    return { mode: 'cloud', localPid: null, cloudReady: true };
  }

  if (process.state === 'running') {
    if (remote !== 'none') throw new Error('SWITCH_ACTIVE_CONFLICT');
    return { mode: 'local', localPid: process.identity.pid };
  }
  const release = await local.guard();
  try {
    checkAbort();
    if (remote === 'cloud') {
      // Record first: an uncertain delete or Ctrl-C must not bypass the drain
      // on a subsequent invocation that observes an already-empty webhook.
      await writeDrain(now() + CLOUD_DRAIN_MS);
      await api.deleteWebhook({ drop_pending_updates: false });
      if (webhookMode(await api.getWebhookInfo()) !== 'none') throw new Error('SWITCH_WEBHOOK_CHECK');
    }
    const remainingMs = Math.max(0, await readDrain() - now());
    if (remainingMs > 0) {
      onStatus('DRAINING_CLOUD', { remainingMs });
      await sleep(remainingMs, signal);
    }
    checkAbort();
    if (webhookMode(await api.getWebhookInfo()) !== 'none') throw new Error('SWITCH_WEBHOOK_CHECK');
  } finally { await release(); }
  checkAbort();
  onStatus('STARTING_LOCAL');
  await local.start();
  const running = await local.inspect();
  if (running.state !== 'running') throw new Error('SWITCH_LOCAL_NOT_READY');
  await clearDrain();
  return { mode: 'local', localPid: running.identity.pid };
}
