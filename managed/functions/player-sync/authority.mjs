const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
const RARITY_SCALE = [1, 1.441163, 2.147372, 3.084756, 4.435796, 6.370091, 9.143236, 13.119459, 18.814853];
const LOCATION_UNLOCK_LEVELS = [1, 5, 10, 16, 23, 31, 40, 50, 60, 70, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98];
const MAX_LEVEL = 99;
const ITEM_SELL_MULTIPLIER = {
  common: 0.3, uncommon: 0.7, rare: 1.4, epic: 2.8, legendary: 4.6,
  mythic: 6.5, relic: 6.5, cosmic: 9, divine: 13, celestial: 18,
};
const ARCHETYPES = {
  shepherd: { hp: 340, atk: 86, def: 12, speed: 104, growth: [.007, .0115, .0035], crit: .12, critDamage: 1.85, dps: 1.1, caps: [.4,.15,.5,2.3,.2] },
  assassin: { hp: 310, atk: 78, def: 10, speed: 130, growth: [.0065,.01,.003], crit: .23, critDamage: 2, dodge: .05, caps: [.4,.3,.6,2.5,.25] },
  knight: { hp: 500, atk: 56, def: 28, speed: 92, growth: [.012,.0055,.009], crit: .08, critDamage: 1.6, hpMult: 1.15, caps: [.6,.1,.45,2,.2] },
  druid: { hp: 450, atk: 60, def: 20, speed: 100, growth: [.0105,.0065,.0065], crit: .1, critDamage: 1.7, hpMult: 1.1, regen: .004, caps: [.5,.15,.45,2.1,.2] },
  archer: { hp: 360, atk: 70, def: 14, speed: 124, growth: [.008,.009,.0045], crit: .15, critDamage: 2.15, attackSpeed: .08, caps: [.45,.2,.55,2.7,.25] },
};

const LEGACY_IDS = {
  ironfoot: 'knight-common', greenscout: 'archer-common', cutpurse: 'assassin-common',
  acolyte: 'shepherd-common', shrubmage: 'druid-common', dawnknight: 'knight-uncommon',
  thornranger: 'archer-uncommon', moonpriest: 'shepherd-uncommon', grovekeeper: 'druid-uncommon',
  stoneguard: 'knight-rare', stormsniper: 'archer-rare', duskblade: 'assassin-rare',
  irondruid: 'druid-rare', voidknight: 'knight-epic', starfall: 'archer-epic',
  deathwhisper: 'assassin-epic', solarsage: 'shepherd-epic', stormdruid: 'druid-epic',
  sunpaladin: 'knight-legendary', eternalbow: 'archer-legendary', soulreaper: 'assassin-legendary',
  divinehealer: 'shepherd-legendary', worldtree: 'druid-legendary', worldender: 'knight-mythic',
  cosmosarcher: 'archer-mythic', voidstalker: 'assassin-mythic', ancientknight: 'knight-mythic',
  relicdruid: 'druid-mythic', cursedknight: 'knight-mythic', cursedarcher: 'archer-mythic',
  cosmicmage: 'shepherd-cosmic', divine: 'shepherd-divine',
};

function integer(value, min, max) {
  return Math.min(max, Math.max(min, Math.floor(Number(value) || 0)));
}

function canonicalId(value) {
  const id = typeof value === 'string' ? value : '';
  return LEGACY_IDS[id] ?? id;
}

function idRarity(value) {
  const id = canonicalId(value);
  const rarity = id.slice(id.lastIndexOf('-') + 1);
  return RARITIES.includes(rarity) || rarity === 'relic' || rarity === 'cursed' ? rarity : 'common';
}

function itemSellValue(item) {
  const rarity = idRarity(item?.itemId);
  const multiplier = ITEM_SELL_MULTIPLIER[rarity] ?? 0.3;
  const level = integer(item?.level, 1, 10_000);
  const enchantLevel = integer(item?.enchantLevel, 0, 20);
  return Math.max(5, Math.round(multiplier * 5 * (1 + (level - 1) * 0.05) * (1 + enchantLevel * 0.2)));
}

function entityIds(value) {
  return new Set((Array.isArray(value) ? value : []).map((entry) => String(entry?.uid ?? '')).filter(Boolean));
}

function heldItemIds(state) {
  const ids = entityIds(state?.inventory);
  for (const listing of Array.isArray(state?.marketListings) ? state.marketListings : []) {
    const uid = listing?.item?.uid;
    if (typeof uid === 'string' && uid) ids.add(uid);
  }
  return ids;
}

export function allowedGoldCredit(currentState, requestedState) {
  const current = currentState && typeof currentState === 'object' ? currentState : {};
  const requested = requestedState && typeof requestedState === 'object' ? requestedState : {};
  const requestedItemIds = heldItemIds(requested);
  const itemRefund = (Array.isArray(current.inventory) ? current.inventory : [])
    .filter((item) => item?.uid && !requestedItemIds.has(String(item.uid)))
    .reduce((sum, item) => sum + itemSellValue(item), 0);

  return Math.min(1_000_000_000_000, itemRefund);
}

export function preserveHeroOwnership(currentOwnedHeroes, escrowHeroes, requestedOwnedHeroes, savedInventoryIds, ledgerIds) {
  const current = Array.isArray(currentOwnedHeroes) ? currentOwnedHeroes : [];
  const escrow = Array.isArray(escrowHeroes) ? escrowHeroes : [];
  const requested = Array.isArray(requestedOwnedHeroes) ? requestedOwnedHeroes : [];
  const savedItems = savedInventoryIds instanceof Set ? savedInventoryIds : new Set();
  const ledgerItems = ledgerIds instanceof Set ? ledgerIds : new Set();
  const serverHeroes = [...current, ...escrow];
  const canonicalize = (authoritative, candidate) => {
    const requestedEquipped = candidate?.equipped && typeof candidate.equipped === 'object' && !Array.isArray(candidate.equipped)
      ? candidate.equipped
      : {};
    const authoritativeEquipped = authoritative?.equipped && typeof authoritative.equipped === 'object' && !Array.isArray(authoritative.equipped)
      ? authoritative.equipped
      : {};
    const equipped = Object.fromEntries(Object.entries(requestedEquipped)
      .filter(([, uid]) => savedItems.has(String(uid ?? '')) && !ledgerItems.has(String(uid ?? ''))));
    for (const [slot, uid] of Object.entries(authoritativeEquipped)) {
      if (ledgerItems.has(String(uid ?? ''))) equipped[slot] = uid;
    }
    return {
      ...authoritative,
      equipped,
      locked: candidate?.locked,
      isNew: candidate?.isNew,
      respawnAt: authoritative?.respawnAt,
    };
  };
  const accepted = requested.flatMap((candidate) => {
    const authoritative = serverHeroes.find((hero) => String(hero?.uid ?? '') === String(candidate?.uid ?? ''));
    return authoritative ? [canonicalize(authoritative, candidate)] : [];
  });
  const acceptedIds = entityIds(accepted);
  const preserved = current
    .filter((hero) => hero?.uid && !acceptedIds.has(String(hero.uid)))
    .map((hero) => canonicalize(hero, hero));
  return [...accepted, ...preserved];
}

export function serverLocationCap(state) {
  const safeState = state && typeof state === 'object' ? state : {};
  const accountLevel = integer(safeState.accountLevel, 1, MAX_LEVEL);
  const highestLocation = integer(safeState.highestLocation, 1, 10_000);
  const discoveredCap = Math.min(LOCATION_UNLOCK_LEVELS.length, highestLocation);
  let latestLocation = 1;
  for (let index = 0; index < discoveredCap; index += 1) {
    if (accountLevel >= LOCATION_UNLOCK_LEVELS[index]) latestLocation = index + 1;
  }
  return latestLocation;
}

function accountXpNeeded(level) {
  if (level < 20) return Math.round(1800 + level * 85);
  if (level < 29) return Math.round(10_400 + (level - 20) * 360);
  return Math.min(36_000, Math.round(14_000 + (level - 29) * 1_100));
}

function heroXpNeeded(level) {
  return Math.max(1, Math.round(accountXpNeeded(level) / 1.3));
}

export function settleTrainingState(sourceState, nowMs) {
  const source = sourceState && typeof sourceState === 'object' ? sourceState : {};
  const now = Math.max(0, Math.floor(Number(nowMs) || 0));
  const camp = source.trainingCamp && typeof source.trainingCamp === 'object' ? source.trainingCamp : null;
  if (!camp || now <= 0) return source;
  const from = Math.min(now, Math.max(0, Math.floor(Number(camp.lastTick) || now)));
  if (now - from < 1_000) return source;

  let cursor = from;
  let activeBoostKey = typeof camp.activeBoostKey === 'string' ? camp.activeBoostKey : null;
  let boostMultiplier = [1, 2, 4].includes(Number(camp.boostMultiplier)) ? Number(camp.boostMultiplier) : 1;
  let boostEndsAt = Math.max(0, Math.floor(Number(camp.boostEndsAt) || 0));
  const boostQueue = (Array.isArray(camp.boostQueue) ? camp.boostQueue : []).map((entry) => ({ ...entry }));
  const rewardWindowStart = Math.max(from, now - 7 * 24 * 60 * 60 * 1000);
  let effectiveSeconds = 0;
  const addRewardTime = (start, end, multiplier) => {
    const rewardedStart = Math.max(start, rewardWindowStart);
    const rewardedEnd = Math.min(end, now);
    if (rewardedEnd > rewardedStart) effectiveSeconds += ((rewardedEnd - rewardedStart) / 1000) * multiplier;
  };

  while (cursor < now) {
    if (boostMultiplier > 1 && boostEndsAt > cursor) {
      const segmentEnd = Math.min(now, boostEndsAt);
      addRewardTime(cursor, segmentEnd, boostMultiplier);
      cursor = segmentEnd;
      if (cursor < now && cursor >= boostEndsAt) {
        activeBoostKey = null;
        boostMultiplier = 1;
        boostEndsAt = 0;
      }
      continue;
    }
    const next = boostQueue.shift();
    if (next && [2, 4].includes(Number(next.multiplier)) && Number(next.durationMs) > 0) {
      activeBoostKey = typeof next.key === 'string' ? next.key : null;
      boostMultiplier = Number(next.multiplier);
      boostEndsAt = cursor + Math.min(24 * 60 * 60 * 1000, Math.floor(Number(next.durationMs)));
      continue;
    }
    addRewardTime(cursor, now, 1);
    cursor = now;
  }
  if (boostMultiplier > 1 && boostEndsAt <= now) {
    activeBoostKey = null;
    boostMultiplier = 1;
    boostEndsAt = 0;
  }

  const locationId = serverLocationCap(source);
  const xpPerWave = Math.max(1, Math.round((4 + locationId * 1.2) * 0.55));
  const xpGain = Math.floor((xpPerWave * 1.6 / 12) * effectiveSeconds);
  const team = new Set(Array.isArray(source.team) ? source.team : []);
  const accountLevel = integer(source.accountLevel, 1, MAX_LEVEL);
  const heroUids = (Array.isArray(camp.heroUids) ? camp.heroUids : []).map((uid) => typeof uid === 'string' ? uid : null);
  const trainees = new Set(heroUids.filter((uid) => uid && !team.has(uid)));
  const ownedHeroes = (Array.isArray(source.ownedHeroes) ? source.ownedHeroes : []).map((hero) => {
    if (!trainees.has(hero?.uid) || integer(hero?.level, 1, MAX_LEVEL) >= accountLevel || xpGain <= 0) return hero;
    let level = integer(hero.level, 1, MAX_LEVEL);
    let remaining = Math.max(0, Math.floor(Number(hero.xp) || 0)) + xpGain;
    while (level < accountLevel && remaining >= heroXpNeeded(level)) {
      remaining -= heroXpNeeded(level);
      level += 1;
    }
    return level >= accountLevel
      ? { ...hero, level: accountLevel, xp: 0 }
      : { ...hero, level, xp: Math.min(remaining, heroXpNeeded(level) - 1) };
  });

  return {
    ...source,
    ownedHeroes,
    trainingCamp: {
      ...camp,
      heroUids,
      activeBoostKey,
      boostMultiplier,
      boostEndsAt,
      boostQueue,
      lastTick: now,
    },
  };
}

export function applyTrainingPurchases(sourceState, events, nowMs) {
  const settled = settleTrainingState(sourceState, nowMs);
  const sourceCamp = settled.trainingCamp && typeof settled.trainingCamp === 'object' ? settled.trainingCamp : {};
  const camp = {
    ...sourceCamp,
    boostQueue: Array.isArray(sourceCamp.boostQueue) ? [...sourceCamp.boostQueue] : [],
  };
  const applied = new Set(Array.isArray(camp.serverAppliedPurchaseIds) ? camp.serverAppliedPurchaseIds.filter((id) => typeof id === 'string') : []);
  const now = Math.max(0, Math.floor(Number(nowMs) || 0));
  for (const event of Array.isArray(events) ? events : []) {
    const id = typeof event?.idempotency_key === 'string' ? event.idempotency_key : '';
    const kind = typeof event?.action_kind === 'string' ? event.action_kind : '';
    if (!id || applied.has(id)) continue;
    if (kind === 'training-slot') {
      camp.unlockedSlots = Math.min(10, Math.max(2, integer(camp.unlockedSlots, 2, 10)) + 1);
      applied.add(id);
      continue;
    }
    const match = /^training-boost-(2|4)x-(1|4)h$/.exec(kind);
    if (!match) continue;
    const multiplier = Number(match[1]);
    const hours = Number(match[2]);
    const key = `${multiplier}x-${hours}h`;
    const durationMs = hours * 60 * 60 * 1000;
    if (Number(camp.boostMultiplier) <= 1 || Number(camp.boostEndsAt) <= now) {
      camp.activeBoostKey = key;
      camp.boostMultiplier = multiplier;
      camp.boostEndsAt = now + durationMs;
    } else if (camp.activeBoostKey === key) {
      camp.boostEndsAt = Number(camp.boostEndsAt) + durationMs;
    } else {
      camp.boostQueue.push({ key, multiplier, durationMs });
    }
    applied.add(id);
  }
  camp.serverAppliedPurchaseIds = [...applied].slice(-200);
  return { ...settled, trainingCamp: camp };
}

function starMultiplier(stars) {
  return 1 + integer(stars, 0, 20) * .05;
}

function heroLevelMastery(level) {
  return 1 + .75 * (integer(level, 1, MAX_LEVEL) - 1) / 79;
}

const ITEM_STAT_KEYS = new Set(['hp', 'atk', 'def', 'atkSpeed', 'critChance', 'critDamage', 'dodge']);
const SET_BONUS_PERCENT = {
  common: 5, uncommon: 10, rare: 15, epic: 20, legendary: 30, mythic: 40,
  relic: 40, cosmic: 50, divine: 60, celestial: 70, cursed: 80, immortal: 90, god: 100,
};
const ENCHANT_RESONANCE_PERCENT = [0, 1, 2, 4, 7, 11, 16, 22, 30, 39, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];

function enchantV4Multiplier(level) {
  const safe = integer(level, 0, 20);
  return 1 + Math.min(safe, 5) * .10
    + Math.max(0, Math.min(safe, 10) - 5) * .15
    + Math.max(0, Math.min(safe, 15) - 10) * .20
    + Math.max(0, safe - 15) * .25;
}

function canonicalItemStats(items) {
  const equipped = Array.isArray(items) ? items : [];
  const rarity = equipped.length === 8 && equipped.every((item) => item?.rarity === equipped[0]?.rarity)
    ? equipped[0].rarity
    : null;
  const setBonus = (SET_BONUS_PERCENT[rarity] ?? 0) / 100;
  const minimumEnchant = equipped.length === 8
    ? Math.min(...equipped.map((item) => integer(item?.enchant_level, 0, 20)))
    : 0;
  const resonance = (ENCHANT_RESONANCE_PERCENT[minimumEnchant] ?? 0) / 100;
  return equipped.reduce((totals, item) => {
    const version = Number(item?.enchant_stats_version);
    const v3 = version === 3;
    for (const stat of Array.isArray(item?.stats) ? item.stats : []) {
      if (!ITEM_STAT_KEYS.has(stat?.key)) continue;
      const value = Number(stat?.value);
      if (!Number.isFinite(value)) continue;
      const rate = v3 ? ['hp','atk','def'].includes(stat.key) ? .1
        : ['goldBonus','xpBonus'].includes(stat.key) ? .025 : .05 : .1;
      const level = integer(item?.enchant_level, 0, 20);
      const multiplier = (version === 4 ? enchantV4Multiplier(level) : 1 + level * rate)
        + setBonus + (v3 ? 0 : resonance);
      const bounded = Math.max(-1_000_000_000, Math.min(1_000_000_000, value));
      const effective = stat?.isPercent === true
        ? Math.round(bounded * multiplier * 1000) / 1000
        : Math.round(bounded * multiplier);
      totals[stat.key] += effective;
    }
    return totals;
  }, { hp: 0, atk: 0, def: 0, atkSpeed: 0, critChance: 0, critDamage: 0, dodge: 0 });
}

function canonicalStats(hero, equippedItems = []) {
  const id = canonicalId(hero?.heroId);
  const separator = id.lastIndexOf('-');
  const heroClass = id.slice(0, separator);
  const rarity = id.slice(separator + 1);
  const archetype = ARCHETYPES[heroClass];
  const tier = RARITIES.indexOf(rarity);
  if (!archetype || tier < 0) return null;

  const rarityScale = RARITY_SCALE[tier];
  const level = integer(hero?.level, 1, MAX_LEVEL);
  const stars = integer(hero?.stars, 0, 20);
  const starScale = starMultiplier(stars);
  const itemStats = canonicalItemStats(equippedItems);
  const rarityGrowth = 1 + tier * .02;
  const mastery = heroLevelMastery(level);
  const hp = Math.round((archetype.hp * rarityScale * .2 * (1 + archetype.growth[0] * rarityGrowth * (level - 1)) * starScale + itemStats.hp) * (archetype.hpMult ?? 1) * mastery);
  const atk = Math.round((archetype.atk * rarityScale * .2 * (1 + archetype.growth[1] * rarityGrowth * (level - 1)) * starScale + itemStats.atk) * mastery);
  const def = Math.round((archetype.def * rarityScale * .2 * (1 + archetype.growth[2] * rarityGrowth * (level - 1)) * starScale + itemStats.def) * mastery);
  const speed = archetype.speed * (1 + tier * .01) + stars * .1;
  const attackSpeed = Math.min((archetype.attackSpeed ?? 0) + itemStats.atkSpeed, archetype.caps[4]);
  const interval = Math.max(600, (1540 - Math.min(speed * 2.2, 700)) / (1 + attackSpeed));
  const crit = Math.min(archetype.crit + itemStats.critChance, archetype.caps[2]);
  const critDamage = Math.min(archetype.critDamage + itemStats.critDamage, archetype.caps[3]);
  const dodge = Math.min((archetype.dodge ?? 0) + itemStats.dodge, archetype.caps[1]);
  const dps = atk * (1000 / interval) * (1 + crit * (critDamage - 1)) * (archetype.dps ?? 1);
  const mitigation = Math.min(archetype.caps[0], def / (def + 200));
  const effectiveHp = hp / (1 - mitigation) / (1 - dodge);
  const sustain = hp * (archetype.regen ?? 0);
  return { hero_id: id, level, stars, power: 4 * dps + .08 * effectiveHp + 1.5 * sustain };
}

export function deriveServerSummary(state, ledgerItems = []) {
  const safeState = state && typeof state === 'object' ? state : {};
  const owned = Array.isArray(safeState.ownedHeroes) ? safeState.ownedHeroes : [];
  const byUid = new Map(owned.filter((hero) => hero && typeof hero.uid === 'string').map((hero) => [hero.uid, hero]));
  const ledgerByUid = new Map((Array.isArray(ledgerItems) ? ledgerItems : []).flatMap((item) =>
    item && typeof item.id === 'string' ? [[item.id, item]] : []));
  const statsForRoster = (heroes) => {
    const claimedItems = new Set();
    return heroes.map((hero) => {
      const equippedUids = hero?.equipped && typeof hero.equipped === 'object'
        ? [...new Set(Object.values(hero.equipped).filter((uid) => typeof uid === 'string'))]
        : [];
      const equipped = equippedUids.flatMap((uid) => {
        if (claimedItems.has(uid) || !ledgerByUid.has(uid)) return [];
        claimedItems.add(uid);
        return [ledgerByUid.get(uid)];
      });
      return canonicalStats(hero, equipped);
    }).filter(Boolean);
  };
  const team = Array.isArray(safeState.team) ? [...new Set(safeState.team)].slice(0, 3) : [];
  const lineup = statsForRoster(team.map((uid) => byUid.get(uid)));
  const roster = statsForRoster(owned);
  const rawCollectionPower = Math.min(10_000_000, Math.max(0, Math.round(roster.reduce((sum, hero) => sum + hero.power, 0))));
  const rawLineupPower = Math.min(10_000_000, Math.max(0, Math.round(lineup.reduce((sum, hero) => sum + hero.power, 0))));
  const trainingHeroCount = integer(safeState.trainingCamp?.heroUids?.filter?.(Boolean)?.length, 0, 10);
  const trainingMultiplier = trainingHeroCount >= 5 ? 0.1 : [1, 0.9, 0.75, 0.5, 0.25][trainingHeroCount] ?? 1;
  const accountLevel = integer(safeState.accountLevel, 1, MAX_LEVEL);
  const highestLocation = integer(safeState.highestLocation, 1, 10_000);
  const currentLocation = integer(safeState.currentLocation, 1, highestLocation);
  const latestLocation = serverLocationCap(safeState);
  const totalKills = integer(safeState.totalKills, 0, 1_000_000_000);
  const bossKills = integer(safeState.totalBossKills, 0, 1_000_000_000);
  const chestsOpened = integer(safeState.chestsOpenedToday, 0, 1_000_000_000);
  const totalTokensEarned = Math.min(1_000_000_000_000, Math.max(0, Number(safeState.totalTokensEarned) || 0));
  return {
    power: Math.floor(rawLineupPower * trainingMultiplier),
    combat_power: rawLineupPower,
    collection_power: rawCollectionPower,
    account_level: accountLevel,
    training_hero_count: trainingHeroCount,
    total_kills: totalKills,
    boss_kills: bossKills,
    chests_opened: chestsOpened,
    heroes_owned: owned.length,
    highest_location: highestLocation,
    lineup: lineup.map(({ power: _power, ...hero }) => hero),
    total_tokens_earned: totalTokensEarned,
    token_eligible: currentLocation <= latestLocation && currentLocation >= Math.max(1, latestLocation - 1),
  };
}
