import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Package, ArrowUp, Check, X, Star } from 'lucide-react';
import { ITEM_MAP, formatStatValue, STAT_LABEL, SLOT_LABEL } from '@/game/items';
import { RARITY_COLORS, RARITY_LABEL, RARITY_INDEX } from '@/game/heroes';
import { formatNum } from '@/game/state';
import type { OwnedItem, OwnedHero, ItemSlot } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { itemArtSrc, itemArtStyle } from '@/game/art';

interface BetterItem {
  item: OwnedItem;
  slot: ItemSlot;
  heroUid: string;
  heroName: string;
  oldItem: OwnedItem | null;
}

function findBetterUpgrades(items: OwnedItem[], heroes: OwnedHero[]): BetterItem[] {
  const upgrades: BetterItem[] = [];
  for (const item of items) {
    const base = ITEM_MAP[item.itemId];
    if (!base) continue;
    const slot = base.slot;
    for (const hero of heroes) {
      const equippedUid = hero.equipped[slot];
      const oldItem = equippedUid ? items.find(i => i.uid === equippedUid) : null;
      if (!oldItem || item.power > oldItem.power) {
        upgrades.push({ item, slot, heroUid: hero.uid, heroName: hero.uid || 'Hero', oldItem: oldItem ?? null });
      }
    }
  }
  return upgrades;
}

export function ChestOpenModal({
  items, game, heroes, onClose,
}: {
  items: OwnedItem[]; game: GameApi; heroes: OwnedHero[]; onClose: () => void;
}) {
  const [equipped, setEquipped] = useState<Set<string>>(new Set());

  const upgrades = findBetterUpgrades(items, heroes);

  const autoEquipBest = () => {
    const newEquipped = new Set(equipped);
    for (const u of upgrades) {
      // Only equip if not already equipped by someone better
      if (!newEquipped.has(u.item.uid)) {
        game.equipItem(u.heroUid, u.item.uid, u.slot);
        newEquipped.add(u.item.uid);
      }
    }
    setEquipped(newEquipped);
  };

  const equipOne = (u: BetterItem) => {
    game.equipItem(u.heroUid, u.item.uid, u.slot);
    setEquipped(new Set([...equipped, u.item.uid]));
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-4 anim-fade backdrop-blur-md">
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto no-scrollbar px-panel-raised p-5">
        {/* Header */}
        <div className="text-center mb-4">
          <div className="text-3xl mb-1 anim-chest">📦</div>
          <h2 className="font-pixel text-sm text-gold-glow">CHESTS OPENED!</h2>
          <p className="font-vt text-px-dim text-sm">{items.length} chest{items.length > 1 ? 's' : ''} opened</p>
        </div>

        {/* Auto-equip banner */}
        {upgrades.length > 0 && (
          <div className="mb-4 p-2.5 border-2 border-px-green bg-px-green/10" style={{ boxShadow: '2px 2px 0 #1a4a14' }}>
            <div className="flex items-center justify-between">
              <span className="font-vt text-sm text-px-green font-bold">
                {upgrades.length} upgrade{upgrades.length > 1 ? 's' : ''} found!
              </span>
              <button onClick={autoEquipBest} className="px-btn px-3 py-1 text-xs font-bold flex items-center gap-1">
                <ArrowUp size={12} /> AUTO-EQUIP BEST
              </button>
            </div>
          </div>
        )}

        {/* Items grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
          {items.map((item) => {
            const base = ITEM_MAP[item.itemId];
            if (!base) return null;
            const rc = RARITY_COLORS[base.rarity];
            const isEquipped = equipped.has(item.uid);
            const upgrade = upgrades.find(u => u.item.uid === item.uid);
            return (
              <div
                key={item.uid}
                className={`p-2.5 border-2 anim-reveal relative ${isEquipped ? 'border-px-green' : ''}`}
                style={{
                  borderColor: isEquipped ? '#3a8a28' : rc,
                  background: `linear-gradient(160deg, ${rc}18, #100c02)`,
                  boxShadow: `3px 3px 0 ${rc}44`,
                }}
              >
                {isEquipped && <div className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-px-green border border-green-300 flex items-center justify-center"><Check size={11} className="text-white" /></div>}
                <div className="relative mx-auto mb-2 aspect-square w-20 overflow-hidden rounded-lg border border-white/10 bg-black/30">
                  {itemArtStyle(base.id)
                    ? <img src={itemArtSrc(base.id)!} alt={base.name} className="absolute max-w-none" style={itemArtStyle(base.id)!} />
                    : <div className="grid h-full place-items-center text-3xl">{base.icon}</div>}
                </div>
                <div className="text-center font-vt text-xs font-bold" style={{ color: rc }}>{base.name}</div>
                <div className="text-center text-[8px] text-px-dim uppercase tracking-wide font-pixel">{RARITY_LABEL[base.rarity]}</div>
                <div className="text-center text-[9px] text-px-dim font-vt mt-0.5">Lv{item.level} · ⚡{item.power}</div>
                <div className="mt-1.5 space-y-0.5">
                  {item.stats.map((s, i) => (
                    <div key={i} className="text-[9px] text-center font-vt">
                      <span className="text-px-dim">{STAT_LABEL[s.key]}: </span>
                      <span className="text-px-green">{formatStatValue(s)}</span>
                    </div>
                  ))}
                </div>
                {/* Equip button if upgrade */}
                {upgrade && !isEquipped && (
                  <button
                    onClick={() => equipOne(upgrade)}
                    className="w-full mt-1.5 py-1 px-btn text-[10px] font-bold flex items-center justify-center gap-1"
                  >
                    <ArrowUp size={10} /> {SLOT_LABEL[upgrade.slot]}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex justify-center">
          <button onClick={onClose} className="px-btn px-6 py-2 text-sm font-bold flex items-center gap-1.5">
            <Package size={14} /> SEND TO BAG
          </button>
        </div>

        <button onClick={onClose} className="absolute -top-2 -right-2 p-1.5 bg-px-panel border-2 border-px-border">
          <X size={14} className="text-px-text" />
        </button>
      </div>
    </div>,
    document.body
  );
}

void RARITY_INDEX;
void Star;
