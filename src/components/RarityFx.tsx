import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { Rarity } from '@/game/types';
import '@/theme/scene/rarity.css';

// Rarity frames v4 (docs/game/rarities.md; Founder 2026-10-04: frames must complement the art, not dominate).
// Each tier's forged frame art is drawn as a 9-slice: corners keep their proportions, bars repeat, crests are
// separate layers, and the thickness follows the box (about 6% of its width). A matte keeps the picture inside
// the opening and a silhouette mask on the box hides any backing outside the frame. Code adds only light:
// Rare inner light, Legendary+ glint, Mythic+ aura and motes, Divine+ rays. Decorative only: drop inside a
// `position: relative; overflow: hidden` box.
const TIER: Record<Rarity, number> = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6, relic: 7, cosmic: 7, divine: 8, celestial: 9, cursed: 10, immortal: 11, god: 12 };
const MOTES: Partial<Record<Rarity, number>> = { mythic: 3, cosmic: 4, relic: 4, divine: 3, celestial: 3, cursed: 3, immortal: 3, god: 4 };
const ART: Partial<Record<Rarity, Rarity>> = { relic: 'cosmic' };
const CRESTS: Partial<Record<Rarity, ('top' | 'bottom')[]>> = { legendary: ['top'], mythic: ['top'], cosmic: ['top'], divine: ['top', 'bottom'], celestial: ['top', 'bottom'], cursed: ['top', 'bottom'], immortal: ['top', 'bottom'], god: ['top', 'bottom'] };
const BW_RATIO = 0.12;

// `tcg` is the collectible hero card (Founder 2026-10-04: heroes are summoned like cards): a thin card rim with a
// rarity gem and a name banner, drawn whole on a fixed 3:4 box; `label` is written into the banner.
export function RarityFx({ rarity, shape = 'card', label }: { rarity: Rarity; shape?: 'card' | 'slot' | 'tcg'; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const tier = TIER[rarity] ?? 1;
  const motes = MOTES[rarity] ?? 0;
  const art = ART[rarity] ?? rarity;
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    if (shape === 'tcg') return;
    const apply = () => { const width = host.clientWidth; if (width > 0) host.style.setProperty('--rx-bw', `${Math.max(4, Math.round(width * BW_RATIO))}px`); };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    return () => observer.disconnect();
  }, [shape]);
  return <span ref={ref} className={`rx rx-${art} rx-${shape}`} data-tier={tier} aria-hidden="true">
    <span className="rx-matte" />
    {tier >= 3 && <span className="rx-light" />}
    {tier >= 8 && <span className="rx-rays" />}
    {tier >= 6 && <span className="rx-aura" />}
    {motes > 0 && <span className="rx-motes">{Array.from({ length: motes }, (_, i) => <i key={i} style={{ '--m': i } as CSSProperties} />)}</span>}
    {tier >= 5 && <span className="rx-glint" />}
    <span className="rx-frame" style={shape === 'tcg' ? { backgroundImage: `url('/assets/ui/rarity-frames/${art}-tcg.webp')` } : undefined} />
    {shape === 'tcg' && label && <span className="rx-banner"><b>{label}</b></span>}
    {shape !== 'tcg' && (CRESTS[art] ?? []).map((side) => <span key={side} className={`rx-crest rx-crest-${side}`} style={{ backgroundImage: `url('/assets/ui/rarity-frames/${art}-${shape}-crest-${side}.webp')` }} />)}
  </span>;
}
