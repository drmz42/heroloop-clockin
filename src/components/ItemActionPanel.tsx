import { useState, type CSSProperties } from 'react';
import { ArrowUp, Dice5, ShieldCheck, Trash2, Lock, Unlock, X, Coins } from 'lucide-react';
import { ITEM_MAP, SLOT_LABEL, enchantedStats, formatStatValue, STAT_LABEL, sellValue, enchantSuccessChance, enchantGoldCost, enchantCharmCost, rerollCost } from '@/game/items';
import { CLASS_LABEL, RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { formatNum } from '@/game/state';
import { ItemArtwork } from '@/components/ItemArtwork';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import type { GameApi } from '@/game/useGame';
import type { ItemStatKey, OwnedItem, ItemSlot } from '@/game/types';

interface Props {
  item: OwnedItem;
  game: GameApi;
  equippedSlot?: ItemSlot | null;
  comparisonItem?: OwnedItem | null;
  onEquip?: (slot: ItemSlot) => void;
  onUnequip?: () => void;
  onBeforeSell?: (item: OwnedItem) => Promise<boolean>;
  equipDisabledReason?: string;
  onClose: () => void;
}

export function ItemActionPanel({ item, game, equippedSlot, comparisonItem, onEquip, onUnequip, onBeforeSell, equipDisabledReason, onClose }: Props) {
  const [showEnchant, setShowEnchant] = useState(false);
  const [showReroll, setShowReroll] = useState(false);
  const [showSellConfirm, setShowSellConfirm] = useState(false);
  const base = ITEM_MAP[item.itemId];
  if (!base) return null;
  const rc = RARITY_COLORS[base.rarity];
  const refund = sellValue(item);
  const enchChance = enchantSuccessChance(item.enchantLevel);
  const enchGold = enchantGoldCost(item.enchantLevel);
  const charmCost = enchantCharmCost(item.enchantLevel);
  const canEnchant = item.enchantLevel < 10;
  const rCost = rerollCost(base.rarity, item.rerollCount);
  const candidateStats = new Map(enchantedStats(item.stats, item.enchantLevel).map((stat) => [stat.key, stat]));
  const equippedStats = new Map((comparisonItem ? enchantedStats(comparisonItem.stats, comparisonItem.enchantLevel) : []).map((stat) => [stat.key, stat]));
  const comparisonKeys = [...new Set([...candidateStats.keys(), ...equippedStats.keys()])] as ItemStatKey[];

  return (
    <div className="item-action-panel rounded-xl border p-2" style={{ '--item-rarity': rc } as CSSProperties}>
      {/* Header */}
      <div className="mb-1.5 flex items-start gap-2">
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border-2 text-xl" style={{ borderColor: rc, background: rc + '22' }}>
          <ItemArtwork itemId={base.id} name={base.name} fallback={base.icon} className="text-2xl" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm" style={{ color: rc }}>{base.name} {item.enchantLevel > 0 && <span className="text-amber-400">+{item.enchantLevel}</span>}</div>
          <div className="text-[9px] text-slate-500 uppercase">{SLOT_LABEL[base.slot]} · {RARITY_LABEL[base.rarity]} · Lv {item.level}</div>
          {base.heroClass && <div className="mt-0.5 text-[9px] font-black uppercase tracking-wide text-amber-200">{CLASS_LABEL[base.heroClass]} only</div>}
          <div className="text-[9px] text-slate-400">⚡{item.power} {item.rerollCount > 0 && `· ${item.rerollCount} rerolls`}</div>
        </div>
        <button onClick={onClose} className="game-control grid h-7 w-7 shrink-0 place-items-center"><X size={13} /></button>
      </div>

      {/* Stats */}
      <div className="mb-1.5 grid grid-cols-1 gap-y-0.5 rounded-md bg-black/20 px-2 py-1">
        {item.stats.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-[11px]">
            <span className="text-slate-400">{STAT_LABEL[s.key]}</span>
            <span className="font-bold text-emerald-300">{formatStatValue(s)}{item.enchantLevel > 0 && <span className="text-amber-400/70 text-[8px] ml-0.5">(+{item.enchantLevel * 10}%)</span>}</span>
          </div>
        ))}
      </div>

      {comparisonItem && (
        <div className="mb-1.5 rounded-md border border-[#665233] bg-black/30 px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between gap-2 text-[9px] font-black uppercase tracking-wide text-[#d8c59f]"><span>Compared with equipped</span><span>{item.power - comparisonItem.power >= 0 ? '+' : ''}{item.power - comparisonItem.power} Power</span></div>
          <div className="mb-1 truncate text-[9px] text-[#8f887b]">{ITEM_MAP[comparisonItem.itemId]?.name ?? 'Equipped item'}</div>
          <div className="grid gap-0.5">
            {comparisonKeys.map((key) => {
              const candidate = candidateStats.get(key);
              const equipped = equippedStats.get(key);
              const delta = (candidate?.value ?? 0) - (equipped?.value ?? 0);
              const isPercent = candidate?.isPercent ?? equipped?.isPercent ?? false;
              return <div key={key} className="flex items-center justify-between text-[10px]"><span className="text-[#9f9789]">{STAT_LABEL[key]}</span><span className={delta > 0 ? 'text-emerald-300' : delta < 0 ? 'text-rose-300' : 'text-slate-300'}>{delta > 0 ? '▲ +' : delta < 0 ? '▼ −' : '= '}{formatStatValue({ key, value: Math.abs(delta), isPercent })}</span></div>;
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-1">
        {/* Equip / Unequip */}
        {equippedSlot ? (
          <button onClick={onUnequip} className="flex w-full items-center justify-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 py-1 text-[10px] font-bold text-sky-300 transition hover:bg-sky-500/20">
            <ArrowUp size={13} className="rotate-180" /> Unequip from {SLOT_LABEL[equippedSlot]}
          </button>
        ) : onEquip && (
          <div className="grid grid-cols-2 gap-1.5">
            {equipDisabledReason && <div className="col-span-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-center text-[10px] font-bold text-amber-200">{equipDisabledReason}</div>}
            {(base.slot === 'ring1' || base.slot === 'ring2')
              ? <>
                <button disabled={Boolean(equipDisabledReason)} onClick={() => onEquip('ring1')} className="flex items-center justify-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"><ArrowUp size={11} /> Ring 1</button>
                <button disabled={Boolean(equipDisabledReason)} onClick={() => onEquip('ring2')} className="flex items-center justify-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"><ArrowUp size={11} /> Ring 2</button>
              </>
              : <button disabled={Boolean(equipDisabledReason)} onClick={() => onEquip(base.slot)} className="col-span-2 flex items-center justify-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"><ArrowUp size={11} /> Equip {SLOT_LABEL[base.slot]}</button>
            }
          </div>
        )}

        <div className="grid grid-cols-2 gap-1.5">
          {canEnchant && (
            <button onClick={() => setShowEnchant(s => !s)} className="flex items-center justify-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1 py-1 text-[10px] font-bold text-amber-300 transition hover:bg-amber-500/20">
              <ArrowUp size={12} /> Enchant +{item.enchantLevel + 1} · {Math.round(enchChance * 100)}%
            </button>
          )}
          <button onClick={() => setShowReroll(s => !s)} className={`${canEnchant ? '' : 'col-span-2'} flex items-center justify-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1 py-1 text-[10px] font-bold text-cyan-300 transition hover:bg-cyan-500/20`}>
            <Dice5 size={12} /> Reroll · <HeroTokenIcon size={10} /> {rCost}
          </button>
        </div>

        {showEnchant && canEnchant && (
          <div className="rounded-lg bg-black/30 p-2 space-y-1.5">
            <div className="text-[10px] text-slate-400">Success: <span className={enchChance >= 1 ? 'text-emerald-300' : 'text-amber-300'}>{Math.round(enchChance * 100)}%</span> {enchChance < 1 && <span className="text-rose-400">· Fail = item destroyed</span>}</div>
            <button
              onClick={() => { game.enchantItem(item.uid, false); setShowEnchant(false); onClose(); }}
              disabled={game.state.gold < enchGold}
              className="w-full py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-bold hover:bg-amber-500/25 disabled:opacity-40 transition"
            >
              Enchant (<Coins size={10} className="inline" /> {formatNum(enchGold)})
            </button>
            {charmCost > 0 && (
              <button
                type="button"
                onClick={() => { game.enchantItem(item.uid, true); setShowEnchant(false); onClose(); }}
                disabled={game.state.gold < enchGold}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-300 text-xs font-bold hover:bg-violet-500/25 disabled:opacity-40 transition"
              >
                <ShieldCheck size={13} /> 100% Safe (<Coins size={10} /> {formatNum(enchGold)} + <HeroTokenIcon size={10} /> {charmCost})
              </button>
            )}
          </div>
        )}

        {showReroll && (
          <div className="rounded-lg bg-black/30 p-2">
            <div className="text-[10px] text-slate-400 mb-1">Randomly rerolls all stats (within rarity range). Cost increases with each reroll.</div>
            <button
              type="button"
              onClick={() => { game.rerollItem(item.uid); setShowReroll(false); }}
              className="w-full py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-xs font-bold hover:bg-cyan-500/25 disabled:opacity-40 transition"
            >
              Reroll for {rCost} $HERO
            </button>
          </div>
        )}

        {/* Sell + Lock */}
        <div className="grid grid-cols-2 gap-1.5">
          <div className="relative">
            <button onClick={() => setShowSellConfirm((value) => !value)} className="flex w-full items-center justify-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 py-1 text-[10px] font-bold text-rose-300 transition hover:bg-rose-500/20">
              <Trash2 size={11} /> Sell {formatNum(refund)}
            </button>
            {showSellConfirm && <div className="item-sell-confirm absolute bottom-full left-0 z-30 mb-1 w-44 rounded-md border border-[#80502d] p-2 text-left shadow-xl">
              <p className="text-[9px] font-bold text-[#ead9bf]">Sell for {formatNum(refund)} Gold?</p>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                <button type="button" onClick={() => setShowSellConfirm(false)} className="game-control py-1 text-[9px] font-bold">Cancel</button>
                <button type="button" onClick={async () => { if (!onBeforeSell || await onBeforeSell(item)) { game.sellItem(item.uid); onClose(); } }} className="rounded border border-rose-500/45 bg-rose-500/15 py-1 text-[9px] font-black text-rose-200">Sell</button>
              </div>
            </div>}
          </div>
          <button onClick={() => game.toggleItemLock(item.uid)} className={`flex items-center justify-center gap-1 rounded-md border py-1 text-[10px] font-bold ${item.locked ? 'border-amber-500/40 bg-amber-500/15 text-amber-200' : 'border-white/10 bg-slate-800 text-slate-300'}`} title={item.locked ? 'Unlock' : 'Lock'}>
            {item.locked ? <Lock size={11} /> : <Unlock size={11} className="text-slate-400" />}
            {item.locked ? 'Unlock' : 'Lock'}
          </button>
        </div>
      </div>
    </div>
  );
}
