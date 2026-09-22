import {
  COMBAT_EFFECTS_V2_VERSION,
  advanceTriggeredCooldown,
  applyCappedTargetEffect,
  consumeTriggeredCooldown,
  pruneExpiredTargetEffects,
  recordLandedHit,
  resolveEchoDamage,
  selectLowestHpPercentAlly,
  serverEffectForClass,
  tickSourceCooldown,
} from './combat-effects-v2.mjs';

const V2_EFFECTS = {
  aegis: serverEffectForClass('knight', 'teamContribution'),
  echo: serverEffectForClass('shepherd', 'coreTrait'),
  mark: serverEffectForClass('shepherd', 'teamContribution'),
  expose: serverEffectForClass('assassin', 'teamContribution'),
  heal: serverEffectForClass('druid', 'teamContribution'),
  suppress: serverEffectForClass('archer', 'teamContribution'),
};

const usesCombatEffectsV2 = (unit) => unit.combatEffectsVersion === COMBAT_EFFECTS_V2_VERSION;

export function seededCombatRandom(seed) {
  let state = (Math.floor(seed) | 0) || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = state + 0x6d2b79f5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * @template {import('./combat-step.mjs').CombatStepUnit} T
 * @param {readonly T[]} units
 * @param {number} elapsedMs
 * @param {() => number} [random]
 * @returns {{ units: T[]; events: import('./combat-step.mjs').CombatStepEvent[] }}
 */
export function advanceCombatFrame(units, elapsedMs, random = Math.random) {
  const dt = Math.max(0, Math.min(Number.isFinite(elapsedMs) ? elapsedMs : 0, 100));
  const hpDelta = new Map();
  const healing = new Map();
  const v2Healing = new Map();
  const barriers = new Map();
  const curses = new Map();
  const targetEffects = new Map();
  const aegisBarriers = new Map();
  const events = [];

  const queueTargetEffect = (targetUid, effect, sourceUid) => {
    targetEffects.set(targetUid, [...(targetEffects.get(targetUid) ?? []), { effect, sourceUid }]);
  };

  const updated = units.map((original) => {
    if (!original.alive) return original;
    let unit = original;
    if (usesCombatEffectsV2(unit) || unit.activeEffectsV2 || unit.aegisBarrierV2) {
      const effectClockMsV2 = Math.max(0, Number(unit.effectClockMsV2) || 0) + dt;
      unit = {
        ...unit,
        effectClockMsV2,
        activeEffectsV2: pruneExpiredTargetEffects(unit.activeEffectsV2, effectClockMsV2),
      };
      if (unit.aegisBarrierV2 && unit.aegisBarrierV2.expiresAtMs <= effectClockMsV2) delete unit.aegisBarrierV2;
    }
    if ((unit.curseRemainingMs ?? 0) > 0) unit = { ...unit, curseRemainingMs: Math.max(0, unit.curseRemainingMs - dt) };
    if ((unit.regenPerSecond ?? (unit.heroClass === 'druid' ? .004 : 0)) > 0 && unit.regenTimer !== undefined) {
      const regenTimer = unit.regenTimer + dt;
      if (regenTimer >= 3000) {
        const amount = Math.min(Math.round(unit.maxHp * (unit.regenPerSecond ?? .004) * 3), unit.maxHp - unit.hp);
        if (amount > 0) events.push({ kind: 'heal', targetUid: unit.uid, amount });
        unit = { ...unit, hp: unit.hp + amount, regenTimer: 0 };
      } else unit = { ...unit, regenTimer };
    }

    const legacyAbilityTimer = Number.isFinite(Number(unit.abilityTimer)) ? Math.max(0, Number(unit.abilityTimer)) : 0;
    const effectCooldowns = { ...(unit.effectCooldowns ?? {}) };
    const tickEffect = (effectId, intervalMs, applyEffect) => {
      const stored = Number(effectCooldowns[effectId]);
      const elapsed = (Number.isFinite(stored) ? Math.max(0, stored) : legacyAbilityTimer) + dt;
      if (elapsed >= intervalMs) {
        applyEffect();
        effectCooldowns[effectId] = 0;
      } else effectCooldowns[effectId] = elapsed;
    };
    const allies = units.filter((fighter) => fighter.side === unit.side && fighter.alive);
    const enemies = units.filter((fighter) => fighter.side !== unit.side && fighter.alive);
    if (usesCombatEffectsV2(unit)) {
      let sourceState = unit.effectSourceStateV2 ?? {};
      if (unit.heroClass === 'knight') {
        const settled = tickSourceCooldown(sourceState, V2_EFFECTS.aegis.id, V2_EFFECTS.aegis.trigger.cooldownMs, dt);
        sourceState = settled.state;
        if (settled.due) {
          const target = selectLowestHpPercentAlly(allies);
          if (target) {
            const amount = Math.round(unit.maxHp * V2_EFFECTS.aegis.magnitude.sourceMaxHpFraction);
            const current = aegisBarriers.get(target.uid);
            aegisBarriers.set(target.uid, {
              effectId: V2_EFFECTS.aegis.id,
              amount: Math.max(current?.amount ?? target.aegisBarrierV2?.amount ?? 0, amount),
              expiresAtMs: (Number(target.effectClockMsV2) || 0) + dt + V2_EFFECTS.aegis.durationMs,
              sourceUids: [...new Set([...(current?.sourceUids ?? target.aegisBarrierV2?.sourceUids ?? []), unit.uid])].sort(),
            });
            events.push({ kind: 'effect', effectId: V2_EFFECTS.aegis.id, sourceUid: unit.uid, targetUid: target.uid, amount, durationMs: V2_EFFECTS.aegis.durationMs });
          }
        }
      }
      if (unit.heroClass === 'druid') {
        const settled = tickSourceCooldown(sourceState, V2_EFFECTS.heal.id, V2_EFFECTS.heal.trigger.cooldownMs, dt);
        sourceState = settled.state;
        if (settled.due) {
          for (const target of allies) {
            const amount = Math.min(Math.round(target.maxHp * V2_EFFECTS.heal.magnitude.targetMaxHpFraction), target.maxHp - target.hp);
            if (amount > (v2Healing.get(target.uid)?.amount ?? 0)) {
              v2Healing.set(target.uid, { amount, sourceUid: unit.uid });
            }
          }
        }
      }
      if (unit.heroClass === 'assassin') {
        sourceState = advanceTriggeredCooldown(sourceState, V2_EFFECTS.expose.id, V2_EFFECTS.expose.trigger.cooldownMs, dt);
      }
      unit = { ...unit, effectSourceStateV2: sourceState };
    }
    if (unit.role === 'support') {
      tickEffect('role.support-heal', 12000, () => {
        const target = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (!target) return;
        const amount = Math.round(target.maxHp * .06);
        healing.set(target.uid, (healing.get(target.uid) ?? 0) + amount);
        events.push({ kind: 'effect', effectId: 'role.support-heal', sourceUid: unit.uid, targetUid: target.uid, amount });
      });
    }
    if (unit.eliteAffix === 'mending') {
      tickEffect('affix.mending-heal', 14000, () => {
        const target = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (!target) return;
        const amount = Math.round(target.maxHp * .06);
        healing.set(target.uid, (healing.get(target.uid) ?? 0) + amount);
        events.push({ kind: 'effect', effectId: 'affix.mending-heal', sourceUid: unit.uid, targetUid: target.uid, amount });
      });
    }
    if (unit.role === 'caster') {
      tickEffect('role.caster-blast', 10000, () => {
        const target = [...enemies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (!target) return;
        const amount = Math.round(unit.atk * 1.2);
        hpDelta.set(target.uid, (hpDelta.get(target.uid) ?? 0) + amount);
        events.push({ kind: 'effect', effectId: 'role.caster-blast', sourceUid: unit.uid, targetUid: target.uid, amount });
      });
    }
    if (unit.eliteAffix === 'lane-blast') {
      tickEffect('affix.lane-blast', 12000, () => {
        const target = [...enemies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (!target) return;
        const amount = Math.round(unit.atk * 1.15);
        hpDelta.set(target.uid, (hpDelta.get(target.uid) ?? 0) + amount);
        events.push({ kind: 'effect', effectId: 'affix.lane-blast', sourceUid: unit.uid, targetUid: target.uid, amount });
      });
    }
    if (unit.eliteAffix === 'barrier') {
      tickEffect('affix.barrier', 14000, () => {
        const target = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (!target) return;
        const amount = Math.round(target.maxHp * .1);
        barriers.set(target.uid, Math.max(target.shield ?? 0, amount));
        events.push({ kind: 'effect', effectId: 'affix.barrier', sourceUid: unit.uid, targetUid: target.uid, amount });
      });
    }
    if (unit.eliteAffix === 'curse') {
      tickEffect('affix.curse', 14000, () => {
        const target = [...enemies].sort((a, b) => b.atk - a.atk)[0];
        if (!target) return;
        curses.set(target.uid, 8000);
        events.push({ kind: 'effect', effectId: 'affix.curse', sourceUid: unit.uid, targetUid: target.uid, durationMs: 8000 });
      });
    }
    if (unit.eliteAffix === 'enrage' && !unit.enraged && unit.hp / unit.maxHp <= .35) unit = { ...unit, atk: unit.atk * 1.2, enraged: true };
    if (unit.eliteAffix === 'summoner' && !unit.summoned && unit.hp / unit.maxHp <= .5) {
      barriers.set(unit.uid, Math.max(unit.shield ?? 0, Math.round(unit.maxHp * .05)));
      unit = { ...unit, atk: unit.atk * 1.05, summoned: true };
    }
    unit = { ...unit, effectCooldowns };
    delete unit.abilityTimer;
    const suppression = unit.activeEffectsV2?.[V2_EFFECTS.suppress.id];
    const effectiveAttackInterval = suppression
      ? unit.attackInterval / (1 - V2_EFFECTS.suppress.magnitude.attackSpeedReductionFraction)
      : unit.attackInterval;
    const timer = unit.attackTimer + dt;
    if (timer < effectiveAttackInterval) return { ...unit, attackTimer: timer };
    const formation = units.filter((fighter) => fighter.side === unit.side);
    const opposition = units.filter((fighter) => fighter.side !== unit.side);
    const lane = Math.max(0, formation.findIndex((fighter) => fighter.uid === unit.uid));
    const laneTarget = opposition[lane];
    const target = laneTarget?.alive ? laneTarget : unit.assistLowestHp
      ? [...opposition].filter((fighter) => fighter.alive).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]
      : undefined;
    if (!target?.alive) return { ...unit, attackTimer: effectiveAttackInterval };
    if ((target.dodge ?? 0) > 0 && random() < (target.dodge ?? 0)) {
      events.push({ kind: 'miss', attackerUid: unit.uid, targetUid: target.uid });
      return { ...unit, attackTimer: 0 };
    }
    const critical = random() < unit.critChance;
    const targetV2Effects = pruneExpiredTargetEffects(target.activeEffectsV2, (Number(target.effectClockMsV2) || 0) + dt);
    const expose = targetV2Effects[V2_EFFECTS.expose.id];
    const exposeApplies = expose && !expose.sourceUids.includes(unit.uid);
    const effectiveDefense = target.def * (exposeApplies ? 1 - V2_EFFECTS.expose.magnitude.allyDefenseIgnoreFraction : 1);
    const rawDamage = Math.max(unit.atk - effectiveDefense * 0.5, unit.atk * 0.12);
    const curseMultiplier = (unit.curseRemainingMs ?? 0) > 0 ? .88 : 1;
    const mark = targetV2Effects[V2_EFFECTS.mark.id];
    const markMultiplier = mark && !mark.sourceUids.includes(unit.uid) ? V2_EFFECTS.mark.magnitude.otherAllyDamageMultiplier : 1;
    const amount = Math.round(rawDamage * curseMultiplier * (unit.damageMultiplier ?? 1) * markMultiplier * (critical ? unit.critDamage : 1) * (0.9 + random() * 0.2));
    hpDelta.set(target.uid, (hpDelta.get(target.uid) ?? 0) + amount);
    events.push({ kind: 'damage', attackerUid: unit.uid, targetUid: target.uid, amount, critical });
    if (usesCombatEffectsV2(unit)) {
      let sourceState = unit.effectSourceStateV2 ?? {};
      if (unit.heroClass === 'shepherd') {
        const hit = recordLandedHit(sourceState, V2_EFFECTS.echo.id, V2_EFFECTS.echo.trigger.every);
        sourceState = hit.state;
        if (hit.due) {
          const echo = resolveEchoDamage(V2_EFFECTS.echo, amount, critical);
          hpDelta.set(target.uid, (hpDelta.get(target.uid) ?? 0) + echo.amount);
          events.push({ kind: 'effect', effectId: V2_EFFECTS.echo.id, sourceUid: unit.uid, targetUid: target.uid, amount: echo.amount });
          queueTargetEffect(target.uid, V2_EFFECTS.mark, unit.uid);
        }
      }
      if (unit.heroClass === 'assassin' && critical) {
        const consumed = consumeTriggeredCooldown(sourceState, V2_EFFECTS.expose.id, V2_EFFECTS.expose.trigger.cooldownMs);
        sourceState = consumed.state;
        if (consumed.consumed) queueTargetEffect(target.uid, V2_EFFECTS.expose, unit.uid);
      }
      if (unit.heroClass === 'archer') {
        const hit = recordLandedHit(sourceState, V2_EFFECTS.suppress.id, V2_EFFECTS.suppress.trigger.every);
        sourceState = hit.state;
        if (hit.due) queueTargetEffect(target.uid, V2_EFFECTS.suppress, unit.uid);
      }
      unit = { ...unit, effectSourceStateV2: sourceState };
    }
    return { ...unit, attackTimer: 0 };
  });

  for (const [targetUid, heal] of v2Healing) {
    healing.set(targetUid, (healing.get(targetUid) ?? 0) + heal.amount);
    events.push({ kind: 'effect', effectId: V2_EFFECTS.heal.id, sourceUid: heal.sourceUid, targetUid, amount: heal.amount });
  }

  const finalUnits = updated.map((unit) => {
    const damage = hpDelta.get(unit.uid) ?? 0;
    const recovered = healing.get(unit.uid) ?? 0;
    const shield = Math.max(unit.shield ?? 0, barriers.get(unit.uid) ?? 0);
    const aegisBarrierV2 = aegisBarriers.get(unit.uid) ?? unit.aegisBarrierV2;
    const aegisAbsorbed = Math.min(aegisBarrierV2?.amount ?? 0, damage);
    const absorbed = Math.min(shield, damage - aegisAbsorbed);
    let activeEffectsV2 = unit.activeEffectsV2;
    for (const pending of targetEffects.get(unit.uid) ?? []) {
      activeEffectsV2 = applyCappedTargetEffect(activeEffectsV2, pending.effect, pending.sourceUid, unit.effectClockMsV2 ?? dt).activeEffects;
      events.push({ kind: 'effect', effectId: pending.effect.id, sourceUid: pending.sourceUid, targetUid: unit.uid, durationMs: pending.effect.durationMs });
    }
    const nextAegis = aegisBarrierV2 ? { ...aegisBarrierV2, amount: aegisBarrierV2.amount - aegisAbsorbed } : undefined;
    if (damage === 0 && recovered === 0 && shield === (unit.shield ?? 0) && !curses.has(unit.uid)
      && activeEffectsV2 === unit.activeEffectsV2 && nextAegis === unit.aegisBarrierV2) return unit;
    const hp = Math.min(unit.maxHp, Math.max(0, unit.hp - (damage - aegisAbsorbed - absorbed) + recovered));
    const next = { ...unit, hp, shield: shield - absorbed, activeEffectsV2, curseRemainingMs: curses.get(unit.uid) ?? unit.curseRemainingMs ?? 0, alive: hp > 0 };
    if (nextAegis?.amount > 0) next.aegisBarrierV2 = nextAegis;
    else delete next.aegisBarrierV2;
    return next;
  });
  return { units: finalUnits, events };
}

/** @param {readonly import('./combat-step.mjs').CombatStepUnit[]} units */
export function combatResolution(units) {
  const heroes = units.filter((unit) => unit.side === 'hero');
  const enemies = units.filter((unit) => unit.side === 'enemy');
  const activeLaneExists = heroes.some((hero, lane) => hero.alive && enemies[lane]?.alive);
  if (heroes.some((unit) => unit.alive) && enemies.some((unit) => unit.alive) && activeLaneExists) return null;
  const wonHeroUids = enemies
    .map((enemy, lane) => enemy.alive ? null : heroes[lane]?.uid)
    .filter((uid) => typeof uid === 'string');
  return {
    deadHeroUids: heroes.filter((hero) => !hero.alive).map((hero) => hero.uid),
    wonHeroUids,
    clearedLanes: wonHeroUids.length,
    allCleared: enemies.length > 0 && enemies.every((enemy) => !enemy.alive),
  };
}

/**
 * @template {import('./combat-step.mjs').CombatStepUnit} T
 * @param {readonly T[]} initialUnits
 * @param {number} seed
 * @param {number} [stepMs]
 * @param {number} [maxElapsedMs]
 * @returns {import('./combat-step.mjs').ResolvedCombat<T>}
 */
export function resolveCombat(initialUnits, seed, stepMs = 20, maxElapsedMs = 120000, afterStep) {
  const random = seededCombatRandom(seed);
  let units = initialUnits.map((unit) => ({ ...unit }));
  let elapsedMs = 0;
  let resolution = combatResolution(units);
  const events = [];
  while (!resolution && elapsedMs < maxElapsedMs) {
    const step = advanceCombatFrame(units, stepMs, random);
    units = step.units;
    elapsedMs += stepMs;
    events.push(...step.events.map((event) => ({ ...event, elapsedMs })));
    resolution = combatResolution(units);
    if (!resolution && afterStep) {
      units = afterStep(units, elapsedMs).map((unit) => ({ ...unit }));
      resolution = combatResolution(units);
    }
  }
  return {
    units,
    resolution: resolution ?? {
      deadHeroUids: units.filter((unit) => unit.side === 'hero' && !unit.alive).map((unit) => unit.uid),
      wonHeroUids: [], clearedLanes: 0, allCleared: false,
    },
    elapsedMs,
    timedOut: resolution === null,
    events,
  };
}
