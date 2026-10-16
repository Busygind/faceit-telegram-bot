import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { CARD_HEIGHT, CARD_WIDTH, MATCH_CARD_WIDTH, NOTICE_HEIGHT, renderMatchCard, renderNoticeCard, renderPlayerCard, renderReportCard } from '../tgcloud/lib/card.js';
import { DEMO_LAST_REPORT, DEMO_REPORT } from '../scripts/render-demo.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parsePng(bytes) {
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(Buffer.isBuffer(bytes), false, 'portable API must return Uint8Array, not Buffer');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  const names = [];
  let width;
  let height;
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    names.push(name);
    assert.ok(offset + length + 12 <= bytes.length);
    if (name === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      assert.deepEqual([...bytes.subarray(offset + 16, offset + 21)], [8, 2, 0, 0, 0]);
    }
    if (name === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.equal(offset, bytes.length);
  assert.equal(names[0], 'IHDR');
  assert.equal(names.at(-1), 'IEND');
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 3 + 1;
  assert.equal(raw.length, stride * height);
  for (let y = 0; y < height; y += 1) assert.equal(raw[y * stride], 0, 'every scanline has PNG filter 0');
  const pixel = (x, y) => [...raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)];
  const region = (x, y, w, h) => {
    const rows = [];
    for (let line = y; line < y + h; line += 1) rows.push(raw.subarray(line * stride + 1 + x * 3, line * stride + 1 + (x + w) * 3));
    return digest(Buffer.concat(rows));
  };
  return { width, height, raw, pixel, region };
}

for (const [name, render, report, artifact] of [
  ['stats', renderPlayerCard, DEMO_REPORT, 'demo-player-card.png'],
  ['last', renderMatchCard, DEMO_LAST_REPORT, 'demo-last-match-card.png'],
]) {
  test(`${name} selected FACEIT Dark is a valid portable RGB PNG within Telegram photo limits`, () => {
    const bytes = render(report);
    assert.ok(bytes.length < 10_000_000);
    const image = parsePng(bytes);
    assert.equal(image.width, name === 'last' ? MATCH_CARD_WIDTH : CARD_WIDTH);
    assert.equal(image.height, 1360);
    assert.equal(image.width, name === 'last' ? MATCH_CARD_WIDTH : CARD_WIDTH);
    assert.equal(image.height, CARD_HEIGHT);
    assert.deepEqual(image.pixel(0, 0), [19, 19, 24]);
    assert.deepEqual(image.pixel(60, 34), [255, 107, 43]);
    assert.ok(image.width + image.height <= 10000);
    assert.ok(image.width / image.height < 20 && image.height / image.width < 20);
  });

  test(`${name} card is deterministic and matches the visually approved demo artifact`, async () => {
    const first = render(report);
    const second = render(structuredClone(report));
    assert.equal(digest(first), digest(second));
    const approved = await readFile(new URL(`../docs/${artifact}`, import.meta.url));
    assert.equal(digest(first), digest(approved));
  });
}

test('public dispatcher renders the right card for both command kinds', () => {
  assert.equal(digest(renderReportCard(DEMO_REPORT)), digest(renderPlayerCard(DEMO_REPORT)));
  assert.equal(digest(renderReportCard(DEMO_LAST_REPORT)), digest(renderMatchCard(DEMO_LAST_REPORT)));
  assert.notEqual(digest(renderReportCard(DEMO_REPORT)), digest(renderReportCard(DEMO_LAST_REPORT)));
});

test('missing optional fields, zero sample and empty last report render honestly', () => {
  for (const [bytes, width] of [[renderPlayerCard({ count: 0 }), CARD_WIDTH], [renderMatchCard({ kind: 'last', count: 0, match: null }), MATCH_CARD_WIDTH]]) {
    const image = parsePng(bytes);
    assert.equal(image.width, width);
    assert.equal(image.height, CARD_HEIGHT);
  }
  const unknown = { ...DEMO_LAST_REPORT, match: { ...DEMO_LAST_REPORT.match, result: '?' } };
  assert.notEqual(digest(renderMatchCard(unknown)), digest(renderMatchCard(DEMO_LAST_REPORT)));
});

test('long Unicode nickname, missing metrics, partial/stale and extra maps stay within the stats card', () => {
  const report = {
    ...DEMO_REPORT,
    nickname: 'ОченьДлинныйНик🙂<b>&'.repeat(100),
    partial: true,
    stale: true,
    elo: null,
    level: null,
    winRate: null,
    unknownResults: 2,
    range: { from: NaN, to: Number.MAX_VALUE },
    updatedAt: Infinity,
    recent: ['?', 'W', 'L', null, 'unexpected'],
    metrics: {
      kd: { value: null, matches: 0, maps: 0 },
      adr: { value: 90, approximate: true, matches: 12, maps: 13 },
      kills: { value: Number.MAX_VALUE, matches: 30, maps: 30 },
      hs: { value: Infinity, matches: 0, maps: 0 },
    },
    maps: [...DEMO_REPORT.maps, ...DEMO_REPORT.maps],
  };
  const image = parsePng(renderPlayerCard(report));
  assert.equal(image.width, CARD_WIDTH);
  assert.equal(image.height, CARD_HEIGHT);
  assert.deepEqual(image.pixel(CARD_WIDTH - 1, CARD_HEIGHT - 1), [19, 19, 24]);
});

test('stats renderer uses supplied metrics directly without mutation or recalculation', () => {
  const original = structuredClone(DEMO_REPORT);
  const inconsistent = structuredClone(DEMO_REPORT);
  inconsistent.metrics.kd.value = 9.99;
  assert.notEqual(digest(renderPlayerCard(original)), digest(renderPlayerCard(inconsistent)));
  assert.deepEqual(original, DEMO_REPORT);
});

test('one-map headline uses round score instead of match-level 1:0 series score', () => {
  const first = structuredClone(DEMO_LAST_REPORT);
  const changedSeries = structuredClone(first);
  changedSeries.match.score = { own: 9, opponent: 7 };
  assert.equal(digest(renderMatchCard(first)), digest(renderMatchCard(changedSeries)));
  const changedRounds = structuredClone(first);
  changedRounds.match.maps[0].ownScore = 12;
  const a = parsePng(renderMatchCard(first));
  const b = parsePng(renderMatchCard(changedRounds));
  assert.notEqual(a.region(48, 244, 1104, 170), b.region(48, 244, 1104, 170));
});

test('BO3 headline is labelled and scored as a series, not one map round score', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  report.match.expectedMaps = 3;
  report.match.score = { own: 2, opponent: 1 };
  report.match.maps.push({ name: 'de_nuke', ownScore: 9, opponentScore: 13 },
    { name: 'de_ancient', ownScore: 13, opponentScore: 10 });
  const first = parsePng(renderMatchCard(report));
  const changedMap = structuredClone(report);
  changedMap.match.maps[0].ownScore = 11;
  const second = parsePng(renderMatchCard(changedMap));
  assert.equal(first.region(48, 244, 1104, 170), second.region(48, 244, 1104, 170));
  assert.notEqual(first.region(48, 650, 1104, 123), second.region(48, 650, 1104, 123));
  const changedSeries = structuredClone(report);
  changedSeries.match.score.own = 1;
  const third = parsePng(renderMatchCard(changedSeries));
  assert.notEqual(first.region(48, 244, 1104, 170), third.region(48, 244, 1104, 170));
});

test('own team renders first regardless of FACEIT array order and requested player is identified by ID', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  report.match.teams.reverse();
  assert.equal(digest(renderMatchCard(report)), digest(renderMatchCard(DEMO_LAST_REPORT)));
  const differentRequestedId = { ...report, playerId: 'no-such-player' };
  const first = parsePng(renderMatchCard(report));
  const second = parsePng(renderMatchCard(differentRequestedId));
  assert.notEqual(first.region(48, 890, 540, 282), second.region(48, 890, 540, 282));
  assert.equal(first.region(612, 818, 540, 354), second.region(612, 818, 540, 354));
});

test('missing last-match metrics stay distinct from real zeros and no input is mutated', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  report.partial = true;
  report.match.partial = true;
  report.match.statsAvailable = false;
  report.match.maps = [];
  report.match.player = Object.fromEntries(['kills', 'deaths', 'assists', 'kd', 'kr', 'adr', 'hs'].map((key) => [key, null]));
  for (const team of report.match.teams) {
    for (const player of team.players) {
      for (const key of ['kills', 'deaths', 'assists', 'kd']) player[key] = null;
    }
  }
  const before = structuredClone(report);
  const image = parsePng(renderMatchCard(report));
  const zeros = structuredClone(report);
  for (const key of Object.keys(zeros.match.player)) zeros.match.player[key] = 0;
  const zeroImage = parsePng(renderMatchCard(zeros));
  assert.notEqual(image.region(48, 476, 1104, 112), zeroImage.region(48, 476, 1104, 112));
  assert.deepEqual(report, before);
});

test('last-match ADR approximation is disclosed without changing the supplied metric', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  const first = parsePng(renderMatchCard(report));
  for (const flag of ['approximate', 'approximation']) {
    const approximate = structuredClone(report);
    approximate.metrics = { adr: { value: 100, [flag]: true, matches: 1, maps: 1 } };
    const second = parsePng(renderMatchCard(approximate));
    assert.notEqual(first.region(600, 538, 90, 45), second.region(600, 538, 90, 45));
    assert.equal(first.region(696, 538, 168, 45), second.region(696, 538, 168, 45));
  }
});

test('long last-match rosters and five maps render within fixed geometry with partial/stale status', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  report.nickname = 'Ник🙂<script>'.repeat(80);
  report.partial = true;
  report.stale = true;
  report.match.partial = true;
  report.match.expectedMaps = 5;
  for (const team of report.match.teams) {
    team.name = 'ОченьДлинноеНазваниеКоманды'.repeat(30);
    team.players.push(...structuredClone(team.players));
    for (const player of team.players) player.nickname = 'ОченьДлинныйНик🙂<b>&'.repeat(50);
  }
  report.match.maps = Array.from({ length: 5 }, (_, index) => ({
    name: `de_Карта_С_ОченьДлиннымНазванием_${index}`.repeat(10), ownScore: null, opponentScore: NaN,
  }));
  const image = parsePng(renderMatchCard(report));
  assert.equal(image.width, MATCH_CARD_WIDTH);
  assert.equal(image.height, CARD_HEIGHT);
  assert.deepEqual(image.pixel(MATCH_CARD_WIDTH - 1, CARD_HEIGHT - 1), [19, 19, 24]);
});

test('missing report is rejected explicitly by all public renderers', () => {
  for (const render of [renderPlayerCard, renderMatchCard, renderNoticeCard, renderReportCard]) {
    assert.throws(() => render(null), TypeError);
    assert.throws(() => render(), TypeError);
  }
});


test('stats image includes seven maps and explicitly changes when additional maps are omitted', () => {
  const report = structuredClone(DEMO_REPORT);
  report.maps = Array.from({ length: 7 }, (_, index) => ({ name: `Map${index + 1}`, matches: 4, winRate: 50 }));
  const first = parsePng(renderPlayerCard(report));
  const changedSeventh = structuredClone(report);
  changedSeventh.maps[6].name = 'SeventhShown';
  const second = parsePng(renderPlayerCard(changedSeventh));
  assert.notEqual(first.region(48, 1136, 245, 30), second.region(48, 1136, 245, 30));
  const extra = structuredClone(report);
  extra.maps.push({ name: 'UnshownEighth', matches: 2, winRate: 100 });
  const third = parsePng(renderPlayerCard(extra));
  assert.notEqual(first.region(48, 1170, 768, 22), third.region(48, 1170, 768, 22));
});

test('last image includes all five maps before the teams and marks overflow', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  report.match.expectedMaps = 5;
  report.match.maps = Array.from({ length: 5 }, (_, index) => ({ name: `Map${index + 1}`, ownScore: 13, opponentScore: index }));
  const first = parsePng(renderMatchCard(report));
  const changedFifth = structuredClone(report);
  changedFifth.match.maps[4].name = 'FifthShown';
  const second = parsePng(renderMatchCard(changedFifth));
  assert.notEqual(first.region(48, 758, 790, 24), second.region(48, 758, 790, 24));
  const extra = structuredClone(report);
  extra.match.maps.push({ name: 'Sixth', ownScore: 5, opponentScore: 13 });
  const third = parsePng(renderMatchCard(extra));
  assert.notEqual(first.region(48, 779, 1104, 15), third.region(48, 779, 1104, 15));
});

test('notice dispatcher produces a compact Dark PNG with no fabricated player metrics', () => {
  const report = { kind: 'notice', title: 'Нужно немного подождать', message: 'FACEIT ограничил запросы. Нажмите «Продолжить» позже.', nickname: 'PlayerOne', updatedAt: 1792094400 };
  const image = parsePng(renderNoticeCard(report));
  assert.equal(image.width, CARD_WIDTH);
  assert.equal(image.height, NOTICE_HEIGHT);
  assert.ok(image.raw.byteLength < 10_000_000);
  assert.deepEqual(image.pixel(0, 0), [19, 19, 24]);
  assert.deepEqual(image.pixel(60, 34), [255, 107, 43]);
  assert.equal(digest(renderReportCard(report)), digest(renderNoticeCard(report)));
  const numericNoise = { ...report, elo: 9999, level: 10, count: 30, metrics: { kd: { value: 5 } } };
  assert.equal(digest(renderNoticeCard(report)), digest(renderNoticeCard(numericNoise)));
});

test('notice text wraps across lines and missing or unbroken Unicode messages remain bounded', () => {
  const short = { kind: 'notice', title: 'Проверка', message: 'Одно слово' };
  const first = parsePng(renderNoticeCard(short));
  const multi = { ...short, message: 'Первая строка\nВторая строка\nТретья строка' };
  const second = parsePng(renderNoticeCard(multi));
  assert.notEqual(first.region(80, 288, 704, 80), second.region(80, 288, 704, 80));
  for (const message of [null, '', 'Я'.repeat(9000), 'ДлинныйНик🙂<b>&'.repeat(1000)]) {
    const image = parsePng(renderNoticeCard({ ...short, message, title: 'Очень длинный заголовок '.repeat(100), nickname: 'Ник'.repeat(1000) }));
    assert.equal(image.width, CARD_WIDTH);
    assert.equal(image.height, NOTICE_HEIGHT);
    assert.deepEqual(image.pixel(CARD_WIDTH - 1, NOTICE_HEIGHT - 1), [19, 19, 24]);
    assert.deepEqual(image.pixel(20, 300), [19, 19, 24]);
    assert.deepEqual(image.pixel(840, 300), [19, 19, 24]);
  }
});

test('notice sanitization and rendering are deterministic and do not mutate input', () => {
  const report = { kind: 'notice', title: 'Ошибка', message: 'Проверка\u0000\u0001 текста', nickname: 'Ник', updatedAt: 1792094400 };
  const before = structuredClone(report);
  assert.equal(digest(renderNoticeCard(report)), digest(renderNoticeCard(structuredClone(report))));
  assert.equal(digest(renderNoticeCard(report)), digest(renderNoticeCard({ ...report, message: 'Проверка   текста' })));
  assert.deepEqual(report, before);
});


test('stats maps are win-rate ranked regardless of unequal input order without mutation', () => {
  const report = structuredClone(DEMO_REPORT);
  const before = structuredClone(report);
  const first = digest(renderPlayerCard(report));
  const reversed = structuredClone(report);
  reversed.maps.reverse();
  assert.equal(first, digest(renderPlayerCard(reversed)));
  assert.deepEqual(report, before);
});

test('stats map win-rate ties and missing values retain stable order, with zero before null', () => {
  const report = structuredClone(DEMO_REPORT);
  report.maps = [
    { name: 'MissingA', matches: 1, winRate: null },
    { name: 'Zero', matches: 1, winRate: 0 },
    { name: 'MissingB', matches: 1, winRate: NaN },
    { name: 'TieA', matches: 1, winRate: 80 },
    { name: 'TieB', matches: 1, winRate: 80 },
  ];
  const before = structuredClone(report);
  const expected = structuredClone(report);
  expected.maps = [report.maps[3], report.maps[4], report.maps[1], report.maps[0], report.maps[2]];
  assert.equal(digest(renderPlayerCard(report)), digest(renderPlayerCard(expected)));
  const switchedTies = structuredClone(report);
  [switchedTies.maps[3], switchedTies.maps[4]] = [switchedTies.maps[4], switchedTies.maps[3]];
  assert.notEqual(digest(renderPlayerCard(report)), digest(renderPlayerCard(switchedTies)));
  const switchedMissing = structuredClone(report);
  [switchedMissing.maps[0], switchedMissing.maps[2]] = [switchedMissing.maps[2], switchedMissing.maps[0]];
  assert.notEqual(digest(renderPlayerCard(report)), digest(renderPlayerCard(switchedMissing)));
  assert.deepEqual(report, before);
});

test('both separate team tables are ADR ranked, independent of unequal input order, without mutation', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  const before = structuredClone(report);
  const first = digest(renderMatchCard(report));
  const reversed = structuredClone(report);
  for (const team of reversed.match.teams) team.players.reverse();
  assert.equal(first, digest(renderMatchCard(reversed)));
  assert.deepEqual(report, before);
});

test('ADR sorting preserves ties and missing-order, puts finite zero before null, and keeps ID highlight', () => {
  const report = structuredClone(DEMO_LAST_REPORT);
  const team = report.match.teams.find((item) => item.id === report.match.ownTeamId);
  const [a, b, c, d, e] = team.players;
  a.adr = null; b.adr = 0; c.adr = NaN; d.adr = 80; e.adr = 80;
  const before = structuredClone(report);
  const expected = structuredClone(report);
  expected.match.teams.find((item) => item.id === expected.match.ownTeamId).players = [d, e, b, a, c];
  assert.equal(digest(renderMatchCard(report)), digest(renderMatchCard(expected)));
  const changedTies = structuredClone(report);
  const tiedPlayers = changedTies.match.teams.find((item) => item.id === changedTies.match.ownTeamId).players;
  [tiedPlayers[3], tiedPlayers[4]] = [tiedPlayers[4], tiedPlayers[3]];
  assert.notEqual(digest(renderMatchCard(report)), digest(renderMatchCard(changedTies)));
  const changedMissing = structuredClone(report);
  const missingPlayers = changedMissing.match.teams.find((item) => item.id === changedMissing.match.ownTeamId).players;
  [missingPlayers[0], missingPlayers[2]] = [missingPlayers[2], missingPlayers[0]];
  assert.notEqual(digest(renderMatchCard(report)), digest(renderMatchCard(changedMissing)));
  const withoutHighlight = { ...report, playerId: 'not-present' };
  const originalImage = parsePng(renderMatchCard(report));
  const noHighlightImage = parsePng(renderMatchCard(withoutHighlight));
  assert.notEqual(originalImage.region(48, 1049, 540, 48), noHighlightImage.region(48, 1049, 540, 48));
  assert.deepEqual(report, before);
});

test('coverage metadata is visually silent, while incomplete sample remains disclosed', () => {
  const report = structuredClone(DEMO_REPORT);
  const alteredCoverage = structuredClone(report);
  for (const metric of Object.values(alteredCoverage.metrics)) {
    metric.matches = 0;
    metric.maps = 0;
  }
  assert.equal(digest(renderPlayerCard(report)), digest(renderPlayerCard(alteredCoverage)));
  const incomplete = { ...report, count: 12 };
  const first = parsePng(renderPlayerCard(report));
  const second = parsePng(renderPlayerCard(incomplete));
  assert.notEqual(first.region(48, 1218, 768, 32), second.region(48, 1218, 768, 32));
  assert.equal(first.region(48, 42, 768, 40), second.region(48, 42, 768, 40));
});
