import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BookOpen, ChevronDown, Gem, HelpCircle, Loader2, Pickaxe, Square, X } from 'lucide-react';
import { markTutorialSeen, MINE_GUIDE, MINE_LIMIT_ROWS, MINE_LIMITS, MINE_STAKE_TIERS, tutorialSeen, type MineStakeTier } from '@/game/seekerMine';
import {
  acceptMineTerms, formatAmountShort, loadMineBoard, loadMineStatus, refreshWallet, SeekerWalletError, startMine, stopMine,
  type MineBoard, type MineStatus,
} from '@/game/seekerWallet';
import { MineQuests, MineTutorial } from '@/components/SeekerMineExtras';
import '@/theme/scene/scene.css';
import '@/theme/scene/mine.css';

const ROUND_CHOICES = [1, 5, 15, 30, 60] as const;
const SQUARES = Array.from({ length: 25 }, (_, i) => i);
const ERRORS: Record<string, string> = {
  mining_unavailable: 'The Mine is not open yet.',
  mining_capacity_reached: 'The Mine is full right now. Try a smaller session or later.',
  mining_terms_required: 'Accept the Guide & Terms first.',
  mining_session_pending: 'You already have a session running.',
  mining_budget_exceeded: 'This session is above your session or daily limit.',
  mining_budget_below_round_cost: 'Choose at least one full round.',
  invalid_mining_request: 'Pick at least one shaft.',
  skr_insufficient_balance_or_overflow: 'Not enough SOL in your game balance. Deposit SOL first.',
};
const sol = (minor: string | null | undefined) => `${formatAmountShort(minor ?? '0', 'SOL', 'down')} SOL`;
const shortSol = (minor: string | undefined) => {
  const value = Number(minor ?? 0) / 1e9;
  return value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toFixed(2);
};
const maskSquares = (mask: string | null | undefined) =>
  mask == null ? SQUARES : SQUARES.filter(i => Number(mask) & (1 << i));
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

// ORE Mine: the Deep Vein scene. The player picks shafts on the live 5x5 board; rounds run
// on the server from the player's in-game SOL.
export function SeekerMinePanel({ onClose, claimQuest, still = false }: {
  onClose?: () => void; claimQuest?: (id: string) => Promise<boolean>; still?: boolean;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [tutorial, setTutorial] = useState(() => !tutorialSeen());
  const [stake, setStake] = useState<MineStakeTier>(MINE_STAKE_TIERS[0]);
  const [rounds, setRounds] = useState<number>(ROUND_CHOICES[0]);
  const [picked, setPicked] = useState<number[]>([]);
  const [status, setStatus] = useState<MineStatus | null>(null);
  const [board, setBoard] = useState<MineBoard | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setStatus(await loadMineStatus()); } catch { setStatus(null); }
  }, []);
  const refreshBoard = useCallback(async () => {
    try {
      const next = await loadMineBoard();
      setBoard(next);
      setSecondsLeft(next.ends_in_seconds);
    } catch { /* the board is informative; keep the last one */ }
  }, []);
  useEffect(() => { void refresh(); void refreshBoard(); }, [refresh, refreshBoard]);
  useEffect(() => {
    const timer = setInterval(() => { void refreshBoard(); }, 4_000);
    const tick = setInterval(() => setSecondsLeft(s => (s == null ? s : Math.max(0, s - 1))), 1_000);
    return () => { clearInterval(timer); clearInterval(tick); };
  }, [refreshBoard]);
  const live = status?.session && status.session.status !== 'closed' ? status.session : null;
  const liveId = live?.id;
  useEffect(() => {
    if (!liveId) return;
    const timer = setInterval(() => { void refresh(); }, 6_000);
    return () => clearInterval(timer);
  }, [liveId, refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      void refreshWallet();
    } catch (reason) {
      const code = reason instanceof SeekerWalletError ? reason.code : '';
      setError(ERRORS[code] ?? 'The Mine could not complete this request. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled === true;
  const accepted = enabled && status?.accepted_terms_version === status?.terms_version;
  const strike = board?.previous?.winning_square ?? null;
  const shown = useMemo(() => new Set(live ? maskSquares(live.square_mask) : picked), [live, picked]);
  const perRound = Number(stake) * picked.length;
  const tooBig = (count: number) => perRound * count > Number(MINE_LIMITS.sessionSol);
  const toggle = (square: number) => setPicked(list => list.includes(square) ? list.filter(s => s !== square) : [...list, square]);
  const random = () => setPicked([...SQUARES].sort(() => Math.random() - .5).slice(0, 3));
  // 1 pick shafts → 2 set stake → 3 strike (running session).
  const stepNow = [!live && !picked.length, !live && picked.length > 0, !!live];
  const stepDone = [!!live || picked.length > 0, !!live, false];
  const closeTutorial = () => { markTutorialSeen(); setTutorial(false); };

  return (
    <div className="mn-window">
      {onClose && <button type="button" className="sc-socket mn-close" onClick={onClose} aria-label="Close"><X size={16} /></button>}
      <div className={`sc-root mn-root${still ? ' sc-still' : ''}`}>
        <section className="sc-stage mn-stage" aria-label="The Deep Vein">
          <div className="sc-stage-art" aria-hidden="true" />
          <div className="sc-glow" aria-hidden="true" />
          {!still && <div className="sc-embers" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>}
          <header className="sc-head">
            <span className="sc-kicker">ORE Mine</span>
            <h2 className="sc-title">The Deep Vein</h2>
            <p className="sc-lede">Twenty-five shafts. One strikes every round. Pick yours and stake SOL.</p>
          </header>
          <div className="mn-plaques">
            <span className="mn-plaque"><strong>{board ? `#${board.round_id}` : '—'}</strong><small>Round</small></span>
            <span className="mn-glass" role="timer" aria-label="Seconds left in this round"><span>{secondsLeft ?? '—'}<small>SEC</small></span></span>
            <span className="mn-plaque"><strong>{strike == null ? '—' : `Shaft ${strike + 1}`}</strong><small>Last strike</small></span>
          </div>
        </section>

        <div className="sc-body">
          <section className="sc-panel" aria-label="Steps">
            <ol className="mn-steps">
              {['Pick shafts', 'Set stake', 'Strike'].map((label, i) => (
                <li key={label} className={`mn-step${stepNow[i] ? ' is-now' : ''}${stepDone[i] ? ' is-done' : ''}`}><b>{i + 1}</b>{label}</li>
              ))}
            </ol>
          </section>

          <section className="sc-panel" aria-label="Mine shafts">
            <div className="sc-section-head"><span>The vein</span><button type="button" className="sc-chip" onClick={() => setTutorial(true)}><HelpCircle size={13} /> How to play</button></div>
            {!live && !picked.length && <p className="mn-hint">Tap the shafts where you want to stake</p>}
            <div className="mn-grid" role="group" aria-label="Mine shafts">
              {SQUARES.map(square => (
                <button key={square} type="button" disabled={!!live}
                  className={`mn-tile${shown.has(square) ? ' is-picked' : ''}${strike === square ? ' is-strike' : ''}`}
                  aria-pressed={shown.has(square)} aria-label={`Shaft ${square + 1}, ${shortSol(board?.deployed_minor[square])} SOL staked by ${board?.miners[square] ?? 0} miners`}
                  onClick={() => toggle(square)}>
                  <span className="mn-tile-n">{square + 1}</span>
                  <Gem aria-hidden="true" />
                  <span className="mn-tile-pot">{board ? `◎${shortSol(board.deployed_minor[square])}` : ''}</span>
                </button>
              ))}
            </div>
            <p className="mn-legend">◎ SOL all miners staked on a shaft this round<i className="is-picked" />yours<i className="is-strike" />last strike</p>
          </section>

          {live ? (
            <section className="sc-panel" aria-label="Your session">
              <div className="sc-section-head"><span>{live.status === 'active' ? 'Your crew is digging' : 'Hauling up the last cart'}</span><span className="tabular-nums">{live.completed} / {live.round_limit}</span></div>
              <div className="mn-progress" role="progressbar" aria-label="Rounds played" aria-valuemin={0} aria-valuemax={live.round_limit} aria-valuenow={live.completed}>
                <i style={{ width: `${Math.min(100, (live.completed / Math.max(1, live.round_limit)) * 100)}%` }} />
              </div>
              <dl className="mn-dl">
                <dt>Stake per round</dt><dd>{sol(live.stake_minor)}</dd>
                <dt>Spent</dt><dd>{sol(live.spent_minor)}</dd>
                <dt>Won back</dt><dd style={{ color: '#9fe3b8' }}>{sol(live.credited_minor)}</dd>
              </dl>
              {live.status === 'active' && (
                <button type="button" className="sc-plate mn-strike-btn" disabled={busy} onClick={() => void act(() => stopMine(live.id))}>
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Square size={14} />} Stop after this round
                </button>
              )}
              <p className="sc-muted" style={{ marginTop: 8 }}>Winnings are claimed when the session ends; unspent SOL then returns to your balance.</p>
            </section>
          ) : (
            <section className="sc-panel" aria-label="Your stake">
              <div className="sc-section-head"><span>Your stake</span>{status?.available_minor != null && <span className="sc-muted">Balance {sol(status.available_minor)}</span>}</div>
              <div className="mn-row">
                <span className="mn-label">Shafts · {picked.length} chosen</span>
                <button type="button" className="sc-chip" onClick={random}>Random 3</button>
                <button type="button" className="sc-chip" onClick={() => setPicked(SQUARES)}>All 25</button>
                <button type="button" className="sc-chip" onClick={() => setPicked([])}>Clear</button>
              </div>
              <div className="mn-row">
                <span className="mn-label">Stake per shaft</span>
                {MINE_STAKE_TIERS.map(tier => (
                  <button key={tier} type="button" className="sc-chip" aria-pressed={stake === tier} onClick={() => setStake(tier)}>{tier} SOL</button>
                ))}
              </div>
              <div className="mn-row">
                <span className="mn-label">Rounds</span>
                {ROUND_CHOICES.map(count => (
                  <button key={count} type="button" className="sc-chip" aria-pressed={rounds === count} disabled={picked.length > 0 && tooBig(count)} onClick={() => setRounds(count)}>{count}</button>
                ))}
              </div>
              <p className="mn-sum">
                {picked.length
                  ? <><b>{picked.length}</b> {picked.length === 1 ? 'shaft' : 'shafts'} × <b>{stake} SOL</b> = <b>{fmt(perRound)} SOL</b> a round{rounds > 1 ? <>, up to <b>{fmt(perRound * rounds)} SOL</b></> : null}</>
                  : 'Choose shafts on the vein above.'}
              </p>
              {error && <p role="alert" className="mn-warn" style={{ marginBottom: 10 }}>{error}</p>}
              {!enabled ? (
                <button type="button" className="sc-seal mn-strike-btn" disabled><Pickaxe size={16} aria-hidden="true" /> The shafts open soon</button>
              ) : !accepted ? (
                <div className="grid gap-2">
                  <label className="flex min-h-11 items-start gap-2 text-xs leading-5" style={{ color: 'var(--sc-ivory)' }}>
                    <input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[#e0a83c]" />
                    I have read the Guide &amp; Terms, understand that I can lose the SOL I stake, and I am allowed to take part where I live.
                  </label>
                  <button type="button" className="sc-seal mn-strike-btn" disabled={!agreed || busy} onClick={() => void act(() => acceptMineTerms(status!.terms_version))}>
                    {busy && <Loader2 size={15} className="animate-spin" />} Accept terms
                  </button>
                </div>
              ) : (
                <button type="button" className="sc-seal mn-strike-btn" disabled={busy || !picked.length || tooBig(rounds)} onClick={() => void act(() => startMine(stake, rounds, picked))}>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Pickaxe size={16} />} Strike the vein
                </button>
              )}
            </section>
          )}

          <MineQuests claim={claimQuest} />

          <p className="mn-warn">A game of chance: you can lose the SOL you stake. Only use SOL you can afford to lose.</p>

          <section className="sc-panel">
            <button type="button" aria-expanded={guideOpen} aria-controls="seeker-mine-guide" onClick={() => setGuideOpen(open => !open)}
              className="sc-plate flex w-full items-center justify-between gap-2">
              <span className="flex items-center gap-2"><BookOpen size={14} aria-hidden="true" /> Guide &amp; Terms</span>
              <ChevronDown size={14} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${guideOpen ? 'rotate-180' : ''}`} />
            </button>
            {guideOpen && (
              <div id="seeker-mine-guide" className="mt-3 space-y-2.5 text-xs leading-5">
                {MINE_GUIDE.map(section => (
                  <section key={section.title}>
                    <h4 className="font-black" style={{ color: section.title.startsWith('Risks') ? '#f3b5a5' : 'var(--sc-gold)' }}>{section.title}</h4>
                    <p style={{ color: 'var(--sc-ivory)' }}>{section.body}</p>
                  </section>
                ))}
                <dl className="mn-dl">
                  {MINE_LIMIT_ROWS.map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd>{value}</dd></div>)}
                  {status && <div className="contents"><dt>Used today</dt><dd>{sol(status.used_today_minor)}</dd></div>}
                </dl>
                {status?.float_address && <p className="sc-muted break-all">Mine wallet (public): {status.float_address}</p>}
              </div>
            )}
          </section>
        </div>
      </div>
      {tutorial && <MineTutorial onClose={closeTutorial} />}
    </div>
  );
}
