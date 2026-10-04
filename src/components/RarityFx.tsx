import type { CSSProperties } from 'react';
import type { Rarity } from '@/game/types';
import '@/theme/scene/rarity.css';

// Rarity frames v2 (docs/game/rarities.md, Founder 2026-10-04: "real ornate borders, more detail"). Every
// tier uses the game's forged 9-slice frame, re-metalled per rarity, and each step up adds detail:
// Rare inner light, Epic corner gems, Legendary crest and glint, Mythic+ aura and motes, Divine+ rays
// and a lower crest. Decorative only: drop inside a `position: relative; overflow: hidden` art box.
// Motion is transform/opacity only and stops under Reduced Motion, `.sc-still` and `.game-motion-off`.
const TIER: Record<Rarity, number> = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6, relic: 7, cosmic: 7, divine: 8, celestial: 9, cursed: 10, immortal: 11, god: 12 };
const MOTES: Partial<Record<Rarity, number>> = { mythic: 3, cosmic: 4, relic: 4, divine: 3, celestial: 3, cursed: 3, immortal: 3, god: 4 };

export function RarityFx({ rarity, compact = false }: { rarity: Rarity; compact?: boolean }) {
  const tier = TIER[rarity] ?? 1;
  const motes = MOTES[rarity] ?? 0;
  return <span className={`rx rx-${rarity}${compact ? ' rx-compact' : ''}`} data-tier={tier} aria-hidden="true">
    {tier >= 3 && <span className="rx-light" />}
    {tier >= 8 && <span className="rx-rays" />}
    {tier >= 6 && <span className="rx-aura" />}
    {motes > 0 && <span className="rx-motes">{Array.from({ length: motes }, (_, i) => <i key={i} style={{ '--m': i } as CSSProperties} />)}</span>}
    {tier >= 5 && <span className="rx-glint" />}
    <span className="rx-frame" />
    {tier >= 4 && <span className="rx-gems"><i /><i /><i /><i /></span>}
    {tier >= 5 && <span className="rx-crest" />}
    {tier >= 8 && <span className="rx-crest rx-crest-low" />}
  </span>;
}
