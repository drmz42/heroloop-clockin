export const ORDINARY_POTION_POLICY: string;
export const ORDINARY_POTION_BALANCE_VERSION: string;
export const ORDINARY_POTION_PRICE: number;
export interface OrdinaryPotionTimer {
  cooldown_until_ms: number;
  buff: { total: number; ticks: number; next_ms: number } | null;
}
export type OrdinaryPotionContext = Record<string, OrdinaryPotionTimer>;
