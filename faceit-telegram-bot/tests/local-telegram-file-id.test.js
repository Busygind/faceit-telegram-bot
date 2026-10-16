import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputFile, createTelegramApi, TelegramApiError } from '../local/telegram.mjs';

const TOKEN = `123456:${'fixture_'.repeat(4)}`;
const FILE_ID = 'AgACAgIAAxkBAA_fixture-file_ID-0123';
const ok = result => new Response(JSON.stringify({ ok: true, result }));

test('photo file_id uses JSON, preserves keyboard/thread and does not invent a caption', async () => {
  let sent;
  const api = createTelegramApi({ token: TOKEN, fetch: async (url, request) => { sent = request; return ok({ message_id: 7 }); } });
  const payload = { chat_id: -10, message_thread_id: 4, photo: FILE_ID,
    reply_markup: { inline_keyboard: [[{ text: 'Menu', callback_data: 'help' }]] } };
  assert.deepEqual(await api.sendPhoto(payload), { message_id: 7 });
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.equal(typeof sent.body, 'string');
  assert.deepEqual(JSON.parse(sent.body), payload);
  assert.equal(Object.hasOwn(JSON.parse(sent.body), 'caption'), false);
  assert.equal(api.setWebhook, undefined);
  assert.equal(api.deleteWebhook, undefined);
});

test('photo file_id rejects URLs, attach references, controls, padding, unicode and oversized IDs before fetch', async () => {
  let requests = 0;
  const api = createTelegramApi({ token: TOKEN, fetch: async () => { requests++; return ok(true); } });
  for (const photo of ['', 'https://example.invalid/a.png', 'http://example.invalid/a.png', 'attach://photo',
    '/tmp/photo.png', 'file://photo', 'photo id', 'photo\n', 'фото', 'ABC=', 'ABC+', 'ABC/', 'a'.repeat(1025)]) {
    await assert.rejects(api.sendPhoto({ chat_id: -10, photo }), { code: 'TELEGRAM_INPUT' });
  }
  assert.equal(requests, 0);
  await api.sendPhoto({ chat_id: -10, photo: 'a'.repeat(1024) });
  assert.equal(requests, 1);
});

test('byte photo remains multipart with lossless bytes and no explicit multipart Content-Type', async () => {
  let sent;
  const api = createTelegramApi({ token: TOKEN, fetch: async (url, request) => { sent = request; return ok({ message_id: 8 }); } });
  const bytes = new Uint8Array([137, 80, 78, 71, 255, 0]);
  await api.sendPhoto({ chat_id: -10, photo: createInputFile(bytes, 'dark.png') });
  assert.equal(sent.headers, undefined);
  assert.ok(sent.body instanceof FormData);
  assert.equal(sent.body.get('caption'), null);
  assert.deepEqual(new Uint8Array(await sent.body.get('photo').arrayBuffer()), bytes);
});

test('only explicit 400 identifier rejection exposes immutable boolean, never raw descriptions', async () => {
  for (const description of ['Bad Request: wrong file identifier/HTTP URL specified',
    "Bad Request: wrong remote file identifier specified: can't unserialize it. wrong last symbol",
    'Bad Request: FILE_REFERENCE_EXPIRED', 'FILE_ID_INVALID', 'Bad Request: wrong file_id']) {
    let requests = 0;
    const api = createTelegramApi({ token: TOKEN, fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 });
    } });
    await assert.rejects(api.sendPhoto({ chat_id: -10, photo: FILE_ID }), error => {
      assert.equal(error.invalidFileId, true);
      assert.equal(error.code, 400);
      assert.throws(() => { error.invalidFileId = false; }, TypeError);
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(description));
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('other 400s, forbidden, rate limits, 5xx and unknown transport never authorize byte fallback', async () => {
  for (const [status, description] of [[400, 'Bad Request: chat not found'], [400, 'Bad Request: message thread not found'],
    [400, `private ${TOKEN} wrong file identifier`], [403, 'Bad Request: wrong file identifier'],
    [429, 'Bad Request: wrong file identifier'], [500, 'FILE_ID_INVALID']]) {
    const api = createTelegramApi({ token: TOKEN, fetch: async () => new Response(JSON.stringify({ ok: false, error_code: status, description }), { status }) });
    await assert.rejects(api.sendPhoto({ chat_id: -10, photo: FILE_ID }), error => {
      assert.equal(error.invalidFileId, false);
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(TOKEN));
      return true;
    });
  }
  const offline = createTelegramApi({ token: TOKEN, fetch: async url => { throw new Error(url); } });
  await assert.rejects(offline.sendPhoto({ chat_id: -10, photo: FILE_ID }), error => error.invalidFileId === false);
  const uploadRejected = createTelegramApi({ token: TOKEN, fetch: async () => new Response(JSON.stringify({ ok: false, error_code: 400,
    description: 'Bad Request: wrong file identifier' }), { status: 400 }) });
  await assert.rejects(uploadRejected.sendPhoto({ chat_id: -10, photo: createInputFile(new Uint8Array([1]), 'dark.png') }), error => error.invalidFileId === false);
  assert.equal(new TelegramApiError({ code: 500, invalidFileId: true }).invalidFileId, false);
  assert.equal(new TelegramApiError({ code: 400, invalidFileId: 'true' }).invalidFileId, false);
});
