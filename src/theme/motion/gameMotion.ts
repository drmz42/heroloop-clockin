// Interface motion layer (src/theme/motion/game-motion.css): screen entrances, press feedback, tab
// bar pop, battle ambience and value pops. It only adds animations; it never changes layout,
// rules or values. 2026-10-06 Founder request ("more alive, not a set of buttons") with fast
// rollback: on by default in the Seeker build only; ?motion=off on any URL turns it off for that
// browser (remembered in localStorage) and ?motion=on returns it. The in-game battle animation
// setting "Off" and the system Reduced Motion preference also disable every effect of this layer.
export type UiMotion = 'on' | 'off';

const STORAGE_KEY = 'heroloop-ui-motion';
const isMotion = (value: unknown): value is UiMotion => value === 'on' || value === 'off';

export const defaultUiMotion: UiMotion =
  import.meta.env.VITE_EDITION === 'seeker' || ['staging2', 'seeker'].includes(import.meta.env.MODE) ? 'on' : 'off';

export function resolveUiMotion(): UiMotion {
  try {
    const requested = new URLSearchParams(window.location.search).get('motion');
    if (isMotion(requested)) {
      window.localStorage.setItem(STORAGE_KEY, requested);
      return requested;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isMotion(saved)) return saved;
  } catch {
    // Storage can be blocked; fall back to the build default.
  }
  return defaultUiMotion;
}

export function applyUiMotion(motion: UiMotion) {
  document.documentElement.dataset.hlMotion = motion;
}
