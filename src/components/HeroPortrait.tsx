import { useState, useMemo } from 'react';
import type { HeroClass, Rarity } from '@/game/types';
import { buildHeroSvg, heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { RARITY_COLORS, RARITY_GLOW } from '@/game/heroes';

interface HeroPortraitProps {
  heroClass: HeroClass;
  heroId?: string;
  rarity: Rarity;
  color: string;
  size?: number;
  onClick?: () => void;
  active?: boolean;
  badge?: string | number;
  respawn?: number; // seconds remaining
  className?: string;
}

export function HeroPortrait({
  heroClass, heroId, rarity, color, size = 64,
  onClick, active, badge, respawn, className = '',
}: HeroPortraitProps) {
  const [imgError, setImgError] = useState(false);
  const rc = RARITY_COLORS[rarity];
  const glow = RARITY_GLOW[rarity];

  const svgSrc = useMemo(
    () => heroId ? heroPortraitSrc(heroId, heroClass, rarity, color) : buildHeroSvg(heroClass, rarity, color),
    [heroId, heroClass, rarity, color]
  );
  const fallbackSrc = useMemo(() => buildHeroSvg(heroClass, rarity, color), [heroClass, rarity, color]);

  const isDead = respawn !== undefined && respawn > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`hero-portrait-rarity rarity-${rarity} relative shrink-0 flex items-center justify-center rounded-xl overflow-hidden transition-transform active:scale-95 select-none ${className}`}
      style={{
        width: size, height: size,
        border: `2px solid ${active ? rc : rc + '66'}`,
        boxShadow: active ? `0 0 16px ${glow}, inset 0 0 12px ${glow}` : `0 0 6px ${rc}44`,
        background: `radial-gradient(circle at 50% 30%, ${color}22, #0a0a14)`,
      }}
    >
      <img
        src={imgError ? fallbackSrc : svgSrc}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="w-full h-full object-cover"
        style={imgError ? undefined : heroPortraitStyle(heroId, heroClass)}
        onError={() => setImgError(true)}
      />

      {/* dead overlay */}
      {isDead && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 rounded-xl">
          <span className="text-xl">💀</span>
          <span className="text-[10px] font-bold text-rose-300 mt-0.5">{respawn}s</span>
        </div>
      )}

      {/* badge (level) */}
      {badge !== undefined && !isDead && (
        <div className="hero-level-badge absolute bottom-0 right-0 rounded-tl-md px-1 font-black text-white">
          Lv {badge}
        </div>
      )}

      {/* active team indicator */}
      {active && !isDead && (
        <div className="absolute top-0 left-0 w-2.5 h-2.5 rounded-br-lg" style={{ background: rc }} />
      )}
    </button>
  );
}
