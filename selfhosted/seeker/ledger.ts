// Accounting contract only. No signer, RPC, HTTP route or current-game balance.
export const SKR_ASSET = Object.freeze({
  network: 'solana:mainnet',
  mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
  decimals: 6,
  program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
});
export type SkrAccountKind = 'player' | 'withdrawal_reserve' | 'fees' | 'merchant' | 'rewards' | 'chain';
export type SkrEventKind = 'deposit' | 'transfer' | 'withdraw_reserve' | 'withdraw_release' | 'withdraw_finalize';
export type SkrLeg = { account_id: string; delta_minor: string };
export type SkrAccount = { id: string; kind: SkrAccountKind; player_id: string | null; balance_minor: string };
export type SkrEvent = {
  id: string; idempotency_key: string; kind: SkrEventKind;
  request: { kind: SkrEventKind; signature: string | null; legs: SkrLeg[] };
  chain_signature: string | null; created_at: string;
};
export type SkrEntry = { event_id: string; account_id: string; delta_minor: string };
const MAX = 18_446_744_073_709_551_615n;

export function skrMinor(amount: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount) || amount.length > 27) {
    throw new Error('invalid_skr_amount');
  }
  const [whole, fraction = ''] = amount.split('.');
  const minor = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (minor <= 0n || minor > MAX) throw new Error('invalid_skr_amount');
  return minor.toString();
}

export function skrLegs(value: unknown): SkrLeg[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error('invalid_skr_legs');
  const ids = new Set<string>();
  let total = 0n;
  const result = value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_skr_legs');
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || typeof row.account_id !== 'string' || typeof row.delta_minor !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.account_id) ||
      !/^-?[1-9][0-9]{0,19}$/.test(row.delta_minor)) throw new Error('invalid_skr_legs');
    const amount = BigInt(row.delta_minor);
    if (amount > MAX || amount < -MAX || ids.has(row.account_id)) throw new Error('unbalanced_skr_event');
    ids.add(row.account_id);
    total += amount;
    return { account_id: row.account_id, delta_minor: row.delta_minor };
  });
  if (total !== 0n) throw new Error('unbalanced_skr_event');
  return result.sort((a, b) => a.account_id.localeCompare(b.account_id));
}
