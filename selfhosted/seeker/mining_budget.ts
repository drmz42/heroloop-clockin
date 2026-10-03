// Offline server policy planner. No ORE protocol adapter, ledger writes or signer.
// All amounts are lamports. Approved policy and verified protocol costs are required.
const MAX = 18_446_744_073_709_551_615n;
export type MiningPolicy = Readonly<{
  sessionLimit: bigint; dailyRemaining: bigint; stakePerRound: bigint;
  networkPerRound: bigint; protocolPerRound: bigint; maxRounds: number;
}>;
export type MiningPlan = Readonly<{
  reserved: bigint; spent: bigint; inFlight: bigint; completed: number;
  stopped: boolean; roundCost: bigint; roundLimit: number;
}>;
const amount = (v: bigint, positive = false) => {
  if (typeof v !== 'bigint' || v < (positive ? 1n : 0n) || v > MAX) {
    throw new Error('invalid_mining_amount');
  }
  return v;
};
export function planMining(budget: bigint, available: bigint, policy: MiningPolicy): MiningPlan {
  amount(budget, true); amount(available);
  amount(policy.sessionLimit, true); amount(policy.dailyRemaining);
  amount(policy.stakePerRound, true); amount(policy.networkPerRound); amount(policy.protocolPerRound);
  if (!Number.isSafeInteger(policy.maxRounds) || policy.maxRounds < 1 || policy.maxRounds > 10_000) {
    throw new Error('invalid_mining_round_limit');
  }
  if (budget > available || budget > policy.sessionLimit || budget > policy.dailyRemaining) {
    throw new Error('mining_budget_exceeded');
  }
  const roundCost = amount(policy.stakePerRound + policy.networkPerRound + policy.protocolPerRound, true);
  if (budget < roundCost) throw new Error('mining_budget_below_round_cost');
  const roundLimit = Number(budget / roundCost < BigInt(policy.maxRounds)
    ? budget / roundCost : BigInt(policy.maxRounds));
  return Object.freeze({ reserved: budget, spent: 0n, inFlight: 0n, completed: 0,
    stopped: false, roundCost, roundLimit });
}
function validate(plan: MiningPlan) {
  amount(plan.reserved, true); amount(plan.spent); amount(plan.inFlight); amount(plan.roundCost, true);
  if (typeof plan.stopped !== 'boolean' || !Number.isSafeInteger(plan.completed) || plan.completed < 0
    || !Number.isSafeInteger(plan.roundLimit) || plan.roundLimit < 1 || plan.roundLimit > 10_000
    || plan.completed > plan.roundLimit || plan.spent + plan.inFlight > plan.reserved
    || (plan.inFlight !== 0n && plan.inFlight !== plan.roundCost)) throw new Error('invalid_mining_plan');
}
// Persist under a session lock before sending a protocol transaction. A timeout
// keeps inFlight reserved; it is never an instruction to retry a new transaction.
export function beginMiningRound(plan: MiningPlan): MiningPlan {
  validate(plan);
  if (plan.stopped || plan.inFlight !== 0n || plan.completed >= plan.roundLimit
    || plan.spent + plan.roundCost > plan.reserved) throw new Error('mining_round_unavailable');
  return Object.freeze({ ...plan, inFlight: plan.roundCost });
}
// Call once for a uniquely recorded, finalized protocol outcome. Neither a reward
// nor recovered SOL increases this session's authorized budget (no reinvestment).
export function settleMiningRound(plan: MiningPlan, verifiedCost: bigint): MiningPlan {
  validate(plan); amount(verifiedCost);
  if (plan.inFlight === 0n || verifiedCost > plan.inFlight) throw new Error('invalid_mining_round_result');
  return Object.freeze({ ...plan, spent: plan.spent + verifiedCost, inFlight: 0n,
    completed: plan.completed + 1 });
}
export function stopMining(plan: MiningPlan): MiningPlan {
  validate(plan);
  return Object.freeze({ ...plan, stopped: true });
}
export function releasableMiningBudget(plan: MiningPlan): bigint {
  validate(plan);
  if (!plan.stopped) throw new Error('mining_session_not_stopped');
  return plan.reserved - plan.spent - plan.inFlight;
}
