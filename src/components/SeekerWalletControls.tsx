import type { WalletAsset } from '@/game/seekerWallet';
export type DisplayWalletAsset = WalletAsset | 'ORE';
export function WalletAssetPicker({ asset, busy, onChange }: {asset: DisplayWalletAsset; busy: boolean; onChange: (asset: DisplayWalletAsset) => void}) {
  return <div role="radiogroup" aria-label="Token" className="grid grid-cols-3 gap-2">
    {(['SKR', 'SOL', 'ORE'] as const).map(entry => <button key={entry} type="button" role="radio" aria-checked={asset === entry} disabled={busy}
      onClick={() => onChange(entry)} className={`game-control min-h-11 px-2 text-sm font-black ${asset === entry ? 'border-[#e0a83c] text-[#f6d283]' : 'text-[#8f887b]'}`}>{entry}</button>)}
  </div>;
}
export function WalletAmount({id, amount, asset, busy, available, onChange, onMax}: {id: string; amount: string; asset: DisplayWalletAsset; busy: boolean; available: string; onChange: (amount: string) => void; onMax?: () => void}) {
  return <div>
    <label htmlFor={id} className="text-[11px] font-semibold uppercase tracking-wider text-[#8f887b]">Amount</label>
    <div className="mt-1 flex items-center gap-2">
      <input id={id} inputMode="decimal" autoComplete="off" value={amount} disabled={busy || asset === 'ORE'}
        onChange={event => onChange(event.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}
        placeholder="0" className="min-h-11 min-w-0 flex-1 rounded-xl border border-[#3f3626] bg-black/30 px-3 text-base font-bold text-[#f1d188]" />
      <button type="button" disabled={busy || !onMax || asset === 'ORE'} onClick={onMax} className="game-control min-h-11 px-3 text-xs font-black text-[#f6d283] disabled:opacity-45">MAX</button>
    </div>
    <p aria-live="polite" className="mt-1 text-[11px] leading-4 text-[#8f887b]">{available}</p>
  </div>;
}
