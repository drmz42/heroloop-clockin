// Numbers that hit one fighter play one after another: damage first, then misses,
// heals and text effects (poison, MEND, BARRIER...). Presentation only.
export const FLOATER_QUEUE_GAP_MS = 320;
export const MAX_FLOATER_QUEUE_MS = 960;

const isDamage = (floater) => !floater.miss && !floater.heal && !floater.effect && !floater.label;

export function scheduleFloaters(batch, now, nextFree) {
  return batch
    .map((floater, index) => ({ floater, index }))
    .sort((a, b) => Number(!isDamage(a.floater)) - Number(!isDamage(b.floater)) || a.index - b.index)
    .map(({ floater }) => {
      const start = Math.min(Math.max(now, nextFree.get(floater.targetUid) ?? 0), now + MAX_FLOATER_QUEUE_MS);
      nextFree.set(floater.targetUid, start + FLOATER_QUEUE_GAP_MS);
      return { ...floater, born: now, delayMs: Math.round(start - now) };
    });
}
