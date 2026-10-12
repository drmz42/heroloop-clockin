/** HeroLoop gold: one minted coin, or a small coin pile for reward tiles. */
export function GoldIcon({ size = 12, stack = false, className }: { size?: number; stack?: boolean; className?: string }) {
  return <img src={stack ? '/assets/ui/gold-pile-v1.webp' : '/assets/ui/gold-coin-v1.webp'} alt="" aria-hidden="true" draggable={false} className={className}
    width={size} height={size} style={{ width: size, height: size, flexShrink: 0, display: 'inline-block', objectFit: 'contain' }} />;
}
