// Edition selection is server-owned. Old waves retain their original policy.
export const AUTOMATIC_HEALING_POLICY = 'automatic-healing-v1';
export const AUTOMATIC_HEALING_BALANCE_VERSION = 'balance-v6-2026.09.29-v1-combat-effects-v2-auto-healing-v1';
export const AUTOMATIC_HEALING_PRICES = Object.freeze({ xs: 1, sm: 1, md: 1, lg: 2, xl: 4, xxl: 10 });

export function goldHealingEnabled(config = {}) {
  return config.goldHealingOptOut !== true && (config.goldHealingOptOut !== undefined || config.enabled !== false);
}

export function automaticHealingConfig(config = {}) {
  return { ...config, enabled: true, autoBuy: config.healingInfoSeen === true && goldHealingEnabled(config),
    autoSelectTier: true, threshold: .35 };
}
