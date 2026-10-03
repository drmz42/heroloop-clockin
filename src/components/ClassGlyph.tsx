import { useId } from 'react';
import type { HeroClass } from '@/game/types';
import { CLASS_LABEL } from '@/game/heroes';

// Class-only gear mark: one distinct silhouette and colour per class, so items read at a glance
// without text. Warrior sword, Mage staff with a glowing gem, Assassin crossed daggers,
// Druid antlered oak leaf, Crossbowman crossbow.
const glyphs = (steel: string, glow: string, leaf: string): Record<HeroClass, JSX.Element> => ({
  knight: <>
    <path d="M12 2.2 13.6 4.4V14.6H10.4V4.4Z" fill={steel} stroke="#2a2118" strokeWidth=".6" />
    <path d="M12 3.4V14.2" stroke="#fff6dc" strokeOpacity=".55" strokeWidth=".55" />
    <path d="M6.6 14.4H17.4L16.6 16.2H7.4Z" fill="#e6b74f" stroke="#3b2a12" strokeWidth=".6" />
    <rect x="11" y="16.2" width="2" height="3.6" fill="#7a4a24" stroke="#2a1a0c" strokeWidth=".5" />
    <circle cx="12" cy="20.8" r="1.35" fill="#e6b74f" stroke="#3b2a12" strokeWidth=".5" />
  </>,
  shepherd: <>
    <path d="M12.7 8.6 10.6 21.6" stroke="#7c4f2a" strokeWidth="1.7" strokeLinecap="round" />
    <path d="M12.7 8.6 10.6 21.6" stroke="#c18a52" strokeWidth=".55" strokeLinecap="round" />
    <path d="M9.6 7.2C9.8 9.2 11.2 10 12.8 9.6 14.6 9.2 15.4 7.6 14.8 6" fill="none" stroke="#d9b45f" strokeWidth=".9" strokeLinecap="round" />
    <circle className="class-glyph-orb" cx="12.3" cy="5.6" r="3.4" fill={glow} />
    <path d="M12.3 2.9 14.2 5.6 12.3 8.3 10.4 5.6Z" fill="#c9b6ff" stroke="#f3ecff" strokeWidth=".45" />
  </>,
  assassin: <>
    <g transform="rotate(42 12 12)">
      <path d="M12 2.4 13.3 4.2V13.4H10.7V4.2Z" fill={steel} stroke="#250d0d" strokeWidth=".5" />
      <path d="M8.9 13.4H15.1V14.7H8.9Z" fill="#b8323a" stroke="#2a0a0a" strokeWidth=".45" />
      <rect x="11.2" y="14.7" width="1.6" height="4.6" fill="#3a1d1d" stroke="#150707" strokeWidth=".4" />
    </g>
    <g transform="rotate(-42 12 12)">
      <path d="M12 2.4 13.3 4.2V13.4H10.7V4.2Z" fill={steel} stroke="#250d0d" strokeWidth=".5" />
      <path d="M8.9 13.4H15.1V14.7H8.9Z" fill="#b8323a" stroke="#2a0a0a" strokeWidth=".45" />
      <rect x="11.2" y="14.7" width="1.6" height="4.6" fill="#3a1d1d" stroke="#150707" strokeWidth=".4" />
    </g>
  </>,
  druid: <>
    <path d="M8.4 9.4C7 7.8 6.6 5.6 7.2 3.6M7.6 6.6 5.4 5.6M15.6 9.4C17 7.8 17.4 5.6 16.8 3.6M16.4 6.6 18.6 5.6" fill="none" stroke="#c9a26a" strokeWidth="1.1" strokeLinecap="round" />
    <path d="M12 21.4C8.2 18.8 7 15.6 7.8 12.6 8.4 10.4 10.2 8.8 12 7.4 13.8 8.8 15.6 10.4 16.2 12.6 17 15.6 15.8 18.8 12 21.4Z" fill={leaf} stroke="#123a14" strokeWidth=".6" />
    <path d="M12 8.6V20.4M12 12.4 9.6 10.8M12 12.4 14.4 10.8M12 15.4 9.2 13.8M12 15.4 14.8 13.8M12 18.2 10 17M12 18.2 14 17" fill="none" stroke="#d6f5a8" strokeOpacity=".8" strokeWidth=".55" strokeLinecap="round" />
  </>,
  archer: <>
    <path d="M3.6 9.8C7 6.2 17 6.2 20.4 9.8" fill="none" stroke="#8a5a2c" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M3.6 9.8C7 6.2 17 6.2 20.4 9.8" fill="none" stroke="#d29a5a" strokeWidth=".6" strokeLinecap="round" />
    <path d="M3.8 10 12 13.2 20.2 10" fill="none" stroke="#efe6d2" strokeWidth=".5" />
    <rect x="10.9" y="7.2" width="2.2" height="14.2" rx=".5" fill="#6b4323" stroke="#2a190b" strokeWidth=".5" />
    <path d="M12 2.4 13.2 4.6H10.8Z" fill={steel} stroke="#123033" strokeWidth=".4" />
    <path d="M12 4.6V12.8" stroke="#d8e7e8" strokeWidth=".7" />
    <path d="M10.4 18.6H13.6" stroke="#5fd0d6" strokeWidth=".9" />
  </>,
});

export function ClassGlyph({ heroClass, className = '' }: { heroClass: HeroClass; className?: string }) {
  // Per-instance gradient ids: a shared id breaks when its first copy sits in a hidden panel.
  const id = useId().replace(/:/g, '');
  return (
    <span className={`class-glyph class-glyph-${heroClass} ${className}`} title={`${CLASS_LABEL[heroClass]} only`} aria-label={`${CLASS_LABEL[heroClass]} only`} role="img">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8f9aa3" /><stop offset=".5" stopColor="#f1f4f6" /><stop offset="1" stopColor="#7d8790" /></linearGradient>
          <radialGradient id={`${id}g`}><stop offset="0" stopColor="#efe4ff" /><stop offset=".45" stopColor="#a979ff" stopOpacity=".85" /><stop offset="1" stopColor="#6d38ff" stopOpacity="0" /></radialGradient>
          <linearGradient id={`${id}l`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8fdc5a" /><stop offset="1" stopColor="#2f7a2a" /></linearGradient>
        </defs>
        {glyphs(`url(#${id}s)`, `url(#${id}g)`, `url(#${id}l)`)[heroClass]}
      </svg>
    </span>
  );
}
