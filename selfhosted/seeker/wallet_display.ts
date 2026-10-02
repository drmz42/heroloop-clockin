// Read-only balances for display/MAX; transfer limits and settlement stay server-owned.
import type { WalletAsset } from './chain.ts';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
export function externalBalances(sol: unknown, tokens: unknown, limits: Record<WalletAsset, bigint>) {
  if (!record(sol) || !Number.isSafeInteger(sol.value) || Number(sol.value) < 0
    || !record(tokens) || !Array.isArray(tokens.value)) throw new Error('rpc_balance');
  let total = 0n, largest = 0n;
  for (const row of tokens.value) {
    const info = row?.account?.data?.parsed?.info;
    const token = info?.tokenAmount;
    if (!token || token.decimals !== 6 || typeof token.amount !== 'string' || !/^\d+$/.test(token.amount)) throw new Error('rpc_balance');
    const amount = BigInt(token.amount);
    total += amount;
    if (info.state === 'initialized' && amount > largest) largest = amount;
  }
  const balance = BigInt(Number(sol.value));
  // Leave the same base network fee used by the existing deposit transaction.
  const spendableSol = balance > 5000n ? balance - 5000n : 0n;
  return {
    external_balances: { SKR: total.toString(), SOL: balance.toString() },
    max_deposit_balances: {
      SKR: (largest < limits.SKR ? largest : limits.SKR).toString(),
      SOL: (spendableSol < limits.SOL ? spendableSol : limits.SOL).toString(),
    },
  };
}
