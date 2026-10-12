import { useId } from 'react';

/** Minted gold coin face (rim, beaded edge, crown emblem, shine) drawn in a 32×32 box. */
function Coin({ id, x = 0, y = 0, scale = 1, shade = 0 }: { id: string; x?: number; y?: number; scale?: number; shade?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <circle cx="16" cy="16.6" r="14.6" fill="#3a1d03" />
    <circle cx="16" cy="16" r="14.6" fill={`url(#${id}r)`} />
    <circle cx="16" cy="16" r="12.9" fill="none" stroke="#fff3b8" strokeOpacity=".55" strokeWidth="1.1" strokeDasharray="0.1 2.02" strokeLinecap="round" />
    <circle cx="16" cy="16" r="11.4" fill="#6b3a06" />
    <circle cx="16" cy="16.5" r="10.8" fill={`url(#${id}f)`} />
    <circle cx="16" cy="16" r="10.8" fill="none" stroke="#fff0a8" strokeOpacity=".7" strokeWidth=".6" />
    <path d="M9.6 20.4 8.4 12.3l4.3 3.3L16 9.7l3.3 5.9 4.3-3.3-1.2 8.1z" fill="#7a4306" transform="translate(.5 .7)" />
    <path d="M9.6 20.4 8.4 12.3l4.3 3.3L16 9.7l3.3 5.9 4.3-3.3-1.2 8.1z" fill={`url(#${id}e)`} stroke="#fff6c7" strokeOpacity=".75" strokeWidth=".45" strokeLinejoin="round" />
    <rect x="9.4" y="21.3" width="13.2" height="1.9" rx=".7" fill={`url(#${id}e)`} stroke="#7a4306" strokeWidth=".4" />
    <circle cx="16" cy="15.4" r="1.05" fill="#d8323a" stroke="#5a0f12" strokeWidth=".35" />
    <path d="M6.2 11.2A11 11 0 0 1 14 5.4" fill="none" stroke="#fffbe0" strokeWidth="1.4" strokeLinecap="round" opacity=".85" />
    {shade > 0 && <circle cx="16" cy="16" r="14.6" fill="#2a1402" opacity={shade} />}
  </g>;
}

function Defs({ id }: { id: string }) {
  return <defs>
    <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#fff2a6" /><stop offset=".35" stopColor="#f2b52a" /><stop offset=".7" stopColor="#b26d0c" /><stop offset="1" stopColor="#5e3104" />
    </linearGradient>
    <radialGradient id={`${id}f`} cx=".38" cy=".32" r=".8">
      <stop offset="0" stopColor="#ffe98a" /><stop offset=".45" stopColor="#e9a521" /><stop offset="1" stopColor="#8a4d07" />
    </radialGradient>
    <linearGradient id={`${id}e`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#fffbe2" /><stop offset=".5" stopColor="#ffd45a" /><stop offset="1" stopColor="#c98315" />
    </linearGradient>
  </defs>;
}

/** HeroLoop gold: one minted coin, or a small stacked pile for reward tiles. */
export function GoldIcon({ size = 12, stack = false, className }: { size?: number; stack?: boolean; className?: string }) {
  const id = `gi${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox={stack ? '0 0 40 40' : '0 0 32 32'} style={{ flexShrink: 0, display: 'inline-block', overflow: 'visible' }}>
    <Defs id={id} />
    {stack ? <>
      <ellipse cx="20" cy="35.5" rx="17" ry="3.2" fill="#000" opacity=".45" />
      <Coin id={id} x={1} y={14} scale={0.72} shade={0.3} />
      <Coin id={id} x={17} y={13} scale={0.7} shade={0.3} />
      <Coin id={id} x={6} y={2} scale={0.95} />
    </> : <Coin id={id} />}
  </svg>;
}
