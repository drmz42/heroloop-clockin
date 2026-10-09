import { useState } from 'react';
import { createPortal } from 'react-dom';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP, RARITY_COLORS } from '@/game/heroes';
import type { DungeonChestStatus, OwnedHero, Rarity } from '@/game/types';
import { DUNGEON_CHEST_NUMERAL as NUMERAL, dungeonChestTitle, type DungeonChestDepth } from '@/game/dungeonChests';

const ORDER: Rarity[] = ['celestial', 'divine', 'cosmic', 'mythic', 'legendary', 'epic'];
const LABEL: Partial<Record<Rarity, string>> = { celestial: 'Celestial', divine: 'Divine', cosmic: 'Cosmic', mythic: 'Mythic', legendary: 'Legendary', epic: 'Epic' };
const OPEN_ERRORS: Record<string, string> = {
  hero_capacity_exceeded: 'Your Hero roster is full. Release or upgrade capacity first.',
  resource_insufficient_balance: 'No chest of this Depth is left.',
  account_restricted: 'This account cannot receive rewards right now.',
};

export function DungeonChestArt({ depth, size = 48 }: { depth: number; size?: number }) {
  return <span className={`dungeon-chest-art depth-${depth}`} style={{ width: size, height: size }} aria-hidden="true">
    <img src="/assets/ui/chest-ceremony-v1.webp" alt="" width={size} height={size} decoding="async" draggable={false} />
    <b>{NUMERAL[depth as DungeonChestDepth] ?? depth}</b>
  </span>;
}

export function DungeonChestSlot({ depth, count, selected, onSelect }: { depth: DungeonChestDepth; count: number; selected: boolean; onSelect: () => void }) {
  return <button type="button" aria-label={`${dungeonChestTitle(depth)}: ${count}`} aria-pressed={selected} onClick={onSelect} title={`${dungeonChestTitle(depth)}: ${count}`}
    className={`item-slot dungeon-chest-slot depth-${depth} relative flex aspect-square min-w-0 w-full items-center justify-center overflow-hidden border ${selected ? 'is-selected' : ''}`}>
    <span className="resource-slot-art"><DungeonChestArt depth={depth} /></span>
    <span className="dungeon-chest-count ui-text-small absolute bottom-0 right-0 z-10 min-w-3 rounded-tl px-px text-center font-bold leading-3">{count}</span>
  </button>;
}

export function DungeonChestPanel({ depth, status, opening, onOpen }: {
  depth: DungeonChestDepth; status: DungeonChestStatus; opening: boolean;
  onOpen: (depth: DungeonChestDepth) => Promise<{ hero: OwnedHero } | { error: string }>;
}) {
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<OwnedHero | null>(null);
  const odds = status.odds[String(depth)] ?? {};
  const count = status.balances[depth];
  const open = async () => {
    setError('');
    const result = await onOpen(depth);
    if ('hero' in result) setRevealed(result.hero);
    else if (result.error !== 'busy') setError(OPEN_ERRORS[result.error] ?? 'The chest could not be opened. Please try again.');
  };
  return <div className={`dungeon-chest-panel depth-${depth} mt-2 rounded-lg border p-2`}>
    <div className="flex items-center gap-2">
      <DungeonChestArt depth={depth} size={52} />
      <div className="min-w-0">
        <strong className="ui-text-large block text-[#efe4ce]">{dungeonChestTitle(depth)}</strong>
        <span className="ui-text-small text-[#9b9283]">Owned: {count} · Contains one Hero</span>
      </div>
    </div>
    <ul className="dungeon-chest-odds" aria-label="Hero rarity odds">
      {ORDER.filter((rarity) => (odds[rarity] ?? 0) > 0).map((rarity) => <li key={rarity} style={{ color: RARITY_COLORS[rarity] }}>
        <span>{LABEL[rarity]}</span><b>{odds[rarity]}%</b>
      </li>)}
    </ul>
    {error && <p role="alert" className="ui-text-small mt-1.5 text-red-300">{error}</p>}
    <button type="button" disabled={count < 1 || opening} onClick={() => void open()} className="game-control game-primary mt-2 !min-h-[44px] w-full px-3 py-2 ui-text-medium font-bold disabled:opacity-55">
      {opening ? 'Opening…' : 'Open Dungeon Chest'}
    </button>
    {revealed && <DungeonChestReveal depth={depth} hero={revealed} onClose={() => setRevealed(null)} />}
  </div>;
}

function DungeonChestReveal({ depth, hero, onClose }: { depth: DungeonChestDepth; hero: OwnedHero; onClose: () => void }) {
  const base = HERO_MAP[hero.heroId];
  if (!base) return null;
  const color = RARITY_COLORS[base.rarity];
  return createPortal(<div className={`hl-portal dungeon-chest-reveal rarity-${base.rarity}`} role="dialog" aria-modal="true" aria-label={`${dungeonChestTitle(depth)} opened`} style={{ position: 'fixed', zIndex: 9999 }}>
    <div className="dungeon-chest-reveal-card" style={{ ['--reveal-color' as string]: color }}>
      <small>{dungeonChestTitle(depth).toUpperCase()}</small>
      <div className="dungeon-chest-reveal-hero"><HeroPortrait heroClass={base.heroClass} heroId={base.id} rarity={base.rarity} color={base.color} size={132} priority /></div>
      <em style={{ color }}>{LABEL[base.rarity] ?? base.rarity}</em>
      <strong>{base.name}</strong>
      <p>Added to your Heroes.</p>
      <button type="button" autoFocus className="game-control game-primary" onClick={onClose}>CONTINUE</button>
    </div>
  </div>, document.body);
}
