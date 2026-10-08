import { useCallback, useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { playerSync } from '@/game/backend';
import { ItemArtwork } from '@/components/ItemArtwork';

type Stock = { weak: number; strong: number; minor: number };
export type PremiumPotionChoice = { tier: 'weak' | 'strong'; hero_uid: string; delay_ms: number };
export type PremiumPotionEvent = { elapsed_ms: number; hero_uid: string; amount: number; hp_after: number };

function parseStock(value: unknown): Stock | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const stock = { weak: Number(source.weak), strong: Number(source.strong), minor: Number(source.minor) };
  return Object.values(stock).every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000) ? stock : null;
}

function usePremiumStock(onAvailability?: (available: boolean) => void) {
  const [stock, setStock] = useState<Stock | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setError('');
    const result = await playerSync<Record<string, unknown>>('premium_potion_status', {}, setError);
    const next = parseStock(result);
    if (next) { setStock(next); onAvailability?.(next.weak > 0 || next.strong > 0); }
    else setError((message) => message || 'Potion stock is unavailable. Retry before using a potion.');
  }, [onAvailability]);
  useEffect(() => { let active = true;
    void playerSync<Record<string, unknown>>('premium_potion_status', {}, (message) => { if (active) setError(message); }).then((result) => {
      if (!active) return;
      const next = parseStock(result);
      if (next) { setStock(next); onAvailability?.(next.weak > 0 || next.strong > 0); }
      else setError((message) => message || 'Potion stock is unavailable. Retry before using a potion.');
    });
    return () => { active = false; };
  }, [onAvailability]);
  return { stock, setStock, error, setError, reload };
}

export function PremiumPotionWorkshop({ onHydrate }: { onHydrate: (state: unknown, revision?: number) => void }) {
  const { stock, setStock, error, setError, reload } = usePremiumStock();
  const [busy, setBusy] = useState(false);
  const upgrade = async (recipe: 'brew' | 'merge') => {
    if (busy) return;
    setBusy(true); setError('');
    const result = await playerSync<Record<string, unknown>>('premium_potion_upgrade', { recipe, idempotency_key: crypto.randomUUID() }, setError);
    if (result) {
      const next = parseStock(result.stock);
      if (next) setStock(next);
      if (result.state) onHydrate(result.state, Number(result.revision));
    }
    setBusy(false);
  };
  return <section className="material-panel mt-2 min-w-0 rounded-lg p-2" aria-label="Premium potions">
    <h3 className="flex items-center gap-2 ui-text-medium font-bold text-violet-200"><FlaskConical size={16} />Premium Potions</h3>
    <div className="mt-2 grid grid-cols-2 gap-2">{(['weak', 'strong'] as const).map((tier) => <div key={tier} className="min-w-0 rounded border border-violet-500/35 bg-violet-950/20 p-2">
      <div className="flex items-center gap-2"><div className="h-8 w-8 shrink-0"><ItemArtwork itemId={tier === 'weak' ? 'potion-md' : 'potion-xl'} name={`${tier} premium potion`} fallback="Potion" /></div><strong className="ui-text-small capitalize">{tier} · {stock?.[tier] ?? '…'}</strong></div>
      <p className="mt-1 ui-text-small text-[#c4bba7]">{tier === 'weak' ? '200 HP over 20s' : '500 HP over 30s'}</p>
    </div>)}</div>
    <p className="mt-2 ui-text-small text-[#c4bba7]">Stock only. Tonics reserved for the current normal wave cannot be brewed. Choose a living hero before a Boss fight. Heals every 5s; excess healing is lost.</p>
    <details className="mt-2"><summary className="cursor-pointer min-h-11 py-3 ui-text-medium font-bold text-violet-200">Upgrade Potions</summary>
      <p className="ui-text-small text-[#c4bba7]">Brew: 2 Minor Tonics → 1 Weak Premium. Merge: 2 Weak Premium → 1 Strong Premium. No Gold charge.</p>
      <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" disabled={busy || !stock || stock.minor < 2} onClick={() => void upgrade('brew')} className="game-control min-h-11 px-2 ui-text-small font-bold disabled:opacity-50">Brew Weak · 2 Minor</button><button type="button" disabled={busy || !stock || stock.weak < 2} onClick={() => void upgrade('merge')} className="game-control min-h-11 px-2 ui-text-small font-bold disabled:opacity-50">Merge Strong · 2 Weak</button></div>
    </details>
    <button type="button" disabled={busy} onClick={() => void reload()} className="game-control mt-2 min-h-11 px-2 ui-text-small">Refresh stock</button>
    {error && <div role="alert" className="mt-2 ui-text-small text-rose-300">{error.split('_').join(' ')} <button type="button" disabled={busy} onClick={() => void reload()} className="game-control min-h-11 px-2">Retry</button></div>}
  </section>;
}

export function PremiumPotionBattleControls({ heroes, busy, onUse, onAvailability }: {
  heroes: { uid?: string; alive: boolean; current_hp: number; max_hp: number; position?: number }[];
  busy: boolean;
  onUse: (choice: PremiumPotionChoice) => void;
  onAvailability: (available: boolean) => void;
}) {
  const { stock, error, reload } = usePremiumStock(onAvailability);
  const living = heroes.filter((hero) => hero.uid && hero.alive && hero.current_hp > 0);
  const [heroUid, setHeroUid] = useState('');
  const [tier, setTier] = useState<'weak' | 'strong'>('weak');
  const [delay, setDelay] = useState(0);
  const target = living.find((hero) => hero.uid === heroUid)?.uid ?? living[0]?.uid ?? '';
  const selectedTier = stock && stock[tier] === 0 && stock[tier === 'weak' ? 'strong' : 'weak'] > 0 ? (tier === 'weak' ? 'strong' : 'weak') : tier;
  if (stock && stock.weak === 0 && stock.strong === 0) return null;
  return <fieldset disabled={busy} className="min-w-0 rounded-lg border border-violet-500/40 bg-violet-950/20 p-2">
    <legend className="px-1 ui-text-small font-bold text-violet-200">Premium Potion · optional</legend>
    <div className="grid min-w-0 gap-2">
      <label className="ui-text-small">Hero<select aria-label="Premium potion hero" value={target} onChange={(event) => setHeroUid(event.target.value)} className="game-control mt-1 min-h-11 w-full min-w-0 px-2">{living.map((hero, index) => <option key={hero.uid} value={hero.uid}>Hero {(hero.position ?? index) + 1} · {Math.round(hero.current_hp)}/{Math.round(hero.max_hp)} HP</option>)}</select></label>
      <label className="ui-text-small">Potion<select aria-label="Premium potion tier" value={selectedTier} onChange={(event) => setTier(event.target.value as 'weak' | 'strong')} className="game-control mt-1 min-h-11 w-full min-w-0 px-2"><option value="weak" disabled={!stock?.weak}>Weak · 200 HP / 20s · {stock?.weak ?? '…'} owned</option><option value="strong" disabled={!stock?.strong}>Strong · 500 HP / 30s · {stock?.strong ?? '…'} owned</option></select></label>
      <label className="ui-text-small">Activate<select aria-label="Premium potion activation" value={delay} onChange={(event) => setDelay(Number(event.target.value))} className="game-control mt-1 min-h-11 w-full px-2"><option value={0}>At battle start</option><option value={5000}>After 5 seconds</option><option value={10000}>After 10 seconds</option></select></label>
      <p className="ui-text-small text-[#c4bba7]">First heal 5s after activation. One potion for this fight; unused ticks and overhealing are lost. Cannot revive.</p>
      <button type="button" disabled={!stock || stock[selectedTier] < 1 || !target} onClick={() => onUse({ tier: selectedTier, hero_uid: target, delay_ms: delay })} className="game-control min-h-11 px-2 ui-text-small font-bold text-violet-200 disabled:opacity-50">Use Potion &amp; Fight</button>
      {error && <div role="alert" className="ui-text-small text-rose-300">{error.split('_').join(' ')} <button type="button" onClick={() => void reload()} className="game-control min-h-11 px-2">Retry</button></div>}
    </div>
  </fieldset>;
}
