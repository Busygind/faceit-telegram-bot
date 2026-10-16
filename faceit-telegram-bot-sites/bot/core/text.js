export const TS_HELP = 'Настройка только для этой группы (администратором):\n/setts ts.example.org:9987 пароль с пробелами\nБез пароля: /setts --no-password ts.example.org:9987\nКоманда с паролем видна участникам. После сохранения попробую её удалить, но уведомления и копии могут остаться.';
export const HELP = 'FACEIT CS2 • меню\n\n/last ник — обзор последнего завершённого матча\n/stats ник — последние 30 завершённых матчей\n/poll — опрос «Играть сегодня (время по МСК)»\n/ts — TeamSpeak этой группы\n/setts адрес:порт пароль — настройка TeamSpeak (админ)\n/setup — помощь с настройкой\n/menu — кнопки\n\nНик FACEIT обязателен каждый раз. Привязок игроков и совместной статистики нет. Все действия — в группе.\nДлинный запрос может потребовать кнопку «Продолжить»: прогресс сохраняется.';

export function clean(value, limit = 100) {
  return Array.from(String(value ?? '—').replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, limit).join('');
}
export function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}
export function moscow(time) {
  if (!Number.isFinite(time) || time <= 0) return '—';
  const parsed = new Date((time + 10800) * 1000);
  if (!Number.isFinite(parsed.getTime())) return '—';
  const date = parsed.toISOString();
  return `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)} ${date.slice(11, 16)} МСК`;
}
export function splitText(text, limit = 3900) {
  if (!Number.isInteger(limit) || limit < 2 || limit > 4096) throw new RangeError('Message limit must be an integer from 2 to 4096');
  const chunks = [];
  let current = '';
  for (let line of String(text).split('\n')) {
    if (current && current.length + line.length + 1 > limit) { chunks.push(current); current = ''; }
    while (line.length > limit) {
      let end = limit;
      if (/[\uD800-\uDBFF]/.test(line[end - 1])) end--;
      chunks.push(line.slice(0, end)); line = line.slice(end);
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ['Нет данных.'];
}
function metric(report, key, digits = 2, unit = '') {
  const item = report.metrics?.[key];
  return `${fmt(item?.value, digits)}${Number.isFinite(item?.value) ? unit : ''} (${item?.matches ?? 0}/${report.count} матч.)`;
}
function percent(value, digits = 1) { return `${fmt(value, digits)}${Number.isFinite(value) ? '%' : ''}`; }
export function playerText(report) {
  return [
    `FACEIT • ${clean(report.nickname)}`,
    `Последние ${report.count} из ${report.requested ?? 30} завершённых матчей`,
    `Победы ${report.wins ?? 0} • поражения ${report.losses ?? 0} • исход неизвестен ${report.unknownResults ?? 0}`,
    `Win rate ${percent(report.winRate)} • форма ${(report.recent ?? []).join(' ') || '—'} (слева новый)`,
    `Средние убийства ${metric(report, 'avgKills', 1)}`,
    `K/D ${metric(report, 'kd')} • K/R ${metric(report, 'kr')}`,
    `HS ${metric(report, 'hs', 1, '%')} • ADR ${metric(report, 'adr', 1)}`,
    report.metrics?.adr?.approximate ? 'ADR: взвешенное по раундам приближение из ADR карт.' : '',
    `Убийства ${metric(report, 'kills', 0)} • смерти ${metric(report, 'deaths', 0)}`,
    `Сейчас: ELO ${report.elo ?? '—'} • уровень ${report.level ?? '—'} (не изменение за матчи)`,
    ...(report.maps ?? []).map((map) => `${clean(map.name, 30)}: сыграно ${map.matches}, WR ${percent(map.winRate)}`),
    `Выборка: ${moscow(report.range?.from)} — ${moscow(report.range?.to)}`,
    report.partial ? '⚠ Неполные данные: часть показателей отсутствует. Старые матчи не подставлены вместо них.' : '',
    report.stale ? '⚠ Данные из устаревшего кэша: дата обновления указана ниже.' : '',
    `Обновлено: ${moscow(report.updatedAt)}`,
  ].filter(Boolean).join('\n');
}
export function lastText(report) {
  const match = report.match ?? report.matches?.[0];
  if (!match) return `FACEIT • ${clean(report.nickname)}\nЗавершённых CS2 матчей не найдено.`;
  const player = match.player ?? {};
  return [
    `FACEIT • ${clean(report.nickname)} • последний завершённый матч`,
    `${moscow(match.finishedAt)} • ${match.result === 'W' ? 'ПОБЕДА' : match.result === 'L' ? 'ПОРАЖЕНИЕ' : 'Исход неизвестен'}`,
    `Счёт вашей команды: ${match.score?.own ?? '—'} : ${match.score?.opponent ?? '—'}`,
    ...(match.maps ?? []).map((map) => `${clean(map.name, 30)}: ${map.ownScore ?? '—'} : ${map.opponentScore ?? '—'}`),
    `K / D / A: ${player.kills ?? '—'} / ${player.deaths ?? '—'} / ${player.assists ?? '—'}`,
    `K/D ${fmt(player.kd)} • K/R ${fmt(player.kr)} • HS ${percent(player.hs)} • ADR ${fmt(player.adr, 1)}`,
    ...((match.teams ?? []).flatMap((team) => [
      `\n${team.id === match.ownTeamId ? 'ВАША КОМАНДА' : 'СОПЕРНИК'} • ${clean(team.name, 40)}`,
      ...(team.players ?? []).slice(0, 10).map((p) => `${clean(p.nickname, 40)}  ${p.kills ?? '—'}/${p.deaths ?? '—'}/${p.assists ?? '—'}`),
    ])),
    !match.statsAvailable ? '\nПодробная статистика ещё недоступна. Это фактический последний матч, не предыдущий.' : '',
    match.partial && match.statsAvailable ? '\nЧасть показателей отсутствует у источника.' : '',
    report.stale ? '\nДанные из устаревшего кэша.' : '',
  ].filter(Boolean).join('\n');
}
