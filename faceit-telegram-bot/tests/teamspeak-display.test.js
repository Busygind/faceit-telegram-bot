import test from 'node:test';
import assert from 'node:assert/strict';
import { displayTeamspeakAddress } from '../tgcloud/lib/teamspeak.js';
import { HELP, TS_HELP } from '../tgcloud/lib/text.js';

test('TeamSpeak display omits the standard connection suffix for hostnames and IPv4', () => {
  for (const [address, expected] of [
    ['TS.Example.org', 'ts.example.org'],
    ['TS.Example.org:9987', 'ts.example.org'],
    ['localhost:9987', 'localhost'],
    ['203.0.113.10', '203.0.113.10'],
    ['203.0.113.10:9987', '203.0.113.10'],
  ]) assert.equal(displayTeamspeakAddress(address), expected);
});

test('TeamSpeak display preserves IPv6 groups, brackets and nonstandard connection settings', () => {
  for (const [address, expected] of [
    ['[2001:DB8::1]:9987', '[2001:db8::1]'],
    ['[2001:db8::1]', '[2001:db8::1]'],
    ['2001:db8::1', '[2001:db8::1]'],
    ['2001:db8::9987', '[2001:db8::9987]'],
    ['[2001:db8::9987]:9987', '[2001:db8::9987]'],
    ['[::]:9987', '[::]'],
    ['[::1]:10000', '[::1]:10000'],
    ['TS.Example.org:10000', 'ts.example.org:10000'],
    ['203.0.113.10:1', '203.0.113.10:1'],
  ]) assert.equal(displayTeamspeakAddress(address), expected);
});

test('TeamSpeak display does not trim an unvalidated stored value', () => {
  for (const address of [
    null, undefined, 123, '', 'https://ts.example.org:9987',
    'bad_host:9987', '[invalid]:9987', '256.1.1.1:9987',
    'ts.example.org :9987', 'ts.example.org:9987/other',
    '::1::9987', '[2001:db8::1]:0',
  ]) assert.equal(displayTeamspeakAddress(address), address);
});

test('TeamSpeak help asks only for an address and never exposes standard connection settings', () => {
  for (const text of [HELP, TS_HELP]) assert.doesNotMatch(text, /порт|port|9987/i);
  assert.match(HELP, /\/setts адрес пароль/);
  assert.match(TS_HELP, /\/setts ts\.example\.org пароль с пробелами/);
  assert.match(TS_HELP, /--no-password ts\.example\.org/);
});
