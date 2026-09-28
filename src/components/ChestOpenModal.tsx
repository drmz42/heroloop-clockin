import { createPortal } from 'react-dom';
import { Package, X } from 'lucide-react';
import { ITEM_MAP, SLOT_LABEL, displayItemPower } from '@/game/items';
import { RARITY_COLORS, RARITY_LABEL, RARITY_INDEX } from '@/game/heroes';
import type { OwnedItem, OwnedHero } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { ItemArtwork } from '@/components/ItemArtwork';

export function ChestOpenModal({
  items, onClose,
}: {
  items: OwnedItem[]; game: GameApi; heroes: OwnedHero[]; onClose: () => void;
}) {
  const sortedItems = [...items].sort((a, b) => {
    const aBase = ITEM_MAP[a.itemId];
    const bBase = ITEM_MAP[b.itemId];
    return (RARITY_INDEX[bBase?.rarity ?? 'common'] ?? 0) - (RARITY_INDEX[aBase?.rarity ?? 'common'] ?? 0);
  });

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[5px] anim-fade">
      <div className="relative flex max-h-[78vh] w-full max-w-xl flex-col overflow-hidden rounded-xl px-panel-raised p-4">
        {/* Header */}
        <div className="mb-3 text-center">
          <h2 className="font-pixel text-base text-gold-glow">{items.length} ITEMS FOUND</h2>
          <p className="font-vt text-px-dim text-xs">Sorted by rarity</p>
        </div>

        <div className="game-scrollbar mb-3 grid min-h-0 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {sortedItems.map((item) => {
            const base = ITEM_MAP[item.itemId];
            if (!base) return null;
            const rc = RARITY_COLORS[base.rarity];
            return (
              <div
                key={item.uid}
                className={`item-slot rarity-${base.rarity} flex min-h-[54px] items-center gap-2 rounded-lg border px-2 py-1.5 anim-reveal`}
                style={{
                  borderColor: rc,
                  background: `radial-gradient(circle at 50% 22%, ${rc}18, transparent 54%), linear-gradient(160deg,#171815,#080a0b)`,
                }}
              >
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-white/[.06] bg-black/25">
                  <ItemArtwork itemId={base.id} name={base.name} fallback={base.icon} className="text-2xl" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-vt text-sm font-bold leading-tight" style={{ color: rc }}>{base.name}</div>
                  <div className="mt-0.5 truncate text-[10px] text-px-dim">
                    {RARITY_LABEL[base.rarity]} · {SLOT_LABEL[base.slot]} · iLvl {item.level} · ⚡ {displayItemPower(item)}
                  </div>
                </div>
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
