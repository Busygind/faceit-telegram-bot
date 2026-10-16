import { createHash } from 'node:crypto';

export const REPORT_CACHE_SCOPE = 'faceit-dark-v1/core-schema-v1';
export const REPORT_CACHE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS report_cache (
    cache_key TEXT PRIMARY KEY, scope_hash TEXT NOT NULL, kind TEXT NOT NULL,
    report_json TEXT NOT NULL, file_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_report_cache_expiry ON report_cache(expires_at)',
];
const LIMIT = 1024 * 1024;
const CAPACITY = 256;
const KINDS = new Set(['last', 'stats']);
const FILE_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const own = (object, key) => Object.hasOwn(object, key);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const numberOrNull = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;

function canonical(value, seen = new Set(), depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 50_000 || depth > 32) throw new Error('REPORT_CACHE_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new Error('REPORT_CACHE_INVALID');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen, depth + 1, budget)).join(',')}]`;
    if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('REPORT_CACHE_INVALID');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen, depth + 1, budget)}`).join(',')}}`;
  } finally { seen.delete(value); }
}

function identity(state, scope, rendererScope) {
  if (!state || !KINDS.has(state.kind) || state.target !== (state.kind === 'last' ? 1 : 30)
    || !['details', 'stats', 'done'].includes(state.phase) || !Array.isArray(state.selected)
    || state.selected.length < 1 || state.selected.length > state.target) return null;
  const profile = state.profile;
  if (!profile || !text(profile.playerId, 128) || !text(profile.nickname, 64)
    || !own(profile, 'elo') || !own(profile, 'level') || !numberOrNull(profile.elo) || !numberOrNull(profile.level)) return null;
  const ids = state.selected.map(item => item?.match_id);
  if (!ids.every(id => text(id, 128)) || new Set(ids).size !== ids.length) return null;
  try {
    const serialized = canonical({ version: rendererScope, scope, kind: state.kind, target: state.target,
      profile: { playerId: profile.playerId, nickname: profile.nickname, elo: profile.elo, level: profile.level }, selected: state.selected });
    if (bytes(serialized) > LIMIT) return null;
    return { key: hash(serialized), ids };
  } catch { return null; }
}

function validReport(state, report, ids, now) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || report.kind !== state.kind || report.playerId !== state.profile.playerId || report.nickname !== state.profile.nickname
    || report.elo !== state.profile.elo || report.level !== state.profile.level || report.requested !== state.target
    || report.count !== ids.length || !Array.isArray(report.matches) || report.matches.length !== ids.length
    || report.matches.some((match, index) => match?.matchId !== ids[index])
    || typeof report.partial !== 'boolean' || report.stale !== undefined && report.stale !== false
    || !Number.isSafeInteger(report.updatedAt) || report.updatedAt <= 0 || report.updatedAt > now) return false;
  if (state.kind === 'last' && report.match?.matchId !== ids[0]) return false;
  return true;
}

export function createReportCache({ db, botToken, faceitKey, now = () => Math.floor(Date.now() / 1000),
  onEvent = () => {}, rendererScope = REPORT_CACHE_SCOPE } = {}) {
  if (!db?.get || !db?.run || typeof botToken !== 'string' || !botToken || typeof faceitKey !== 'string' || !faceitKey
    || typeof now !== 'function' || typeof onEvent !== 'function'
    || typeof rendererScope !== 'string' || !/^[A-Za-z0-9._/:\-]{1,128}$/.test(rendererScope)) throw new Error('REPORT_CACHE_CONFIG');
  const scope = hash(JSON.stringify([botToken, faceitKey]));
  const event = (event, kind, ageSeconds) => {
    try { onEvent({ event, kind, ...(ageSeconds === undefined ? {} : { ageSeconds }) }); } catch {}
  };
  const clock = () => {
    let value;
    try { value = now(); } catch { throw new Error('REPORT_CACHE_CLOCK'); }
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('REPORT_CACHE_CLOCK');
    return value;
  };

  return {
    async get(state) {
      const id = identity(state, scope, rendererScope);
      if (!id) return null;
      let row;
      try { row = await db.get('SELECT * FROM report_cache WHERE cache_key=:key AND scope_hash=:scope', { ':key': id.key, ':scope': scope }); }
      catch { throw new Error('REPORT_CACHE_READ_FAILED'); }
      // Native D1/SQLite adapters are asynchronous. A queued read may cross
      // expiry, so freshness is measured after the I/O, not before it.
      const at = clock();
      const miss = () => { event('miss', state.kind); return null; };
      if (!row || row.cache_key !== id.key || row.scope_hash !== scope || row.kind !== state.kind
        || typeof row.report_json !== 'string' || bytes(row.report_json) > LIMIT
        || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.expires_at) || row.expires_at <= at
        || row.file_id !== null && (typeof row.file_id !== 'string' || !FILE_ID.test(row.file_id))) return miss();
      let report;
      try { report = JSON.parse(row.report_json); } catch { return miss(); }
      if (!validReport(state, report, id.ids, at) || row.created_at !== report.updatedAt
        || row.expires_at !== report.updatedAt + (report.partial ? 60 : 300)) return miss();
      event('hit', state.kind, at - report.updatedAt);
      return { key: id.key, report, fileId: row.file_id };
    },
    async put(state, report, fileId = null) {
      const id = identity(state, scope, rendererScope);
      const at = clock();
      if (!id || !validReport(state, report, id.ids, at)
        || fileId !== null && (typeof fileId !== 'string' || !FILE_ID.test(fileId))) throw new Error('REPORT_CACHE_INVALID');
      let json;
      try { json = canonical(report); } catch { throw new Error('REPORT_CACHE_INVALID'); }
      if (bytes(json) > LIMIT) throw new Error('REPORT_CACHE_INVALID');
      const expires = report.updatedAt + (report.partial ? 60 : 300);
      // Neither a cache hit nor a later Telegram file_id can extend freshness.
      if (expires <= at) return;
      try {
        await db.run(`INSERT INTO report_cache(cache_key,scope_hash,kind,report_json,file_id,created_at,expires_at)
          VALUES(:key,:scope,:kind,:report,:file,:created,:expires)
          ON CONFLICT(cache_key) DO UPDATE SET scope_hash=excluded.scope_hash,kind=excluded.kind,
          report_json=excluded.report_json,file_id=excluded.file_id,created_at=excluded.created_at,expires_at=excluded.expires_at`,
        { ':key': id.key, ':scope': scope, ':kind': state.kind, ':report': json, ':file': fileId, ':created': report.updatedAt, ':expires': expires });
        // One bounded pruning statement; all scopes share a hard storage cap.
        await db.run(`DELETE FROM report_cache WHERE expires_at<=:now OR cache_key IN (
          SELECT cache_key FROM report_cache WHERE expires_at>:now
          ORDER BY created_at DESC,cache_key DESC LIMIT -1 OFFSET ${CAPACITY})`, { ':now': at });
      } catch { throw new Error('REPORT_CACHE_WRITE_FAILED'); }
      event('write', state.kind);
    },
  };
}
