import { useEffect, useState } from 'react';
import { Mail, X } from 'lucide-react';
import { ItemArtwork } from '@/components/ItemArtwork';
import { RARITY_COLORS } from '@/game/heroes';
import { ITEM_MAP, displayItemPower } from '@/game/items';
import { formatNum } from '@/game/state';
import { versionedAsset } from '@/game/assetVersion';
import type { MailClaimResult, MailEntry } from '@/game/useGame';

const SOURCE: Record<MailEntry['source'], string> = {
  market_purchase: 'Market purchase',
  market_return: 'Returned from Market',
  store_overflow: 'Store purchase',
  boss_reward: 'Boss Hunt reward',
};
const ERRORS: Record<string, string> = {
  item_capacity_exceeded: 'Your bag is full. Free a slot to claim items.',
  chests_full: 'Your chest storage is full (500). Open some chests to claim more.',
  mail_not_found: 'This item was already claimed.',
  rate_limited: 'Please wait a little before trying again.',
  feature_paused: 'The Mailbox is temporarily unavailable.',
};

export function MailboxModal({ onClose, loadMail, claimMail, freeSlots, chestCount }: {
  onClose: () => void;
  loadMail: () => Promise<MailEntry[] | null>;
  claimMail: (mailId: string | null) => Promise<MailClaimResult>;
  freeSlots: number;
  chestCount: number;
}) {
  const [entries, setEntries] = useState<MailEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    const result = await loadMail();
    setEntries(result ?? []);
    if (!result) setMessage('The Mailbox could not be loaded. Please try again later.');
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const claim = async (mailId: string | null) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    const result = await claimMail(mailId);
    if (!result.ok) setMessage(ERRORS[result.error ?? ''] ?? 'The item could not be claimed. Please try again.');
    else if (!result.claimed && result.chestsFull) setMessage(ERRORS.chests_full);
    else if ((result.remaining ?? 0) > 0 && mailId === null) setMessage(result.chestsFull && result.itemsFull ? 'Your bag and chest storage are full. The rest stays in the Mailbox.' : result.chestsFull ? 'Your chest storage is full. The rest stays in the Mailbox.' : 'Your bag is full. The rest stays in the Mailbox.');
    await refresh();
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[4px]" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="mailbox-title" className="px-panel-raised flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col rounded-2xl border border-[#9a6a22] shadow-[0_24px_90px_rgba(0,0,0,.8)]">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#51422e] p-4">
          <div><div className="section-kicker flex items-center gap-2"><Mail size={14} /> Mailbox</div><h2 id="mailbox-title" className="mt-1 font-vt text-xl font-black text-[#f0dfbb]">Deliveries</h2></div>
          <button type="button" onClick={onClose} disabled={busy} className="game-control grid h-10 w-10 shrink-0 place-items-center" aria-label="Close mailbox"><X size={17} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          <p className="text-xs leading-5 text-[#c9c2b6]">Rewards, Market purchases and items that did not fit into a full bag wait here. Free bag slots: <b className="text-[#f0dfbb]">{Math.max(0, freeSlots)}</b> · chests: <b className="text-[#f0dfbb]">{chestCount}/500</b>.</p>
          {message && <p role="status" className="mt-3 rounded border border-[#9a6a22]/60 bg-black/30 p-3 text-xs text-[#f0d9a8]">{message}</p>}
          {entries === null ? <p className="mt-4 text-xs text-[#c9c2b6]">Loading…</p> : entries.length === 0 ? <p className="mt-4 text-xs text-[#c9c2b6]">The Mailbox is empty.</p> : (
            <>
              <button type="button" disabled={busy || (freeSlots <= 0 && chestCount >= 500)} onClick={() => void claim(null)} className="game-control game-primary mt-4 min-h-11 w-full px-4 text-xs font-black disabled:opacity-45">{busy ? 'Claiming…' : `Claim all (${entries.length})`}</button>
              <div className="mt-3 grid gap-2">
                {entries.map((entry) => {
                  if (entry.kind === 'chest') {
                    return <article key={entry.id} className="flex items-center gap-3 rounded-lg border border-[#9a6a22]/70 bg-black/20 p-2">
                      <span className="block h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-black/25"><img src={versionedAsset('/assets/ui/open-treasure-chest-v1.webp')} alt="" className="h-full w-full object-contain" /></span>
                      <span className="min-w-0 flex-1">
                        <b className="block truncate text-xs text-[#f3c64e]">{entry.chest.boss ? 'Boss Chest' : 'Chest'}</b>
                        <span className="block text-[10px] text-[#8d8374]">Location {entry.chest.stage} · {SOURCE[entry.source] ?? 'Delivery'}</span>
                      </span>
                      <button type="button" disabled={busy || chestCount >= 500} onClick={() => void claim(entry.id)} className="game-control min-h-10 shrink-0 px-3 text-[11px] font-bold disabled:opacity-45">Claim</button>
                    </article>;
                  }
                  const base = ITEM_MAP[entry.item.itemId];
                  if (!base) return null;
                  return <article key={entry.id} className={`rarity-${base.rarity} flex items-center gap-3 rounded-lg border border-[#51422e] bg-black/20 p-2`}>
                    <span className="block h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-black/25"><ItemArtwork itemId={base.id} name={base.name} fallback={base.icon} /></span>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-xs" style={{ color: RARITY_COLORS[base.rarity] }}>{base.name}{entry.item.enchantLevel ? ` +${entry.item.enchantLevel}` : ''}</b>
                      <span className="block text-[10px] text-[#8d8374]">Lv {entry.item.level} · {formatNum(displayItemPower(entry.item))} PWR · {SOURCE[entry.source] ?? 'Delivery'}</span>
                    </span>
                    <button type="button" disabled={busy || freeSlots <= 0} onClick={() => void claim(entry.id)} className="game-control min-h-10 shrink-0 px-3 text-[11px] font-bold disabled:opacity-45">Claim</button>
                  </article>;
                })}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
