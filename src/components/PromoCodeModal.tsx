import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CheckCircle2, Gift, KeyRound, X } from 'lucide-react';
import { playerSync } from '@/game/backend';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import { groupNumber } from '@/game/numberFormat';
import { ChestCollectIcon } from '@/components/ChestCollectIcon';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { ItemArtwork } from '@/components/ItemArtwork';
import './PromoCodeModal.css';

type PotionSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

export interface PromoRedemption {
  label: string;
  rewards: { gold: number; hero: number; summon_scrolls: number; boss_keys: number; chests?: number; potions?: Partial<Record<PotionSize, number>> };
  state: unknown;
  revision: number;
  token_balance: number;
}

const POTION_LABEL: Record<PotionSize, string> = { xs: 'XS', sm: 'S', md: 'M', lg: 'L', xl: 'XL', xxl: 'XXL' };

const ERROR_TEXT: Record<string, string> = {
  invalid_promo_code: 'This code is invalid or has expired.',
  promo_code_already_redeemed: 'You have already redeemed this code.',
  promo_code_exhausted: 'This code has reached its redemption limit.',
  chest_capacity_exceeded: 'Not enough space for the reward chests. Open some stored chests, then redeem this code again. Your code has not been used.',
  rate_limited: 'Too many attempts. Please wait and try again.',
};

interface RewardCard {
  id: string;
  amount: number;
  label: string;
  tone: string;
  artwork: ReactNode;
}

function GoldArtwork() {
  const id = useId();
  return (
    <svg viewBox="0 0 100 100" width="88" height="88" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-gold`} x2=".2" y2="1"><stop stopColor="#fff0ae" /><stop offset=".45" stopColor="#d9a143" /><stop offset="1" stopColor="#795016" /></linearGradient>
        <linearGradient id={`${id}-edge`} x2="0" y2="1"><stop stopColor="#c88b31" /><stop offset="1" stopColor="#55340e" /></linearGradient>
      </defs>
      {[[28, 65, 3], [69, 57, 4], [48, 78, 2]].map(([x, y, count]) => (
        <g key={x}>
          {Array.from({ length: count }, (_, index) => <g key={index} transform={`translate(${x} ${y - index * 7})`}>
            <path d="M-20 0v6c0 12 40 12 40 0V0" fill={`url(#${id}-edge)`} stroke="#8c5c21" />
            <ellipse rx="20" ry="8" fill={`url(#${id}-gold)`} stroke="#f4d28a" strokeWidth="1.2" />
            <ellipse rx="14" ry="5" fill="none" stroke="#875b21" strokeWidth="1" />
            <path d="m0-4 5 4-5 4-5-4Z" fill="#956624" />
          </g>)}
        </g>
      ))}
      <path d="m80 22 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" fill="#fff1b3" />
    </svg>
  );
}

export function PromoCodeModal({ onClose, onRedeemed }: { onClose: () => void; onRedeemed: (result: PromoRedemption) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PromoRedemption | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    const previousFocus = previousFocusRef.current;
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => { if (result) continueRef.current?.focus({ preventScroll: true }); }, [result]);

  const redeem = async () => {
    const normalized = code.trim();
    if (busy || normalized.length < 4) return;
    setBusy(true);
    setError('');
    const idempotencyKey = crypto.randomUUID();
    let errorCode = '';
    const redeemed = await playerSync<PromoRedemption>('promo_redeem', { code: normalized, idempotency_key: idempotencyKey }, (message) => { errorCode = message; });
    if (redeemed) {
      setResult(redeemed);
      onRedeemed(redeemed);
    } else {
      setError(ERROR_TEXT[errorCode] ?? 'Code redemption is temporarily unavailable. No reward was changed.');
    }
    setBusy(false);
  };

  const rewards: RewardCard[] = result ? [
    { id: 'gold', amount: result.rewards.gold, label: 'Gold', tone: 'gold', artwork: <GoldArtwork /> },
    { id: 'hero', amount: result.rewards.hero, label: '$HERO', tone: 'gold', artwork: <HeroTokenIcon size={80} /> },
    { id: 'scrolls', amount: result.rewards.summon_scrolls, label: 'Summon Scrolls', tone: 'violet', artwork: <SummonScrollArtwork size={88} /> },
    { id: 'keys', amount: result.rewards.boss_keys, label: 'Boss Keys', tone: 'crimson', artwork: <BossKeyIcon size={88} /> },
    { id: 'chests', amount: result.rewards.chests ?? 0, label: result.rewards.chests === 1 ? 'Chest' : 'Chests', tone: 'gold', artwork: <ChestCollectIcon size={88} /> },
    ...(Object.entries(result.rewards.potions ?? {}) as [PotionSize, number][]).map(([size, amount]) => ({
      id: `potion-${size}`, amount, label: `${POTION_LABEL[size] ?? size} Potions`, tone: 'teal',
      artwork: <span className="promo-gift__potion"><ItemArtwork itemId={`potion-${size}`} name={`${POTION_LABEL[size] ?? size} Potion`} fallback="Potion" /></span>,
    })),
  ].filter((reward) => reward.amount > 0) : [];

  return (
    <div className="promo-overlay fixed inset-0 z-[9999] grid place-items-center bg-black/80 p-3 backdrop-blur-[4px]" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="promo-title" className={result ? 'promo-vault' : 'px-panel-raised w-full max-w-md rounded-2xl border border-[#9a6a22] p-5 shadow-[0_24px_90px_rgba(0,0,0,.8)]'} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        {!result && <div className="flex items-start justify-between gap-3">
          <div><div className="section-kicker flex items-center gap-2"><Gift size={14} /> Reward code</div><h2 id="promo-title" className="mt-1 font-vt text-xl font-black text-[#f0dfbb]">Enter promo code</h2></div>
          <button type="button" onClick={onClose} className="game-control grid h-11 w-11 place-items-center" aria-label="Close"><X size={16} /></button>
        </div>}
        {result ? (
          <>
            <div className="promo-vault__glow" aria-hidden="true" />
            <header className="promo-vault__header">
              <p className="promo-vault__kicker"><span /> Code redeemed <span /></p>
              <h2 id="promo-title" className="promo-vault__title">Your rewards</h2>
              <p className="promo-vault__campaign">{result.label}</p>
            </header>
            <div className="promo-vault__body game-scrollbar" role="region" tabIndex={0} aria-label="Received rewards">
              <ul className={`promo-vault__gifts${rewards.length === 1 ? ' promo-vault__gifts--single' : ''}`}>
                {rewards.map((reward, index) => <li key={reward.id} className={`promo-gift promo-gift--${reward.tone}`} style={{ '--gift-delay': `${Math.min(index * 85, 600)}ms` } as CSSProperties}>
                  <div className="promo-gift__art" aria-hidden="true"><span className="promo-gift__halo" />{reward.artwork}<span className="promo-gift__pedestal" /></div>
                  <span className="promo-gift__amount">+{groupNumber(reward.amount)}</span>
                  <span className="promo-gift__name">{reward.label}</span>
                </li>)}
              </ul>
            </div>
            <footer className="promo-vault__footer">
              <p role="status"><CheckCircle2 size={15} /> Rewards added to your account</p>
              <button ref={continueRef} type="button" onClick={onClose} className="game-control game-primary promo-vault__continue">Continue adventure</button>
            </footer>
          </>
        ) : (
          <form className="mt-5" onSubmit={(event) => { event.preventDefault(); void redeem(); }}>
            <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-[#a79a82]" htmlFor="promo-code">Promo code</label>
            <div className="game-control mt-2 flex h-12 items-center gap-2 px-3">
              <KeyRound size={16} className="text-[#d2a959]" />
              <input id="promo-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="HEROLOOP2026" className="min-w-0 flex-1 bg-transparent font-mono text-sm uppercase tracking-widest text-[#f4e6c7] outline-none placeholder:text-[#625b50]" autoFocus />
            </div>
            {error && <p role="alert" className="mt-2 rounded border border-red-700/50 bg-red-950/35 px-3 py-2 text-xs text-red-200">{error}</p>}
            <button type="submit" disabled={busy || code.trim().length < 4} className="game-control game-primary mt-4 w-full px-4 py-2.5 text-xs font-black disabled:opacity-45">{busy ? 'Checking…' : 'Redeem code'}</button>
          </form>
        )}
      </section>
    </div>
  );
}
