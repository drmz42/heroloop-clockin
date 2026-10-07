import { useRef } from 'react';
import { Lock, Unlock } from 'lucide-react';

// One-shot feedback for player actions (equip, unequip, enchant, lock, team changes). The overlay
// appears only when `watch` changes while `scope` (the item or hero shown) stays the same, so
// opening a screen or switching heroes never plays it. Styles: src/theme/motion/game-motion.css.
export type ActionFxVariant = 'equip' | 'unequip' | 'enchant' | 'lock' | 'unlock' | 'join' | 'leave';

export function ActionFx({ watch, scope = '', variant, downVariant }: { watch: string | number | boolean; scope?: string; variant: ActionFxVariant; downVariant?: ActionFxVariant }) {
  // A numeric watch that goes down (enchant lost, hero left the team) can use its own variant.
  const seen = useRef({ watch, scope, count: 0, down: false });
  if (seen.current.scope !== scope) seen.current = { watch, scope, count: 0, down: false };
  else if (seen.current.watch !== watch) {
    const down = typeof watch === 'number' && typeof seen.current.watch === 'number' && watch < seen.current.watch;
    seen.current = { watch, scope, count: seen.current.count + 1, down };
  }
  if (seen.current.count === 0) return null;
  const shown = seen.current.down && downVariant ? downVariant : variant;
  return (
    <span key={seen.current.count} className={`hl-mo-fx hl-mo-fx-${shown}`} aria-hidden="true">
      {shown === 'lock' ? <Lock /> : shown === 'unlock' ? <Unlock /> : null}
      {shown === 'enchant' && <><i /><i /><i /><i /><i /></>}
    </span>
  );
}
