export function HeroTokenIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/assets/brand/skr-token.png"
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      className={`inline-block shrink-0 object-contain drop-shadow-[0_0_6px_rgba(234,179,55,.5)] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
