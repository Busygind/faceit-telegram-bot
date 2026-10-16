const STOPPED = Symbol('polling-stopped');
const TRANSIENT_CODES = new Set(['TELEGRAM_TRANSPORT', 'TELEGRAM_NETWORK', 'TELEGRAM_TIMEOUT', 'NETWORK_ERROR', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND']);

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(STOPPED);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(STOPPED); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function defaultSleep(ms, signal) {
  if (signal?.aborted) throw STOPPED;
  await new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); cleanup(); reject(STOPPED); };
    const cleanup = () => signal?.removeEventListener('abort', aborted);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function apiStatus(error) {
  return Number.isInteger(error?.code) ? error.code : Number.isInteger(error?.status) ? error.status : null;
}

function fatal(error) {
  switch (apiStatus(error)) {
    case 401: return 'TELEGRAM_AUTH';
    case 403: return 'TELEGRAM_FORBIDDEN';
    case 409: return 'POLLING_CONFLICT';
    default: return null;
  }
}

function transient(error) {
  const status = apiStatus(error);
  return status === 429 || status >= 500 || status === 0 || TRANSIENT_CODES.has(error?.code) || error instanceof TypeError;
}

function delayFor(error, attempt) {
  const seconds = error?.parameters?.retry_after;
  const backoff = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(backoff, Math.min(3_600_000, Math.ceil(seconds * 1000))) : backoff;
}

/** One sequential long-polling consumer. Only offsets, never raw updates, are saved. */
export async function runPolling({ api, bot, database, signal, sleep = defaultSleep, onStatus = () => {} }) {
  const pause = ms => abortable(sleep(ms, signal), signal);
  const request = async (method, payload) => {
    let attempt = 0;
    while (!signal?.aborted) {
      try { return await abortable(api[method](payload, { signal }), signal); }
      catch (error) {
        if (signal?.aborted || error === STOPPED) throw STOPPED;
        const code = fatal(error);
        if (code) throw new Error(code);
        if (!transient(error)) throw new Error('TELEGRAM_POLLING_FAILED');
        const delayMs = delayFor(error, ++attempt);
        onStatus({ code: 'POLLING_RETRY', delayMs, attempt });
        await pause(delayMs);
      }
    }
    throw STOPPED;
  };

  try {
    if (signal?.aborted) return;
    const webhook = await request('getWebhookInfo');
    if (!webhook || typeof webhook.url !== 'string') throw new Error('TELEGRAM_POLLING_PROTOCOL');
    if (webhook.url !== '') throw new Error('WEBHOOK_ACTIVE');
    let offset = await database.getOffset();
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('LOCAL_DATABASE_INVALID_OFFSET');
    onStatus({ code: 'POLLING_READY' });
    while (!signal?.aborted) {
      const updates = await request('getUpdates', {
        offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query'],
      });
      if (!Array.isArray(updates) || updates.some(update => !Number.isSafeInteger(update?.update_id)
        || update.update_id < 0 || !Number.isSafeInteger(update.update_id + 1))) {
        throw new Error('INVALID_UPDATE');
      }
      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (signal?.aborted) throw STOPPED;
        if (update.update_id < offset) continue;
        for (let attempt = 1; ; attempt++) {
          try {
            if (update.message) await bot.handleMessage(update.message, { update });
            else if (update.callback_query) await bot.handleCallback(update.callback_query, { update });
            break;
          } catch (error) {
            if (signal?.aborted || error === STOPPED) throw STOPPED;
            if (attempt >= 3) throw new Error('POLLING_HANDLER_FAILED');
            const delayMs = 1000 * 2 ** (attempt - 1);
            onStatus({ code: 'HANDLER_RETRY', delayMs, attempt });
            await pause(delayMs);
          }
        }
        if (signal?.aborted) throw STOPPED;
        offset = update.update_id + 1;
        await database.setOffset(offset);
      }
    }
  } catch (error) {
    if (error !== STOPPED && !signal?.aborted) throw error;
  } finally { onStatus({ code: 'POLLING_STOPPED' }); }
}
