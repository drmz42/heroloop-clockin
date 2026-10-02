// Public rules only. A payment adapter must supply verified private-ledger
// snapshots before progress or activation can be exposed.
export const SKR_BOOST_POLICY = Object.freeze({
  version: 'skr-boost-v1', spend_usd_cents: 1000, hold_usd_cents: 3000,
  deposit_usd_cents: null, no_withdraw_seconds: null, bonus_percent: null,
  activation_enabled: false,
});
export function unavailableSkrBoost() {
  return { policy: SKR_BOOST_POLICY, status: 'unavailable' as const, activation_enabled: false as const, spend: null, hold: null };
}
