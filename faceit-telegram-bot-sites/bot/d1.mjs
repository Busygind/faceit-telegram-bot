const DIAGNOSTIC_CODES = new Set([
  'CLOUD_DATABASE_UNAVAILABLE', 'CLOUD_DATABASE_BINDING', 'CLOUD_DATABASE_SCHEMA', 'CLOUD_DATABASE_TYPE', 'CLOUD_DATABASE_FAILED',
  'CLOUD_ABORT_UNSUPPORTED', 'CLOUD_HANDLER_DEADLINE', 'CLOUD_CROSS_REQUEST_IO', 'CLOUD_FETCH_RECEIVER', 'CLOUD_FETCH_CACHE_MODE',
  'CLOUD_REDIRECT_REJECTED', 'CLOUD_FETCH_REDIRECT_MODE', 'CLOUD_NETWORK_TYPE', 'CLOUD_NETWORK_ABORTED', 'CLOUD_NETWORK_FAILED', 'CLOUD_TELEGRAM_TRANSPORT', 'CLOUD_UNEXPECTED',
  ...[400,401,403,404,409,413,429,500,502,503,504].map(status => `CLOUD_UPSTREAM_HTTP_${status}`),
]);

/** Classify privately; neither the original error nor its message is emitted. */
export function cloudFailureCode(error, fallback = 'CLOUD_UNEXPECTED') {
  if (DIAGNOSTIC_CODES.has(error?.message)) return error.message;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/Cannot perform I\/O on behalf of a different request|different request.*I\/O/i.test(message)) return 'CLOUD_CROSS_REQUEST_IO';
  if (/Illegal invocation/i.test(message)) return 'CLOUD_FETCH_RECEIVER';
  if (/Invalid redirect value/i.test(message)) return 'CLOUD_FETCH_REDIRECT_MODE';
  if (/Unsupported cache mode/i.test(message)) return 'CLOUD_FETCH_CACHE_MODE';
  if (/no such table|no such column/i.test(message)) return 'CLOUD_DATABASE_SCHEMA';
  if (/D1_TYPE_ERROR|unsupported type.*bind/i.test(message)) return 'CLOUD_DATABASE_TYPE';
  if (/AbortSignal/i.test(message) && /not a function|undefined|unsupported/i.test(message)) return 'CLOUD_ABORT_UNSUPPORTED';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'CLOUD_NETWORK_ABORTED';
  if (error?.code === 'TELEGRAM_TRANSPORT') return 'CLOUD_TELEGRAM_TRANSPORT';
  if (error?.name === 'TypeError') return 'CLOUD_NETWORK_TYPE';
  return DIAGNOSTIC_CODES.has(fallback) ? fallback : 'CLOUD_UNEXPECTED';
}

export function logCloudDiagnostic(code, service) {
  console.error(JSON.stringify({event:'BOT_DIAGNOSTIC',code:DIAGNOSTIC_CODES.has(code)?code:'CLOUD_UNEXPECTED',
    ...(['telegram','faceit','database','runtime'].includes(service)?{service}:{})}));
}

/** Adapt named bindings used by the existing Store to D1 positional bindings. */
export function createD1Adapter(binding, { onDiagnostic = logCloudDiagnostic } = {}) {
  const guarded = async callback => {
    try { return await callback(); }
    catch (error) { const code = cloudFailureCode(error, 'CLOUD_DATABASE_FAILED'); onDiagnostic(code, 'database'); throw new Error(code); }
  };
  if (!binding?.prepare) throw new Error('CLOUD_DATABASE_UNAVAILABLE');
  const prepare = (sql, params) => {
    if (params === undefined) return binding.prepare(sql);
    if (Array.isArray(params)) return binding.prepare(sql).bind(...params);
    const values = [];
    const positional = sql.replace(/:[a-z_][a-z0-9_]*/gi, key => {
      if (!Object.hasOwn(params, key)) throw new Error('CLOUD_DATABASE_BINDING');
      values.push(params[key] ?? null);
      return '?';
    });
    return binding.prepare(positional).bind(...values);
  };
  return {
    async run(sql, params) {
      return guarded(async () => {
      if (/\bRETURNING\b/i.test(sql)) {
        const result = await prepare(sql, params).all();
        return { rows: result.results ?? [], rowsAffected: result.meta?.changes ?? result.results?.length ?? 0 };
      }
      const result = await prepare(sql, params).run();
      return { rowsAffected: result.meta?.changes ?? 0, lastInsertRowid: result.meta?.last_row_id ?? 0, rows: [] };
      });
    },
    async get(sql, params) { return guarded(async () => (await prepare(sql, params).first()) ?? undefined); },
    async all(sql, params) { return guarded(async () => (await prepare(sql, params).all()).results ?? []); },
  };
}
