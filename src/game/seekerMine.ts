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
  ['Stake per round', `${MINE_STAKE_TIERS.join(' / ')} SOL`],
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
    body: 'The Mine plays rounds of ORE, a third-party game on Solana. Each round lasts about a minute and a half. Your stake is spread evenly across all 25 blocks of a 5×5 grid, and one block wins at random. You get back your share of the SOL on the winning block, minus the ORE protocol\'s 10% cut, and may also receive ORE. Because every block is covered, most rounds return part of the stake, but on average you get back less than you put in.',
  },
  {
    title: 'What it costs',
    body: `Choose ${MINE_STAKE_TIERS.slice(0, -1).join(', ')} or ${MINE_STAKE_TIERS[MINE_STAKE_TIERS.length - 1]} SOL per round, paid from your in-game SOL balance. Each round also uses a small Solana network cost. HeroLoop takes no fee from Mine rounds. You can stop at any time; unspent SOL returns to your balance when the session ends.`,
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
    body: 'Playing rounds will also complete Mine quests, streaks and ranks that give in-game items. These never pay SOL, SKR or ORE.',
  },
];
