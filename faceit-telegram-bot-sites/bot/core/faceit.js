/** Portable FACEIT Data API core. No runtime dependencies or background timers. */
const BASE = 'https://open.faceit.com/data/v4';
const WINDOW_SECONDS = 90 * 24 * 60 * 60;
const PAGE_SIZE = 100;
const MAX_OFFSET = 1000;

export class FaceitError extends Error {
  constructor(code, { status = null, retryAt = null } = {}) {
    super(code);
    this.name = 'FaceitError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

function number(value) {
  if (value === null || value === undefined || typeof value === 'boolean'
    || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function stat(record, ...names) {
  if (!record || typeof record !== 'object') return null;
  // Percentage and count fields are different inputs. Dropping '%' used to
  // conflate "Headshots %" with "Headshots" and depended on API key order.
  const canonical = (name) => name.toLowerCase().replace(/%/g, 'percent').replace(/[^a-z0-9]/g, '');
  const keys = names.map(canonical);
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(canonical(key))) return number(value);
  }
  return null;
}

function text(value, limit = 128) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
}

function completeMatch(item, to) {
  const finished = number(item.finished_at);
  return text(item.status).toUpperCase() === 'FINISHED'
    && finished !== null && finished > 0 && finished <= to
    && (!item.game_id || item.game_id === 'cs2') && (!item.game || item.game === 'cs2');
}

function orderMatches(a, b) {
  return Number(b.finished_at) - Number(a.finished_at)
    || String(b.match_id).localeCompare(String(a.match_id));
}

function teamRoster(team) {
  return Array.isArray(team?.roster) ? team.roster : Array.isArray(team?.players) ? team.players : [];
}

function compactHistory(item) {
  const teams = {};
  for (const [id, team] of Object.entries(item.teams || {})) {
    teams[id] = {
      team_id: text(team.team_id), faction_id: text(team.faction_id),
      name: text(team.name || team.nickname),
      players: teamRoster(team).map((player) => ({ player_id: text(player.player_id), nickname: text(player.nickname) })),
    };
  }
  return {
    match_id: text(item.match_id), finished_at: number(item.finished_at), status: text(item.status),
    game_id: 'cs2', faceit_url: text(item.faceit_url, 512), teams,
    results: { winner: text(item.results?.winner), score: item.results?.score || {} },
  };
}

function safeMatchUrl(value, id) {
  const url = text(value, 512).replace('{lang}', 'en');
  return /^https:\/\/(www\.)?faceit\.com\/[a-zA-Z0-9_/?=&%.{}~-]+$/.test(url)
    ? url : `https://www.faceit.com/en/cs2/room/${encodeURIComponent(id)}`;
}

function sumAll(rows, field) {
  return rows.length > 0 && rows.every((row) => row[field] !== null)
    ? rows.reduce((sum, row) => sum + row[field], 0) : null;
}

function ratio(numerator, denominator, multiplier = 1) {
  return numerator !== null && denominator !== null && denominator > 0 ? multiplier * numerator / denominator : null;
}

function coverage(rows, selector) {
  const selected = rows.filter(selector);
  return { selected, matches: new Set(selected.map((row) => row.matchId)).size, maps: selected.length };
}

function aggregate(rows, field, denominator = null, multiplier = 1) {
  const covered = coverage(rows, (row) => row[field] !== null && (!denominator || row[denominator] !== null));
  const numerator = covered.selected.reduce((sum, row) => sum + row[field], 0);
  const divisor = denominator ? covered.selected.reduce((sum, row) => sum + row[denominator], 0) : 1;
  return {
    value: covered.maps ? ratio(numerator, divisor, multiplier) : null,
    matches: covered.matches, maps: covered.maps,
  };
}

function damageMetric(rows) {
  const covered = coverage(rows, (row) => row.rounds !== null && (row.damage !== null || row.adr !== null));
  const rounds = covered.selected.reduce((sum, row) => sum + row.rounds, 0);
  const damage = covered.selected.reduce((sum, row) => sum + (row.damage ?? row.adr * row.rounds), 0);
  return {
    value: covered.maps ? ratio(damage, rounds) : null, matches: covered.matches, maps: covered.maps,
    approximate: covered.selected.some((row) => row.damage === null),
  };
}

function playerValues(player) {
  const source = player?.player_stats;
  return {
    playerId: text(player?.player_id), nickname: text(player?.nickname),
    kills: stat(source, 'Kills'), deaths: stat(source, 'Deaths'), assists: stat(source, 'Assists'),
    headshots: stat(source, 'Headshots', 'Headshot Kills'), damage: stat(source, 'Damage', 'Total Damage'),
    adr: stat(source, 'ADR', 'Average Damage per Round'),
  };
}

function teamAliases(key, team) {
  return [key, team?.team_id, team?.faction_id].filter(Boolean).map(String);
}

function mapWinner(round, own, opponent, aliases) {
  const winner = round.round_stats?.Winner ?? round.round_stats?.winner;
  if (winner && aliases.includes(String(winner))) return 'W';
  if (winner && opponent && String(winner) === String(opponent.team_id)) return 'L';
  const won = stat(own?.team_stats, 'Team Win', 'Winner');
  if (won === 1) return 'W';
  if (won === 0) return 'L';
  return '?';
}

function scoreFor(team) {
  return stat(team?.team_stats, 'Final Score', 'Score');
}

function summarizePlayer(rows, complete = true) {
  const kills = complete ? sumAll(rows, 'kills') : null;
  const deaths = complete ? sumAll(rows, 'deaths') : null;
  const assists = complete ? sumAll(rows, 'assists') : null;
  return {
    kills, deaths, assists, kd: aggregate(rows, 'kills', 'deaths').value,
    kr: aggregate(rows, 'kills', 'rounds').value,
    hs: aggregate(rows, 'headshots', 'kills', 100).value, adr: damageMetric(rows).value,
  };
}

/** Normalize only documented match/stat dictionaries. Missing numeric inputs stay null. */
export function normalizeMatch(history, details, stats, playerId) {
  const main = details || history;
  const teamSource = main.teams || history.teams || {};
  const entries = Object.entries(teamSource);
  const ownEntry = entries.find(([, team]) => teamRoster(team).some((player) => player.player_id === playerId));
  const historyOwn = Object.entries(history.teams || {})
    .find(([, team]) => teamRoster(team).some((player) => player.player_id === playerId));
  const ownKey = ownEntry?.[0] || historyOwn?.[0] || null;
  const aliases = teamAliases(ownKey, ownEntry?.[1] || historyOwn?.[1]);
  const winner = main.results?.winner || history.results?.winner;
  const opponentAliases = entries.filter(([key]) => key !== ownKey)
    .flatMap(([key, team]) => teamAliases(key, team));
  const result = winner && ownKey ? aliases.includes(String(winner)) ? 'W'
    : opponentAliases.includes(String(winner)) ? 'L' : '?' : '?';
  const rounds = Array.isArray(stats?.rounds) ? stats.rounds : [];
  const mapStats = [];
  const allPlayers = [];
  const seenRounds = new Set();
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    if (round.played === false || round.played === 0 || round.played === '0' || round.played === 'false') continue;
    if (round.game_id && round.game_id !== 'cs2') continue;
    const name = text(round.round_stats?.Map || round.round_stats?.map || 'Неизвестная карта', 64);
    const key = `${round.match_id || history.match_id}:${round.match_round ?? index}:${name}`;
    if (seenRounds.has(key)) continue;
    seenRounds.add(key);
    const teams = Array.isArray(round.teams) ? round.teams : [];
    const own = teams.find((team) => teamRoster(team).some((player) => player.player_id === playerId));
    const opponent = teams.find((team) => team !== own);
    const ownScore = scoreFor(own);
    const opponentScore = scoreFor(opponent);
    const roundCount = stat(round.round_stats, 'Rounds')
      ?? (ownScore !== null && opponentScore !== null ? ownScore + opponentScore : null);
    const base = { matchId: history.match_id, name, rounds: roundCount, ownScore, opponentScore };
    let mapResult = own ? mapWinner(round, own, opponent, aliases) : '?';
    if (mapResult === '?' && ownScore !== null && opponentScore !== null && ownScore !== opponentScore) {
      mapResult = ownScore > opponentScore ? 'W' : 'L';
    }
    for (const team of teams) {
      for (const player of teamRoster(team)) allPlayers.push({
        ...base, ...playerValues(player), rounds: stat(player.player_stats, 'Rounds') ?? roundCount,
      });
    }
    const player = own && teamRoster(own).find((row) => row.player_id === playerId);
    if (player) mapStats.push({
      ...base, ...playerValues(player), rounds: stat(player.player_stats, 'Rounds') ?? roundCount, result: mapResult,
    });
  }
  const scores = main.results?.score || history.results?.score || {};
  const ownScore = ownKey ? number(scores[ownKey]) : null;
  const opponentKey = entries.find(([key]) => key !== ownKey)?.[0];
  const opponentScore = opponentKey ? number(scores[opponentKey]) : null;
  const bestOf = number(main.best_of);
  const expectedMaps = bestOf > 1 && ownScore !== null && opponentScore !== null
    && ownScore + opponentScore <= bestOf ? ownScore + opponentScore : Math.max(seenRounds.size, 1);
  const statsComplete = mapStats.length > 0 && mapStats.length >= expectedMaps;
  const missingInputs = mapStats.some((map) => ['kills', 'deaths', 'assists', 'rounds', 'headshots']
    .some((key) => map[key] === null) || (map.damage === null && map.adr === null));
  if (mapStats.length === 1 && expectedMaps === 1 && mapStats[0].result === '?') mapStats[0].result = result;
  const normalizedTeams = entries.map(([id, team]) => ({
    id, name: text(team.name || team.nickname || id), score: number(scores[id]),
    players: teamRoster(team).map((player) => ({
      playerId: text(player.player_id), nickname: text(player.nickname),
      ...summarizePlayer(allPlayers.filter((row) => row.playerId === player.player_id), statsComplete),
    })),
  }));
  return {
    matchId: history.match_id, finishedAt: number(main.finished_at) || history.finished_at,
    result, ownTeamId: ownKey, score: { own: ownScore, opponent: opponentScore },
    teams: normalizedTeams, maps: mapStats, player: summarizePlayer(mapStats, statsComplete),
    url: safeMatchUrl(main.faceit_url || history.faceit_url, history.match_id),
    statsAvailable: mapStats.length > 0, partial: !details || !statsComplete || missingInputs,
    expectedMaps,
  };
}

/** The same report object is used by the image and text renderers. */
export function buildReport(state, updatedAt) {
  const matches = state.matches || [];
  const rows = matches.flatMap((match) => match.maps);
  const wins = matches.filter((match) => match.result === 'W').length;
  const losses = matches.filter((match) => match.result === 'L').length;
  const averageMatches = matches.filter((match) => match.maps.length >= match.expectedMaps
    && match.maps.length > 0 && match.maps.every((map) => map.kills !== null));
  const maps = new Map();
  for (const row of rows) {
    const entry = maps.get(row.name) || { name: row.name, matches: 0, wins: 0, losses: 0, unknownResults: 0 };
    entry.matches += 1;
    if (row.result === 'W') entry.wins += 1;
    else if (row.result === 'L') entry.losses += 1;
    else entry.unknownResults += 1;
    maps.set(row.name, entry);
  }
  return {
    kind: state.kind, nickname: state.profile.nickname, playerId: state.profile.playerId,
    elo: state.profile.elo, level: state.profile.level, requested: state.target, count: matches.length,
    wins, losses, unknownResults: matches.length - wins - losses,
    winRate: ratio(wins, wins + losses, 100), recent: matches.slice(0, 5).map((match) => match.result),
    range: { from: matches.at(-1)?.finishedAt ?? null, to: matches[0]?.finishedAt ?? null },
    partial: state.phase !== 'done' || matches.some((match) => match.partial), updatedAt,
    metrics: {
      kd: aggregate(rows, 'kills', 'deaths'), kr: aggregate(rows, 'kills', 'rounds'),
      hs: aggregate(rows, 'headshots', 'kills', 100), adr: damageMetric(rows),
      kills: aggregate(rows, 'kills'), deaths: aggregate(rows, 'deaths'),
      avgKills: {
        value: averageMatches.length ? averageMatches.reduce((sum, match) => sum + sumAll(match.maps, 'kills'), 0) / averageMatches.length : null,
        matches: averageMatches.length, maps: averageMatches.reduce((sum, match) => sum + match.maps.length, 0),
      },
    },
    maps: [...maps.values()].map((entry) => ({ ...entry, winRate: ratio(entry.wins, entry.wins + entry.losses, 100) }))
      .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name)),
    matches, ...(state.kind === 'last' ? { match: matches[0] || null } : {}),
  };
}

function retryAfter(response, now, attempt = 0) {
  const header = response?.headers?.get?.('retry-after');
  const seconds = header !== undefined && header !== null && /^\d+(?:\.\d+)?$/.test(String(header)) ? Number(header) : null;
  if (seconds !== null) return now + Math.max(1, Math.ceil(seconds));
  const date = header ? Date.parse(header) : NaN;
  if (Number.isFinite(date)) return Math.max(now + 1, Math.ceil(date / 1000));
  return now + Math.min(300, 2 ** Math.min(attempt + 1, 8)) + Math.floor(Math.random() * 3);
}

function progress(state) {
  return {
    phase: state.phase, requests: state.requests, found: state.candidates.length,
    loaded: state.matches.length, requested: state.target, retryAt: state.retryAt || null,
    reason: state.blocked || null,
  };
}

/**
 * fetch must implement the documented Response-like sdk.fetch contract.
 * now returns Unix seconds. Checkpoints deliberately never contain the API key.
 */
export function createFaceitService({ fetch, key, now = () => Math.floor(Date.now() / 1000) }) {
  if (typeof fetch !== 'function' || typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) {
    throw new FaceitError('FACEIT_NOT_CONFIGURED');
  }
  async function get(path, query = {}, attempt = 0) {
    const search = Object.entries(query).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
    let response;
    try {
      response = await fetch(`${BASE}${path}${search ? `?${search}` : ''}`, {
        method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
    } catch {
      throw new FaceitError('FACEIT_TEMPORARY', { retryAt: retryAfter(null, now(), attempt) });
    }
    const status = Number(response?.status);
    if (status === 401 || status === 403) throw new FaceitError('FACEIT_ACCESS_DENIED', { status });
    if (status === 429 || status >= 500) {
      throw new FaceitError(status === 429 ? 'FACEIT_RATE_LIMITED' : 'FACEIT_TEMPORARY', {
        status, retryAt: retryAfter(response, now(), attempt),
      });
    }
    if (status === 404) throw new FaceitError('FACEIT_NOT_FOUND', { status });
    if (status < 200 || status >= 300 || !Number.isFinite(status)) throw new FaceitError('FACEIT_REQUEST_FAILED', { status });
    try { return await response.json(); } catch { throw new FaceitError('FACEIT_INVALID_RESPONSE'); }
  }

  async function start(nickname, kind, { playerId } = {}) {
    if (kind !== 'last' && kind !== 'stats') throw new FaceitError('INVALID_REPORT_KIND');
    const nick = typeof nickname === 'string' ? nickname.trim() : '';
    if (!nick || nick.length > 64 || /[\s\u0000-\u001f\u007f]/.test(nick)) throw new FaceitError('INVALID_NICKNAME');
    const bound = playerId !== undefined;
    if (bound && (typeof playerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(playerId))) throw new FaceitError('INVALID_PLAYER_ID');
    let player;
    // A personal binding follows the immutable FACEIT id, not a nickname that
    // another account could later reuse. Explicit nick requests use the old path.
    try { player = bound ? await get(`/players/${encodeURIComponent(playerId)}`) : await get('/players', { nickname: nick }); } catch (error) {
      if (error.code === 'FACEIT_NOT_FOUND') throw new FaceitError('PLAYER_NOT_FOUND');
      throw error;
    }
    if (!player?.player_id || typeof player.player_id !== 'string' || !text(player.player_id)) throw new FaceitError('FACEIT_INVALID_RESPONSE');
    if (bound && player.player_id !== playerId) throw new FaceitError('FACEIT_INVALID_RESPONSE');
    if (!player.games?.cs2) throw new FaceitError('PLAYER_NO_CS2');
    const to = Math.max(0, Math.floor(now()));
    const from = Math.max(0, to - WINDOW_SECONDS);
    return {
      version: 1, kind, target: kind === 'last' ? 1 : 30,
      profile: { playerId: text(player.player_id), nickname: text(player.nickname, 64) || nick,
        elo: number(player.games.cs2.faceit_elo), level: number(player.games.cs2.skill_level) },
      to, oldest: from, span: WINDOW_SECONDS, windows: [{ from, to, offset: 0 }],
      candidates: [], selected: [], matches: [], detail: null,
      phase: 'history', requests: 1, retryAt: null, retryCount: 0,
    };
  }

  async function advance(checkpoint, { maxRequests = 8, historyOnly = false, shouldContinue } = {}) {
    if (!checkpoint || checkpoint.version !== 1 || !['last', 'stats'].includes(checkpoint.kind)) {
      throw new FaceitError('INVALID_CHECKPOINT');
    }
    const state = JSON.parse(JSON.stringify(checkpoint));
    const budget = Math.min(20, Math.max(1, Math.floor(Number(maxRequests) || 8)));
    if (state.phase === 'done') {
      state.completedAt ??= state.to;
      const report = buildReport(state, state.completedAt);
      report.stale = now() - state.completedAt > 300;
      return { done: true, state, report, progress: progress(state) };
    }
    if (state.blocked || (state.retryAt && state.retryAt > now())) return { done: false, state, report: null, progress: progress(state) };
    state.retryAt = null;
    let used = 0;
    const paused = Symbol('request-budget-exhausted');
    const request = async (path, query) => {
      // Stop only between GETs: a completed detail/stat response is first
      // normalized into the checkpoint, without consuming a fake request.
      if (typeof shouldContinue === 'function' && !shouldContinue()) throw paused;
      used += 1;
      state.requests += 1;
      return get(path, query, state.retryCount);
    };
    try {
      while ((used < budget || (historyOnly && state.phase === 'history' && !state.windows.length)) && state.phase !== 'done') {
        // A report cache may inspect only a fully exhausted fresh history
        // snapshot. Settle selection even at the exact HTTP-budget boundary,
        // then stop before issuing any match-detail/statistics request.
        if (historyOnly && state.phase !== 'history') break;
        if (state.phase === 'history') {
          const window = state.windows[0];
          if (!window) {
            if (state.candidates.length >= state.target || state.oldest === 0) {
              state.selected = state.candidates.sort(orderMatches).slice(0, state.target);
              state.phase = state.selected.length ? 'details' : 'done';
            } else {
              const to = state.oldest;
              state.span *= 2;
              const from = Math.max(0, to - state.span);
              state.oldest = from;
              state.windows.push({ from, to, offset: 0 });
            }
            continue;
          }
          const data = await request(`/players/${encodeURIComponent(state.profile.playerId)}/history`, {
            // The contract does not specify inclusive/exclusive bounds. A
            // one-second overlap protects integer timestamps at partitions;
            // completeMatch still enforces the original fixed snapshot `to`.
            game: 'cs2', from: Math.max(0, window.from - 1), to: window.to + 1,
            offset: window.offset, limit: PAGE_SIZE,
          });
          if (!Array.isArray(data?.items)) throw new FaceitError('FACEIT_INVALID_RESPONSE');
          const seenMatches = new Set(state.candidates.map((row) => row.match_id));
          for (const item of data.items) {
            if (!item?.match_id || !completeMatch(item, state.to)) continue;
            if (!seenMatches.has(item.match_id)) {
              state.candidates.push(compactHistory(item));
              seenMatches.add(item.match_id);
            }
          }
          // API does not promise ordering. Only an exhausted window is complete.
          if (data.items.length < PAGE_SIZE) state.windows.shift();
          else if (window.offset < MAX_OFFSET) window.offset += PAGE_SIZE;
          else {
            if (window.to - window.from <= 1) {
              state.blocked = 'HISTORY_DENSITY_UNRESOLVED';
              break;
            }
            const middle = Math.floor((window.from + window.to) / 2);
            state.windows.splice(0, 1,
              { from: middle, to: window.to, offset: 0 },
              { from: window.from, to: middle, offset: 0 });
          }
        } else if (state.phase === 'details') {
          const item = state.selected[state.matches.length];
          if (!item) { state.phase = 'done'; continue; }
          let detail = null;
          try { detail = await request(`/matches/${encodeURIComponent(item.match_id)}`); } catch (error) {
            if (error.code !== 'FACEIT_NOT_FOUND') throw error;
          }
          const detailStatus = text(detail?.status).toUpperCase();
          const invalidDetail = detail && ((detailStatus && detailStatus !== 'FINISHED')
            || (number(detail.finished_at) !== null && Number(detail.finished_at) > state.to)
            || (detail.game && detail.game !== 'cs2') || (detail.game_id && detail.game_id !== 'cs2'));
          if (invalidDetail) {
            // A canceled/current entry must never become a completed match.
            state.candidates = state.candidates.filter((row) => row.match_id !== item.match_id);
            state.selected = state.candidates.sort(orderMatches).slice(0, state.target);
            if (state.selected.length < state.target && state.oldest > 0) state.phase = 'history';
            continue;
          }
          state.detail = detail;
          state.phase = 'stats';
        } else if (state.phase === 'stats') {
          const item = state.selected[state.matches.length];
          let stats = null;
          try { stats = await request(`/matches/${encodeURIComponent(item.match_id)}/stats`); } catch (error) {
            if (error.code !== 'FACEIT_NOT_FOUND') throw error;
          }
          state.matches.push(normalizeMatch(item, state.detail, stats, state.profile.playerId));
          state.detail = null;
          state.phase = state.matches.length >= state.selected.length ? 'done' : 'details';
        } else throw new FaceitError('INVALID_CHECKPOINT');
        state.retryCount = 0;
      }
    } catch (error) {
      if (error !== paused) {
        if (!(error instanceof FaceitError) || !error.retryAt) throw error;
        state.retryAt = error.retryAt;
        state.retryCount += 1;
      }
    }
    if (state.phase === 'done') state.completedAt ??= now();
    return {
      done: state.phase === 'done', state,
      report: state.phase === 'done' ? { ...buildReport(state, state.completedAt), stale: now() - state.completedAt > 300 } : null,
      progress: progress(state),
    };
  }
  return { start, advance };
}
