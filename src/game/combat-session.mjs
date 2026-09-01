const ACTIVE_PHASES = new Set(['preparing', 'playing', 'settling']);

/**
 * Owns the browser-side lifetime of one combat wave. Calls from equipment,
 * formation, location and hydration flows may request a new wave, but cannot
 * replace an active one. Their latest request is retained for diagnostics; the
 * normal result handoff starts the next wave from current authoritative state.
 */
export function createCombatSession() {
  let phase = 'idle';
  let generation = 0;
  let activeRequest = null;
  let pendingRequest = null;

  return {
    begin(request) {
      if (ACTIVE_PHASES.has(phase)) {
        pendingRequest = request;
        return null;
      }
      generation += 1;
      phase = 'preparing';
      activeRequest = request;
      pendingRequest = null;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation && phase !== 'idle';
    },
    markPlaying(candidate) {
      if (candidate !== generation || phase !== 'preparing') return false;
      phase = 'playing';
      return true;
    },
    markSettling() {
      if (phase !== 'playing') return null;
      phase = 'settling';
      return generation;
    },
    markIdle(candidate) {
      if (candidate !== generation || phase !== 'settling') return false;
      phase = 'idle';
      activeRequest = null;
      return true;
    },
    markRecovering(candidate) {
      if (candidate !== generation) return false;
      phase = 'recovering';
      activeRequest = null;
      return true;
    },
    reset() {
      generation += 1;
      phase = 'idle';
      activeRequest = null;
      pendingRequest = null;
    },
    snapshot() {
      return { phase, generation, activeRequest, pendingRequest };
    },
  };
}
