import { createReportCache } from './report-cache.mjs';
import { fetchWithoutRedirects } from './network.mjs';
import { timingSafeEqual } from 'node:crypto';
import { createBot } from './core/bot.js';
import { Store } from './core/store.js';
import { createSealer } from './core/credentials.js';
import { createFaceitService } from './core/faceit.js';
import { renderReportCard } from './core/card.js';
import { createTelegramApi, createInputFile } from './telegram.mjs';
import { compressPng } from './png.mjs';
import { createCachedFaceitFetch } from './faceit-cache.mjs';
import { createD1Adapter, cloudFailureCode, logCloudDiagnostic } from './d1.mjs';

export const SECRET_NAMES = ['BOT_TOKEN', 'FACEIT_API_KEY', 'TS_ENCRYPTION_KEY', 'WEBHOOK_SECRET'];
export const CLOUD_HANDLER_MS = 90_000;
export const CLOUD_WORK_MS = 65_000;
const MAX_BODY = 65536;
const faceitCaches = new WeakMap();
function faceitCache(fetch) {
  let cached = faceitCaches.get(fetch);
  if (!cached) { cached = createCachedFaceitFetch({ fetch }); faceitCaches.set(fetch, cached); }
  return cached;
}
const encoder = new TextEncoder();
const response = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function readConfiguration(env) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.BOT_TOKEN ?? '')
      || typeof env.FACEIT_API_KEY !== 'string' || env.FACEIT_API_KEY.length < 16 || /\s/.test(env.FACEIT_API_KEY)
      || !/^[a-f0-9]{64}$/i.test(env.TS_ENCRYPTION_KEY ?? '')
      || !/^[A-Za-z0-9_-]{32,128}$/.test(env.WEBHOOK_SECRET ?? '')) throw new Error('CLOUD_CONFIGURATION');
  return {};
}

export function health(env) {
  let configured = false;
  try { readConfiguration(env); configured = true; } catch { /* No values or missing names disclosed. */ }
  return response(200, { service: 'road-to-3-elo-bot', runtime: 'sites', configured, database: Boolean(env.DB) });
}

export function authorized(env, request) {
  const actual = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  const expected = env.WEBHOOK_SECRET ?? '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(actual)) return false;
  if (typeof expected !== 'string' || expected.length < 32 || actual.length !== expected.length || actual.length > 128) return false;
  return timingSafeEqual(encoder.encode(actual), encoder.encode(expected));
}

async function readUpdate(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error('BODY_LIMIT');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('BODY_INVALID');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw new Error('BODY_LIMIT'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let update;
  try { update = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('BODY_INVALID'); }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !Number.isSafeInteger(update.update_id + 1)) throw new Error('BODY_INVALID');
  return update;
}

export function createCloudRuntime(env, {
  fetch = globalThis.fetch, now = () => Date.now(), onDiagnostic = logCloudDiagnostic,
  onMetrics = value => console.log(JSON.stringify({ event: 'BOT_REQUEST_METRICS', ...value })),
  onCacheEvent = value => console.log(JSON.stringify({ event: 'BOT_REPORT_CACHE', action: value.event, kind: value.kind,
    ...(Number.isFinite(value.ageSeconds) ? { ageSeconds: value.ageSeconds } : {}) })),
  setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimer = timer => clearTimeout(timer),
} = {}) {
  readConfiguration(env);
  const cachedFetch = faceitCache(fetch);
  return async (update, { startedAt = now() } = {}) => {
    // The absolute egress deadline belongs to this invocation, never a cached
    // runtime or another concurrently handled update. D1 waits cannot extend it.
    if (!Number.isFinite(startedAt)) throw new Error('CLOUD_HANDLER_DEADLINE');
    const deadline = startedAt + CLOUD_HANDLER_MS;
    const workDeadline = startedAt + CLOUD_WORK_MS;
    const epochNow = () => Math.floor(now() / 1000);
    const metrics = { faceitReads: 0, telegramRequests: 0, databaseCalls: 0, renderCount: 0, photoUploads: 0, photoFileReuses: 0 };
    const controller = new AbortController();
    const shouldContinue = () => !controller.signal.aborted && now() < workDeadline;
    const assertActive = () => {
      if (controller.signal.aborted || now() >= deadline) {
        controller.abort();
        throw new Error('CLOUD_HANDLER_DEADLINE');
      }
    };
    const timer = setTimer(() => controller.abort(), Math.max(0, deadline - now()));
    const networkFetch = async (url, request = {}) => {
      let service = 'runtime';
      try {
      assertActive();
      const target = new URL(url);
      if (!['https://api.telegram.org', 'https://open.faceit.com'].includes(target.origin) || target.username || target.password) throw new Error('CLOUD_ORIGIN');
      const faceit = target.origin === 'https://open.faceit.com';
      service = faceit ? 'faceit' : 'telegram';
      if (faceit) metrics.faceitReads++;
      else {
        metrics.telegramRequests++;
        if (target.pathname.endsWith('/sendPhoto')) {
          if (request.body instanceof FormData) metrics.photoUploads++;
          else metrics.photoFileReuses++;
        }
      }
      if (typeof AbortSignal.any !== 'function' || typeof AbortSignal.timeout !== 'function') throw new Error('CLOUD_ABORT_UNSUPPORTED');
      const signals = [controller.signal, AbortSignal.timeout(Math.max(1, Math.min(deadline - now(), faceit ? 15000 : 35000)))];
      if (request.signal) signals.push(request.signal);
      // This check is also reached after every awaited database/cache operation
      // before any new outbound request. Only successful match bodies are cached.
      assertActive();
      const response = await fetchWithoutRedirects(faceit ? cachedFetch : fetch, url, { ...request, signal: AbortSignal.any(signals) });
      assertActive();
      if ([400,401,403,404,409,413,429,500,502,503,504].includes(response.status)) onDiagnostic(`CLOUD_UPSTREAM_HTTP_${response.status}`, service);
      return response;
      } catch (error) {
        const code = cloudFailureCode(error, 'CLOUD_NETWORK_FAILED');
        onDiagnostic(code, service);
        throw new Error(code);
      }
    };
    try {
      assertActive();
      const api = createTelegramApi({ token: env.BOT_TOKEN, fetch: networkFetch });
      const adapter = createD1Adapter(env.DB, { onDiagnostic });
      const database = Object.fromEntries(['run', 'get', 'all'].map(method => [method, (...args) => {
        metrics.databaseCalls++; return adapter[method](...args);
      }]));
      const bot = createBot({
        api, store: new Store(database, epochNow), now: epochNow, shouldContinue,
        reportCache: createReportCache({ db: database, botToken: env.BOT_TOKEN, faceitKey: env.FACEIT_API_KEY, now: epochNow, onEvent: onCacheEvent }),
        settings: { maxRequests: 8, autoAdvanceBatches: 32, autoAdvanceSeconds: CLOUD_WORK_MS / 1000 },
        sealer: createSealer({ keyHex: env.TS_ENCRYPTION_KEY, keyId: 'cloud-v1' }),
        faceit: createFaceitService({ fetch: networkFetch, key: env.FACEIT_API_KEY, now: epochNow }),
        renderCard: report => { metrics.renderCount++; return compressPng(renderReportCard(report)); }, inputFile: createInputFile,
      });
      if (update.message) await bot.handleMessage(update.message, { update });
      else if (update.callback_query) await bot.handleCallback(update.callback_query, { update });
    } finally {
      clearTimer(timer);
      controller.abort();
      try { onMetrics({ ...metrics, elapsedMs: Math.max(0, now() - startedAt) }); } catch { /* Metrics cannot break delivery. */ }
    }
  };
}

export function createWebhook({ getEnv, getRuntime = createCloudRuntime, now = () => Date.now(), onDiagnostic = logCloudDiagnostic }) {
  return async request => {
    const startedAt = now();
    const env = getEnv();
    if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
    if (!authorized(env, request)) return response(403, { error: 'forbidden' });
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return response(415, { error: 'json_required' });
    try {
      readConfiguration(env);
      if (!env.DB) return response(503, { error: 'not_ready' });
    } catch { return response(503, { error: 'not_ready' }); }
    let update;
    try { update = await readUpdate(request); }
    catch (error) { return response(error.message === 'BODY_LIMIT' ? 413 : 400, { error: 'invalid_update' }); }
    try {
      // Resolve request-scoped binding/fetch facades anew; only immutable match
      // bytes are shared across requests, never an environment/runtime closure.
      const runtime = getRuntime(env);
      // Await the handler before acknowledging. No raw update or TS command is queued.
      await runtime(update, { startedAt });
      return response(200, { ok: true });
    } catch (error) { onDiagnostic(cloudFailureCode(error), 'runtime'); return response(503, { error: 'processing_unavailable' }); }
  };
}
