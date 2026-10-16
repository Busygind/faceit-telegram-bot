import { FONT_ASCENT, FONT_SIZE, GLYPHS } from './card-font.js';

// Portable renderer: no DOM, Node, canvas, filesystem, fetch, or runtime packages.
// All values come from the normalized report; no metrics are recomputed.
export const CARD_WIDTH = 864;
export const MATCH_CARD_WIDTH = 1200;
export const CARD_HEIGHT = 1360;
export const NOTICE_HEIGHT = 640;

const C = {
  background: [19, 19, 24], panel: [32, 32, 39], deep: [25, 25, 31],
  ink: [246, 246, 247], muted: [178, 178, 186], faint: [132, 132, 145],
  line: [51, 51, 60], grid: [42, 42, 50], accent: [255, 107, 43],
  accentPanel: [48, 35, 33], win: [158, 226, 189], winPanel: [38, 60, 51],
  loss: [240, 166, 169], lossPanel: [64, 42, 45],
};
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const glyphCache = new Map();

function decodeBase64(input) {
  const output = new Uint8Array(Math.floor(input.length * 3 / 4) - (input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0));
  let bits = 0;
  let value = 0;
  let offset = 0;
  for (const character of input) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) continue;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (value >>> bits) & 255;
    }
  }
  return output;
}

function glyph(character) {
  const key = Object.hasOwn(GLYPHS, character) ? character : '?';
  if (glyphCache.has(key)) return glyphCache.get(key);
  const [advance, left, top, width, height, encoded] = GLYPHS[key];
  const pairs = decodeBase64(encoded);
  const pixels = new Uint8Array(width * height);
  let position = 0;
  for (let index = 0; index < pairs.length; index += 2) {
    pixels.fill(pairs[index + 1], position, position + pairs[index]);
    position += pairs[index];
  }
  const result = { advance, left, top, width, height, pixels };
  glyphCache.set(key, result);
  return result;
}

function measure(input, size) {
  let width = 0;
  for (const character of String(input)) width += glyph(character).advance * size / FONT_SIZE;
  return width;
}

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function fit(input, maxWidth, size, minimum = size) {
  const text = cleanText(input).slice(0, 300);
  let fittedSize = size;
  while (fittedSize > minimum && measure(text, fittedSize) > maxWidth) fittedSize -= 1;
  if (measure(text, fittedSize) <= maxWidth) return { text, size: fittedSize };
  const characters = Array.from(text);
  while (characters.length && measure(`${characters.join('')}…`, fittedSize) > maxWidth) characters.pop();
  return { text: `${characters.join('')}…`, size: fittedSize };
}

class Raster {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  pixel(x, y, color, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const offset = (y * this.width + x) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      this.pixels[offset + channel] = Math.round(color[channel] * alpha + this.pixels[offset + channel] * (1 - alpha));
    }
  }

  rect(x, y, width, height, color, radius = 0) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + width));
    const y1 = Math.min(this.height, Math.ceil(y + height));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        let alpha = 1;
        if (radius > 0) {
          const dx = Math.max(x + radius - (px + 0.5), 0, px + 0.5 - (x + width - radius));
          const dy = Math.max(y + radius - (py + 0.5), 0, py + 0.5 - (y + height - radius));
          if (dx && dy) alpha = Math.max(0, Math.min(1, radius + 0.5 - Math.sqrt(dx * dx + dy * dy)));
        }
        this.pixel(px, py, color, alpha);
      }
    }
  }

  line(x1, y1, x2, y2, color = C.line, width = 1) {
    const length = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let step = 0; step <= length; step += 1) {
      const part = length ? step / length : 0;
      this.rect(x1 + (x2 - x1) * part, y1 + (y2 - y1) * part, width, width, color);
    }
  }

  text(input, x, y, size, color = C.ink, align = 'left') {
    const text = cleanText(input);
    const width = measure(text, size);
    let cursor = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    const scale = size / FONT_SIZE;
    const baseline = y + FONT_ASCENT * scale;
    for (const character of text) {
      const g = glyph(character);
      const left = cursor + g.left * scale;
      const top = baseline + g.top * scale;
      const outWidth = g.width * scale;
      const outHeight = g.height * scale;
      for (let py = Math.floor(top); py < Math.ceil(top + outHeight); py += 1) {
        for (let px = Math.floor(left); px < Math.ceil(left + outWidth); px += 1) {
          const sx = (px + 0.5 - left) / scale - 0.5;
          const sy = (py + 0.5 - top) / scale - 0.5;
          const ix = Math.floor(sx);
          const iy = Math.floor(sy);
          let alpha = 0;
          for (let dy = 0; dy <= 1; dy += 1) {
            for (let dx = 0; dx <= 1; dx += 1) {
              const gx = ix + dx;
              const gy = iy + dy;
              if (gx < 0 || gx >= g.width || gy < 0 || gy >= g.height) continue;
              alpha += g.pixels[gy * g.width + gx]
                * (dx ? sx - ix : 1 - sx + ix) * (dy ? sy - iy : 1 - sy + iy);
            }
          }
          this.pixel(px, py, color, alpha / 255);
        }
      }
      cursor += g.advance * scale;
    }
  }

  fitted(input, x, y, maxWidth, size, minimum = size, color = C.ink, align = 'left') {
    const result = fit(input, maxWidth, size, minimum);
    this.text(result.text, x, y, result.size, color, align);
  }
}

function number(value, decimals = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : '—';
}

function percentage(value, decimals = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(decimals)}%` : '—';
}

function metric(report, name) {
  const input = report.metrics?.[name];
  return input && typeof input === 'object' ? input : { value: null, matches: 0, maps: 0 };
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function date(value, withTime = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  // Fixed UTC+3 is Moscow time; no locale data or Intl/timezone support required.
  const parsed = new Date((value + 3 * 3600) * 1000);
  if (!Number.isFinite(parsed.getTime())) return '—';
  const pad = (part) => String(part).padStart(2, '0');
  const day = `${pad(parsed.getUTCDate())}.${pad(parsed.getUTCMonth() + 1)}.${parsed.getUTCFullYear()}`;
  return withTime ? `${day} ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}` : day;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function panel(image, x, y, width, height, { fill = C.panel } = {}) {
  image.rect(x, y, width, height, fill, 18);
}

function base(report, section, width = CARD_WIDTH) {
  if (!report || typeof report !== 'object') throw new TypeError('PlayerReport is required');
  const image = new Raster(width, CARD_HEIGHT, C.background);
  const right = width - 48;
  const levelX = right - 162;
  image.rect(48, 32, 70, 4, C.accent, 2);
  image.text('FACEIT / CS2', 48, 48, 21, C.accent);
  image.fitted(section, right, 48, width - 354, 20, 16, C.muted, 'right');
  image.rect(48, 112, 88, 88, C.accent, 22);
  const monogram = Array.from(cleanText(report.nickname || '?').slice(0, 300).replace(/[^\p{L}\p{N}]/gu, ''))
    .slice(0, 2).join('').toUpperCase() || '?';
  image.fitted(monogram, 92, 130, 75, 34, 20, C.background, 'center');
  image.fitted(report.nickname || 'Игрок', 158, 108, levelX - 186, 43, 28);
  image.fitted(`ELO ${number(report.elo)} · сейчас`, 158, 168, levelX - 187, 23, 19, C.muted);
  image.rect(levelX, 122, 162, 48, C.accentPanel, 12);
  image.fitted(`LEVEL ${number(report.level)}`, levelX + 81, 133, 142, 23, 18, C.accent, 'center');
  return image;
}

function footer(image, report) {
  const right = image.width - 48;
  image.rect(32, 1192, image.width - 64, 144, C.background);
  image.line(48, 1200, right, 1200, C.line);
  const states = [];
  const n = count(report.count);
  const requested = count(report.requested) || (report.kind === 'last' ? 1 : 30);
  if (report.kind !== 'last' && n > 0 && n < requested) states.push(`Найдено ${n} матчей`);
  if (report.partial || report.match?.partial) states.push('Неполные данные');
  if (report.stale) states.push('Кэш');
  if (states.length) image.fitted(states.join(' · '), 48, 1220, image.width - 96, 18, 16, C.accent);
  image.text(`${date(report.updatedAt, true)} МСК`, 48, 1290, 17, C.muted);
  if (report.demo) image.text('ДЕМО', right, 1290, 15, C.faint, 'right');
}

function sortedRows(rows, key) {
  const source = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  return source.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftFinite = finite(left.row[key]);
    const rightFinite = finite(right.row[key]);
    if (leftFinite !== rightFinite) return leftFinite ? -1 : 1;
    if (leftFinite && left.row[key] !== right.row[key]) return right.row[key] - left.row[key];
    return left.index - right.index;
  }).map(({ row }) => row);
}

function drawMetric(image, report, name, label, column, row, decimals, suffix = '') {
  const data = metric(report, name);
  const x = 48 + column * 261;
  const y = 428 + row * 142;
  panel(image, x, y, 246, 126);
  const value = number(data.value, decimals);
  image.fitted(value === '—' ? value : `${value}${suffix}`, x + 22, y + 12, 202, 46, 26);
  const approximate = name === 'adr' && (data.approximate || data.approximation);
  image.text(approximate ? `${label} ≈` : label, x + 22, y + 78, 21, C.muted);
}

/** Render the selected FACEIT Dark template, with the original win-rate hero. */
export function renderPlayerCard(report) {
  if (!report || typeof report !== 'object') throw new TypeError('PlayerReport is required');
  const n = count(report.count);
  const image = base(report, 'СТАТИСТИКА');
  image.fitted(percentage(report.winRate, Number.isInteger(report.winRate) ? 0 : 1),
    44, 244, 390, 112, 70);
  image.text('побед в выбранных матчах', 48, 365, 22, C.muted);
  image.fitted(`${count(report.wins)} побед · ${count(report.losses)} поражений`,
    816, 292, 380, 25, 20, C.ink, 'right');
  image.fitted(`${date(report.range?.from)} — ${date(report.range?.to)}`,
    816, 332, 378, 21, 18, C.muted, 'right');
  if (count(report.unknownResults)) image.text(`без результата: ${count(report.unknownResults)}`, 816, 365, 19, C.faint, 'right');
  image.line(48, 406, 816, 406, C.line);

  drawMetric(image, report, 'kd', 'KD', 0, 0, 2);
  drawMetric(image, report, 'avgKills', 'K/M', 1, 0, 1);
  drawMetric(image, report, 'kr', 'K/R', 2, 0, 2);
  drawMetric(image, report, 'adr', 'ADR', 0, 1, 1);
  drawMetric(image, report, 'hs', 'HS', 1, 1, 0, '%');
  drawMetric(image, report, 'kills', 'K', 2, 1, 0);

  image.text('Последние 5', 48, 738, 23, C.muted);
  image.text('слева новые', 48, 772, 18, C.faint);
  const recent = Array.isArray(report.recent) ? report.recent.slice(0, 5) : [];
  recent.forEach((result, index) => {
    const x = 486 + index * 68;
    const win = result === 'W';
    const loss = result === 'L';
    image.rect(x, 742, 58, 54, win ? C.winPanel : loss ? C.lossPanel : C.panel, 10);
    image.text(win ? 'W' : loss ? 'L' : '?', x + 29, 753, 25,
      win ? C.win : loss ? C.loss : C.muted, 'center');
  });
  if (!recent.length) image.text('—', 816, 752, 30, C.faint, 'right');
  image.line(48, 822, 816, 822, C.line);
  image.text('КАРТЫ', 48, 842, 20, C.muted);
  image.text('матчи · победы', 816, 842, 19, C.muted, 'right');
  const maps = sortedRows(report.maps, 'winRate');
  maps.slice(0, 7).forEach((map, index) => {
    const y = 884 + index * 42;
    image.fitted(`${cleanText(map.name).replace(/^de_/, '')} · ${count(map.matches)}`, 48, y, 245, 22, 18);
    image.rect(316, y + 11, 342, 8, C.line, 4);
    if (finite(map.winRate)) image.rect(316, y + 11, 342 * Math.max(0, Math.min(100, map.winRate)) / 100, 8, C.accent, 4);
    image.text(percentage(map.winRate, Number.isInteger(map.winRate) ? 0 : 1), 816, y, 22, C.ink, 'right');
  });
  if (!maps.length) image.text(n ? 'Данные по картам недоступны' : 'Нет завершённых матчей в выборке', 48, 916, 23, C.faint);
  if (maps.length > 7) image.text(`Часть карт не показана: ещё ${maps.length - 7}`, 48, 1173, 15, C.faint);

  footer(image, report);
  return encodePng(image.pixels, image.width, image.height);
}

function ownTeams(match) {
  const teams = Array.isArray(match?.teams) ? match.teams.filter((team) => team && typeof team === 'object') : [];
  const own = teams.find((team) => team.id === match.ownTeamId);
  return [own || null, teams.find((team) => team !== own) || null];
}

function scoreScope(match) {
  const maps = Array.isArray(match.maps) ? match.maps : [];
  const series = count(match.expectedMaps) > 1 || maps.length > 1;
  const map = maps.length === 1 ? maps[0] : null;
  if (!series && map && finite(map.ownScore) && finite(map.opponentScore)) {
    return { own: map.ownScore, opponent: map.opponentScore, label: 'СЧЁТ ПО РАУНДАМ' };
  }
  // A match-level 1:0 can be the series result, not round counts. Do not relabel it.
  return { own: match.score?.own, opponent: match.score?.opponent, label: 'СЧЁТ СЕРИИ' };
}

function drawRoster(image, team, requestedId, x, own) {
  panel(image, x, 818, 540, 354, { fill: C.deep });
  image.fitted(team?.name || (own ? 'Ваша команда' : 'Соперники'), x + 20, 832, 500, 25, 20, own ? C.accent : C.muted);
  image.text('ИГРОК', x + 20, 870, 15, C.faint);
  image.text('ADR', x + 314, 870, 15, C.faint, 'right');
  image.text('K/D/A', x + 438, 870, 15, C.faint, 'right');
  image.text('KD', x + 520, 870, 15, C.faint, 'right');
  const players = sortedRows(team?.players, 'adr');
  players.slice(0, 5).forEach((player, index) => {
    const y = 895 + index * 52;
    const active = Boolean(requestedId && player.playerId === requestedId);
    if (active) {
      image.rect(x + 8, y - 2, 524, 45, C.accentPanel, 6);
      image.rect(x + 8, y - 2, 3, 45, C.accent);
    }
    image.fitted(player.nickname || 'Игрок', x + 20, y + 7, 210, 22, 20, active ? C.accent : C.ink);
    image.fitted(number(player.adr, Number.isInteger(player.adr) ? 0 : 1),
      x + 314, y + 7, 76, 22, 19, C.ink, 'right');
    image.fitted(`${number(player.kills)}/${number(player.deaths)}/${number(player.assists)}`,
      x + 438, y + 8, 112, 21, 18, C.ink, 'right');
    image.fitted(number(player.kd, 2), x + 520, y + 7, 70, 22, 19, C.muted, 'right');
    if (index < 4) image.line(x + 20, y + 46, x + 520, y + 46, C.grid);
  });
  if (!players.length) image.text('Состав недоступен', x + 20, 926, 22, C.faint);
  if (players.length > 5) image.text(`Не показано игроков: ${players.length - 5}`, x + 520, 1151, 13, C.faint, 'right');
}

/** Render last completed match with wide, ADR-ranked team tables. */
export function renderMatchCard(report) {
  const image = base(report, 'ПОСЛЕДНИЙ МАТЧ', MATCH_CARD_WIDTH);
  const match = report.match && typeof report.match === 'object' ? report.match : null;
  if (!match) {
    panel(image, 48, 260, 1104, 390, { fill: C.deep });
    image.text('МАТЧ НЕ НАЙДЕН', 80, 302, 34, C.accent);
    image.text('— : —', 80, 375, 105, C.muted);
    image.text('Нет завершённых матчей в выборке', 80, 526, 27, C.muted);
    footer(image, report);
    return encodePng(image.pixels, image.width, image.height);
  }
  const result = match.result === 'W' ? 'ПОБЕДА' : match.result === 'L' ? 'ПОРАЖЕНИЕ' : 'РЕЗУЛЬТАТ НЕИЗВЕСТЕН';
  const resultColor = match.result === 'W' ? C.accent : match.result === 'L' ? C.loss : C.muted;
  const score = scoreScope(match);
  const maps = Array.isArray(match.maps) ? match.maps : [];
  panel(image, 48, 244, 1104, 170, { fill: C.deep });
  image.text(result, 72, 261, 23, resultColor);
  image.fitted(`${number(score.own)} : ${number(score.opponent)}`, 64, 288, 620, 100, 68, resultColor);
  image.text(score.label, 1128, 262, 18, C.faint, 'right');
  image.fitted(date(match.finishedAt, true), 1128, 302, 400, 28, 22, C.ink, 'right');
  image.text('МСК', 1128, 350, 18, C.muted, 'right');
  image.text('ваша команда : соперники', 72, 386, 16, C.faint);

  image.text('ЛИЧНАЯ СТАТИСТИКА', 48, 439, 19, C.muted);
  const player = match.player && typeof match.player === 'object' ? match.player : {};
  const kda = [['kills', 'K'], ['deaths', 'D'], ['assists', 'A']];
  kda.forEach(([field, label], index) => {
    const x = 48 + index * 172;
    panel(image, x, 476, 160, 112);
    image.fitted(number(player[field]), x + 20, 488, 120, 48, 30, C.ink);
    image.text(label, x + 20, 553, 18, C.faint);
  });
  const ratios = [['kd', 'KD', 2, ''], ['kr', 'K/R', 2, ''], ['adr', 'ADR', 1, ''], ['hs', 'HS', 0, '%']];
  ratios.forEach(([field, label, decimals, suffix], index) => {
    const x = 600 + (index % 2) * 288;
    const y = 476 + Math.floor(index / 2) * 62;
    const approximate = field === 'adr' && (metric(report, 'adr').approximate || metric(report, 'adr').approximation);
    image.text(approximate ? `${label} ≈` : label, x, y + 4, 18, C.faint);
    const value = number(player[field], decimals);
    image.fitted(value === '—' ? value : `${value}${suffix}`, x + 264, y - 1, 168, 34, 24, C.accent, 'right');
    image.line(x, y + 45, x + 264, y + 45, C.line);
  });

  image.text('КАРТЫ / РАУНДЫ', 48, 617, 19, C.muted);
  image.text('ВАША : СОПЕРНИКИ', 1152, 619, 16, C.faint, 'right');
  maps.slice(0, 5).forEach((map, index) => {
    const y = 650 + index * 27;
    image.fitted(cleanText(map.name).replace(/^de_/, ''), 48, y, 790, 21, 18, C.ink);
    image.text(`${number(map.ownScore)} : ${number(map.opponentScore)}`, 1152, y, 21, C.accent, 'right');
  });
  if (!maps.length) image.text('Данные по картам ожидаются', 48, 661, 24, C.faint);
  if (maps.length > 5) image.text(`Часть карт не показана: ещё ${maps.length - 5}`, 48, 779, 13, C.faint);
  else if (!match.statsAvailable) image.text('Статистика ожидается', 48, 757, 17, C.faint);

  const [own, opponent] = ownTeams(match);
  image.text('ВАША КОМАНДА', 48, 795, 15, C.accent);
  image.text('СОПЕРНИКИ', 612, 795, 15, C.faint);
  drawRoster(image, own, report.playerId, 48, true);
  drawRoster(image, opponent, report.playerId, 612, false);
  footer(image, report);
  return encodePng(image.pixels, image.width, image.height);
}

function wrappedLines(value, maxWidth, size, maxLines) {
  const original = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').trim();
  const source = original.slice(0, 5000) || 'Попробуйте ещё раз.';
  const lines = [];
  for (const paragraph of source.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (measure(word, size) > maxWidth) {
        if (line) { lines.push(line); line = ''; }
        for (const character of Array.from(word)) {
          if (line && measure(`${line}${character}`, size) > maxWidth) { lines.push(line); line = ''; }
          line += character;
        }
      } else if (line && measure(`${line} ${word}`, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    if (lines.length > maxLines) break;
  }
  const omitted = lines.length > maxLines || original.length > 5000;
  const visible = lines.slice(0, maxLines);
  if (omitted) visible[visible.length - 1] = fit(`${visible.at(-1)}…`, maxWidth, size).text;
  return visible;
}

/** A branded image-only error/action state. No player metrics are invented. */
export function renderNoticeCard(report) {
  if (!report || typeof report !== 'object') throw new TypeError('NoticeReport is required');
  const image = new Raster(CARD_WIDTH, NOTICE_HEIGHT, C.background);
  image.rect(48, 32, 70, 4, C.accent, 2);
  image.text('FACEIT / CS2', 48, 48, 21, C.accent);
  image.text('ROAD TO 3 ELO', 816, 48, 18, C.muted, 'right');
  panel(image, 48, 118, 768, 418);
  image.rect(72, 144, 64, 64, C.accent, 16);
  image.text('!', 104, 153, 39, C.background, 'center');
  image.fitted(report.title || 'Сообщение бота', 156, 145, 628, 33, 24, C.ink);
  if (report.nickname) image.fitted(report.nickname, 156, 192, 628, 21, 17, C.muted);
  const lines = wrappedLines(report.message, 704, 25, 6);
  lines.forEach((line, index) => image.text(line, 80, 248 + index * 40, 25, C.ink));
  image.line(48, 572, 816, 572, C.line);
  if (finite(report.updatedAt) && report.updatedAt > 0) {
    image.text(`${date(report.updatedAt, true)} МСК`, 816, 593, 17, C.faint, 'right');
  }
  return encodePng(image.pixels, image.width, image.height);
}

/** Dispatch command reports and image-only notices to the selected template. */
export function renderReportCard(report) {
  if (report?.kind === 'notice') return renderNoticeCard(report);
  return report?.kind === 'last' ? renderMatchCard(report) : renderPlayerCard(report);
}

function write32(output, offset, value) {
  output[offset] = (value >>> 24) & 255;
  output[offset + 1] = (value >>> 16) & 255;
  output[offset + 2] = (value >>> 8) & 255;
  output[offset + 3] = value & 255;
}

function crc32(bytes, from = 0, to = bytes.length) {
  let crc = 0xffffffff;
  for (let index = from; index < to; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const result = new Uint8Array(data.length + 12);
  write32(result, 0, data.length);
  for (let index = 0; index < 4; index += 1) result[4 + index] = type.charCodeAt(index);
  result.set(data, 8);
  write32(result, result.length - 4, crc32(result, 4, result.length - 4));
  return result;
}

function encodePng(pixels, width, height) {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  // Zlib wrapper + stored DEFLATE blocks; deliberately avoids platform compression.
  const blocks = Math.ceil(raw.length / 65535);
  const zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  zlib.set([0x78, 0x01]);
  let offset = 2;
  let a = 1;
  let b = 0;
  for (let start = 0; start < raw.length; start += 65535) {
    const length = Math.min(65535, raw.length - start);
    zlib[offset++] = start + length === raw.length ? 1 : 0;
    zlib[offset++] = length & 255;
    zlib[offset++] = (length >>> 8) & 255;
    zlib[offset++] = (~length) & 255;
    zlib[offset++] = ((~length) >>> 8) & 255;
    zlib.set(raw.subarray(start, start + length), offset);
    offset += length;
    for (let index = start; index < start + length; index += 1) {
      a = (a + raw[index]) % 65521;
      b = (b + a) % 65521;
    }
  }
  write32(zlib, offset, ((b << 16) | a) >>> 0);
  const header = new Uint8Array(13);
  write32(header, 0, width);
  write32(header, 4, height);
  header[8] = 8;
  header[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
