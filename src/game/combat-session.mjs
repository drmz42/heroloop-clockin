const ACTIVE_PHASES = new Set(['preparing', 'playing', 'settling']);

/**
 * Owns the browser-side lifetime of one combat wave. Calls from equipment,
 * formation, location and hydration flows may request a new wave, but cannot
 * replace an active one. Their latest request is retained for diagnostics; the
 * normal result handoff starts the next wave from current authoritative state.
 */
export function createCombatSession(now = Date.now) {
  let phase = 'idle';
  let generation = 0;
  let activeRequest = null;
  let pendingRequest = null;
  let lastProgressAt = now();

  const touch = () => {
    lastProgressAt = now();
  };

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
      touch();
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation && ACTIVE_PHASES.has(phase);
    },
    markPlaying(candidate) {
      if (candidate !== generation || phase !== 'preparing') return false;
      phase = 'playing';
      touch();
      return true;
    },
    markProgress(candidate) {
      if (candidate !== generation || !ACTIVE_PHASES.has(phase)) return false;
      touch();
      return true;
    },
    markSettling() {
      if (phase !== 'playing') return null;
      phase = 'settling';
      touch();
      return generation;
    },
    markIdle(candidate) {
      if (candidate !== generation || phase !== 'settling') return false;
      phase = 'idle';
      activeRequest = null;
      touch();
      return true;
    },
    markRecovering(candidate) {
      if (candidate !== generation) return false;
      phase = 'recovering';
      activeRequest = null;
      touch();
      return true;
    },
    reset() {
      generation += 1;
      phase = 'idle';
      activeRequest = null;
      pendingRequest = null;
      touch();
    },
    snapshot() {
      return { phase, generation, activeRequest, pendingRequest, lastProgressAt };
    },
  };
}

export function combatRecoveryDelay(attempt, reason) {
  if (reason === 'rate_limited') return 65_000;
  return Math.min(30_000, 3_000 * (2 ** Math.max(0, attempt - 1)));
}

export function stalledCombatGeneration(snapshot, observedAt, limits = {}) {
  const limit = limits[snapshot.phase] ?? ({ preparing: 20_000, playing: 15_000, settling: 45_000 })[snapshot.phase];
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(observedAt)) return null;
  return observedAt - snapshot.lastProgressAt >= limit ? snapshot.generation : null;
}
