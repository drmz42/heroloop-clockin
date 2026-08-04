import { useState } from 'react';
import { itemArtSrc, itemArtStyle } from '@/game/art';

export function ItemArtwork({ itemId, name, fallback, className = 'text-2xl leading-none' }: { itemId: string; name: string; fallback: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = itemArtSrc(itemId);
  const style = itemArtStyle(itemId);

  return (
    <span className={`relative block h-full w-full overflow-hidden ${className}`}>
      {failed || !src || !style
        ? <span className="absolute inset-0 grid place-items-center">{fallback}</span>
        : <img src={src} alt={name} loading="lazy" decoding="async" className="absolute max-w-none" style={style} onError={() => setFailed(true)} />}
    </span>
  );
}
