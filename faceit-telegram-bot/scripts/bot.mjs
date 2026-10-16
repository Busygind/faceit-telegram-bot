import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readProtected } from './configure.mjs';
import { secureDirectory, acquireLock, loadCredentials } from '../local/config.mjs';
import { createTelegramApi } from '../local/telegram.mjs';
import { createLocalProcesses } from '../local/process.mjs';
import { CLOUD_WEBHOOK, controlBot } from '../local/control.mjs';
import { createDrainState } from '../local/drain.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CODES = new Set(['SWITCH_ARGUMENTS', 'SWITCH_WEBHOOK_CHECK', 'SWITCH_BOT_MISMATCH', 'SWITCH_FOREIGN_WEBHOOK',
  'SWITCH_CLOUD_NOT_READY', 'SWITCH_SECRET_INVALID', 'SWITCH_CLOUD_FAILED', 'SWITCH_CLOUD_UNCERTAIN',
  'SWITCH_CLOUD_FAILED_LOCAL_OFFLINE', 'SWITCH_CLOUD_FAILED_LOCAL_RESTORED', 'SWITCH_ACTIVE_CONFLICT',
  'SWITCH_LOCAL_NOT_READY', 'SWITCH_PROCESS_UNVERIFIED', 'SWITCH_LOCK_UNSAFE', 'SWITCH_STALE_LOCK',
  'SWITCH_PROCESS_CHANGED', 'SWITCH_STOP_FAILED', 'SWITCH_STOP_TIMEOUT', 'SWITCH_LOG_UNSAFE',
  'SWITCH_LOCAL_START_FAILED', 'SWITCH_LOCAL_START_TIMEOUT', 'SWITCH_DRAIN_UNSAFE', 'SWITCH_INTERRUPTED', 'SWITCH_OFFSET_UNAVAILABLE', 'LOCAL_ALREADY_RUNNING', 'LOCAL_STALE_LOCK',
  'LOCAL_LOCK_UNSAFE', 'LOCAL_DIRECTORY_UNSAFE', 'LOCAL_TOKEN_FILE', 'LOCAL_FACEIT_FILE', 'LOCAL_TOKEN_FORMAT', 'LOCAL_FACEIT_FORMAT']);

export function safeControlError(error) {
  if (Number.isInteger(error?.code) && [401, 403, 409, 429].includes(error.code)) return `TELEGRAM_${error.code}`;
  return CODES.has(error?.message) ? error.message : 'SWITCH_FAILED';
}

/** Protected, read-only dependency probe: configuration booleans are not readiness. */
export async function checkCloudReadiness({ secret, fetch = globalThis.fetch } = {}) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return false;
  try {
    const response = await fetch(new URL('/api/health', CLOUD_WEBHOOK), {
      method: 'POST', body: '{}',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store', credentials: 'omit',
    });
    if (response.status !== 200 || response.redirected) return false;
    const data = await response.json();
    return data?.ready === true && data.database === true && data.telegram === true && data.expectedBot === true;
  } catch { return false; }
}

export async function main(args, { root = ROOT, fetch = globalThis.fetch, signal, onStatus = (value, details) => console.log(value === 'DRAINING_CLOUD'
  ? `DRAINING_CLOUD: waiting ${Math.ceil(details.remainingMs / 1000)} seconds for an accepted cloud request to finish; queued updates are preserved.` : value) } = {}) {
  if (args.length !== 1 || !['status', 'cloud', 'local'].includes(args[0])) throw new Error('SWITCH_ARGUMENTS');
  const credentials = await loadCredentials({ root });
  const api = createTelegramApi({ token: credentials.token, fetch, webhookManagement: true });
  const local = createLocalProcesses({ root });
  let release;
  if (args[0] !== 'status') {
    await secureDirectory(join(root, '.local-data'));
    release = await acquireLock(join(root, '.local-data/control.lock'));
  }
  try {
    return await controlBot(args[0], {
      api, local, onStatus, signal, ...createDrainState(root),
      sleep: (ms, abortSignal) => new Promise((resolveSleep, reject) => {
        if (abortSignal?.aborted) { reject(new Error('SWITCH_INTERRUPTED')); return; }
        const aborted = () => { clearTimeout(timer); abortSignal.removeEventListener('abort', aborted); reject(new Error('SWITCH_INTERRUPTED')); };
        const timer = setTimeout(() => { abortSignal?.removeEventListener('abort', aborted); resolveSleep(); }, ms);
        abortSignal?.addEventListener('abort', aborted, { once: true });
      }),
      checkCloud: secret => checkCloudReadiness({ fetch, secret }),
      readSecret: async () => {
        try {
          const file = join(resolve(root, '..'), 'faceit-telegram-bot-sites/.secrets/cloud-generated.json');
          const data = JSON.parse(await readProtected(file));
          return data.WEBHOOK_SECRET;
        } catch { throw new Error('SWITCH_SECRET_INVALID'); }
      },
    });
  } finally { if (release) await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) console.error('Interrupt requested; waiting for a safe point and releasing this command’s locks.');
    controller.abort();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  main(process.argv.slice(2), { signal: controller.signal }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`Bot control: ${safeControlError(error)}. No secret values printed.`);
    process.exitCode = 1;
  }).finally(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
}
