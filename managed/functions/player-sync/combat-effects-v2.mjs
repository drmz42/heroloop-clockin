export const COMBAT_EFFECTS_V2_VERSION = 'combat-effects-v2-team-contributions-candidate-2026.09.06-v1';

const SERVER_EFFECTS_V2 = {
  knight: {
    coreTrait: { id: 'core.warrior.bulwark', kind: 'stat-modifier', magnitude: { maxHpMultiplier: 1.15, defMitigationCap: .6 } },
    teamContribution: { id: 'team.warrior.guardian-aegis', kind: 'barrier', trigger: { cooldownMs: 10_000 }, magnitude: { sourceMaxHpFraction: .06 }, durationMs: 5_000, eventKind: 'barrier-applied' },
  },
  shepherd: {
    coreTrait: { id: 'core.mage.arcane-echo', kind: 'echo-damage', trigger: { kind: 'landed-hit-count', every: 5 }, magnitude: { triggerFinalDamageFraction: .5 }, cap: { recursiveTriggers: 0 } },
    teamContribution: { id: 'team.mage.arcane-mark', magnitude: { otherAllyDamageMultiplier: 1.04 }, durationMs: 4_000, eventKind: 'status-applied' },
  },
  assassin: {
    coreTrait: { id: 'core.assassin.predator', kind: 'stat-modifier', magnitude: { criticalChancePoints: .05, baseDodgePointsRetained: .05 } },
    teamContribution: { id: 'team.assassin.expose', trigger: { cooldownMs: 6_000 }, magnitude: { allyDefenseIgnoreFraction: .06 }, durationMs: 4_000, eventKind: 'status-applied' },
  },
  druid: {
    coreTrait: { id: 'core.druid.wild-growth', kind: 'stat-modifier', magnitude: { maxHpMultiplier: 1.1 } },
    teamContribution: { id: 'team.druid.wild-growth-heal', trigger: { cooldownMs: 3_000 }, magnitude: { targetMaxHpFraction: .012 }, eventKind: 'team-heal' },
  },
  archer: {
    coreTrait: { id: 'core.crossbowman.deadeye', kind: 'stat-modifier', magnitude: { attackSpeedPoints: .08, criticalDamagePoints: .25 } },
    teamContribution: { id: 'team.crossbowman.suppressing-fire', trigger: { every: 5 }, magnitude: { attackSpeedReductionFraction: .08 }, durationMs: 4_000, eventKind: 'status-applied' },
  },
};

export function serverEffectForClass(classId, layer) {
  const effect = SERVER_EFFECTS_V2[classId]?.[layer];
  if (!effect) throw new Error('unknown_server_combat_effect');
  return structuredClone(effect);
}

const boundedElapsed = (elapsedMs) => Math.max(0, Math.min(Number.isFinite(elapsedMs) ? elapsedMs : 0, 60_000));

export function canonicalEffectForClass(registry, classId, layer) {
  if (registry?.registryVersion !== COMBAT_EFFECTS_V2_VERSION) throw new Error('combat_effect_registry_version_mismatch');
  if (registry.activation?.runtime !== true || registry.activation?.staging !== true || registry.activation?.production !== false) throw new Error('combat_effect_registry_activation_mismatch');
  if (layer !== 'coreTrait' && layer !== 'teamContribution') throw new Error('unknown_combat_effect_layer');
  const effect = registry.classes?.[classId]?.[layer];
  if (!effect?.id) throw new Error('unknown_combat_effect');
  return structuredClone(effect);
}

export function tickSourceCooldown(state, effectId, cooldownMs, elapsedMs) {
  if (!effectId || !Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new Error('invalid_combat_effect_cooldown');
  const cooldowns = { ...(state?.cooldowns ?? {}) };
  const current = Math.max(0, Number(cooldowns[effectId]) || 0);
  const total = current + boundedElapsed(elapsedMs);
  const due = total >= cooldownMs;
  cooldowns[effectId] = due ? total % cooldownMs : total;
  return { state: { ...(state ?? {}), cooldowns }, due };
}

export function advanceTriggeredCooldown(state, effectId, cooldownMs, elapsedMs) {
  if (!effectId || !Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new Error('invalid_combat_effect_cooldown');
  const cooldowns = { ...(state?.cooldowns ?? {}) };
  const current = Object.hasOwn(cooldowns, effectId) ? Math.max(0, Number(cooldowns[effectId]) || 0) : cooldownMs;
  cooldowns[effectId] = Math.min(cooldownMs, current + boundedElapsed(elapsedMs));
  return { ...(state ?? {}), cooldowns };
}

export function consumeTriggeredCooldown(state, effectId, cooldownMs) {
  if ((Number(state?.cooldowns?.[effectId]) || 0) < cooldownMs) return { state, consumed: false };
  return { state: { ...(state ?? {}), cooldowns: { ...(state?.cooldowns ?? {}), [effectId]: 0 } }, consumed: true };
}

export function recordLandedHit(state, effectId, every) {
  if (!effectId || !Number.isInteger(every) || every <= 0) throw new Error('invalid_combat_effect_hit_trigger');
  const hitCounts = { ...(state?.hitCounts ?? {}) };
  const next = (Math.max(0, Math.trunc(Number(hitCounts[effectId]) || 0)) + 1) % every;
  hitCounts[effectId] = next;
  return { state: { ...(state ?? {}), hitCounts }, due: next === 0 };
}

export function resolveEchoDamage(effect, triggerFinalDamage, inheritedCritical) {
  const fraction = Number(effect?.magnitude?.triggerFinalDamageFraction);
  if (effect?.kind !== 'echo-damage' || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error('invalid_combat_effect_echo');
  }
  const amount = Math.max(0, Math.round(Math.max(0, Number(triggerFinalDamage) || 0) * fraction));
  return { amount, inheritedCritical: inheritedCritical === true, recursiveTriggers: 0 };
}

export function selectLowestHpPercentAlly(units) {
  return [...units]
    .filter((unit) => unit?.alive === true && Number(unit.maxHp) > 0)
    .sort((left, right) => (left.hp / left.maxHp) - (right.hp / right.maxHp) || String(left.uid).localeCompare(String(right.uid)))[0];
}

export function applyCappedTargetEffect(activeEffects, effect, sourceUid, appliedAtMs) {
  if (!effect?.id || !Number.isFinite(effect.durationMs) || effect.durationMs <= 0) throw new Error('invalid_combat_effect_duration');
  const now = Math.max(0, Number(appliedAtMs) || 0);
  const current = activeEffects?.[effect.id];
  const sourceUids = [...new Set([...(current?.sourceUids ?? []), String(sourceUid)])].sort();
  const next = {
    effectId: effect.id,
    magnitude: structuredClone(effect.magnitude),
    sourceUids,
    appliedAtMs: current?.appliedAtMs ?? now,
    expiresAtMs: Math.max(current?.expiresAtMs ?? 0, now + effect.durationMs),
    stacks: 1,
  };
  return {
    activeEffects: { ...(activeEffects ?? {}), [effect.id]: next },
    event: {
      kind: current ? 'status-refreshed' : effect.eventKind,
      effectId: effect.id,
      sourceUid: String(sourceUid),
      durationMs: effect.durationMs,
      refresh: Boolean(current),
    },
  };
}

export function pruneExpiredTargetEffects(activeEffects, elapsedMs) {
  const now = Math.max(0, Number(elapsedMs) || 0);
  return Object.fromEntries(Object.entries(activeEffects ?? {}).filter(([, effect]) => Number(effect.expiresAtMs) > now));
}
