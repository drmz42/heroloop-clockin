import { useState } from 'react';
import { CheckCircle2, Gift, KeyRound, X } from 'lucide-react';
import { playerSync } from '@/game/backend';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';

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
  rate_limited: 'Too many attempts. Please wait and try again.',
};

export function PromoCodeModal({ onClose, onRedeemed }: { onClose: () => void; onRedeemed: (result: PromoRedemption) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PromoRedemption | null>(null);

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

  const rewards = result ? [
    result.rewards.gold > 0 && { label: `${result.rewards.gold.toLocaleString()} Gold` },
    result.rewards.hero > 0 && { label: `${result.rewards.hero.toLocaleString()} $HERO` },
    result.rewards.summon_scrolls > 0 && { label: `${result.rewards.summon_scrolls.toLocaleString()} Summon Scrolls`, icon: <SummonScrollArtwork size={20} /> },
    result.rewards.boss_keys > 0 && { label: `${result.rewards.boss_keys.toLocaleString()} Boss Keys`, icon: <BossKeyIcon size={20} /> },
    (result.rewards.chests ?? 0) > 0 && { label: `${(result.rewards.chests ?? 0).toLocaleString()} ${result.rewards.chests === 1 ? 'Chest' : 'Chests'}` },
    ...(Object.entries(result.rewards.potions ?? {}) as [PotionSize, number][]).map(([size, amount]) => amount > 0 && { label: `${amount.toLocaleString()} ${POTION_LABEL[size] ?? size} Potions` }),
  ].filter((reward): reward is { label: string; icon?: JSX.Element } => Boolean(reward)) : [];

  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[4px]" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="promo-title" className="px-panel-raised w-full max-w-md rounded-2xl border border-[#9a6a22] p-5 shadow-[0_24px_90px_rgba(0,0,0,.8)]">
        <div className="flex items-start justify-between gap-3">
          <div><div className="section-kicker flex items-center gap-2"><Gift size={14} /> Reward code</div><h2 id="promo-title" className="mt-1 font-vt text-xl font-black text-[#f0dfbb]">Enter promo code</h2></div>
          <button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center" aria-label="Close"><X size={16} /></button>
        </div>
        {result ? (
          <div className="mt-5 rounded-xl border border-emerald-500/45 bg-emerald-950/30 p-4 text-center">
            <CheckCircle2 size={28} className="mx-auto text-emerald-300" />
            <strong className="mt-2 block text-sm text-emerald-200">{result.label}</strong>
            <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs leading-5 text-[#c9c2b6]">{rewards.map((reward) => <span key={reward.label} className="inline-flex items-center gap-1">{reward.icon}{reward.label}</span>)}</div>
            <button type="button" onClick={onClose} className="game-control game-primary mt-4 w-full px-4 py-2 text-xs font-black">Done</button>
          </div>
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
