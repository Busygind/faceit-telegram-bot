import test from 'node:test';
import assert from 'node:assert/strict';
import { InputError, parseTeamspeak, validateAddress } from '../tgcloud/lib/teamspeak.js';
import { makeHarness } from './bot-harness.js';

function invalidAddress(value) {
  assert.throws(() => validateAddress(value), (error) => error instanceof InputError && error.code === 'TS_ADDRESS');
}

test('TeamSpeak defaults bare DNS, IPv4 and IPv6 addresses to voice port 9987', () => {
  for (const [address, expected] of [
    ['TS.Example.org', 'ts.example.org:9987'],
    ['localhost', 'localhost:9987'],
    ['203.0.113.10', '203.0.113.10:9987'],
    ['[2001:DB8::1]', '[2001:db8::1]:9987'],
    ['2001:DB8::1', '[2001:db8::1]:9987'],
    ['2001:db8::1234', '[2001:db8::1234]:9987'],
    ['::1', '[::1]:9987'],
    ['::', '[::]:9987'],
    ['2001:db8:0:1:2:3:4:5', '[2001:db8:0:1:2:3:4:5]:9987'],
  ]) assert.equal(validateAddress(address), expected);
});

test('TeamSpeak retains explicit valid ports and requires brackets for IPv6 ports', () => {
  for (const [address, expected] of [
    ['TS.Example.org:01000', 'ts.example.org:1000'],
    ['203.0.113.10:1', '203.0.113.10:1'],
    ['[2001:DB8::1]:65535', '[2001:db8::1]:65535'],
    ['[::1]:9987', '[::1]:9987'],
  ]) assert.equal(validateAddress(address), expected);
});

test('TeamSpeak address rejects URLs, controls, invalid DNS, IPv4, IPv6 and ports', () => {
  for (const value of [
    '', undefined, null, 123, ' ', 'ts.example.org ', 'ts.example.org\n', 'ts.example.org\u007f',
    'ts3server://ts.example.org', 'https://ts.example.org', 'user@ts.example.org', 'ts.example.org/path',
    'ts.example.org?port=9987', 'ts.example.org#voice', 'bad_host', '-bad.test', 'bad-.test',
    '.bad.test', 'bad..test', `${'a'.repeat(64)}.test`, `${'a.'.repeat(127)}a`,
    '256.1.1.1', '01.1.1.1', '127.0.0', '127.0.0.1.1',
    'host:', 'host:0', 'host:65536', 'host:100000', 'host:-1', 'host:abc',
    '[2001:db8::1]:', '[2001:db8::1]:0', '[::1]:65536', '[]', '[2001:db8::1', '2001:db8::1]',
    '[:::]', ':::', ':1::', '::1:', '1:2:3', '[1:2:3]', '1::2::3', '2001:db8::g',
    '[1:2:3:4:5:6:7:8::]', '1:2:3:4:5:6:7:8:9', 'fe80::1%en0', '[fe80::1%en0]',
  ]) invalidAddress(value);
});

test('TeamSpeak optional port preserves password spaces and explicit no-password semantics', () => {
  assert.deepEqual(parseTeamspeak('TS.Example.org pass with  spaces'), {
    host: 'ts.example.org:9987', password: 'pass with  spaces',
  });
  assert.deepEqual(parseTeamspeak('203.0.113.10:10000 pass with  spaces'), {
    host: '203.0.113.10:10000', password: 'pass with  spaces',
  });
  assert.deepEqual(parseTeamspeak('--no-password TS.Example.org'), { host: 'ts.example.org:9987', password: '' });
  assert.deepEqual(parseTeamspeak('--no-password [2001:db8::1]'), { host: '[2001:db8::1]:9987', password: '' });
  assert.deepEqual(parseTeamspeak('--no-password ::1'), { host: '[::1]:9987', password: '' });
  for (const args of ['host', '[::1]', '--no-password', '--no-password host extra', 'host   ', 'host password\n', 'host password\tvalue']) {
    assert.throws(() => parseTeamspeak(args), InputError);
  }
});

test('TeamSpeak group path accepts missing port, isolates chats and preserves old settings on invalid input', async (t) => {
  const bot = await makeHarness(t);
  await bot.send('/setts TS.Example.org fixture password  spaces');
  assert.ok(!bot.sent().at(-1).text.includes('fixture password'));
  await bot.send('/ts', { userId: 2 });
  assert.match(bot.sent().at(-1).text, /Адрес: ts\.example\.org\n/);
  assert.match(bot.sent().at(-1).text, /fixture password  spaces/);
  await bot.send('/ts', { userId: 2, chatId: -20 });
  assert.match(bot.sent().at(-1).text, /ещё не настроен/);
  for (const args of ['TS.Example.org', 'TS.Example.org:0 bad', '--no-password host extra']) {
    await bot.send(`/setts ${args}`);
    await bot.send('/ts', { userId: 2 });
    assert.match(bot.sent().at(-1).text, /fixture password  spaces/);
  }
  await bot.send('/setts --no-password [2001:db8::1]');
  await bot.send('/ts', { userId: 2 });
  assert.match(bot.sent().at(-1).text, /Адрес: \[2001:db8::1\]\n/);
  assert.ok(!bot.sent().at(-1).text.includes('fixture password'));
});
