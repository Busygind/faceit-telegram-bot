import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMatchCard, renderPlayerCard } from '../tgcloud/lib/card.js';

const coverage = { matches: 30, maps: 30 };
export const DEMO_REPORT = {
  kind: 'stats', nickname: 'PlayerOne', playerId: 'synthetic-demo', elo: 1710, level: 8,
  requested: 30, count: 30, wins: 18, losses: 12, unknownResults: 0,
  winRate: 60, recent: ['W', 'L', 'W', 'W', 'L'],
  range: { from: 1789423200, to: 1791838800 }, partial: false,
  updatedAt: 1792094400, demo: true,
  metrics: {
    kd: { value: 1.24, ...coverage }, kr: { value: 0.78, ...coverage },
    avgKills: { value: 20.3, ...coverage }, hs: { value: 51, ...coverage },
    adr: { value: 84.6, ...coverage }, kills: { value: 609, ...coverage },
    deaths: { value: 491, ...coverage },
  },
  maps: [
    { name: 'Mirage', matches: 10, wins: 7, losses: 3, winRate: 70 },
    { name: 'Inferno', matches: 8, wins: 5, losses: 3, winRate: 62.5 },
    { name: 'Nuke', matches: 6, wins: 4, losses: 2, winRate: 66.7 },
    { name: 'Ancient', matches: 6, wins: 2, losses: 4, winRate: 33.3 },
  ],
  matches: [],
};

const ownPlayers = [
  { playerId: 'synthetic-demo', nickname: 'PlayerOne', kills: 20, deaths: 11, assists: 5, kd: 1.82, kr: 0.95, adr: 100, hs: 45 },
  { playerId: 'demo-own-2', nickname: 'FlashPoint', kills: 23, deaths: 12, assists: 3, kd: 1.92, kr: 1.10, adr: 107.2, hs: 52 },
  { playerId: 'demo-own-3', nickname: 'silent.exe', kills: 18, deaths: 12, assists: 6, kd: 1.50, kr: 0.86, adr: 89.5, hs: 50 },
  { playerId: 'demo-own-4', nickname: 'neonwave', kills: 14, deaths: 14, assists: 7, kd: 1, kr: 0.67, adr: 68.4, hs: 43 },
  { playerId: 'demo-own-5', nickname: 'last_ticket', kills: 10, deaths: 14, assists: 8, kd: 0.71, kr: 0.48, adr: 54.9, hs: 40 },
];
const opponentPlayers = [
  { playerId: 'demo-away-1', nickname: 'Northstar', adr: 89.6, kills: 19, deaths: 16, assists: 3, kd: 1.19 },
  { playerId: 'demo-away-2', nickname: 'coldpixel', adr: 75.4, kills: 15, deaths: 17, assists: 4, kd: 0.88 },
  { playerId: 'demo-away-3', nickname: 'NO_SCOPE', adr: 61.8, kills: 12, deaths: 18, assists: 2, kd: 0.67 },
  { playerId: 'demo-away-4', nickname: 'velvet', adr: 55.2, kills: 10, deaths: 17, assists: 5, kd: 0.59 },
  { playerId: 'demo-away-5', nickname: 'midnight', adr: 43.1, kills: 7, deaths: 17, assists: 4, kd: 0.41 },
];

export const DEMO_LAST_REPORT = {
  kind: 'last', nickname: 'PlayerOne', playerId: 'synthetic-demo', elo: 1710, level: 8,
  requested: 1, count: 1, wins: 1, losses: 0, winRate: 100, recent: ['W'],
  updatedAt: 1792187400, demo: true, partial: false,
  match: {
    matchId: 'synthetic-demo-match', finishedAt: 1792186200,
    result: 'W', ownTeamId: 'faction2', score: { own: 1, opponent: 0 },
    teams: [
      { id: 'faction1', name: 'team_Northstar', score: 0, players: opponentPlayers },
      { id: 'faction2', name: 'team_PlayerOne', score: 1, players: ownPlayers },
    ],
    maps: [{ matchId: 'synthetic-demo-match', name: 'de_mirage', ownScore: 13, opponentScore: 8, rounds: 21 }],
    player: { kills: 20, deaths: 11, assists: 5, kd: 1.82, kr: 0.95, adr: 100, hs: 45 },
    url: 'https://www.faceit.com/en/cs2/room/synthetic-demo-match',
    statsAvailable: true, partial: false, expectedMaps: 1,
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = [
    [process.argv[2] || fileURLToPath(new URL('../docs/demo-player-card.png', import.meta.url)), renderPlayerCard, DEMO_REPORT],
    [process.argv[3] || fileURLToPath(new URL('../docs/demo-last-match-card.png', import.meta.url)), renderMatchCard, DEMO_LAST_REPORT],
  ];
  for (const [output, render, report] of files) {
    const start = performance.now();
    const bytes = render(report);
    await writeFile(output, bytes);
    console.log(`Saved demo: ${output} (${bytes.length.toLocaleString('en-US')} bytes, ${Math.round(performance.now() - start)} ms)`);
  }
}
