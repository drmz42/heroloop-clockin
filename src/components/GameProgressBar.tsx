import { useEffect, useRef, useState } from 'react';
import { ScrollText, Zap } from 'lucide-react';

export function GameProgressBar({ power, readyQuests, identity, onQuestsClick }: {
  power: number; readyQuests: number; identity: string; onQuestsClick: () => void;
}) {
  const previous = useRef({ power, identity });
  const [delta, setDelta] = useState(0);
  useEffect(() => {
    const last = previous.current;
    previous.current = { power, identity };
    setDelta(last.identity === identity ? power - last.power : 0);
    const timer = window.setTimeout(() => setDelta(0), 4000);
    return () => window.clearTimeout(timer);
  }, [power, identity]);
  const format = (value: number) => Math.round(value).toLocaleString('en-US');
  return <aside className="game-progress-bar" aria-label="Team progress">
    <div className="game-progress-power">
      <Zap size={21} aria-hidden="true" />
      <div><span className="game-progress-label">Team Power</span><strong data-team-power={Math.round(power)}>{format(power)}</strong></div>
      <span role="status" className={`game-power-change ${delta > 0 ? 'is-gain' : 'is-loss'}`}>{delta !== 0 && `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`}</span>
    </div>
    <button type="button" onClick={onQuestsClick} className={`game-progress-quests ${readyQuests > 0 ? 'quest-reward-ready' : ''}`} aria-label={readyQuests > 0 ? `Quests, ${readyQuests} rewards ready` : 'Open quests'}>
      <ScrollText size={19} aria-hidden="true" /><span>{readyQuests > 0 ? 'Reward ready' : 'Quests'}<small>{readyQuests > 0 ? `${readyQuests} to claim` : 'Your next goal'}</small></span>
    </button>
  </aside>;
}
