/**
 * Advance one bounded combat frame without reading browser state. The caller
 * supplies randomness so the exact same mechanics can be replayed in tests and
 * by a future server settlement.
 *
 * @template {import('./combat-step.js').CombatStepUnit} T
 * @param {readonly T[]} units
 * @param {number} elapsedMs
 * @param {() => number} [random]
 * @returns {{ units: T[]; events: import('./combat-step.js').CombatStepEvent[] }}
 */
export function advanceCombatFrame(units, elapsedMs, random = Math.random) {
  const dt = Math.max(0, Math.min(Number.isFinite(elapsedMs) ? elapsedMs : 0, 100));
  const hpDelta = new Map();
  const events = [];

  const updated = units.map((original) => {
    if (!original.alive) return original;
    let unit = original;

    if (unit.heroClass === 'druid' && unit.regenTimer !== undefined) {
      const regenTimer = unit.regenTimer + dt;
      if (regenTimer >= 3000) {
        const amount = Math.min(Math.round(unit.maxHp * 0.015), unit.maxHp - unit.hp);
        if (amount > 0) events.push({ kind: 'heal', targetUid: unit.uid, amount });
        unit = { ...unit, hp: unit.hp + amount, regenTimer: 0 };
      } else {
        unit = { ...unit, regenTimer };
      }
    }

    const timer = unit.attackTimer + dt;
    if (timer < unit.attackInterval) return { ...unit, attackTimer: timer };

    const formation = units.filter((fighter) => fighter.side === unit.side);
    const opposition = units.filter((fighter) => fighter.side !== unit.side);
    const lane = Math.max(0, formation.findIndex((fighter) => fighter.uid === unit.uid));
    const target = opposition[lane];
    if (!target?.alive) return { ...unit, attackTimer: unit.attackInterval };

    if ((target.dodge ?? 0) > 0 && random() < target.dodge) {
      events.push({ kind: 'miss', attackerUid: unit.uid, targetUid: target.uid });
      return { ...unit, attackTimer: 0 };
    }

    const critical = random() < unit.critChance;
    const rawDamage = Math.max(unit.atk - target.def * 0.5, unit.atk * 0.12);
    const amount = Math.round(rawDamage * (critical ? unit.critDamage : 1) * (0.9 + random() * 0.2));
    hpDelta.set(target.uid, (hpDelta.get(target.uid) ?? 0) + amount);
    events.push({ kind: 'damage', attackerUid: unit.uid, targetUid: target.uid, amount, critical });
    return { ...unit, attackTimer: 0 };
  });

  const finalUnits = updated.map((unit) => {
    const damage = hpDelta.get(unit.uid);
    if (damage === undefined) return unit;
    const hp = Math.max(0, unit.hp - damage);
    return { ...unit, hp, alive: hp > 0 };
  });

  return { units: finalUnits, events };
}

/**
 * Return the exact lane result when combat has stopped, otherwise null.
 * Living fighters never redirect into another lane.
 *
 * @param {readonly import('./combat-step.js').CombatStepUnit[]} units
 * @returns {import('./combat-step.js').CombatResolution | null}
 */
export function combatResolution(units) {
  const heroes = units.filter((unit) => unit.side === 'hero');
  const enemies = units.filter((unit) => unit.side === 'enemy');
  const livingHeroes = heroes.filter((unit) => unit.alive);
  const livingEnemies = enemies.filter((unit) => unit.alive);
  const activeLaneExists = heroes.some((hero, lane) => hero.alive && enemies[lane]?.alive);
  if (livingHeroes.length > 0 && livingEnemies.length > 0 && activeLaneExists) return null;

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
