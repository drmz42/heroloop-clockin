// Decorative battle-stage life (drifting fog, rising embers, a slow light shaft). Pure CSS
// animation from src/theme/motion/game-motion.css; hidden unless the motion layer is on.
export function BattleAmbience() {
  return (
    <div className="hl-mo-ambience" aria-hidden="true">
      <i className="hl-mo-shaft" />
      <i className="hl-mo-fog hl-mo-fog-a" />
      <i className="hl-mo-fog hl-mo-fog-b" />
      {Array.from({ length: 18 }, (_, index) => <b key={index} className="hl-mo-ember" />)}
    </div>
  );
}
