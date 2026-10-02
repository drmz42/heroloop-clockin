// Private server evaluator. Its caller must read the isolated ledger and verified
// settlement quotes; this module grants neither ledger access nor SKR rewards.
import { SKR_ASSET, type SkrAccount, type SkrEntry, type SkrEvent } from './ledger.ts';
import { SKR_BOOST_POLICY } from '../api/skr_boost.ts';
export { SKR_BOOST_POLICY } from '../api/skr_boost.ts';
export const SKR_STORE_CATEGORIES = ['store', 'gear_upgrade', 'reroll', 'gacha', 'potion'] as const;
export type SkrPurchaseProof = {
  event_id: string; quote_id: string; category: string; usd_cents: string;
  mint: string; network: string;
};
export type SkrRefundProof = { event_id: string; purchase_event_id: string };
export type SkrBoostSnapshot = {
  player_id: string; accounts: SkrAccount[]; entries: SkrEntry[]; events: SkrEvent[];
  purchases: SkrPurchaseProof[]; refunds: SkrRefundProof[];
  rate: { mint: string; network: string; usd_micros_per_skr: string; observed_at: string } | null;
};

function amount(value: string, signed = false): bigint {
  if (!(signed ? /^-?(0|[1-9][0-9]{0,19})$/ : /^(0|[1-9][0-9]{0,19})$/).test(value)) throw new Error('invalid_skr_boost_snapshot');
  const result = BigInt(value);
  if (result > 18446744073709551615n || result < -18446744073709551615n) throw new Error('invalid_skr_boost_snapshot');
  return result;
}
function unique<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (!id || result.has(id)) throw new Error('invalid_skr_boost_snapshot');
    result.set(id, row);
  }
  return result;
}
const ceil = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;

export function evaluateSkrBoost(snapshot: SkrBoostSnapshot, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('invalid_skr_boost_clock');
  const accounts = unique(snapshot.accounts, row => row.id);
  const events = unique(snapshot.events, row => row.id);
  unique(snapshot.entries, row => `${row.event_id}:${row.account_id}`);
  unique(snapshot.purchases, row => row.event_id);
  unique(snapshot.purchases, row => row.quote_id);
  unique(snapshot.refunds, row => row.event_id);
  const playerAccounts = snapshot.accounts.filter(row => row.kind === 'player' && row.player_id === snapshot.player_id);
  if (playerAccounts.length !== 1) throw new Error('invalid_skr_boost_snapshot');
  const player = playerAccounts[0];
  const legs = new Map<string, SkrEntry[]>();
  let available = 0n;
  for (const entry of snapshot.entries) {
    if (!events.has(entry.event_id) || !accounts.has(entry.account_id)) throw new Error('invalid_skr_boost_snapshot');
    const delta = amount(entry.delta_minor, true);
    if (delta === 0n) throw new Error('invalid_skr_boost_snapshot');
    if (entry.account_id === player.id) available += delta;
    legs.set(entry.event_id, [...(legs.get(entry.event_id) ?? []), entry]);
  }
  if (available < 0n || available !== amount(player.balance_minor)) throw new Error('invalid_skr_boost_snapshot');
  for (const entries of legs.values()) {
    if (entries.reduce((sum, row) => sum + amount(row.delta_minor, true), 0n) !== 0n) throw new Error('invalid_skr_boost_snapshot');
  }
  const ownDelta = (eventId: string) => amount((legs.get(eventId) ?? []).find(row => row.account_id === player.id)?.delta_minor ?? '0', true);
  const merchantOnly = (eventId: string) => (legs.get(eventId) ?? []).filter(row => row.account_id !== player.id)
    .every(row => ['merchant', 'fees'].includes(accounts.get(row.account_id)?.kind ?? ''));
  const purchases = new Map<string, { paid: bigint; usd: bigint; refunded: bigint }>();
  for (const proof of snapshot.purchases) {
    if (proof.mint !== SKR_ASSET.mint || proof.network !== SKR_ASSET.network) throw new Error('invalid_skr_boost_asset');
    const event = events.get(proof.event_id);
    const paid = -ownDelta(proof.event_id);
    if (!event || event.kind !== 'transfer' || paid <= 0n) throw new Error('invalid_skr_boost_purchase');
    const usd = amount(proof.usd_cents) * 10000n;
    if (usd <= 0n) throw new Error('invalid_skr_boost_purchase');
    // Marketplace and peer transfers never qualify, even if mislabelled Store.
    if (!SKR_STORE_CATEGORIES.includes(proof.category as typeof SKR_STORE_CATEGORIES[number]) || !merchantOnly(proof.event_id)) continue;
    purchases.set(proof.event_id, { paid, usd, refunded: 0n });
  }
  for (const refund of snapshot.refunds) {
    const purchase = purchases.get(refund.purchase_event_id);
    if (!purchase) continue;
    const event = events.get(refund.event_id);
    const returned = ownDelta(refund.event_id);
    if (!event || event.kind !== 'transfer' || returned <= 0n || !merchantOnly(refund.event_id)) throw new Error('invalid_skr_boost_refund');
    purchase.refunded += returned;
    if (purchase.refunded > purchase.paid) throw new Error('invalid_skr_boost_refund');
  }
  // Original settled quote value is immutable. Refunds reduce that same value;
  // the current SKR rate never revalues historical spending.
  const spentUsdMicros = [...purchases.values()].reduce((sum, purchase) => sum + purchase.usd - ceil(purchase.usd * purchase.refunded, purchase.paid), 0n);
  const observed = Date.parse(snapshot.rate?.observed_at ?? '');
  const rateValid = snapshot.rate?.mint === SKR_ASSET.mint && snapshot.rate.network === SKR_ASSET.network
    && Number.isFinite(observed) && observed <= now && now - observed <= 60000;
  const rate = rateValid && snapshot.rate ? amount(snapshot.rate.usd_micros_per_skr) : 0n;
  const holdGoal = rate > 0n ? ceil(BigInt(SKR_BOOST_POLICY.hold_usd_cents) * 10000n * 1000000n, rate) : null;
  return {
    policy: SKR_BOOST_POLICY, status: 'verified' as const, activation_enabled: false as const,
    checked_at: new Date(now).toISOString(),
    spend: { usd_cents: (spentUsdMicros / 10000n).toString(), complete: spentUsdMicros >= BigInt(SKR_BOOST_POLICY.spend_usd_cents) * 10000n },
    hold: { available_minor: available.toString(), required_minor: holdGoal?.toString() ?? null, complete: holdGoal !== null && available >= holdGoal, rate_available: holdGoal !== null },
  };
}
