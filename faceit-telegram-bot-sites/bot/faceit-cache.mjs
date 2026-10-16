import { createHash } from 'node:crypto';

const ORIGIN = 'https://open.faceit.com';
const DEFAULT_TTL = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function cacheTarget(url, request) {
  let target;
  try { target = new URL(url); } catch { return null; }
  if ((request.method ?? 'GET').toUpperCase() !== 'GET' || request.body != null
      || target.origin !== ORIGIN || target.username || target.password || target.search || target.hash) return null;
  const match = /^\/data\/v4\/matches\/([a-zA-Z0-9_-]{1,128})(\/stats)?$/.exec(target.pathname);
  if (!match) return null;
  let authorization;
  try { authorization = new Headers(request.headers).get('authorization') ?? ''; } catch { return null; }
  // Partition by credential without retaining a token or request headers.
  const scope = createHash('sha256').update(authorization).digest('hex');
  const detailKey = `${scope}:${match[1]}`;
  return { id: match[1], stats: Boolean(match[2]), detailKey, key: `${detailKey}${match[2] ?? ''}` };
}

async function boundedBody(response, maximum) {
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        // A cloned stream may wait for its original consumer before cancellation.
        void reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/** Per-process, bounded LRU for successful completed-match data only. */
export function createCachedFaceitFetch({
  fetch = globalThis.fetch, now = () => Date.now(), ttlMs = DEFAULT_TTL,
  maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof fetch !== 'function' || typeof now !== 'function'
      || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_TTL
      || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > DEFAULT_MAX_ENTRIES
      || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) throw new Error('LOCAL_CACHE_OPTIONS');
  const entries = new Map();
  let bytesUsed = 0;
  const remove = (key) => {
    const entry = entries.get(key);
    if (entry) { bytesUsed -= entry.bytes.length; entries.delete(key); }
  };
  const find = (key) => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) { remove(key); return null; }
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };
  const put = (key, bytes) => {
    remove(key);
    for (const [oldKey, entry] of entries) if (entry.expiresAt <= now()) remove(oldKey);
    while (entries.size >= maxEntries || bytesUsed + bytes.length > maxBytes) remove(entries.keys().next().value);
    entries.set(key, { bytes: bytes.slice(), expiresAt: now() + ttlMs });
    bytesUsed += bytes.length;
  };
  return async (url, request = {}) => {
    if (request.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const target = cacheTarget(url, request);
    const knownFinished = target && (!target.stats || Boolean(find(target.detailKey)));
    const cached = target && knownFinished && find(target.key);
    if (cached) return new Response(cached.bytes.slice(), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await fetch(url, request);
    if (!target || response.status !== 200 || !knownFinished) return response;
    try {
      const bytes = await boundedBody(response, maxBytes);
      if (!bytes) return response;
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const valid = target.stats
        ? Array.isArray(data?.rounds) && data.rounds.length > 0
          && data.rounds.every((round) => round && typeof round === 'object' && (!round.match_id || round.match_id === target.id))
          && data.rounds.some((round) => Array.isArray(round.teams) && round.teams.length > 0)
        : data?.status === 'FINISHED' && data.match_id === target.id
          && (!data.game || data.game === 'cs2') && (!data.game_id || data.game_id === 'cs2');
      if (valid && (!target.stats || find(target.detailKey))) put(target.key, bytes);
    } catch { /* Parse/body errors are never cached; the caller consumes the original response. */ }
    return response;
  };
}
