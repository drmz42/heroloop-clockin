import { useState } from 'react';
import { ArrowUp, Zap, Dice5, ShieldCheck, Trash2, Lock, Unlock, X, Coins } from 'lucide-react';
import { ITEM_MAP, SLOT_LABEL, formatStatValue, STAT_LABEL, sellValue, enchantSuccessChance, enchantGoldCost, enchantCharmCost, rerollCost } from '@/game/items';
import { RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { formatNum } from '@/game/state';
import { itemArtSrc, itemArtStyle } from '@/game/art';
import type { GameApi } from '@/game/useGame';
import type { OwnedItem, ItemSlot } from '@/game/types';

interface Props {
  item: OwnedItem;
  game: GameApi;
  equippedSlot?: ItemSlot | null;
  onEquip?: (slot: ItemSlot) => void;
  onUnequip?: () => void;
  onClose: () => void;
}

export function ItemActionPanel({ item, game, equippedSlot, onEquip, onUnequip, onClose }: Props) {
  const [showEnchant, setShowEnchant] = useState(false);
  const [showReroll, setShowReroll] = useState(false);
  const base = ITEM_MAP[item.itemId];
  if (!base) return null;
  const rc = RARITY_COLORS[base.rarity];
  const refund = sellValue(item);
  const enchChance = enchantSuccessChance(item.enchantLevel);
  const enchGold = enchantGoldCost(item.enchantLevel);
  const charmCost = enchantCharmCost(item.enchantLevel);
  const canEnchant = item.enchantLevel < 10;
  const rCost = rerollCost(base.rarity, item.rerollCount);

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: rc + '55', background: `linear-gradient(160deg, ${rc}12, rgba(10,10,20,0.85))` }}>
      {/* Header */}
      <div className="flex items-start gap-2.5 mb-2">
        <div className="relative w-12 h-12 rounded-lg flex items-center justify-center text-2xl border-2 shrink-0 overflow-hidden" style={{ borderColor: rc, background: rc + '22' }}>
          {itemArtStyle(base.id)
            ? <img src={itemArtSrc(base.id)!} alt={base.name} className="absolute max-w-none" style={itemArtStyle(base.id)!} />
            : base.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm" style={{ color: rc }}>{base.name} {item.enchantLevel > 0 && <span className="text-amber-400">+{item.enchantLevel}</span>}</div>
          <div className="text-[9px] text-slate-500 uppercase">{SLOT_LABEL[base.slot]} · {RARITY_LABEL[base.rarity]} · Lv {item.level}</div>
          <div className="text-[9px] text-slate-400">⚡{item.power} {item.rerollCount > 0 && `· ${item.rerollCount} rerolls`}</div>
        </div>
        <button onClick={onClose} className="p-1 rounded-full bg-slate-800/80 shrink-0"><X size={13} className="text-slate-400" /></button>
      </div>

      {/* Stats */}
      <div className="space-y-0.5 mb-2.5">
        {item.stats.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-[11px]">
            <span className="text-slate-400">{STAT_LABEL[s.key]}</span>
            <span className="font-bold text-emerald-300">{formatStatValue(s)}{item.enchantLevel > 0 && <span className="text-amber-400/70 text-[8px] ml-0.5">(+{item.enchantLevel * 10}%)</span>}</span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="space-y-1.5">
        {/* Equip / Unequip */}
        {equippedSlot ? (
          <button onClick={onUnequip} className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 text-xs font-bold hover:bg-sky-500/20 transition">
            <ArrowUp size={13} className="rotate-180" /> Unequip from {SLOT_LABEL[equippedSlot]}
          </button>
        ) : onEquip && (
          <div className="grid grid-cols-2 gap-1.5">
            {(base.slot === 'ring1' || base.slot === 'ring2')
              ? <>
                <button onClick={() => onEquip('ring1')} className="flex items-center justify-center gap-1 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-bold hover:bg-emerald-500/20 transition"><ArrowUp size={12} /> Ring 1</button>
                <button onClick={() => onEquip('ring2')} className="flex items-center justify-center gap-1 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-bold hover:bg-emerald-500/20 transition"><ArrowUp size={12} /> Ring 2</button>
              </>
              : <button onClick={() => onEquip(base.slot)} className="col-span-2 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-bold hover:bg-emerald-500/20 transition"><ArrowUp size={13} /> Equip {SLOT_LABEL[base.slot]}</button>
            }
          </div>
        )}

        {/* Enchant */}
        {canEnchant && (
          <button onClick={() => setShowEnchant(s => !s)} className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold hover:bg-amber-500/20 transition">
            <span className="flex items-center gap-1.5"><ArrowUp size={13} /> Enchant +{item.enchantLevel + 1}</span>
            <span className="flex items-center gap-1 text-amber-200">{Math.round(enchChance * 100)}% · <Coins size={10} /> {formatNum(enchGold)}</span>
          </button>
        )}

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
                onClick={() => { game.enchantItem(item.uid, true); setShowEnchant(false); onClose(); }}
                disabled={game.state.gold < enchGold || game.state.hero < charmCost}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-300 text-xs font-bold hover:bg-violet-500/25 disabled:opacity-40 transition"
              >
                <ShieldCheck size={13} /> 100% Safe ({charmCost} $HERO)
              </button>
            )}
          </div>
        )}

        {/* Reroll */}
        <button onClick={() => setShowReroll(s => !s)} className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-bold hover:bg-cyan-500/20 transition">
          <span className="flex items-center gap-1.5"><Dice5 size={13} /> Reroll Stats</span>
          <span className="flex items-center gap-1 text-cyan-200"><Zap size={10} /> {rCost}</span>
        </button>
        {showReroll && (
          <div className="rounded-lg bg-black/30 p-2">
            <div className="text-[10px] text-slate-400 mb-1">Randomly rerolls all stats (within rarity range). Cost increases with each reroll.</div>
            <button
              onClick={() => { game.rerollItem(item.uid); setShowReroll(false); }}
              disabled={game.state.hero < rCost}
              className="w-full py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-xs font-bold hover:bg-cyan-500/25 disabled:opacity-40 transition"
            >
              Reroll for {rCost} $HERO
            </button>
          </div>
        )}

        {/* Sell + Lock */}
        <div className="flex gap-1.5">
          <button onClick={() => { game.sellItem(item.uid); onClose(); }} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-bold hover:bg-rose-500/20 transition">
            <Trash2 size={13} /> Sell {formatNum(refund)}
          </button>
          <button onClick={() => game.toggleItemLock(item.uid)} className="px-3 rounded-lg bg-slate-800 border border-white/10" title={item.locked ? 'Unlock' : 'Lock'}>
            {item.locked ? <Lock size={14} className="text-amber-300" /> : <Unlock size={14} className="text-slate-500" />}
          </button>
        </div>
      </div>
    </div>
  );
}
