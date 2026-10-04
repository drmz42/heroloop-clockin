// Player-facing ORE Mine rules for the Android/Seeker edition. Display only:
// the server policy in selfhosted/seeker/mining_sessions.sql stays authoritative.
// Owner: docs/game/seeker-ore-mine.md. The Mine is not live yet.

export const MINE_STAKE_TIERS = ['0.01', '0.1', '1'] as const;
export type MineStakeTier = (typeof MINE_STAKE_TIERS)[number];

export const MINE_LIMITS = {
  roundsPerSession: 60,
  sessionSol: '10',
  dailySol: '25',
  roundSeconds: 96,
  feePercent: 0,
} as const;

export const MINE_LIMIT_ROWS: [string, string][] = [
  ['Stake per shaft', `${MINE_STAKE_TIERS.join(' / ')} SOL`],
  ['Rounds per session', `up to ${MINE_LIMITS.roundsPerSession}`],
  ['Session budget', `up to ${MINE_LIMITS.sessionSol} SOL`],
  ['Daily budget (UTC)', `up to ${MINE_LIMITS.dailySol} SOL`],
  ['HeroLoop Mine fee', 'none'],
];

export interface MineGuideSection {
  title: string;
  body: string;
}

export const MINE_GUIDE: MineGuideSection[] = [
  {
    title: 'How the Mine works',
    body: 'The Deep Vein runs on ORE, a third-party game on Solana. Pick one or more of the 25 shafts and a stake for each. Every round (about a minute and a half) one shaft strikes at random. If you hold the winning shaft, you share all SOL staked on the other 24 shafts with the other miners there, in proportion to your stake, minus the ORE protocol\'s 10% cut, and you may also receive ORE. Stakes on the other shafts are lost. Covering more shafts strikes more often but pays less; on average you get back less than you put in.',
  },
  {
    title: 'What it costs',
    body: `Stake ${MINE_STAKE_TIERS.slice(0, -1).join(', ')} or ${MINE_STAKE_TIERS[MINE_STAKE_TIERS.length - 1]} SOL on each chosen shaft every round, paid from your in-game SOL balance. Each round also uses a small Solana network cost. HeroLoop takes no fee from Mine rounds. You can stop at any time; unspent SOL returns to your balance when the session ends.`,
  },
  {
    title: 'Limits',
    body: `At most ${MINE_LIMITS.roundsPerSession} rounds and ${MINE_LIMITS.sessionSol} SOL per session, and ${MINE_LIMITS.dailySol} SOL per day (UTC). A round already sent cannot be cancelled; its result arrives when Solana confirms it.`,
  },
  {
    title: 'Winnings',
    body: 'SOL winnings are added to your in-game SOL balance after they are confirmed on-chain. ORE rewards appear when ORE support is enabled.',
  },
  {
    title: 'Risks — please read',
    body: 'This is a game of chance. On average players lose SOL, and you can lose your whole session budget. ORE prices change quickly. ORE is run by a third party; HeroLoop does not control its rules or randomness. Only use SOL you can afford to lose. This is not financial advice. You must be of legal age and mining must be allowed where you live.',
  },
  {
    title: 'Game rewards',
    body: 'Verified rounds complete ORE Mine quests: 5 / 20 / 50 rounds a day, streaks of 3 and 7 days with 5+ rounds, and Miner ranks at 50 / 250 / 1,000 / 5,000 rounds. They pay Gold and Summon Scrolls only, never SOL, SKR or ORE.',
  },
];

// The Mine tutorial opens once per device (a convenience; storage may be unavailable).
const SEEN_KEY = 'heroloop-seeker:v1:mine-tutorial-seen';
export function tutorialSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
}
export function markTutorialSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* per-device convenience only */ }
}
