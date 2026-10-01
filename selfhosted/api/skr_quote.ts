// SKR pricing and payment verification for the HeroLoop Seeker version
// (docs/game/seeker-skr-payments.md). Pure functions only: no network, no
// database, no route is wired to them yet. Money is integer arithmetic in the
// token's minimal units (BigInt); a float never decides an amount.

export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
export const SKR_DECIMALS = 6; // mainnet getAccountInfo, 2026-09-30
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SKR_NETWORK = "solana:mainnet";

const PRICE_SCALE = 12; // USD price of 1 SKR is kept with 12 fractional digits
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type SkrRate = {
  usdPerSkr: string; // decimal string, e.g. "0.0321"
  source: string;
  observedAt: string; // ISO time the provider reported
};

export type SkrQuote = {
  quoteId: string;
  productId: string;
  accountId: string;
  mint: string;
  network: string;
  usdCents: number;
  amountMinor: string; // integer string in minimal units (10^-6 SKR)
  rate: SkrRate;
  rounding: "ceil";
  createdAt: string;
  expiresAt: string;
};

export class SkrQuoteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new SkrQuoteError(code);
}

/** Parses a positive decimal string into an integer scaled by 10^PRICE_SCALE. */
export function parseUsdPrice(value: string): bigint {
  if (typeof value !== "string" || !/^\d{1,9}(\.\d{1,12})?$/.test(value)) fail("invalid_rate");
  const [whole, fraction = ""] = value.split(".");
  const scaled = BigInt(whole) * 10n ** BigInt(PRICE_SCALE) + BigInt(fraction.padEnd(PRICE_SCALE, "0"));
  if (scaled <= 0n) fail("invalid_rate");
  return scaled;
}

/** SKR minimal units for a USD price in cents, rounded up so the treasury never receives less. */
export function skrAmountForUsdCents(usdCents: number, usdPerSkr: string, decimals = SKR_DECIMALS): bigint {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0 || usdCents > 100_000_00) fail("invalid_price");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) fail("invalid_decimals");
  const price = parseUsdPrice(usdPerSkr);
  // amount = usdCents / 100 / price * 10^decimals, with price = scaled / 10^PRICE_SCALE
  const numerator = BigInt(usdCents) * 10n ** BigInt(decimals + PRICE_SCALE);
  const denominator = 100n * price;
  return (numerator + denominator - 1n) / denominator;
}

export function createSkrQuote(input: {
  quoteId: string;
  productId: string;
  accountId: string;
  usdCents: number;
  rate: SkrRate;
  now: Date;
  ttlSeconds: number;
  maxRateAgeSeconds: number;
}): SkrQuote {
  const { quoteId, productId, accountId, usdCents, rate, now, ttlSeconds, maxRateAgeSeconds } = input;
  if (!/^[0-9a-f-]{36}$/.test(quoteId) || !productId || !accountId) fail("invalid_quote_input");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) fail("invalid_ttl");
  const observed = Date.parse(rate.observedAt);
  if (!Number.isFinite(observed) || !rate.source) fail("invalid_rate");
  const age = (now.getTime() - observed) / 1000;
  if (age < -5 || age > maxRateAgeSeconds) fail("stale_rate");
  return {
    quoteId,
    productId,
    accountId,
    mint: SKR_MINT,
    network: SKR_NETWORK,
    usdCents,
    amountMinor: skrAmountForUsdCents(usdCents, rate.usdPerSkr).toString(),
    rate,
    rounding: "ceil",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
}

export function formatSkr(amountMinor: bigint, decimals = SKR_DECIMALS): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (amountMinor % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${amountMinor / base}${fraction ? `.${fraction}` : ""}`;
}

// ── Payment verification against a `getTransaction` (jsonParsed) result ──

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

export type ParsedTransaction = {
  slot: number;
  blockTime?: number | null;
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: { signatures: string[]; message: { accountKeys: { pubkey: string; signer: boolean }[] } };
};

export type PaymentCheck = {
  signature: string;
  payer: string;
  treasury: string;
  confirmation: "processed" | "confirmed" | "finalized";
};

export type PaymentVerdict =
  | { ok: true; signature: string; receivedMinor: string }
  | { ok: false; reason: string };

function ownerDelta(balances: TokenBalance[] | undefined, owner: string): bigint {
  return (balances ?? [])
    .filter((entry) => entry.mint === SKR_MINT && entry.owner === owner)
    .reduce((sum, entry) => {
      if (entry.uiTokenAmount.decimals !== SKR_DECIMALS) fail("unexpected_decimals");
      if (entry.programId && entry.programId !== SPL_TOKEN_PROGRAM) fail("unexpected_token_program");
      return sum + BigInt(entry.uiTokenAmount.amount);
    }, 0n);
}

/**
 * Accepts a payment only when the transaction succeeded, is finalized, was signed by
 * the quoted payer, moved at least the quoted SKR from the payer to the treasury and
 * landed before the quote expired. Replays (one signature used twice) are refused by
 * the caller's unique settlement record, not here.
 */
export function verifySkrPayment(quote: SkrQuote, check: PaymentCheck, tx: ParsedTransaction | null): PaymentVerdict {
  if (!tx) return { ok: false, reason: "transaction_not_found" };
  if (check.confirmation !== "finalized") return { ok: false, reason: "not_finalized" };
  if (!ADDRESS.test(check.payer) || !ADDRESS.test(check.treasury) || check.payer === check.treasury) {
    return { ok: false, reason: "invalid_parties" };
  }
  if (!tx.transaction.signatures.includes(check.signature)) return { ok: false, reason: "signature_mismatch" };
  if (!tx.meta || tx.meta.err !== null) return { ok: false, reason: "transaction_failed" };
  const payerSigned = tx.transaction.message.accountKeys.some((key) => key.pubkey === check.payer && key.signer);
  if (!payerSigned) return { ok: false, reason: "payer_not_signer" };
  if (typeof tx.blockTime !== "number" || tx.blockTime * 1000 > Date.parse(quote.expiresAt)) {
    return { ok: false, reason: "quote_expired" };
  }
  let received: bigint;
  let paid: bigint;
  try {
    received = ownerDelta(tx.meta.postTokenBalances, check.treasury) - ownerDelta(tx.meta.preTokenBalances, check.treasury);
    paid = ownerDelta(tx.meta.preTokenBalances, check.payer) - ownerDelta(tx.meta.postTokenBalances, check.payer);
  } catch (error) {
    return { ok: false, reason: error instanceof SkrQuoteError ? error.code : "invalid_balances" };
  }
  const due = BigInt(quote.amountMinor);
  if (received < due || paid < due) return { ok: false, reason: "amount_too_low" };
  return { ok: true, signature: check.signature, receivedMinor: received.toString() };
}
