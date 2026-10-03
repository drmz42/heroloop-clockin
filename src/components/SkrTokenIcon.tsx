export function SkrTokenIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/assets/brand/skr-token.png"
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      className={`inline-block shrink-0 rounded-full object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
