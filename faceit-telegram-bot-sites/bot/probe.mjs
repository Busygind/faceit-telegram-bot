import { fetchWithoutRedirects } from './network.mjs';
import { authorized, readConfiguration } from './webhook.mjs';
import { createD1Adapter, cloudFailureCode, logCloudDiagnostic } from './d1.mjs';
import { createTelegramApi } from './telegram.mjs';

const reply = (status, value) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

/** Operator-only read-only readiness. Never sends messages or exposes identity. */
export function createDependencyProbe({ getEnv, fetch = globalThis.fetch, onDiagnostic = logCloudDiagnostic }) {
  return async request => {
    const env = getEnv();
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!authorized(env, request)) return reply(403, { error: 'forbidden' });
    const result = { ready: false, database: false, telegram: false, expectedBot: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      readConfiguration(env);
      const db = createD1Adapter(env.DB, { onDiagnostic });
      await db.all('SELECT request_id FROM deliveries LIMIT 0');
      result.database = true;
      const transport = async (url, options = {}) => {
        try {
          const target = new URL(url);
          if (target.origin !== 'https://api.telegram.org' || target.username || target.password) throw new Error('CLOUD_NETWORK_FAILED');
          if (typeof AbortSignal.any !== 'function' || typeof AbortSignal.timeout !== 'function') throw new Error('CLOUD_ABORT_UNSUPPORTED');
          const signals = [controller.signal, AbortSignal.timeout(15000)];
          if (options.signal) signals.push(options.signal);
          const response = await fetchWithoutRedirects(fetch, url, { ...options, signal: AbortSignal.any(signals) });
          return response;
        } catch (error) {
          const code = cloudFailureCode(error, 'CLOUD_NETWORK_FAILED');
          onDiagnostic(code, 'telegram'); throw new Error(code);
        }
      };
      const api = createTelegramApi({ token: env.BOT_TOKEN, fetch: transport });
      const me = await api.getMe();
      result.telegram = me?.is_bot === true;
      result.expectedBot = result.telegram && me.username?.toLowerCase() === 'road_to_3_elo_bot';
      result.ready = result.database && result.telegram && result.expectedBot;
      return reply(result.ready ? 200 : 503, result);
    } catch (error) {
      const code = cloudFailureCode(error);
      onDiagnostic(code, 'runtime');
      return reply(503, { ...result, code });
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
