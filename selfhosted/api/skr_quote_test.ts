import assert from "node:assert/strict";

const assertEquals = (actual: unknown, expected: unknown) => assert.deepEqual(actual, expected);
const assertThrows = (fn: () => unknown, _type: unknown, code?: string) =>
  assert.throws(fn, (error: unknown) => error instanceof SkrQuoteError && (!code || error.code === code));
import {
  createSkrQuote,
  formatSkr,
  type ParsedTransaction,
  parseUsdPrice,
  SKR_MINT,
  skrAmountForUsdCents,
  SkrQuoteError,
  SPL_TOKEN_PROGRAM,
  verifySkrPayment,
} from "./skr_quote.ts";

const PAYER = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";
const TREASURY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const now = new Date("2026-09-30T12:00:00.000Z");
const rate = { usdPerSkr: "0.04", source: "fixture", observedAt: "2026-09-30T11:59:30.000Z" };

Deno.test("amount is integer minimal units, rounded up", () => {
  assertEquals(skrAmountForUsdCents(100, "0.04"), 25_000_000n); // $1 / $0.04 = 25 SKR
  assertEquals(skrAmountForUsdCents(1, "0.03"), 333_334n); // 0.3333333… SKR, ceil
  assertEquals(formatSkr(333_334n), "0.333334");
  assertEquals(formatSkr(25_000_000n), "25");
  assertEquals(parseUsdPrice("1"), 1_000_000_000_000n);
});

Deno.test("bad prices and rates are refused", () => {
  for (const bad of ["0", "-1", "abc", "1e-3", "0.0000000000001"]) {
    assertThrows(() => skrAmountForUsdCents(100, bad), SkrQuoteError);
  }
  assertThrows(() => skrAmountForUsdCents(0, "0.04"), SkrQuoteError);
  assertThrows(() => skrAmountForUsdCents(1.5, "0.04"), SkrQuoteError);
});

Deno.test("stale rate blocks a new quote", () => {
  const base = { quoteId: "0f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", productId: "boost-24h", accountId: "acc", usdCents: 100, now, ttlSeconds: 120, maxRateAgeSeconds: 60 };
  const quote = createSkrQuote({ ...base, rate });
  assertEquals(quote.amountMinor, "25000000");
  assertEquals(quote.expiresAt, "2026-09-30T12:02:00.000Z");
  assertThrows(() => createSkrQuote({ ...base, rate: { ...rate, observedAt: "2026-09-30T11:50:00.000Z" } }), SkrQuoteError, "stale_rate");
});

function tx(overrides: { payerPost?: string; treasuryPost?: string; err?: unknown; blockTime?: number; signer?: string; programId?: string } = {}): ParsedTransaction {
  const balance = (index: number, owner: string, amount: string) => ({
    accountIndex: index, mint: SKR_MINT, owner, programId: overrides.programId ?? SPL_TOKEN_PROGRAM,
    uiTokenAmount: { amount, decimals: 6 },
  });
  return {
    slot: 1,
    blockTime: overrides.blockTime ?? Date.parse("2026-09-30T12:01:00.000Z") / 1000,
    meta: {
      err: overrides.err ?? null,
      preTokenBalances: [balance(1, PAYER, "100000000"), balance(2, TREASURY, "5")],
      postTokenBalances: [balance(1, PAYER, overrides.payerPost ?? "75000000"), balance(2, TREASURY, overrides.treasuryPost ?? "25000005")],
    },
    transaction: { signatures: ["sig1"], message: { accountKeys: [{ pubkey: overrides.signer ?? PAYER, signer: true }] } },
  };
}

Deno.test("payment verification accepts only the exact finalized transfer", () => {
  const quote = createSkrQuote({ quoteId: "0f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", productId: "p", accountId: "a", usdCents: 100, rate, now, ttlSeconds: 120, maxRateAgeSeconds: 60 });
  const check = { signature: "sig1", payer: PAYER, treasury: TREASURY, confirmation: "finalized" as const };
  assertEquals(verifySkrPayment(quote, check, tx()), { ok: true, signature: "sig1", receivedMinor: "25000000" });
  assertEquals(verifySkrPayment(quote, check, null), { ok: false, reason: "transaction_not_found" });
  assertEquals(verifySkrPayment(quote, { ...check, confirmation: "confirmed" }, tx()), { ok: false, reason: "not_finalized" });
  assertEquals(verifySkrPayment(quote, { ...check, signature: "other" }, tx()), { ok: false, reason: "signature_mismatch" });
  assertEquals(verifySkrPayment(quote, check, tx({ err: { InstructionError: [0, "x"] } })), { ok: false, reason: "transaction_failed" });
  assertEquals(verifySkrPayment(quote, check, tx({ signer: TREASURY })), { ok: false, reason: "payer_not_signer" });
  assertEquals(verifySkrPayment(quote, check, tx({ treasuryPost: "24999999", payerPost: "75000006" })), { ok: false, reason: "amount_too_low" });
  assertEquals(verifySkrPayment(quote, check, tx({ blockTime: Date.parse("2026-09-30T12:05:00.000Z") / 1000 })), { ok: false, reason: "quote_expired" });
  assertEquals(verifySkrPayment(quote, check, tx({ programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" })), { ok: false, reason: "unexpected_token_program" });
});
