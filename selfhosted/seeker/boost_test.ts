import assert from 'node:assert/strict';
import { evaluateSkrBoost, SKR_BOOST_POLICY, type SkrBoostSnapshot } from './boost.ts';
import { SKR_ASSET, type SkrEventKind } from './ledger.ts';
import { unavailableSkrBoost } from '../api/skr_boost.ts';

const now = Date.parse('2026-10-02T00:00:00Z');
const owner = 'owner';
const ids = { player: 'player', merchant: 'merchant', chain: 'chain', peer: 'peer', reserve: 'reserve' };
function fixture(): SkrBoostSnapshot {
  const snapshot: SkrBoostSnapshot = {
    player_id: owner,
    accounts: [
      { id: ids.player, kind: 'player', player_id: owner, balance_minor: '0' },
      { id: ids.merchant, kind: 'merchant', player_id: null, balance_minor: '0' },
      { id: ids.chain, kind: 'chain', player_id: null, balance_minor: '0' },
      { id: ids.peer, kind: 'player', player_id: 'other', balance_minor: '0' },
      { id: ids.reserve, kind: 'withdrawal_reserve', player_id: owner, balance_minor: '0' },
    ], entries: [], events: [], purchases: [], refunds: [],
    rate: { mint: SKR_ASSET.mint, network: SKR_ASSET.network, usd_micros_per_skr: '10000', observed_at: new Date(now).toISOString() },
  };
  post(snapshot, 'deposit', 'deposit', ids.chain, ids.player, '5000000000');
  return snapshot;
}
function post(s: SkrBoostSnapshot, id: string, kind: SkrEventKind, from: string, to: string, minor: string) {
  const value = BigInt(minor);
  s.events.push({ id, idempotency_key: id, kind, request: { kind, signature: null, legs: [] }, chain_signature: null, created_at: new Date(now).toISOString() });
  s.entries.push({ event_id: id, account_id: from, delta_minor: (-value).toString() }, { event_id: id, account_id: to, delta_minor: value.toString() });
  for (const account of s.accounts) {
    if (account.id === from) account.balance_minor = (BigInt(account.balance_minor) - value).toString();
    if (account.id === to) account.balance_minor = (BigInt(account.balance_minor) + value).toString();
  }
}
function buy(s: SkrBoostSnapshot, id = 'purchase', category = 'store', target = ids.merchant) {
  post(s, id, 'transfer', ids.player, target, '1000000000');
  s.purchases.push({ event_id: id, quote_id: `quote-${id}`, category, usd_cents: '1000', mint: SKR_ASSET.mint, network: SKR_ASSET.network });
}
Deno.test('approved thresholds stay USD-based; unapproved bonuses and activation stay disabled', () => {
  assert.equal(SKR_BOOST_POLICY.spend_usd_cents, 1000);
  assert.equal(SKR_BOOST_POLICY.hold_usd_cents, 3000);
  assert.equal(SKR_BOOST_POLICY.bonus_percent, null);
  assert.equal(unavailableSkrBoost().spend, null);
  assert.equal(unavailableSkrBoost().hold, null);
  assert.equal(unavailableSkrBoost().activation_enabled, false);
});
Deno.test('eligible settled Store spend and current exact-mint available balance satisfy tasks', () => {
  for (const category of ['store', 'gear_upgrade', 'reroll', 'gacha', 'potion']) {
    const s = fixture(); buy(s, 'purchase', category);
    const result = evaluateSkrBoost(s, now);
    assert.equal(result.spend.complete, true);
    assert.equal(result.spend.usd_cents, '1000');
    assert.equal(result.hold.required_minor, '3000000000');
    assert.equal(result.hold.complete, true);
    assert.equal(result.activation_enabled, false);
  }
});
Deno.test('Marketplace, mislabeled peer transfers and non-SKR purchases never qualify', () => {
  const market = fixture(); buy(market, 'market', 'marketplace', ids.peer);
  assert.equal(evaluateSkrBoost(market, now).spend.usd_cents, '0');
  const forged = fixture(); buy(forged, 'peer', 'store', ids.peer);
  assert.equal(evaluateSkrBoost(forged, now).spend.complete, false);
  const wrongMint = fixture(); buy(wrongMint); wrongMint.purchases[0].mint = 'HERO';
  assert.throws(() => evaluateSkrBoost(wrongMint, now), /invalid_skr_boost_asset/);
});
Deno.test('stale/future/wrong-mint rates fail holding closed without erasing historical spending', () => {
  const s = fixture(); buy(s);
  for (const rate of [null, { ...s.rate!, observed_at: new Date(now - 60001).toISOString() },
    { ...s.rate!, observed_at: new Date(now + 1).toISOString() }, { ...s.rate!, mint: 'OTHER' }]) {
    const result = evaluateSkrBoost({ ...s, rate }, now);
    assert.equal(result.hold.rate_available, false);
    assert.equal(result.hold.complete, false);
    assert.equal(result.spend.complete, true);
  }
  const repriced = evaluateSkrBoost({ ...s, rate: { ...s.rate!, usd_micros_per_skr: '1000' } }, now);
  assert.equal(repriced.spend.usd_cents, '1000');
  assert.equal(repriced.hold.complete, false);
});
Deno.test('withdrawal reservation reduces available holding immediately; no client balance substitution', () => {
  const s = fixture();
  post(s, 'reserve', 'withdraw_reserve', ids.player, ids.reserve, '2000000001');
  assert.equal(evaluateSkrBoost(s, now).hold.complete, false);
  s.accounts[0].balance_minor = '5000000000';
  assert.throws(() => evaluateSkrBoost(s, now), /invalid_skr_boost_snapshot/);
});
Deno.test('partial/full refunds reverse original USD credit with conservative rounding', () => {
  const s = fixture(); buy(s);
  post(s, 'refund-a', 'transfer', ids.merchant, ids.player, '1');
  s.refunds.push({ event_id: 'refund-a', purchase_event_id: 'purchase' });
  assert.equal(evaluateSkrBoost(s, now).spend.usd_cents, '999');
  assert.equal(evaluateSkrBoost(s, now).spend.complete, false);
  post(s, 'refund-b', 'transfer', ids.merchant, ids.player, '999999999');
  s.refunds.push({ event_id: 'refund-b', purchase_event_id: 'purchase' });
  assert.equal(evaluateSkrBoost(s, now).spend.usd_cents, '0');
  post(s, 'over-refund', 'transfer', ids.merchant, ids.player, '1');
  s.refunds.push({ event_id: 'over-refund', purchase_event_id: 'purchase' });
  assert.throws(() => evaluateSkrBoost(s, now), /invalid_skr_boost_refund/);
});
Deno.test('duplicate settlement/quote/refund/ledger rows refuse replay inflation', () => {
  for (const target of ['events', 'entries', 'purchases'] as const) {
    const s = fixture(); buy(s);
    if (target === 'events') s.events.push(s.events[0]);
    if (target === 'entries') s.entries.push(s.entries[0]);
    if (target === 'purchases') s.purchases.push(s.purchases[0]);
    assert.throws(() => evaluateSkrBoost(s, now), /invalid_skr_boost_snapshot/);
  }
  const s = fixture(); buy(s, 'a'); buy(s, 'b'); s.purchases[1].quote_id = s.purchases[0].quote_id;
  assert.throws(() => evaluateSkrBoost(s, now), /invalid_skr_boost_snapshot/);
});
Deno.test('holding conversion rounds up at the atomic-unit boundary', () => {
  const s = fixture(); s.rate!.usd_micros_per_skr = '11000';
  assert.equal(evaluateSkrBoost(s, now).hold.required_minor, '2727272728');
});

Deno.test('fractional-cent approved rerolls retain exact threshold accounting',()=>{
 const s=fixture();buy(s,'a','reroll');s.purchases[0].usd_cents='999.5000';
 assert.equal(evaluateSkrBoost(s,now).spend.complete,false);
 buy(s,'b','reroll');s.purchases[1].usd_cents='0.5000';
 assert.equal(evaluateSkrBoost(s,now).spend.complete,true);
});
