export const AUTOMATIC_HEALING_POLICY: string;
export const AUTOMATIC_HEALING_BALANCE_VERSION: string;
export const AUTOMATIC_HEALING_PRICES: Readonly<Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl', number>>;
export function goldHealingEnabled(config?: { enabled?: boolean; goldHealingOptOut?: boolean }): boolean;
export function automaticHealingConfig<T extends { enabled?: boolean; healingInfoSeen?: boolean; goldHealingOptOut?: boolean }>(config: T): T & { enabled: boolean; autoBuy: boolean; autoSelectTier: boolean; threshold: number };
