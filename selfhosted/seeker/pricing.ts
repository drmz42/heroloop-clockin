import { SKR_ASSET } from './ledger.ts';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export type PriceRate = { mint: string; network: string; usd_micros_per_skr: string; observed_at: string };
export function parsePrice(body: unknown, mint: string, now = Date.now()): PriceRate {
  const row = body && typeof body === 'object' ? (body as Record<string, unknown>)[mint] : null;
  const price = row && typeof row === 'object' ? (row as Record<string, unknown>).usdPrice : null;
  // Round the rate down and the debit up. Never undercollect the USD price.
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1_000_000) throw new Error('stale_skr_rate');
  const micros = Math.floor(price * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros < 1) throw new Error('stale_skr_rate');
  return { mint, network: SKR_ASSET.network, usd_micros_per_skr: String(micros), observed_at: new Date(now).toISOString() };
}
export function quotedAmount(cents: number, rate: string): string {
  if (!Number.isFinite(cents) || !Number.isSafeInteger(Math.round(cents*10000)) || Math.abs(cents*10000-Math.round(cents*10000))>=0.000001 || cents<0.0001 || !/^[1-9][0-9]{0,19}$/.test(rate)) throw new Error('invalid_skr_price');
  const n=BigInt(Math.round(cents*10000))*1_000_000n, d=BigInt(rate);
  return ((n+d-1n)/d).toString();
}
