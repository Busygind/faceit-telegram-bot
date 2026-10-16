import test from 'node:test';
import assert from 'node:assert/strict';
import { createDependencyProbe } from '../bot/probe.mjs';
const token = `123456:${'synthetic_'.repeat(4)}`;
const env = { BOT_TOKEN: token, FACEIT_API_KEY: 'synthetic-faceit-key', TS_ENCRYPTION_KEY: 'ab'.repeat(32), WEBHOOK_SECRET: 'cd'.repeat(32),
  DB: { prepare: sql => { assert.equal(sql, 'SELECT request_id FROM deliveries LIMIT 0'); return { all: async () => ({ results: [] }) }; } } };
const request = (secret = env.WEBHOOK_SECRET) => new Request('https://example.test/api/health', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret } });
test('protected probe verifies database and actual Telegram identity without sending messages', async () => {
  let calls = 0;
  const probe = createDependencyProbe({ getEnv: () => env, fetch: async (url, options) => {
    calls++; assert.equal(new URL(url).pathname.split('/').at(-1), 'getMe'); assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ ok: true, result: { is_bot: true, username: 'road_to_3_elo_bot' } });
  }, onDiagnostic: () => {} });
  const response = await probe(request()); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true, database: true, telegram: true, expectedBot: true }); assert.equal(calls, 1);
  assert.equal((await probe(request('wrong'))).status, 403); assert.equal(calls, 1);
});
test('probe rejects configured-but-broken Telegram and never exposes raw errors or credentials', async () => {
  const codes = [];
  const probe = createDependencyProbe({ getEnv: () => env, fetch: async () => { throw new TypeError('Illegal invocation ' + token); }, onDiagnostic: (code, service) => codes.push({ code, service }) });
  const response = await probe(request()); assert.equal(response.status, 503);
  const body = await response.text(); assert.ok(!body.includes(token)); assert.equal(JSON.parse(body).ready, false);
  assert.ok(codes.some(item => item.code === 'CLOUD_FETCH_RECEIVER')); assert.ok(!JSON.stringify(codes).includes(token));
});
