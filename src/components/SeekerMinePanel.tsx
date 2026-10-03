import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, ChevronDown, Loader2, Lock, Pickaxe, Play, Square } from 'lucide-react';
import { MINE_GUIDE, MINE_LIMIT_ROWS, MINE_LIMITS, MINE_STAKE_TIERS, type MineStakeTier } from '@/game/seekerMine';
import {
  acceptMineTerms, formatAmountShort, loadMineStatus, refreshWallet, SeekerWalletError, startMine, stopMine, type MineStatus,
} from '@/game/seekerWallet';

const ROUND_CHOICES = [5, 15, 30, 60] as const;
const ERRORS: Record<string, string> = {
  mining_unavailable: 'The Mine is not open yet.',
  mining_capacity_reached: 'The Mine is full right now. Try a smaller session or later.',
  mining_terms_required: 'Accept the Guide & Terms first.',
  mining_session_pending: 'You already have a session running.',
  mining_budget_exceeded: 'This session is above your session or daily limit.',
  mining_budget_below_round_cost: 'Choose at least one full round.',
  skr_insufficient_balance_or_overflow: 'Not enough SOL in your game balance. Deposit SOL first.',
};
const sol = (minor: string | null | undefined) => `${formatAmountShort(minor ?? '0', 'SOL', 'down')} SOL`;

// ORE Mine: rounds run on the server from the player's in-game SOL.
export function SeekerMinePanel() {
  const [guideOpen, setGuideOpen] = useState(false);
  const [stake, setStake] = useState<MineStakeTier>(MINE_STAKE_TIERS[0]);
  const [rounds, setRounds] = useState<number>(ROUND_CHOICES[0]);
  const [status, setStatus] = useState<MineStatus | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadMineStatus());
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
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
  const last = status?.session;

  return (
    <>
      <div className="stat-tile flex items-start gap-2.5 p-3">
        <Pickaxe size={18} className="mt-0.5 shrink-0 text-[#e0a83c]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-black text-[#f6d283]">ORE Mine</h3>
            <span className="rounded-full border border-[#5d4a2f] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#aaa397]">
              {enabled ? 'Beta' : 'Coming soon'}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#d9d1c0]">Play short ORE rounds on Solana with your in-game SOL. Read the guide before you start.</p>
          {status?.available_minor != null && <p className="mt-1 text-xs text-[#aaa397]">Game balance: <b className="text-[#d9d1c0]">{sol(status.available_minor)}</b></p>}
        </div>
      </div>

      <button type="button" aria-expanded={guideOpen} aria-controls="seeker-mine-guide" onClick={() => setGuideOpen(open => !open)}
        className="game-control flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-sm font-bold text-[#f6d283]">
        <span className="flex items-center gap-2"><BookOpen size={15} aria-hidden="true" /> Guide &amp; Terms</span>
        <ChevronDown size={15} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${guideOpen ? 'rotate-180' : ''}`} />
      </button>
      {guideOpen && (
        <div id="seeker-mine-guide" className="stat-tile space-y-2.5 p-3 text-xs leading-5">
          {MINE_GUIDE.map(section => (
            <section key={section.title}>
              <h4 className={`font-black ${section.title.startsWith('Risks') ? 'text-rose-200' : 'text-[#f6d283]'}`}>{section.title}</h4>
              <p className="text-[#d9d1c0]">{section.body}</p>
            </section>
          ))}
        </div>
      )}

      {live ? (
        <div className="stat-tile space-y-2 p-3 text-xs">
          <div className="flex items-center justify-between font-bold text-[#f6d283]">
            <span>{live.status === 'active' ? 'Mining…' : 'Finishing session…'}</span>
            <span className="tabular-nums">{live.completed} / {live.round_limit} rounds</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/40" role="progressbar" aria-label="Rounds played"
            aria-valuemin={0} aria-valuemax={live.round_limit} aria-valuenow={live.completed}>
            <div className="h-full bg-[#e0a83c]" style={{ width: `${Math.min(100, (live.completed / Math.max(1, live.round_limit)) * 100)}%` }} />
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt className="text-[#aaa397]">Stake per round</dt><dd className="text-right font-bold tabular-nums">{sol(live.stake_minor)}</dd>
            <dt className="text-[#aaa397]">Spent</dt><dd className="text-right font-bold tabular-nums">{sol(live.spent_minor)}</dd>
            <dt className="text-[#aaa397]">Won back</dt><dd className="text-right font-bold tabular-nums text-emerald-200">{sol(live.credited_minor)}</dd>
          </dl>
          {live.status === 'active' && (
            <button type="button" disabled={busy} onClick={() => void act(() => stopMine(live.id))}
              className="game-control flex min-h-11 w-full items-center justify-center gap-2 px-3 font-black text-[#f6d283] disabled:opacity-45">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Square size={14} />} Stop after this round
            </button>
          )}
          <p className="text-[#aaa397]">Winnings are claimed when the session ends; unspent SOL then returns to your balance.</p>
        </div>
      ) : (
        <>
          <fieldset className="stat-tile p-3">
            <legend className="float-left mb-2 w-full text-xs font-bold text-[#aaa397]">Stake per round</legend>
            <div className="clear-both grid grid-cols-3 gap-2">
              {MINE_STAKE_TIERS.map(tier => (
                <button key={tier} type="button" aria-pressed={stake === tier}
                  onClick={() => { setStake(tier); if (Number(tier) * rounds > Number(MINE_LIMITS.sessionSol)) setRounds(ROUND_CHOICES[0]); }}
                  className={`game-control min-h-11 px-2 text-sm font-black tabular-nums ${stake === tier ? 'text-[#f6d283] ring-1 ring-[#e0a83c]' : 'text-[#8f887b]'}`}>
                  {tier} SOL
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="stat-tile p-3">
            <legend className="float-left mb-2 w-full text-xs font-bold text-[#aaa397]">Rounds in this session</legend>
            <div className="clear-both grid grid-cols-4 gap-2">
              {ROUND_CHOICES.map(count => (
                <button key={count} type="button" aria-pressed={rounds === count} onClick={() => setRounds(count)}
                  disabled={Number(stake) * count > Number(MINE_LIMITS.sessionSol)}
                  className={`game-control min-h-11 px-2 text-sm font-black tabular-nums disabled:opacity-35 ${rounds === count ? 'text-[#f6d283] ring-1 ring-[#e0a83c]' : 'text-[#8f887b]'}`}>
                  {count}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-[#aaa397]">Up to <b className="text-[#d9d1c0]">{(Number(stake) * rounds).toLocaleString('en-US', { maximumFractionDigits: 2 })} SOL</b> in stakes, plus small network costs.</p>
          </fieldset>
        </>
      )}

      <dl className="stat-tile grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 p-3 text-xs">
        {MINE_LIMIT_ROWS.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[#aaa397]">{label}</dt>
            <dd className="text-right font-bold tabular-nums text-[#d9d1c0]">{value}</dd>
          </div>
        ))}
        {status && <div className="contents"><dt className="text-[#aaa397]">Used today</dt><dd className="text-right font-bold tabular-nums text-[#d9d1c0]">{sol(status.used_today_minor)}</dd></div>}
      </dl>

      <div className="flex gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>A game of chance: you can lose the SOL you stake. Only use SOL you can afford to lose.</span>
      </div>

      {error && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-xs text-rose-100">{error}</p>}

      {!enabled ? (
        <button type="button" disabled className="game-control flex min-h-12 w-full items-center justify-center gap-2 px-4 py-3 font-black text-[#f6d283] disabled:opacity-45">
          <Lock size={16} aria-hidden="true" /> Mining opens soon
        </button>
      ) : !accepted ? (
        <div className="stat-tile space-y-2 p-3">
          <label className="flex min-h-11 items-start gap-2 text-xs leading-5 text-[#d9d1c0]">
            <input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[#e0a83c]" />
            I have read the Guide &amp; Terms, understand that I can lose the SOL I stake, and I am allowed to take part where I live.
          </label>
          <button type="button" disabled={!agreed || busy} onClick={() => void act(() => acceptMineTerms(status!.terms_version))}
            className="game-control flex min-h-11 w-full items-center justify-center gap-2 px-3 font-black text-[#f6d283] disabled:opacity-45">
            {busy && <Loader2 size={15} className="animate-spin" />} Accept terms
          </button>
        </div>
      ) : !live && (
        <button type="button" disabled={busy} onClick={() => void act(() => startMine(stake, rounds))}
          className="game-control flex min-h-12 w-full items-center justify-center gap-2 px-4 py-3 font-black text-[#f6d283] disabled:opacity-45">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} Start {rounds} rounds × {stake} SOL
        </button>
      )}

      {status?.float_address && (
        <p className="break-all text-[11px] text-[#8f887b]">Mine wallet (public): {status.float_address}</p>
      )}
      {last && last.status === 'closed' && (
        <p className="text-xs text-[#aaa397]">Last session: {last.completed} rounds, spent {sol(last.spent_minor)}, won back {sol(last.credited_minor)}.</p>
      )}
    </>
  );
}
