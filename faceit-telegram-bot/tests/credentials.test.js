import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createSealer, CredentialsError } from '../tgcloud/lib/credentials.js';
import { gcmsiv } from '../tgcloud/lib/vendor/noble-gcmsiv.js';

const config = { keyHex: '01'.repeat(32), keyId: 'test-only-key' };
const chatId = -1001234567890;
const host = '203.0.113.10:9987';
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

test('vendored AES-256-GCM-SIV matches RFC 8452 C.2 empty and eight-byte vectors', () => {
  const key = fromHex(`01${'00'.repeat(31)}`);
  const nonce = fromHex(`03${'00'.repeat(11)}`);
  const cases = [
    ['', '07f5f4169bbf55a8400cd47ea6fd400f'],
    ['0100000000000000', 'c2ef328e5c71c83b843122130f7364b761e0b97427e3df28'],
  ];
  for (const [plainHex, encryptedHex] of cases) {
    assert.equal(toHex(gcmsiv(key, nonce).encrypt(fromHex(plainHex))), encryptedHex);
    assert.equal(toHex(gcmsiv(key, nonce).decrypt(fromHex(encryptedHex))), plainHex);
  }
});

test('credential public API preserves spaces, Unicode, empty password and maximum size', () => {
  const sealer = createSealer(config);
  const cases = ['', 'secret with  internal spaces ', 'Пароль 🔐 日本語', '\ud800'.repeat(4096)];
  for (const password of cases) {
    const sealed = sealer.seal(chatId, host, password, 1);
    assert.deepEqual(sealer.open(chatId, sealed), { host, password });
    assert.ok(!sealed.includes(host));
    if (password.length) assert.ok(!sealed.includes(password));
  }
});

test('ciphertext is bound to the chat, key material, key id and metadata', () => {
  const sealer = createSealer(config);
  const sealed = sealer.seal(chatId, host, 'do-not-leak-this', 1);
  assert.throws(() => sealer.open(chatId - 1, sealed), CredentialsError);
  assert.throws(() => createSealer({ ...config, keyHex: '02'.repeat(32) }).open(chatId, sealed), CredentialsError);
  assert.throws(() => createSealer({ ...config, keyId: 'another-key' }).open(chatId, sealed), CredentialsError);
  for (const change of [
    (value) => { value.v = 2; },
    (value) => { value.n = `${value.n.slice(0, -2)}02`; },
    (value) => { value.c = `${value.c[0] === '0' ? '1' : '0'}${value.c.slice(1)}`; },
    (value) => { value.n = '00'.repeat(12); },
    (value) => { value.k = 'forged-key'; },
  ]) {
    const value = JSON.parse(sealed);
    change(value);
    assert.throws(() => sealer.open(chatId, JSON.stringify(value)), CredentialsError);
  }
});

test('monotonic versions change nonce and both accepted version endpoints decrypt', () => {
  const sealer = createSealer(config);
  const first = sealer.seal(chatId, host, 'password', 1);
  const next = sealer.seal(chatId, host, 'password', 2);
  const maximum = sealer.seal(chatId, host, 'password', 0xffffffff);
  assert.notEqual(JSON.parse(first).n, JSON.parse(next).n);
  assert.notEqual(first, next);
  for (const sealed of [first, next, maximum]) {
    assert.equal(sealer.open(chatId, sealed).password, 'password');
  }
});

test('invalid keys, key identifiers, chat identifiers, values and versions fail closed', () => {
  for (const value of [undefined, {}, { keyHex: '00', keyId: 'key' },
    { ...config, keyHex: 'x'.repeat(64) }, { ...config, keyId: '' },
    { ...config, keyId: 'key:unsafe' }]) {
    assert.throws(() => createSealer(value), CredentialsError);
  }
  const sealer = createSealer(config);
  for (const id of [0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '-100123']) {
    assert.throws(() => sealer.seal(id, host, 'secret', 1), CredentialsError);
  }
  for (const version of [0, -1, 1.5, 0x100000000, NaN, '1']) {
    assert.throws(() => sealer.seal(chatId, host, 'secret', version), CredentialsError);
  }
  for (const [invalidHost, password] of [['', 'x'], ['x'.repeat(513), 'x'],
    [null, 'x'], [host, null], [host, 'x'.repeat(4097)]]) {
    assert.throws(() => sealer.seal(chatId, invalidHost, password, 1), CredentialsError);
  }
});

test('malformed envelopes fail with one constant error and do not expose credentials', () => {
  const sealer = createSealer(config);
  for (const sealed of ['', '{password:DO_NOT_LEAK}', 'null', '{}', '[]', 'x'.repeat(60001),
    JSON.stringify({ v: 1, k: config.keyId, n: 'x'.repeat(24), c: '00'.repeat(32) })]) {
    assert.throws(() => sealer.open(chatId, sealed), {
      name: 'CredentialsError',
      message: 'TeamSpeak credentials could not be processed safely.',
    });
  }
});

test('credential runtime works without WebCrypto, Buffer, text codecs or module imports', async () => {
  const vendor = await readFile(new URL('../tgcloud/lib/vendor/noble-gcmsiv.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../tgcloud/lib/credentials.js', import.meta.url), 'utf8');
  const plainVendor = vendor.replace(/export\s*\{\s*gcmsiv\s*\};?\s*$/, '');
  const plainModule = source.replace(/^import .*\n/, '').replace(/export (class|function) /g, '$1 ');
  const context = {};
  runInNewContext(`${plainVendor}\n${plainModule}\nthis.result = createSealer({
    keyHex: '${config.keyHex}', keyId: '${config.keyId}'
  }).open(${chatId}, createSealer({keyHex: '${config.keyHex}', keyId: '${config.keyId}'})
    .seal(${chatId}, '${host}', 'Тест 🔐', 1)).password;`, context);
  assert.equal(context.result, 'Тест 🔐');
});
