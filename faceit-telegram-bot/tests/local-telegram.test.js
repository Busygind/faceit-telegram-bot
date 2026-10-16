import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputFile, createTelegramApi, TelegramApiError } from '../local/telegram.mjs';
import { todayPoll } from '../tgcloud/lib/poll.js';

const TOKEN = `123456:${'fixture_'.repeat(4)}`;
const ok = (result, status = 200) => new Response(JSON.stringify({ ok: true, result }), { status });

test('Telegram adapter exposes only the needed methods, unwraps JSON, and fixes the HTTPS origin', async () => {
  const calls = [];
  const api = createTelegramApi({ token: TOKEN, fetch: async (url, options) => { calls.push({ url, options }); return ok({ id: 42 }); } });
  assert.equal(Object.isFrozen(api), true);
  assert.equal(api.deleteWebhook, undefined);
  assert.equal(api.dropPendingUpdates, undefined);
  assert.deepEqual(await api.getMe(), { id: 42 });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getMe`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(calls[0].options.headers, { 'content-type': 'application/json' });
  assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[0].options.signal.aborted, false);
});

test('getUpdates preserves offset/filter and adds a bounded long-poll timeout', async () => {
  const calls = [];
  const api = createTelegramApi({ token: TOKEN, fetch: async (url, options) => { calls.push(options); return ok([]); } });
  assert.deepEqual(await api.getUpdates({ offset: 123, allowed_updates: ['message', 'callback_query'] }), []);
  assert.deepEqual(JSON.parse(calls[0].body), { offset: 123, allowed_updates: ['message', 'callback_query'], timeout: 25 });
  await assert.rejects(api.getUpdates({ timeout: 51 }), { code: 'TELEGRAM_INPUT' });
  assert.equal(calls.length, 1);
});

test('sendPoll sends the exact public multiple-answer, revotable native poll without extra settings', async () => {
  let sent;
  const api = createTelegramApi({ token: TOKEN, fetch: async (url, options) => { sent = JSON.parse(options.body); return ok({ message_id: 2 }); } });
  await api.sendPoll(todayPoll(-1004393474895, 7));
  assert.deepEqual(sent, {
    chat_id: -1004393474895, message_thread_id: 7, question: 'Играть сегодня (время по МСК)',
    options: ['да, в 17', 'да, в 18', 'да, в 19', 'да, в 20', 'да, в 21', 'да, в 22', 'да, в 23', 'да, позже', 'нет'].map((text) => ({ text })),
    type: 'regular', is_anonymous: false, allows_multiple_answers: true, allows_revoting: true,
    shuffle_options: false, allow_adding_options: false, hide_results_until_closes: false,
    is_closed: false, disable_notification: false, protect_content: false, allow_paid_broadcast: false,
  });
});

test('sendPhoto builds native multipart preserving bytes, caption and JSON keyboard', async () => {
  const source = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const photo = createInputFile(source, 'faceit-dark.png');
  source[0] = 0;
  let sent;
  const api = createTelegramApi({ token: TOKEN, fetch: async (url, options) => { sent = options; return ok({ message_id: 9 }); } });
  const keyboard = { inline_keyboard: [[{ text: 'Меню', callback_data: 'help' }]] };
  assert.deepEqual(await api.sendPhoto({ chat_id: -10, message_thread_id: 7, photo, caption: 'FACEIT', reply_markup: keyboard }), { message_id: 9 });
  assert.equal(sent.headers, undefined);
  assert.ok(sent.body instanceof FormData);
  assert.equal(sent.body.get('chat_id'), '-10');
  assert.equal(sent.body.get('message_thread_id'), '7');
  assert.equal(sent.body.get('caption'), 'FACEIT');
  assert.deepEqual(JSON.parse(sent.body.get('reply_markup')), keyboard);
  const file = sent.body.get('photo');
  assert.equal(file.name, 'faceit-dark.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([137, 80, 78, 71, 0, 255]));
});

test('numeric Bot API errors retain safe retry/migration parameters only, with no raw description', async () => {
  const api = createTelegramApi({ token: TOKEN, fetch: async () => new Response(JSON.stringify({
    ok: false, error_code: 429, description: `private ${TOKEN}`, parameters: { retry_after: 2, migrate_to_chat_id: -10042, secret: TOKEN },
  }), { status: 429 }) });
  await assert.rejects(api.sendMessage({ chat_id: -10, text: 'x' }), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.code, 429);
    assert.equal(error.status, 429);
    assert.deepEqual(error.parameters, { retry_after: 2, migrate_to_chat_id: -10042 });
    assert.ok(!`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes(TOKEN));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('unknown transport outcomes are sanitized and POST is never retried', async () => {
  let count = 0;
  const api = createTelegramApi({ token: TOKEN, fetch: async (url) => { count++; throw new Error(`failed ${url}`); } });
  await assert.rejects(api.sendPoll(todayPoll(-10)), (error) => {
    assert.equal(error.code, 'TELEGRAM_TRANSPORT');
    assert.ok(!`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes(TOKEN));
    return true;
  });
  assert.equal(count, 1);
});

test('invalid tokens and inputs fail safely without outgoing requests', async () => {
  for (const token of ['', 'abc', `${TOKEN}\n`, `https://other.test/${TOKEN}`]) {
    assert.throws(() => createTelegramApi({ token }), { code: 'TELEGRAM_CONFIG' });
  }
  assert.throws(() => createTelegramApi({ token: TOKEN, timeoutMs: 0 }), { code: 'TELEGRAM_CONFIG' });
  assert.throws(() => createInputFile(new Uint8Array([1]), '../private.png'), { code: 'TELEGRAM_INPUT' });
  assert.throws(() => createInputFile(new Uint8Array(), 'x.png'), { code: 'TELEGRAM_INPUT' });
  let count = 0;
  const api = createTelegramApi({ token: TOKEN, fetch: async () => { count++; return ok(true); } });
  await assert.rejects(api.sendMessage(null), { code: 'TELEGRAM_INPUT' });
  await assert.rejects(api.sendMessage({ chat_id: 1n }), { code: 'TELEGRAM_INPUT' });
  await assert.rejects(api.sendPhoto({ chat_id: -10, photo: 'https://unsafe.test/a.png' }), { code: 'TELEGRAM_INPUT' });
  assert.equal(count, 0);
});

test('unexpected HTTP origins, redirects and malformed responses are rejected without URL disclosure', async () => {
  for (const response of [
    { redirected: true, url: `https://elsewhere.test/${TOKEN}` },
    { redirected: false, url: `http://api.telegram.org/bot${TOKEN}/getMe` },
    { redirected: false, url: `https://other.test/bot${TOKEN}/getMe` },
    { redirected: false, url: `https://api.telegram.org/bot${TOKEN}/getMe?secret=x` },
  ]) {
    const api = createTelegramApi({ token: TOKEN, fetch: async () => ({ ...response, ok: true, status: 200, json: async () => ({ ok: true, result: true }) }) });
    await assert.rejects(api.getMe(), (error) => {
      assert.equal(error.code, 'TELEGRAM_RESPONSE');
      assert.ok(!`${error}\n${error.stack}`.includes(TOKEN));
      return true;
    });
  }
  for (const response of [new Response(`invalid ${TOKEN}`), new Response(JSON.stringify({ ok: true })), new Response('upstream failed', { status: 502 })]) {
    const api = createTelegramApi({ token: TOKEN, fetch: async () => response });
    await assert.rejects(api.getMe(), (error) => {
      assert.ok(!`${error}\n${error.stack}`.includes(TOKEN));
      assert.ok(!Number.isInteger(error.code));
      return true;
    });
  }
});

test('request timeout aborts transport and does not retry or leak its original error', async () => {
  let count = 0;
  const api = createTelegramApi({ token: TOKEN, timeoutMs: 100, fetch: async (url, { signal }) => {
    count++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(`timeout ${url}`)), { once: true }));
  } });
  await assert.rejects(api.getMe(), (error) => {
    assert.equal(error.code, 'TELEGRAM_TIMEOUT');
    assert.ok(!`${error}\n${error.stack}`.includes(TOKEN));
    return true;
  });
  assert.equal(count, 1);
});

test('an already-aborted external signal stops before fetch and never retains its private reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error(`private ${TOKEN}`));
  let count = 0;
  const api = createTelegramApi({ token: TOKEN, fetch: async () => { count++; return ok([]); } });
  await assert.rejects(api.getUpdates({ offset: 1 }, { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'TELEGRAM_ABORTED');
    assert.ok(!`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes(TOKEN));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(count, 0);
});

test('an external shutdown signal aborts an in-flight long poll with no retry or leaked reason', async () => {
  const controller = new AbortController();
  let count = 0;
  let requestSignal;
  const api = createTelegramApi({ token: TOKEN, fetch: async (url, { signal }) => {
    count++;
    requestSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(`private ${url}`)), { once: true }));
  } });
  const pending = api.getUpdates({ offset: 42 }, { signal: controller.signal });
  controller.abort(new Error(TOKEN));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'TELEGRAM_ABORTED');
    assert.ok(!`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes(TOKEN));
    return true;
  });
  assert.equal(requestSignal.aborted, true);
  assert.equal(count, 1);
});

test('external signal options are validated without issuing requests', async () => {
  let count = 0;
  const api = createTelegramApi({ token: TOKEN, fetch: async () => { count++; return ok(true); } });
  await assert.rejects(api.getMe({}, { signal: { aborted: false } }), { code: 'TELEGRAM_INPUT' });
  await assert.rejects(api.getMe({}, null), { code: 'TELEGRAM_INPUT' });
  assert.equal(count, 0);
});
