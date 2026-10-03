// Seeker (Solana Mobile) edition server gate — docs/game/seeker-hero-removal-map.md.
// With HEROLOOP_EDITION=seeker the API refuses every command that issues, spends or
// pays out $HERO before it touches state, so hiding the client UI is never the only
// control. Unset (every current environment) it refuses nothing.

// Commands that exist only for $HERO (or for unlimited tester grants).
export const SEEKER_REFUSED_ACTIONS: ReadonlySet<string> = new Set([
  "ascension_focus_set",
  "hero_summon_quote",
  "hero_promote_all",
  "hero_capacity_quote",
  "hero_capacity_upgrade",
  "claim",
  "spend_tokens",
  "tester_credit_tokens",
  "tester_credit_gold",
  "set_boost_max_active",
  "store_buy_item",
  "shop_bundle_buy",
  "reward_boost_buy",
  "inventory_bag_buy",
  "reserve_limited_item",
  "remove_limited_item",
  "market_list_item",
  "market_buy_listing",
  "market_seed_test_stock",
]);

export type Edition = "seeker" | "standard";

export function parseEdition(value: string | undefined): Edition {
  return value === "seeker" ? "seeker" : "standard";
}

/** The refusal code for this command in this edition, or null when it may run. */
export function seekerRefusal(edition: Edition, action: string, payload: Record<string, unknown>): string | null {
  if (edition !== "seeker") return null;
  if (SEEKER_REFUSED_ACTIONS.has(action)) return "unavailable_in_seeker_edition";
  // Summon stays available with Summon Scrolls; the $HERO-paid path is off.
  if (action === "hero_summon" && payload.payment_method !== "scroll") return "unavailable_in_seeker_edition";
  // Star Up runs only as Promote All for duplicates + Gold; a single paid Star Up is the SKR product.
  if (action === "hero_ascend" && !(Array.isArray(payload.target_uids) && payload.repeat === true && typeof payload.expected_gold === "number")) {
    return "unavailable_in_seeker_edition";
  }
  if (action === "item_upgrade" && (payload.operation === "reroll" || payload.use_charm === true)) return "unavailable_in_seeker_edition";
  return null;
}
