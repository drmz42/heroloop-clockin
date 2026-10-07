import { editionStorageKey } from './editionStorage';

// Post-tutorial "Next step" tour on the Seeker battle screen: Mine, then the $SKR Store.
// Presentation only; a step counts as seen once its screen has been opened on this device.
export type SeekerTourStep = 'mine' | 'store';
export const SEEKER_TOUR_EVENT = 'hl:seeker-tour';
export const MINE_OPEN_EVENT = 'hl:mine-open';

const key = (step: SeekerTourStep) => editionStorageKey(`seeker-tour-${step}`);

export function seekerTourSeen(step: SeekerTourStep): boolean {
  try { return window.localStorage.getItem(key(step)) === '1'; } catch { return false; }
}

export function markSeekerTourStep(step: SeekerTourStep): void {
  if (seekerTourSeen(step)) return;
  try { window.localStorage.setItem(key(step), '1'); } catch { /* storage blocked: the card simply stays */ }
  window.dispatchEvent(new Event(SEEKER_TOUR_EVENT));
}
