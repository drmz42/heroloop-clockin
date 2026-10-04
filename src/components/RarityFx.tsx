import type { CSSProperties } from 'react';
import type { Rarity } from '@/game/types';
import '@/theme/scene/rarity.css';

// Rarity frames v3 (docs/game/rarities.md, Founder 2026-10-04: "real ornate borders, more detail"). Each
// tier has its own forged frame art (public/assets/ui/rarity-frames, a card 3:4 and a slot 1:1 cut) whose
// ornament grows with tier; a matte keeps the picture inside the frame's opening; code adds only light: Rare inner light, Legendary+ glint, Mythic+ aura and
// motes, Divine+ rays. Decorative only: drop inside a `position: relative; overflow: hidden` art box of
// the matching aspect ratio.
// Motion is transform/opacity only and stops under Reduced Motion, `.sc-still` and `.game-motion-off`.
const ART: Partial<Record<Rarity, Rarity>> = { relic: 'cosmic' };
const TIER: Record<Rarity, number> = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6, relic: 7, cosmic: 7, divine: 8, celestial: 9, cursed: 10, immortal: 11, god: 12 };
const MOTES: Partial<Record<Rarity, number>> = { mythic: 3, cosmic: 4, relic: 4, divine: 3, celestial: 3, cursed: 3, immortal: 3, god: 4 };

export function RarityFx({ rarity, shape = 'card' }: { rarity: Rarity; shape?: 'card' | 'slot' }) {
  const tier = TIER[rarity] ?? 1;
  const motes = MOTES[rarity] ?? 0;
  const art = ART[rarity] ?? rarity;
  return <span className={`rx rx-${rarity} rx-${shape}`} data-tier={tier} aria-hidden="true">
    <span className="rx-matte" />
    {tier >= 3 && <span className="rx-light" />}
    {tier >= 8 && <span className="rx-rays" />}
    {tier >= 6 && <span className="rx-aura" />}
    {motes > 0 && <span className="rx-motes">{Array.from({ length: motes }, (_, i) => <i key={i} style={{ '--m': i } as CSSProperties} />)}</span>}
    {tier >= 5 && <span className="rx-glint" />}
    <span className="rx-frame" style={{ backgroundImage: `url('/assets/ui/rarity-frames/${art}-${shape}.webp')` }} />
  </span>;
}
