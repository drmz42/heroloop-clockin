// Decorative battle-stage life (drifting fog and a slow light shaft). Pure CSS
// animation from src/theme/motion/game-motion.css; hidden unless the motion layer is on.
export function BattleAmbience() {
  return (
    <div className="hl-mo-ambience" aria-hidden="true">
      <i className="hl-mo-shaft" />
      <i className="hl-mo-fog hl-mo-fog-a" />
      <i className="hl-mo-fog hl-mo-fog-b" />
    </div>
  );
}
