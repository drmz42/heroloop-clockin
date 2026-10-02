import { useEffect, useRef, useState } from 'react';
import { Rocket, Zap } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP } from '@/game/heroes';

// The phone top bar's Commander avatar opens the Commander sheet in MainScreen.
export const COMMANDER_OPEN_EVENT = 'hl:commander-open';
export const BATTLE_ACTIONS_SLOT = 'battle-entry-actions-slot';

export function GameProgressBar({ power, identity, commander, boost }: {
  power: number; readyQuests: number; identity: string; onQuestsClick: () => void;
  objective?: { label: string; progress: number; target: number } | null;
  commander?: { heroId: string; level: number };
  boost?: { active: boolean; onClick: () => void };
}) {
  const avatar = commander ? HERO_MAP[commander.heroId] : undefined;
  const previous = useRef({ power, identity });
  const [delta, setDelta] = useState(0);
  useEffect(() => {
    const last = previous.current;
    previous.current = { power, identity };
    setDelta(last.identity === identity ? power - last.power : 0);
    const timer = window.setTimeout(() => setDelta(0), 4000);
    return () => window.clearTimeout(timer);
  }, [power, identity]);
  const format = (value: number) => value >= 1_000_000
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : Math.round(value).toLocaleString('en-US');
  return <aside className="game-progress-bar" aria-label="Team progress">
    <div className="game-progress-power">
      <Zap size={21} aria-hidden="true" />
      <div><span className="game-progress-label">Team Power</span><strong title={Math.round(power).toLocaleString('en-US')} data-team-power={Math.round(power)}>{format(power)}</strong></div>
      <span role="status" className={`game-power-change ${delta > 0 ? 'is-gain' : 'is-loss'}`}>{delta !== 0 && `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`}</span>
    </div>
    {commander && avatar && <button type="button" className="game-progress-commander" onClick={() => window.dispatchEvent(new Event(COMMANDER_OPEN_EVENT))} aria-label={`Commander, level ${commander.level}`}>
      <HeroPortrait heroId={avatar.id} heroClass={avatar.heroClass} rarity={avatar.rarity} color={avatar.color} size={40} />
      <b>{commander.level}</b>
    </button>}
    {boost && <button type="button" className={`game-progress-boost ${boost.active ? 'is-active' : ''}`} onClick={boost.onClick} aria-label={boost.active ? 'Boost Max active' : 'Open Boost Max'}>
      <Rocket size={17} aria-hidden="true" /><span>{boost.active ? 'Boost on' : 'Boost max'}</span>
    </button>}
    <div id={BATTLE_ACTIONS_SLOT} className="game-progress-encounters" aria-label="Encounter actions" />
  </aside>;
}
