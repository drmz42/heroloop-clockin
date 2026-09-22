import { resolveCombat } from './combat-step.mjs';
import { COMBAT_TIMELINE_VERSION, serializeCombatTimeline } from './combat-timeline.mjs';
import { COMBAT_EFFECTS_V2_VERSION, serverEffectForClass } from './combat-effects-v2.mjs';

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
export const BALANCE_VERSION = 'balance-v4-2026.09.01-v6-combat-effects-v1';
export const COMBAT_EFFECTS_V2_BALANCE_VERSION = 'balance-v4-2026.09.06-v7-combat-effects-v2-candidate';
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

function starMultiplier(stars) {
  return 1 + clamp(Math.floor(stars), 0, 20) * .015;
}

function enchantV4Multiplier(level) {
  const safe = clamp(Math.floor(finite(level)), 0, 20);
  return 1 + Math.min(safe, 5) * .10
    + Math.max(0, Math.min(safe, 10) - 5) * .15
    + Math.max(0, Math.min(safe, 15) - 10) * .20
    + Math.max(0, safe - 15) * .25;
}

function attackInterval(speed, attackSpeed = 0) {
  return Math.max((1540 - Math.min(speed * 2.2, 700)) / (1 + attackSpeed), 600);
}

function canonicalItemsForHero(hero, itemMap) {
  if (!record(hero.equipped)) throw new Error('normal_combat_invalid_formation');
  const ids = Object.values(hero.equipped);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error('normal_combat_invalid_formation');
  }
  return ids.map((id) => {
    const item = itemMap.get(id);
    if (!item) throw new Error('normal_combat_item_state_mismatch');
    return item;
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
  if (extra !== undefined || !archetype || tier < 0 || level < 1 || level > 99 || stars < 0 || stars > 20) {
    throw new Error('normal_combat_invalid_formation');
  }
  const items = canonicalItemsForHero(hero, itemMap);
  const sameSet = items.length === 8 && items.every((item) => item.rarity === items[0].rarity);
  const setBonus = sameSet ? finite(SET_BONUS[items[0].rarity]) / 100 : 0;
  const resonance = items.length === 8
    ? finite(RESONANCE[Math.min(...items.map((item) => clamp(Math.floor(finite(item.enchant_level)), 0, 20)))]) / 100
    : 0;
  const additions = { hp: 0, atk: 0, def: 0, atkSpeed: 0, critChance: 0, critDamage: 0, dodge: 0, goldBonus: 0, xpBonus: 0 };
  for (const item of items) {
    const stats = Array.isArray(item.stats) ? item.stats : [];
    for (const stat of stats) {
      if (!record(stat) || !(stat.key in additions)) continue;
      const version = finite(item.enchant_stats_version);
      const v3 = version === 3;
      const rate = v3 ? ['hp', 'atk', 'def'].includes(stat.key) ? .1 : ['goldBonus', 'xpBonus'].includes(stat.key) ? .025 : .05 : .1;
      const level = clamp(Math.floor(finite(item.enchant_level)), 0, 20);
      const multiplier = (version === 4 ? enchantV4Multiplier(level) : 1 + level * rate)
        + setBonus + (v3 ? 0 : resonance);
      const value = stat.isPercent === true
        ? Math.round(finite(stat.value) * multiplier * 1000) / 1000
        : Math.round(finite(stat.value) * multiplier);
      additions[stat.key] += value;
    }
  }
  const rarityScale = RARITY_SCALE[tier];
  const starsScale = starMultiplier(stars);
  const rarityGrowth = 1 + tier * .02;
  const v2 = combatEffectsVersion === COMBAT_EFFECTS_V2_VERSION;
  const coreTrait = v2 ? serverEffectForClass(heroClass, 'coreTrait') : null;
  const hpMultiplier = v2 ? coreTrait.magnitude.maxHpMultiplier ?? 1 : archetype.legacyHpMultiplier ?? 1;
  const hp = Math.round((archetype.hp * rarityScale * .2 * (1 + archetype.growth[0] * rarityGrowth * (level - 1)) * starsScale + additions.hp) * hpMultiplier);
  const atk = Math.round(archetype.atk * rarityScale * .2 * (1 + archetype.growth[1] * rarityGrowth * (level - 1)) * starsScale + additions.atk);
  const def = Math.round(archetype.def * rarityScale * .2 * (1 + archetype.growth[2] * rarityGrowth * (level - 1)) * starsScale + additions.def);
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

const ENDGAME_ENEMIES = [[6163,556,202,103],[6185,558,202,103],[7736,664,325,103],[7815,671,327,103],[8301,711,355,103],[9708,835,403,103],[11836,1017,494,103],[13400,1156,547,103],[15765,1360,646,103],[17315,1498,698,103]];
const ENDGAME_ROLES = ['tank', 'striker', 'skirmisher', 'support', 'caster'];
const ELITE_AFFIXES = ['guard-aura', 'mending', 'barrier', 'enrage', 'curse', 'lane-blast', 'summoner'];
function enemyUnits(location, teamSize, seed) {
  if (location > 10) {
    const [baseHp, baseAtk, baseDef, baseSpeed] = ENDGAME_ENEMIES[location - 11];
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
  const scale = 1 + (location - 1) * .35;
  const difficulty = location === 1 ? 1 : 1.45 + (location - 2) * .18;
  return Array.from({ length: teamSize }, (_, lane) => {
    const id = ENEMY_IDS[(location + lane) % ENEMY_IDS.length];
    const hp = Math.round(300 * scale * (.85 + lane * .08) * .33 * difficulty);
    const atk = Math.round(32 * scale * (.8 + lane * .05) * .32 * difficulty);
    const def = Math.round(10 * scale * .25 * difficulty);
    const speed = 65 + lane * 3 + Math.min(location * 1.5, 50);
    const interval = attackInterval(speed);
    return {
      uid: `e${lane}-${id}`, side: 'enemy', lane, hp, maxHp: hp, alive: true, atk, def,
      attackTimer: interval, attackInterval: interval, critChance: .06, critDamage: 1.5, dodge: 0,
    };
  });
}

export function buildNormalCombat(state, ledgerItems, location, seed, resourceSnapshot, startedAtMs = Date.now(), combatEffectsVersion = /** @type {string | null} */ (null)) {
  if (combatEffectsVersion !== null && combatEffectsVersion !== COMBAT_EFFECTS_V2_VERSION) {
    throw new Error('normal_combat_invalid_effects_version');
  }
  if (!record(state) || !Array.isArray(state.team) || !Array.isArray(state.ownedHeroes)
    || state.team.length < 1 || state.team.length > 3 || new Set(state.team).size !== state.team.length) {
    throw new Error('normal_combat_invalid_formation');
  }
  const items = new Map((Array.isArray(ledgerItems) ? ledgerItems : []).map((item) => [String(item.id), item]));
  const heroesByUid = new Map(state.ownedHeroes.map((hero) => [hero?.uid, hero]));
  const savedHp = record(state.normalCombatHp) ? state.normalCombatHp : {};
  const built = state.team.map((uid, lane) => heroUnit(heroesByUid.get(uid), lane, items, savedHp[uid], startedAtMs, combatEffectsVersion));
  const initialUnits = [...built.map(({ unit }) => unit), ...enemyUnits(location, built.length, seed)];
  const config = record(state.autoPot) ? state.autoPot : {};
  const balances = record(resourceSnapshot) && record(resourceSnapshot.balances) ? resourceSnapshot.balances : {};
  const stock = Object.fromEntries(POTION_TIERS_ASC.map((tier) => {
    const value = balances[`potion_${tier}`];
    return [tier, typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0];
  }));
  const threshold = clamp(finite(config.threshold), .05, 1);
  const autoBuyTier = POTION_TIERS_ASC.includes(config.autoBuyTier) ? config.autoBuyTier : 'sm';
  let availableGold = Math.max(0, Math.floor(finite(state.gold)));
  const autoPotions = [];
  const resolved = resolveCombat(initialUnits, seed, 20, 120000, (units, elapsedMs) => {
    if (config.enabled !== true) return units;
    const hero = units.find((unit) => unit.side === 'hero' && unit.alive && unit.hp / unit.maxHp < threshold);
    if (!hero) return units;
    let tier = POTION_TIERS_DESC.find((candidate) => stock[candidate] > 0);
    let fromStock = true;
    if (!tier && config.autoBuy === true) {
      tier = config.autoSelectTier !== false
        ? POTION_TIERS_ASC.find((candidate) => POTIONS[candidate].hpRestore >= hero.maxHp * .5) ?? 'xxl'
        : autoBuyTier;
      fromStock = false;
      if (availableGold < POTIONS[tier].cost) return units;
    }
    if (!tier) return units;
    const potion = POTIONS[tier];
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
  return {
    seed, balance_version: combatEffectsVersion === COMBAT_EFFECTS_V2_VERSION ? COMBAT_EFFECTS_V2_BALANCE_VERSION : BALANCE_VERSION,
    initial_units: initialUnits,
    reward_bonuses: {
      gold: built.reduce((sum, hero) => sum + hero.goldBonus, 0),
      xp: built.reduce((sum, hero) => sum + hero.xpBonus, 0),
    },
    outcome: {
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
      timeline: serializeCombatTimeline(resolved.events, autoPotions),
    },
  };
}
