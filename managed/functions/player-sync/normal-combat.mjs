import { SEEKER_PROGRESSION_VERSION, SEEKER_PROGRESSION_BALANCE_VERSION } from './seeker-progression.mjs';
import { resolveCombat } from './combat-step.mjs';
import { ORDINARY_POTION_POLICY, ORDINARY_POTION_BALANCE_VERSION, ordinaryPotionSession } from './ordinary-potion.mjs';
import { AUTOMATIC_HEALING_POLICY, AUTOMATIC_HEALING_BALANCE_VERSION, AUTOMATIC_HEALING_PRICES, automaticHealingConfig } from './automatic-healing.mjs';
import { COMBAT_TIMELINE_VERSION, serializeCombatTimeline } from './combat-timeline.mjs';
import { COMBAT_EFFECTS_V2_VERSION, serverEffectForClass } from './combat-effects-v2.mjs';
import { BALANCE_V6_ID, v6EnchantMultiplier, v6EnemyBase, v6AttackSpeedPoints, v6ItemImplicit, v6LevelMastery, v6StarMultiplier } from './balance-v6.mjs';

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
export const BALANCE_VERSION = `${BALANCE_V6_ID}-combat-effects-v1`;
export const COMBAT_EFFECTS_V2_BALANCE_VERSION = `${BALANCE_V6_ID}-combat-effects-v2`;
const RARITY_SCALE = [1, 1.441163, 2.147372, 3.084756, 4.435796, 6.370091, 9.143236, 13.119459, 18.814853];
const SET_BONUS = { common: 5, uncommon: 10, rare: 15, epic: 20, legendary: 30, mythic: 40, relic: 40, cosmic: 50, divine: 60, celestial: 70, cursed: 80, immortal: 90, god: 100 };
const RESONANCE = [0, 1, 2, 4, 7, 11, 16, 22, 30, 39, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];
const ARCHETYPES = {
  shepherd: { hp: 340, atk: 86, def: 12, speed: 104, critChance: .12, critDamage: 1.85, growth: [.007, .0115, .0035], caps: [.5, 2.3, .15], legacyDps: 1.1 },
  assassin: { hp: 310, atk: 78, def: 10, speed: 130, critChance: .18, critDamage: 2, growth: [.0065, .01, .003], caps: [.6, 2.5, .3], dodge: .05, legacyCritChancePoints: .05 },
  knight: { hp: 500, atk: 56, def: 28, speed: 92, critChance: .08, critDamage: 1.6, growth: [.012, .0055, .009], caps: [.45, 2, .1], legacyHpMultiplier: 1.15 },
  druid: { hp: 450, atk: 60, def: 20, speed: 100, critChance: .1, critDamage: 1.7, growth: [.0105, .0065, .0065], caps: [.45, 2.1, .15], legacyHpMultiplier: 1.1, legacyRegen: .004 },
  archer: { hp: 360, atk: 70, def: 14, speed: 124, critChance: .15, critDamage: 1.9, growth: [.008, .009, .0045], caps: [.55, 2.7, .2], legacyAttackSpeedPoints: .08, legacyCriticalDamagePoints: .25 },
};
const ENEMY_IDS = ['goblin', 'skeleton', 'bat', 'slime', 'wolf', 'ghost', 'spider', 'orc'];
const POTION_TIERS_DESC = ['xxl', 'xl', 'lg', 'md', 'sm', 'xs'];
const POTION_TIERS_ASC = [...POTION_TIERS_DESC].reverse();
const POTIONS = {
  xs: { hpRestore: 50, cost: 15 }, sm: { hpRestore: 200, cost: 50 },
  md: { hpRestore: 1000, cost: 150 }, lg: { hpRestore: 4000, cost: 450 },
  xl: { hpRestore: 15000, cost: 1200 }, xxl: { hpRestore: 40000, cost: 3000 },
};

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));


function attackInterval(speed, attackSpeed = 0) {
  return Math.max((1540 - Math.min(speed * 2.2, 700)) / (1 + attackSpeed), 600);
}

// Each item is paired with the slot it is equipped in; Balance v6 derives its base stat from it.
function canonicalItemsForHero(hero, itemMap) {
  if (!record(hero.equipped)) throw new Error('normal_combat_invalid_formation');
  const entries = Object.entries(hero.equipped);
  const ids = entries.map(([, id]) => id);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error('normal_combat_invalid_formation');
  }
  return entries.map(([slot, id]) => {
    const item = itemMap.get(id);
    if (!item) throw new Error('normal_combat_item_state_mismatch');
    return { item, slot };
  });
}

function heroUnit(hero, lane, itemMap, carriedHp, startedAtMs, combatEffectsVersion) {
  if (!record(hero) || typeof hero.uid !== 'string' || typeof hero.heroId !== 'string') {
    throw new Error('normal_combat_invalid_formation');
  }
  const [heroClass, rarity, extra] = hero.heroId.split('-');
  const archetype = ARCHETYPES[heroClass];
  const tier = RARITIES.indexOf(rarity);
  const level = Math.floor(finite(hero.level));
  const stars = Math.floor(finite(hero.stars));
  if (extra !== undefined || !archetype || tier < 0 || level < 1 || level > 200 || stars < 0 || stars > 20) {
    throw new Error('normal_combat_invalid_formation');
  }
  const equipped = canonicalItemsForHero(hero, itemMap);
  const items = equipped.map(({ item }) => item);
  const sameSet = items.length === 8 && items.every((item) => item.rarity === items[0].rarity);
  const setBonus = sameSet ? finite(SET_BONUS[items[0].rarity]) / 100 : 0;
  const resonance = items.length === 8
    ? finite(RESONANCE[Math.min(...items.map((item) => clamp(Math.floor(finite(item.enchant_level)), 0, 20)))]) / 100
    : 0;
  const additions = { hp: 0, atk: 0, def: 0, atkSpeed: 0, critChance: 0, critDamage: 0, dodge: 0, goldBonus: 0, xpBonus: 0 };
  for (const { item, slot } of equipped) {
    const stats = Array.isArray(item.stats) ? item.stats : [];
    const version = finite(item.enchant_stats_version);
    const v3 = version === 3;
    const level = clamp(Math.floor(finite(item.enchant_level)), 0, 20);
    const multiplierFor = (key) => {
      const rate = v3 ? ['hp', 'atk', 'def'].includes(key) ? .1 : ['goldBonus', 'xpBonus'].includes(key) ? .025 : .05 : .1;
      return (version === 4 ? v6EnchantMultiplier(level) : 1 + level * rate) + setBonus + (v3 ? 0 : resonance);
    };
    for (const stat of stats) {
      if (!record(stat) || !(stat.key in additions)) continue;
      const multiplier = multiplierFor(stat.key);
      const value = stat.isPercent === true
        ? Math.round(finite(stat.value) * multiplier * 1000) / 1000
        : Math.round(finite(stat.value) * multiplier);
      additions[stat.key] += stat.key === 'atkSpeed' ? v6AttackSpeedPoints(value, stat.isPercent) : value;
    }
    const implicit = v6ItemImplicit(slot, item.rarity, item.item_level);
    for (const key of ['hp', 'atk', 'def']) {
      if (implicit[key] > 0) additions[key] += Math.round(implicit[key] * multiplierFor(key));
    }
  }
  const rarityScale = RARITY_SCALE[tier];
  const starsScale = v6StarMultiplier(stars);
  const rarityGrowth = 1 + tier * .02;
  const v2 = combatEffectsVersion === COMBAT_EFFECTS_V2_VERSION;
  const coreTrait = v2 ? serverEffectForClass(heroClass, 'coreTrait') : null;
  const hpMultiplier = v2 ? coreTrait.magnitude.maxHpMultiplier ?? 1 : archetype.legacyHpMultiplier ?? 1;
  // Balance v6: Level mastery scales base stats only; equipment adds its own Item Level-scaled stats.
  const mastery = v6LevelMastery(level);
  const hp = Math.round((archetype.hp * rarityScale * .2 * (1 + archetype.growth[0] * rarityGrowth * (level - 1)) * starsScale * mastery + additions.hp) * hpMultiplier);
  const atk = Math.round(archetype.atk * rarityScale * .2 * (1 + archetype.growth[1] * rarityGrowth * (level - 1)) * starsScale * mastery + additions.atk);
  const def = Math.round(archetype.def * rarityScale * .2 * (1 + archetype.growth[2] * rarityGrowth * (level - 1)) * starsScale * mastery + additions.def);
  const speed = archetype.speed * (1 + tier * .01) + stars * .1;
  const classAttackSpeed = v2 ? coreTrait.magnitude.attackSpeedPoints ?? 0 : archetype.legacyAttackSpeedPoints ?? 0;
  const classCritChance = v2 ? coreTrait.magnitude.criticalChancePoints ?? 0 : archetype.legacyCritChancePoints ?? 0;
  const classCritDamage = v2 ? coreTrait.magnitude.criticalDamagePoints ?? 0 : archetype.legacyCriticalDamagePoints ?? 0;
  const attackSpeed = Math.min(classAttackSpeed + additions.atkSpeed, heroClass === 'assassin' || heroClass === 'archer' ? .25 : .2);
  const respawnAt = finite(hero.respawnAt);
  const respawning = respawnAt > startedAtMs;
  const continuityHp = Number.isFinite(Number(carriedHp)) ? clamp(Number(carriedHp), 0, hp) : hp;
  const currentHp = respawning ? 0 : respawnAt > 0 && respawnAt <= startedAtMs ? hp : continuityHp;
  const unit = {
      uid: hero.uid, side: 'hero', lane, hp: currentHp, maxHp: hp, alive: currentHp > 0, atk, def,
      attackTimer: 0, attackInterval: attackInterval(speed, attackSpeed),
      critChance: Math.min(archetype.critChance + classCritChance + additions.critChance, archetype.caps[0]),
      critDamage: Math.min(archetype.critDamage + classCritDamage + additions.critDamage, archetype.caps[1]),
      dodge: Math.min(additions.dodge + (archetype.dodge ?? 0), archetype.caps[2]),
      heroClass, regenTimer: 0, regenPerSecond: v2 ? 0 : archetype.legacyRegen ?? 0,
      damageMultiplier: v2 ? 1 : archetype.legacyDps ?? 1,
    };
  if (v2) {
    unit.combatEffectsVersion = COMBAT_EFFECTS_V2_VERSION;
    unit.effectClockMsV2 = 0;
    unit.effectSourceStateV2 = {};
    unit.activeEffectsV2 = {};
  }
  return {
    unit,
    goldBonus: additions.goldBonus,
    xpBonus: additions.xpBonus,
  };
}

// Balance v6: every Location's enemy base comes from the calibrated table in balance-v6.mjs.
const ENDGAME_ENEMY_SPEED = 103;
const ENDGAME_ROLES = ['tank', 'striker', 'skirmisher', 'support', 'caster'];
const ELITE_AFFIXES = ['guard-aura', 'mending', 'barrier', 'enrage', 'curse', 'lane-blast', 'summoner'];
function enemyUnits(location, teamSize, seed, progressionVersion) {
  const { hp: baseHp, atk: baseAtk, def: baseDef } = v6EnemyBase(location, progressionVersion === SEEKER_PROGRESSION_VERSION);
  if (location > 10) {
    const baseSpeed = ENDGAME_ENEMY_SPEED;
    const elite = Math.abs(seed) % 20 === 0 ? ELITE_AFFIXES[Math.abs(seed >>> 5) % ELITE_AFFIXES.length] : null;
    return Array.from({ length: teamSize }, (_, lane) => {
      const role = ENDGAME_ROLES[Math.abs(seed + lane * 17) % ENDGAME_ROLES.length];
      const roleScale = role === 'tank' ? [1.3,.8,1.35,.9,.0] : role === 'striker' ? [.85,1.25,.85,1,.0]
        : role === 'skirmisher' ? [.8,.9,.8,1.25,.05] : role === 'support' ? [1,.75,1,.95,.0] : [.85,1.05,.8,1,.0];
      const hp = Math.round(baseHp * roleScale[0]);
      const atk = Math.round(baseAtk * roleScale[1]);
      const def = Math.round(baseDef * roleScale[2] * (elite === 'guard-aura' ? 1.1 : 1));
      return { uid: `e${lane}-endgame-${location}`, side: 'enemy', lane, hp, maxHp: hp, alive: true, atk, def,
        attackTimer: 0, attackInterval: attackInterval(baseSpeed * roleScale[3]), critChance: .06, critDamage: 1.5,
        dodge: roleScale[4], role, eliteAffix: elite, effectCooldowns: {}, assistLowestHp: true };
    });
  }
  return Array.from({ length: teamSize }, (_, lane) => {
    const id = ENEMY_IDS[(location + lane) % ENEMY_IDS.length];
    const hp = Math.round(baseHp * (.85 + lane * .08));
    const atk = Math.round(baseAtk * (.8 + lane * .05));
    const def = Math.round(baseDef);
    const speed = 65 + lane * 3 + Math.min(location * 1.5, 50);
    const interval = attackInterval(speed);
    return {
      uid: `e${lane}-${id}`, side: 'enemy', lane, hp, maxHp: hp, alive: true, atk, def,
      attackTimer: interval, attackInterval: interval, critChance: .06, critDamage: 1.5, dodge: 0,
    };
  });
}

export function buildNormalCombat(state, ledgerItems, location, seed, resourceSnapshot, startedAtMs = Date.now(), combatEffectsVersion = /** @type {string | null} */ (null), healingPolicy = /** @type {string | null} */ (null), progressionVersion = /** @type {string | null} */ (null)) {
  if (progressionVersion !== null && progressionVersion !== SEEKER_PROGRESSION_VERSION) throw new Error('normal_combat_invalid_progression_version');
  if (combatEffectsVersion !== null && combatEffectsVersion !== COMBAT_EFFECTS_V2_VERSION) {
    throw new Error('normal_combat_invalid_effects_version');
  }
  if (healingPolicy !== null && (![AUTOMATIC_HEALING_POLICY, ORDINARY_POTION_POLICY].includes(healingPolicy) || combatEffectsVersion !== COMBAT_EFFECTS_V2_VERSION)) {
    throw new Error('normal_combat_invalid_healing_policy');
  }
  if (!record(state) || !Array.isArray(state.team) || !Array.isArray(state.ownedHeroes)
    || state.team.length < 1 || state.team.length > 3 || new Set(state.team).size !== state.team.length) {
    throw new Error('normal_combat_invalid_formation');
  }
  const items = new Map((Array.isArray(ledgerItems) ? ledgerItems : []).map((item) => [String(item.id), item]));
  const heroesByUid = new Map(state.ownedHeroes.map((hero) => [hero?.uid, hero]));
  const savedHp = record(state.normalCombatHp) ? state.normalCombatHp : {};
  const built = state.team.map((uid, lane) => heroUnit(heroesByUid.get(uid), lane, items, savedHp[uid], startedAtMs, combatEffectsVersion));
  const initialUnits = [...built.map(({ unit }) => unit), ...enemyUnits(location, built.length, seed,
    Number(state.accountLevel) >= (location - 1) * 10 + 1 ? progressionVersion : null)];
  const savedConfig = record(state.autoPot) ? state.autoPot : {};
  const config = healingPolicy === AUTOMATIC_HEALING_POLICY ? automaticHealingConfig(savedConfig) : savedConfig;
  const potions = healingPolicy === AUTOMATIC_HEALING_POLICY
    ? Object.fromEntries(Object.entries(POTIONS).map(([tier, potion]) => [tier, { ...potion, cost: AUTOMATIC_HEALING_PRICES[tier] }]))
    : POTIONS;
  const balances = record(resourceSnapshot) && record(resourceSnapshot.balances) ? resourceSnapshot.balances : {};
  const stock = Object.fromEntries(POTION_TIERS_ASC.map((tier) => {
    const value = balances[`potion_${tier}`];
    return [tier, typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0];
  }));
  const threshold = clamp(finite(config.threshold), .05, 1);
  const autoBuyTier = POTION_TIERS_ASC.includes(config.autoBuyTier) ? config.autoBuyTier : 'sm';
  let availableGold = Math.max(0, Math.floor(finite(state.gold)));
  const autoPotions = [];
  const healingContext = record(state.normalCombatHealing)
    ? Object.fromEntries(Object.entries(state.normalCombatHealing).filter(([uid]) => heroesByUid.has(uid))) : {};
  const ordinary = healingPolicy === ORDINARY_POTION_POLICY
    ? ordinaryPotionSession(healingContext, savedConfig, startedAtMs, stock.xs, availableGold) : null;
  if (ordinary) {
    // Mature prepaid doses during the handoff before a new enemy can strike.
    // Their HP is part of the initial snapshot, so playback must not add them twice.
    initialUnits.splice(0, initialUnits.length, ...ordinary.step(initialUnits, 0, false));
    ordinary.ticks.length = 0;
  }
  const resolved = resolveCombat(initialUnits, seed, 20, 120000, (units, elapsedMs) => {
    if (ordinary) return ordinary.step(units, elapsedMs);
    if (config.enabled !== true) return units;
    const hero = units.find((unit) => unit.side === 'hero' && unit.alive && unit.hp / unit.maxHp < threshold);
    if (!hero) return units;
    let tier = POTION_TIERS_DESC.find((candidate) => stock[candidate] > 0);
    let fromStock = true;
    if (!tier && config.autoBuy === true) {
      tier = config.autoSelectTier !== false
        ? POTION_TIERS_ASC.find((candidate) => potions[candidate].hpRestore >= hero.maxHp * .5) ?? 'xxl'
        : autoBuyTier;
      fromStock = false;
      if (availableGold < potions[tier].cost) return units;
    }
    if (!tier) return units;
    const potion = potions[tier];
    if (fromStock) stock[tier] -= 1;
    else availableGold -= potion.cost;
    const hpBefore = hero.hp;
    const hpAfter = Math.min(hero.maxHp, hpBefore + potion.hpRestore);
    autoPotions.push({
      elapsed_ms: elapsedMs, hero_uid: hero.uid, tier, hp_restore: hpAfter - hpBefore,
      from_stock: fromStock, gold_cost: fromStock ? 0 : potion.cost,
    });
    return units.map((unit) => unit.uid === hero.uid ? { ...unit, hp: hpAfter } : unit);
  });
  if (ordinary) {
    resolved.units = ordinary.step(resolved.units, resolved.elapsedMs, false);
    autoPotions.push(...ordinary.purchases);
  }
  return {
    seed, balance_version: ordinary ? ORDINARY_POTION_BALANCE_VERSION : progressionVersion === SEEKER_PROGRESSION_VERSION ? SEEKER_PROGRESSION_BALANCE_VERSION : healingPolicy === AUTOMATIC_HEALING_POLICY ? AUTOMATIC_HEALING_BALANCE_VERSION : combatEffectsVersion === COMBAT_EFFECTS_V2_VERSION ? COMBAT_EFFECTS_V2_BALANCE_VERSION : BALANCE_VERSION,
    initial_units: initialUnits,
    reward_bonuses: {
      gold: built.reduce((sum, hero) => sum + hero.goldBonus, 0),
      xp: built.reduce((sum, hero) => sum + hero.xpBonus, 0),
    },
    outcome: {
      ...(healingPolicy === AUTOMATIC_HEALING_POLICY ? { healing_policy: AUTOMATIC_HEALING_POLICY } : {}),
      ...(ordinary ? { healing_policy: ORDINARY_POTION_POLICY, ordinary_potion_state: ordinary.timers } : {}),
      status: resolved.resolution.allCleared ? 'cleared' : 'failed',
      elapsed_ms: resolved.elapsedMs,
      timed_out: resolved.timedOut,
      final_units: resolved.units,
      dead_hero_uids: resolved.resolution.deadHeroUids,
      won_hero_uids: resolved.resolution.wonHeroUids,
      cleared_lanes: resolved.resolution.clearedLanes,
      all_cleared: resolved.resolution.allCleared,
      auto_potions: autoPotions,
      auto_pot_gold_cost: autoPotions.reduce((sum, event) => sum + event.gold_cost, 0),
      timeline_version: COMBAT_TIMELINE_VERSION,
      timeline: ordinary ? serializeCombatTimeline([...resolved.events, ...ordinary.ticks]) : serializeCombatTimeline(resolved.events, autoPotions),
    },
  };
}
