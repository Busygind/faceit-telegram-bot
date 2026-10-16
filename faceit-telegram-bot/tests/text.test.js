import test from 'node:test';
import assert from 'node:assert/strict';
import { clean, fmt, lastText, moscow, playerText, splitText } from '../tgcloud/lib/text.js';
import { DEMO_REPORT } from '../scripts/render-demo.mjs';

test('fmt preserves valid zero and displays unavailable metrics as a dash', () => {
  assert.equal(fmt(1.236), '1.24');
  assert.equal(fmt(0), '0.00');
  assert.equal(fmt(20.34, 1), '20.3');
  for (const missing of [null, undefined, NaN, Infinity, -Infinity, '1.2']) assert.equal(fmt(missing), '—');
});

test('Moscow timestamps use explicit UTC+3 and tolerate invalid/out-of-range data', () => {
  assert.equal(moscow(Date.UTC(2026, 9, 15, 20, 30) / 1000), '15.10.2026 23:30 МСК');
  assert.equal(moscow(Date.UTC(2026, 9, 15, 23, 30) / 1000), '16.10.2026 02:30 МСК');
  for (const missing of [null, undefined, 0, -1, NaN, Infinity, Number.MAX_VALUE]) assert.equal(moscow(missing), '—');
});

test('clean replaces controls and limits code points without cutting surrogate pairs', () => {
  assert.equal(clean('a\n\r\t\0b'), 'a    b');
  assert.equal(clean('🙂🙂🙂', 2), '🙂🙂');
  assert.equal(clean(null), '—');
  assert.equal(clean('<b>Player & One</b>'), '<b>Player & One</b>');
});

test('message splitter preserves nonempty text and respects UTF-16 Telegram limits', () => {
  const text = `Заголовок\n${'🙂аб'.repeat(4000)}\nКонец`;
  const chunks = splitText(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3900);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk));
  }
  assert.equal(chunks.join('').replace(/\n/g, ''), text.replace(/\n/g, ''));
  assert.deepEqual(splitText(''), ['Нет данных.']);
  assert.deepEqual(splitText('a'.repeat(10), 4), ['aaaa', 'aaaa', 'aa']);
  assert.deepEqual(splitText('🙂🙂', 2), ['🙂', '🙂']);
});

test('invalid message limits fail instead of looping forever or making oversize messages', () => {
  for (const invalid of [0, 1, -1, 4097, NaN, 2.5, Infinity]) {
    assert.throws(() => splitText('🙂', invalid), RangeError);
  }
});

test('30-match text describes current ELO and metric coverage from the supplied report', () => {
  const text = playerText(DEMO_REPORT);
  assert.match(text, /PlayerOne/);
  assert.match(text, /Последние 30 из 30 завершённых матчей/);
  assert.match(text, /Победы 18 • поражения 12/);
  assert.match(text, /K\/D 1\.24 \(30\/30 матч\.\)/);
  assert.match(text, /Средние убийства 20\.3/);
  assert.match(text, /Сейчас: ELO 1710 • уровень 8 \(не изменение за матчи\)/);
  assert.match(text, /W L W W L \(слева новый\)/);
  assert.match(text, /Inferno: сыграно 8, WR 62\.5%/);
  assert.match(text, /МСК/);
});

test('text reports missing values, unknown outcomes, approximation and partial/stale honestly', () => {
  const report = {
    ...DEMO_REPORT, nickname: '<b>Игрок&</b>', count: 4, winRate: null,
    wins: 1, losses: 1, unknownResults: 2, partial: true, stale: true,
    metrics: { adr: { value: 88.1, matches: 2, maps: 3, approximate: true } },
    maps: [{ name: 'Unknown', matches: 1, winRate: null }],
  };
  const text = playerText(report);
  assert.match(text, /FACEIT • <b>Игрок&<\/b>/, 'responses are raw text, not Telegram HTML');
  assert.match(text, /исход неизвестен 2/);
  assert.match(text, /Win rate — •/);
  assert.match(text, /K\/D — \(0\/4 матч\.\)/);
  assert.match(text, /ADR: взвешенное по раундам приближение/);
  assert.match(text, /Неполные данные/);
  assert.match(text, /устаревшего кэша/);
  assert.doesNotMatch(text, /—%|undefined|NaN|Infinity/);
});

test('text covers all maps instead of silently hiding cards beyond the four visual rows', () => {
  const maps = Array.from({ length: 20 }, (_, index) => ({ name: `map_${index}`, matches: 1, winRate: 50 }));
  assert.match(playerText({ ...DEMO_REPORT, maps }), /map_19: сыграно 1/);
});

const MATCH = {
  matchId: 'last-real', finishedAt: Date.UTC(2026, 9, 15, 20) / 1000,
  result: 'W', ownTeamId: 'faction2', score: { own: 13, opponent: 7 },
  maps: [{ name: 'de_mirage', ownScore: 13, opponentScore: 7 }],
  player: { kills: 22, deaths: 11, assists: 7, kd: 2, kr: 1.1, hs: 50, adr: 100.4 },
  teams: [
    { id: 'faction1', name: 'Other', players: [{ nickname: 'Enemy', kills: 11, deaths: 22, assists: 2 }] },
    { id: 'faction2', name: 'Friends', players: [{ nickname: 'PlayerOne', kills: 22, deaths: 11, assists: 7 }] },
  ], statsAvailable: true, partial: false,
};

test('latest-match overview uses requested player team orientation and visible rosters', () => {
  const text = lastText({ nickname: 'PlayerOne', match: MATCH });
  assert.match(text, /последний завершённый матч/);
  assert.match(text, /15\.10\.2026 23:00 МСК • ПОБЕДА/);
  assert.match(text, /Счёт вашей команды: 13 : 7/);
  assert.match(text, /de_mirage: 13 : 7/);
  assert.match(text, /K \/ D \/ A: 22 \/ 11 \/ 7/);
  assert.match(text, /СОПЕРНИК • Other\nEnemy  11\/22\/2/);
  assert.match(text, /ВАША КОМАНДА • Friends\nPlayerOne  22\/11\/7/);
});

test('actual latest match with delayed detailed stats is not replaced or shown as zeros', () => {
  const match = { ...MATCH, player: {}, statsAvailable: false, result: '?', score: null, teams: [] };
  const text = lastText({ nickname: 'PlayerOne', matches: [match] });
  assert.match(text, /Исход неизвестен/);
  assert.match(text, /Счёт вашей команды: — : —/);
  assert.match(text, /K \/ D \/ A: — \/ — \/ —/);
  assert.match(text, /фактический последний матч, не предыдущий/);
  assert.doesNotMatch(text, /—%|undefined|NaN/);
  assert.match(lastText({ nickname: 'Empty' }), /Завершённых CS2 матчей не найдено/);
});
