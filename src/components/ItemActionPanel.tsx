import { useState, type CSSProperties } from 'react';
import { ArrowUp, Dice5, ShieldCheck, Trash2, Lock, Unlock, X, Coins } from 'lucide-react';
import { HERO_USD_QUOTE, ITEM_MAP, SLOT_LABEL, displayItemPower, enchantedStats, itemBaseStats, formatStatValue, STAT_LABEL, sellValue, enchantSuccessChance, enchantCost, enchantCharmCost, rerollCost } from '@/game/items';
import { CLASS_LABEL, RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { formatNum } from '@/game/state';
import { ItemArtwork } from '@/components/ItemArtwork';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import type { GameApi } from '@/game/useGame';
import type { ItemStatKey, OwnedItem, ItemSlot } from '@/game/types';
import { enchantBonusPercent, enchantGuaranteedUsd, MAX_ENCHANT_LEVEL } from '@/game/enchant';

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
  const enchCost = enchantCost(item);
  const charmCost = enchantCharmCost(item.enchantLevel);
  const canEnchant = item.enchantLevel < MAX_ENCHANT_LEVEL;
  const rCost = rerollCost(base.rarity, item.rerollCount);
  const rerollAffordable = game.state.hero >= rCost;
  const enchantAffordable = game.state.gold >= enchCost.gold && game.state.hero >= enchCost.hero;
  const guaranteedAffordable = enchantAffordable && game.state.hero >= enchCost.hero + charmCost;
  const enchantCostText = enchCost.gold > 0 ? `${formatNum(enchCost.gold)} Gold` : `${formatNum(enchCost.hero)} $HERO`;
  const usd = (hero: number) => `$${(hero * HERO_USD_QUOTE).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
  const ringSlot = !equippedSlot && onEquip && (base.slot === 'ring1' || base.slot === 'ring2');
  const baseStats = itemBaseStats(item);
  // Base stat and random lines of the same key are summed for the comparison.
  const statTotals = (source: OwnedItem) => {
    const totals = new Map<ItemStatKey, { key: ItemStatKey; value: number; isPercent: boolean }>();
    for (const stat of enchantedStats([...itemBaseStats(source), ...source.stats], source.enchantLevel)) {
      const current = totals.get(stat.key);
      totals.set(stat.key, { key: stat.key, isPercent: stat.isPercent, value: (current?.value ?? 0) + stat.value });
    }
    return totals;
  };
  const candidateStats = statTotals(item);
  const equippedStats = comparisonItem ? statTotals(comparisonItem) : new Map<ItemStatKey, { key: ItemStatKey; value: number; isPercent: boolean }>();
  const comparisonKeys = [...new Set([...candidateStats.keys(), ...equippedStats.keys()])] as ItemStatKey[];
  const combatPower = displayItemPower(item);
  const comparisonPower = comparisonItem ? displayItemPower(comparisonItem) : 0;

  return (
    <div className="item-action-panel rounded-xl border p-2" style={{ '--item-rarity': rc } as CSSProperties}>
      {/* Header */}
      <div className="mb-1.5 flex items-start gap-2">
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border-2 text-xl" style={{ borderColor: rc, background: rc + '22' }}>
          <ItemArtwork itemId={base.id} name={base.name} fallback={base.icon} className="text-2xl" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold ui-text-medium" style={{ color: rc }}>{base.name} {item.enchantLevel > 0 && <span className="text-amber-400">+{item.enchantLevel}</span>}</div>
          <div className="ui-text-small text-slate-500 uppercase">{SLOT_LABEL[base.slot]} · {RARITY_LABEL[base.rarity]} · Lv {item.level}</div>
          {base.heroClass && <div className="mt-0.5 ui-text-small font-black uppercase tracking-wide text-amber-200">{CLASS_LABEL[base.heroClass]} only</div>}
          <div className="ui-text-small text-slate-400">⚡{combatPower} Gear Power {item.rerollCount > 0 && `· ${item.rerollCount} rerolls`}</div>
        </div>
        <button onClick={onClose} className="game-control grid h-7 w-7 shrink-0 place-items-center"><X size={13} /></button>
      </div>

      {/* Stats */}
      <div className="mb-1.5 grid grid-cols-1 gap-y-0.5 rounded-md bg-black/20 px-2 py-1">
        {baseStats.map((s) => (
          <div key={`base-${s.key}`} className="item-stat-row flex items-center justify-between gap-2 ui-text-medium tabular-nums">
            <span className="text-slate-300">{STAT_LABEL[s.key]} <span className="ui-text-small text-slate-500">base</span></span>
            <span className="font-bold text-slate-100">{formatStatValue(s)}{item.enchantLevel > 0 && <span className="text-amber-400/70 ui-text-small ml-0.5">(+{enchantBonusPercent(item.enchantLevel)}%)</span>}</span>
          </div>
        ))}
        {item.stats.map((s, i) => (
          <div key={i} className="item-stat-row flex items-center justify-between gap-2 ui-text-medium tabular-nums">
            <span className="text-slate-400">{STAT_LABEL[s.key]}</span>
            <span className="font-bold text-emerald-300">{formatStatValue(s)}{item.enchantLevel > 0 && <span className="text-amber-400/70 ui-text-small ml-0.5">(+{enchantBonusPercent(item.enchantLevel)}%)</span>}</span>
          </div>
        ))}
      </div>

      {comparisonItem && (
        <div className="mb-1.5 rounded-md border border-[#665233] bg-black/30 px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between gap-2 ui-text-small font-black uppercase tracking-wide text-[#d8c59f]"><span>Compared with equipped</span><span>{combatPower - comparisonPower >= 0 ? '+' : ''}{combatPower - comparisonPower} Gear Power</span></div>
          <div className="mb-1 truncate ui-text-small text-[#8f887b]">{ITEM_MAP[comparisonItem.itemId]?.name ?? 'Equipped item'}</div>
          <div className="grid gap-0.5">
            {comparisonKeys.map((key) => {
              const candidate = candidateStats.get(key);
              const equipped = equippedStats.get(key);
              const delta = (candidate?.value ?? 0) - (equipped?.value ?? 0);
              const isPercent = candidate?.isPercent ?? equipped?.isPercent ?? false;
              return <div key={key} className="flex items-center justify-between ui-text-small"><span className="text-[#9f9789]">{STAT_LABEL[key]}</span><span className={delta > 0 ? 'text-emerald-300' : delta < 0 ? 'text-rose-300' : 'text-slate-300'}>{delta > 0 ? '▲ +' : delta < 0 ? '▼ −' : '= '}{formatStatValue({ key, value: Math.abs(delta), isPercent }).replace(/^\+/, '')}</span></div>;
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-1">
        {equipDisabledReason && <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-center ui-text-small font-bold text-amber-200">{equipDisabledReason}</div>}

        <div className={`grid gap-1 ${ringSlot ? 'grid-cols-6' : 'grid-cols-5'}`}>
          {equippedSlot ? (
            <button data-item-action="unequip" onClick={onUnequip} className="flex min-h-10 min-w-0 flex-col items-center justify-center rounded-md border border-sky-500/30 bg-sky-500/10 px-0.5 ui-text-small font-black text-sky-300 transition hover:bg-sky-500/20" title={`Unequip from ${SLOT_LABEL[equippedSlot]}`}>
              <span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0"><ArrowUp size={12} className="rotate-180" /><span>Unequip</span></span>
            </button>
          ) : ringSlot ? <>
            <button disabled={Boolean(equipDisabledReason)} onClick={() => onEquip('ring1')} className="flex min-h-10 min-w-0 flex-col items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-0.5 ui-text-small font-black text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40" title={equipDisabledReason || 'Equip in Ring 1'}><span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0"><ArrowUp size={12} /><span>Ring 1</span></span></button>
            <button disabled={Boolean(equipDisabledReason)} onClick={() => onEquip('ring2')} className="flex min-h-10 min-w-0 flex-col items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-0.5 ui-text-small font-black text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40" title={equipDisabledReason || 'Equip in Ring 2'}><span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0"><ArrowUp size={12} /><span>Ring 2</span></span></button>
          </> : onEquip ? (
            <button data-item-action="equip" disabled={Boolean(equipDisabledReason)} onClick={() => onEquip(base.slot)} className="flex min-h-10 min-w-0 flex-col items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-0.5 ui-text-small font-black text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40" title={equipDisabledReason || `Equip ${SLOT_LABEL[base.slot]}`}><span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0"><ArrowUp size={12} /><span>Equip</span></span></button>
          ) : <div />}

          <button disabled={!canEnchant || game.itemUpgradeBusy} onClick={() => setShowEnchant(s => !s)} className="flex min-h-10 min-w-0 flex-col items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10 px-0.5 text-center ui-text-small font-black text-amber-300 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40" title={canEnchant ? `Enchant +${item.enchantLevel + 1}: ${Math.round(enchChance * 100)}% chance, ${enchantCostText}` : `Maximum enchant +${MAX_ENCHANT_LEVEL}`}>
            <span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0"><ArrowUp size={12} /><span>{canEnchant ? `Enchant +${item.enchantLevel + 1}` : `Max +${MAX_ENCHANT_LEVEL}`}</span></span>{canEnchant && <span className="ui-text-small font-bold text-amber-100/70">{Math.round(enchChance * 100)}% · {formatNum(enchCost.gold)} G</span>}
          </button>

          <button disabled={!rerollAffordable || game.itemUpgradeBusy} onClick={() => setShowReroll(s => !s)} className="flex min-h-10 min-w-0 flex-col items-center justify-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-0.5 ui-text-small font-black text-cyan-300 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40" title={rerollAffordable ? `Reroll for ${rCost} $HERO` : `Need ${rCost - game.state.hero} more $HERO`}>
            <span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0"><Dice5 size={12} /><span>Reroll</span></span><span className="flex items-center gap-0.5 ui-text-small font-bold text-cyan-100/70"><HeroTokenIcon size={8} /> {usd(rCost)} · {formatNum(rCost)}</span>
          </button>

          <div className="relative min-w-0">
            <button disabled={item.locked} onClick={() => setShowSellConfirm((value) => !value)} className="flex min-h-10 w-full min-w-0 flex-col items-center justify-center rounded-md border border-rose-500/30 bg-rose-500/10 px-0.5 ui-text-small font-black text-rose-300 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40" title={item.locked ? 'Unlock item before selling' : `Sell for ${formatNum(refund)} Gold`}>
              <span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0"><Trash2 size={12} /><span>Sell</span></span><span className="ui-text-small font-bold text-rose-100/70">{formatNum(refund)} G</span>
            </button>
            {showSellConfirm && <div className="item-sell-confirm absolute bottom-full right-0 z-30 mb-1 w-44 rounded-md border border-[#80502d] p-2 text-left shadow-xl">
              <p className="ui-text-small font-bold text-[#ead9bf]">Sell for {formatNum(refund)} Gold?</p>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                <button type="button" onClick={() => setShowSellConfirm(false)} className="game-control py-1 ui-text-small font-bold">Cancel</button>
                <button type="button" onClick={async () => { if (!onBeforeSell || await onBeforeSell(item)) { game.sellItem(item.uid); onClose(); } }} className="rounded border border-rose-500/45 bg-rose-500/15 py-1 ui-text-small font-black text-rose-200">Sell</button>
              </div>
            </div>}
          </div>

          <button onClick={() => game.toggleItemLock(item.uid)} className={`flex min-h-10 min-w-0 flex-col items-center justify-center rounded-md border px-0.5 ui-text-small font-black ${item.locked ? 'border-amber-500/40 bg-amber-500/15 text-amber-200' : 'border-white/10 bg-slate-800 text-slate-300'}`} title={item.locked ? 'Unlock item' : 'Lock item'}>
            <span className="flex min-w-0 max-w-full items-center justify-center gap-0.5 leading-tight [&>svg]:shrink-0">{item.locked ? <Lock size={12} /> : <Unlock size={12} className="text-slate-400" />}<span>{item.locked ? 'Unlock' : 'Lock'}</span></span>
          </button>
        </div>

        {showEnchant && canEnchant && (
          <div className="rounded-lg bg-black/30 p-2 space-y-1.5">
            <div className="ui-text-small text-slate-400">Ordinary success: <span className={enchChance >= 1 ? 'text-emerald-300' : 'text-amber-300'}>{Math.round(enchChance * 100)}%</span> {enchChance < 1 && <span className="font-bold text-rose-300">· Failure destroys the item ({Math.round((1 - enchChance) * 100)}%)</span>}</div>
            <button
              onClick={() => { void game.enchantItem(item.uid, false); setShowEnchant(false); onClose(); }}
              disabled={game.itemUpgradeBusy || !enchantAffordable}
              className="w-full py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 ui-text-medium font-bold hover:bg-amber-500/25 disabled:opacity-40 transition"
            >
              Ordinary ({enchCost.gold > 0 ? <><Coins size={10} className="inline" /> {formatNum(enchCost.gold)}</> : <><HeroTokenIcon size={10} className="inline" /> {usd(enchCost.hero)} · {formatNum(enchCost.hero)}</>})
            </button>
            {charmCost > 0 && (
              <button
                type="button"
                onClick={() => { void game.enchantItem(item.uid, true); setShowEnchant(false); onClose(); }}
                disabled={game.itemUpgradeBusy || !guaranteedAffordable}
                title="100% success · the item cannot be destroyed"
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-300 ui-text-medium font-bold hover:bg-violet-500/25 disabled:opacity-40 transition"
              >
                <ShieldCheck size={13} /> Guaranteed (<Coins size={10} /> {formatNum(enchCost.gold)} + <HeroTokenIcon size={10} /> ${enchantGuaranteedUsd(item.enchantLevel).toFixed(2)} · {formatNum(charmCost)})
              </button>
            )}
          </div>
        )}

        {showReroll && (
          <div className="rounded-lg bg-black/30 p-2">
            <div className="ui-text-small text-slate-400 mb-1">Randomly rerolls all stats (within rarity range). Price is {usd(rCost)} · {formatNum(rCost)} $HERO and caps at 5×.</div>
            <button
              type="button"
              onClick={() => { void game.rerollItem(item.uid); setShowReroll(false); }}
              disabled={game.itemUpgradeBusy || !rerollAffordable}
              className="w-full py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 ui-text-medium font-bold hover:bg-cyan-500/25 disabled:opacity-40 transition"
            >
              {rerollAffordable ? `Reroll for ${rCost} $HERO` : `Need ${rCost - game.state.hero} more $HERO`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
