// Staging kill switches (config/feature-flags.v1.json). A flag only pauses:
// while it is off the listed command is refused before it touches state, and
// nothing a flag does can enable a feature, grant or refund anything.
//
// The paused set is read from heroloop_api.feature_flags_paused() at most once
// per CACHE_MS, and only when the command is one a flag names, so ordinary
// commands never pay for it. If the read fails the command proceeds: the
// command needs the same database, so an outage fails it anyway, and a flag
// read must never become a second way for the game to go down.
import registry from "./feature_flags.generated.json" with { type: "json" };

const CACHE_MS = 5_000;
const flagByAction: Record<string, string> = registry.actions;

export type PausedReader = () => Promise<unknown>;

export function createFeatureFlagGate(readPaused: PausedReader, now: () => number = Date.now) {
  let cached: { at: number; paused: Set<string> } | null = null;
  let pending: Promise<Set<string>> | null = null;

  async function pausedSet(): Promise<Set<string>> {
    if (cached && now() - cached.at < CACHE_MS) return cached.paused;
    if (!pending) {
      pending = (async () => {
        const result = await readPaused() as { paused?: unknown } | null;
        const list = Array.isArray(result?.paused) ? result.paused.filter((key): key is string => typeof key === "string") : [];
        cached = { at: now(), paused: new Set(list) };
        return cached.paused;
      })().finally(() => {
        pending = null;
      });
    }
    return await pending;
  }

  // The flag key that pauses this action right now, or null.
  return async function pausedFlagFor(action: string): Promise<string | null> {
    const flag = flagByAction[action];
    if (!flag) return null;
    try {
      return (await pausedSet()).has(flag) ? flag : null;
    } catch {
      return null;
    }
  };
}
