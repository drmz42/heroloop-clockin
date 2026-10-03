import assert from 'node:assert/strict';
import { beginMiningRound, planMining, releasableMiningBudget, settleMiningRound, stopMining } from './mining_budget.ts';
const policy = { sessionLimit: 100n, dailyRemaining: 90n, stakePerRound: 10n,
  networkPerRound: 2n, protocolPerRound: 3n, maxRounds: 5 };
Deno.test('mining cap includes network/protocol costs and authorized available funds', () => {
  assert.equal(planMining(31n, 31n, policy).roundLimit, 2);
  for (const [budget, available] of [[0n, 100n], [14n, 100n], [91n, 100n], [31n, 30n]]) {
    assert.throws(() => planMining(budget, available, policy));
  }
  assert.throws(() => planMining(20n, 100n, { ...policy, networkPerRound: -1n }));
  assert.throws(() => planMining(20n, 100n, { ...policy, maxRounds: NaN }));
  assert.throws(() => planMining(20n, 100n, { ...policy, sessionLimit: 0n }));
});
Deno.test('timeout/stop preserves in-flight budget and forbids a second submission', () => {
  const initial = planMining(31n, 31n, policy);
  const pending = beginMiningRound(initial);
  assert.throws(() => beginMiningRound(pending));
  const stopped = stopMining(pending);
  assert.equal(releasableMiningBudget(stopped), 16n);
  assert.throws(() => beginMiningRound(stopped));
  assert.throws(() => settleMiningRound(stopped, 16n));
  const final = settleMiningRound(stopped, 12n);
  assert.equal(releasableMiningBudget(final), 19n);
  assert.throws(() => settleMiningRound(final, 12n));
  assert.equal(initial.spent, 0n);
});
Deno.test('round/session exhaustion forbids continued mining and reinvestment', () => {
  let plan = planMining(31n, 31n, policy);
  assert.throws(() => releasableMiningBudget(plan));
  for (let i = 0; i < 2; i++) plan = settleMiningRound(beginMiningRound(plan), 15n);
  assert.throws(() => beginMiningRound(plan));
  assert.equal(releasableMiningBudget(stopMining(plan)), 1n);
  let bounded = planMining(90n, 100n, { ...policy, maxRounds: 1 });
  bounded = settleMiningRound(beginMiningRound(bounded), 0n);
  assert.throws(() => beginMiningRound(bounded));
  assert.equal(bounded.reserved, 90n);
});
