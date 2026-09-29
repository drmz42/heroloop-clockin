import enchantConfig from '../../config/economy/enchant-v4.v1.json';
import goldConfig from '../../config/economy/enchant-v4-gold-reprice.v1.json';
import type { Rarity } from './types';
import { v6EnchantMultiplier } from '../../managed/functions/player-sync/balance-v6.mjs';

export const ENCHANT_CONFIG_SHA256 = '4c18f4186df22256327f9377c373335cf63a83517fc38a3d20e393ff9abfc359';
export const ENCHANT_GOLD_CONFIG_SHA256 = '889b5048505e913d6bddad218db8425ddcb24196ceedc7e7e8423b6447832495';
export const ENCHANT_BALANCE_VERSION = enchantConfig.balanceVersion;
export const ENCHANT_CONFIG_VERSION = enchantConfig.version;
export const MAX_ENCHANT_LEVEL = enchantConfig.maximumLevel;
export const HERO_USD_QUOTE = 0.001;

const canonicalRarity = (rarity: Rarity): Exclude<Rarity, 'relic'> =>
  rarity === 'relic' ? 'mythic' : rarity;

export function normalizeEnchantLevel(value: number): number {
  return Math.max(0, Math.min(MAX_ENCHANT_LEVEL, Math.floor(Number.isFinite(value) ? value : 0)));
}

// Balance v6 replaces the v4 tiered stat curve with a linear +11% per level (×3.2 at +20).
// Chances, costs and Guaranteed Enchant prices still come from the v4 economy config.
export function enchantBonus(enchantLevel: number): number {
  return v6EnchantMultiplier(normalizeEnchantLevel(enchantLevel)) - 1;
}

export function enchantBonusPercent(enchantLevel: number): number {
  return Math.round(enchantBonus(enchantLevel) * 100);
}

export function enchantMultiplier(enchantLevel: number): number {
  return 1 + enchantBonus(enchantLevel);
}

export function enchantSuccessChance(currentEnchant: number): number {
  const target = normalizeEnchantLevel(currentEnchant) + 1;
  if (target > MAX_ENCHANT_LEVEL) return 0;
  if (target <= enchantConfig.ordinary.guaranteedThrough) return 1;
  return Number(enchantConfig.ordinary.successChanceByTarget[String(target) as keyof typeof enchantConfig.ordinary.successChanceByTarget] ?? 0);
}

export function enchantGoldCost(rarity: Rarity, currentEnchant: number): number {
  const target = normalizeEnchantLevel(currentEnchant) + 1;
  if (target > MAX_ENCHANT_LEVEL) return 0;
  const costs = goldConfig.proposedGoldByTarget[canonicalRarity(rarity)];
  return Number(costs?.[target - 1] ?? 0);
}

export function enchantGuaranteedUsd(currentEnchant: number): number {
  const target = normalizeEnchantLevel(currentEnchant) + 1;
  if (target < enchantConfig.pricing.guaranteed.availableFromTarget || target > MAX_ENCHANT_LEVEL) return 0;
  return Number(enchantConfig.pricing.guaranteed.usdByTarget[String(target) as keyof typeof enchantConfig.pricing.guaranteed.usdByTarget] ?? 0);
}

export function enchantGuaranteedHeroCost(currentEnchant: number): number {
  return Math.ceil(enchantGuaranteedUsd(currentEnchant) / HERO_USD_QUOTE);
}

export const ENCHANT_RESONANCE_PERCENT = Object.freeze([
  0,
  ...Array.from({ length: MAX_ENCHANT_LEVEL }, (_, index) =>
    Number(enchantConfig.resonance.bonusPercentByMinimumLevel[String(index + 1) as keyof typeof enchantConfig.resonance.bonusPercentByMinimumLevel] ?? 0)),
]);

export function enchantResonancePercent(minimumEnchant: number): number {
  return ENCHANT_RESONANCE_PERCENT[normalizeEnchantLevel(minimumEnchant)] ?? 0;
}
