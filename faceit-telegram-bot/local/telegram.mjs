const TELEGRAM_ORIGIN = 'https://api.telegram.org';
const METHODS = Object.freeze([
  'getMe', 'getChat', 'getChatMember', 'sendMessage', 'sendPoll', 'sendPhoto',
  'deleteMessage', 'answerCallbackQuery', 'setMyCommands', 'getWebhookInfo', 'getUpdates',
]);

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

// Never retain the original Error, URL, response description or response body.
// Bot API URLs contain the bot token, including in transport Error messages.
export class TelegramApiError extends Error {
  constructor({ code = 'TELEGRAM_TRANSPORT', status = 0, parameters, invalidFileId = false } = {}) {
    const numericCode = safeInteger(code, 100, 599);
    const safeCode = numericCode ? code
      : ['TELEGRAM_TRANSPORT', 'TELEGRAM_TIMEOUT', 'TELEGRAM_ABORTED', 'TELEGRAM_CONFIG', 'TELEGRAM_INPUT', 'TELEGRAM_RESPONSE'].includes(code)
        ? code : 'TELEGRAM_TRANSPORT';
    super(numericCode ? `Telegram request rejected (${safeCode}).` : 'Telegram request failed safely.');
    this.name = 'TelegramApiError';
    this.code = safeCode;
    this.status = safeInteger(status, 100, 599) ? status : 0;
    Object.defineProperty(this, 'invalidFileId', { value: code === 400 && invalidFileId === true, enumerable: true });
    this.parameters = {};
    if (safeInteger(parameters?.retry_after, 0, Number.MAX_SAFE_INTEGER)) this.parameters.retry_after = parameters.retry_after;
    if (safeInteger(parameters?.migrate_to_chat_id, Number.MIN_SAFE_INTEGER, -1)) {
      this.parameters.migrate_to_chat_id = parameters.migrate_to_chat_id;
    }
    Object.freeze(this.parameters);
  }
}

export function createInputFile(bytes, name, type = 'image/png') {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024
      || typeof name !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(name) || /[\\/]/.test(name)
      || typeof type !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)) {
    throw new TelegramApiError({ code: 'TELEGRAM_INPUT' });
  }
  return Object.freeze({ bytes: new Uint8Array(bytes), name, type });
}

function parameters(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TelegramApiError({ code: 'TELEGRAM_INPUT' });
  }
  return { ...value };
}

function knownInvalidFileId(description) {
  // Recognize only explicit identifier rejection. Never retain the description
  // (it may contain tokens/IDs); unrelated 400s and unknown outcomes cannot retry.
  return typeof description === 'string' && /^(?:bad request: )?(?:wrong (?:remote )?file identifier(?:\/http url)?(?: specified)?(?:[.:].*)?|file_reference_expired|file_id_invalid|wrong file_id(?: specified)?)$/i.test(description);
}

function bodyFor(method, params) {
  try {
    if (method !== 'sendPhoto') return { body: JSON.stringify(params), headers: { 'content-type': 'application/json' } };
    if (typeof params.photo === 'string') {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(params.photo)) throw new TelegramApiError({ code: 'TELEGRAM_INPUT' });
      return { body: JSON.stringify(params), headers: { 'content-type': 'application/json' } };
    }
    const photo = createInputFile(params.photo?.bytes, params.photo?.name, params.photo?.type);
    const body = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (key === 'photo' || value === undefined || value === null) continue;
      body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    body.set('photo', new Blob([photo.bytes], { type: photo.type }), photo.name);
    // Fetch sets the boundary; an explicit Content-Type would corrupt multipart.
    return { body };
  } catch {
    throw new TelegramApiError({ code: 'TELEGRAM_INPUT' });
  }
}

export function createTelegramApi({ token, fetch = globalThis.fetch, timeoutMs = 35000, webhookManagement = false } = {}) {
  if (typeof token !== 'string' || !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token)
      || typeof fetch !== 'function' || typeof webhookManagement !== 'boolean' || !safeInteger(timeoutMs, 100, 120000)) {
    throw new TelegramApiError({ code: 'TELEGRAM_CONFIG' });
  }

  async function request(method, input, options) {
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
      throw new TelegramApiError({ code: 'TELEGRAM_INPUT' });
    }
    const externalSignal = options?.signal;
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
      throw new TelegramApiError({ code: 'TELEGRAM_INPUT' });
    }
    if (externalSignal?.aborted) throw new TelegramApiError({ code: 'TELEGRAM_ABORTED' });
    const params = parameters(input);
    let duration = timeoutMs;
    if (method === 'getUpdates') {
      params.timeout ??= 25;
      if (!safeInteger(params.timeout, 0, 50)) throw new TelegramApiError({ code: 'TELEGRAM_INPUT' });
      duration = Math.max(duration, (params.timeout + 10) * 1000);
    }
    const content = bodyFor(method, params);
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), duration);
    const path = `/bot${token}/${method}`;
    try {
      const response = await fetch(`${TELEGRAM_ORIGIN}${path}`, {
        method: 'POST', ...content, signal, redirect: 'error',
        credentials: 'omit', cache: 'no-store',
      });
      // Native fetch enforces redirect:error. Also reject redirects/custom origins
      // from an injected implementation without exposing the target URL.
      if (response.redirected) throw new TelegramApiError({ code: 'TELEGRAM_RESPONSE' });
      if (response.url) {
        const url = new URL(response.url);
        if (url.origin !== TELEGRAM_ORIGIN || url.pathname !== path || url.search || url.hash || url.username || url.password) {
          throw new TelegramApiError({ code: 'TELEGRAM_RESPONSE' });
        }
      }
      const result = await response.json();
      if (result?.ok === false) {
        throw new TelegramApiError({ code: result.error_code, status: response.status, parameters: result.parameters,
          invalidFileId: method === 'sendPhoto' && typeof params.photo === 'string'
            && result.error_code === 400 && response.status === 400 && knownInvalidFileId(result.description) });
      }
      if (!response.ok || result?.ok !== true || !Object.hasOwn(result, 'result')) {
        throw new TelegramApiError({ code: 'TELEGRAM_RESPONSE', status: response.status });
      }
      return result.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError({ code: controller.signal.aborted ? 'TELEGRAM_TIMEOUT'
        : externalSignal?.aborted ? 'TELEGRAM_ABORTED' : 'TELEGRAM_TRANSPORT' });
    } finally {
      clearTimeout(timer);
    }
  }

  // Runtime bots cannot mutate webhooks. Only the explicit operator CLI opts in.
  const methods = webhookManagement ? [...METHODS, 'setWebhook', 'deleteWebhook'] : METHODS;
  return Object.freeze(Object.fromEntries(methods.map((method) => [method, (params, options) => request(method, params, options)])));
}
