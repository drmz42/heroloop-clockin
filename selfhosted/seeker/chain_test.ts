import { deepStrictEqual as assertEquals } from "node:assert/strict";
import {
  base58Decode,
  base58Encode,
  buildDepositTransaction,
  type DepositIntent,
  newReference,
  parseAmount,
  verifyDeposit,
} from "./chain.ts";

const config = {
  cluster: "devnet" as const,
  skrMint: "45HbhfcjjsvxeWV93dRcuJ8ZepjY3qSCgXwaunqPup1b",
  treasury: "744zoJV751yE97iUTqWwBaKVkCyg6KgMyME4m8rNWGiE",
};
const payer = "61SB7agWUXtGqZSbfoqJG82FrVMaY7PPj5yq6kfjM4mL";
const reference = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const now = Date.now();
const intent = (asset: "SKR" | "SOL", amount: string): DepositIntent => ({
  intent_id: "00000000-0000-4000-8000-000000000001",
  asset,
  amount_minor: amount,
  payer,
  reference,
  created_at: new Date(now - 30_000).toISOString(),
  expires_at: new Date(now + 600_000).toISOString(),
});
const token = (owner: string, amount: string, mint = config.skrMint, decimals = 6) =>
  ({ mint, owner, uiTokenAmount: { amount, decimals } });
function skrTx(overrides: Record<string, unknown> = {}) {
  return {
    blockTime: Math.floor(now / 1000),
    meta: {
      err: null,
      preBalances: [5_000_000, 0, 0],
      postBalances: [4_995_000, 0, 0],
      preTokenBalances: [token(payer, "9000000"), token(config.treasury, "0")],
      postTokenBalances: [token(payer, "7500000"), token(config.treasury, "1500000")],
      ...overrides,
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, writable: true },
          { pubkey: "Src", signer: false, writable: true },
          { pubkey: "Dst", signer: false, writable: true },
          { pubkey: reference, signer: false, writable: false },
        ],
      },
    },
  };
}
function solTx(delta: number, keys = [payer, config.treasury, reference]) {
  return {
    blockTime: Math.floor(now / 1000),
    meta: { err: null, preBalances: [3_000_000_000, 10, 1], postBalances: [3_000_000_000 - delta - 5000, 10 + delta, 1] },
    transaction: { message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 2 })) } },
  };
}

Deno.test("SKR deposit accepted only with exact amount, payer, reference and mint", () => {
  assertEquals(verifyDeposit(intent("SKR", "1500000"), config, skrTx()), null);
  assertEquals(verifyDeposit(intent("SKR", "1500001"), config, skrTx()), "deposit_wrong_amount");
  assertEquals(verifyDeposit({ ...intent("SKR", "1500000"), payer: config.treasury }, config, skrTx()), "deposit_wrong_payer");
  assertEquals(verifyDeposit({ ...intent("SKR", "1500000"), reference: payer.replace("6", "7") }, config, skrTx()),
    "deposit_reference_missing");
  assertEquals(verifyDeposit(intent("SKR", "1500000"), config, skrTx({ err: { InstructionError: [0, "x"] } })),
    "deposit_failed_on_chain");
  const otherMint = skrTx({
    preTokenBalances: [token(payer, "9000000", payer), token(config.treasury, "0", payer)],
    postTokenBalances: [token(payer, "7500000", payer), token(config.treasury, "1500000", payer)],
  });
  assertEquals(verifyDeposit(intent("SKR", "1500000"), config, otherMint), "deposit_wrong_amount");
  const wrongDecimals = skrTx({ postTokenBalances: [token(payer, "7500000"), token(config.treasury, "1500000", config.skrMint, 9)] });
  assertEquals(verifyDeposit(intent("SKR", "1500000"), config, wrongDecimals), "deposit_wrong_mint");
});

Deno.test("deposit window and malformed transactions fail closed", () => {
  const late = { ...skrTx(), blockTime: Math.floor((now + 3_600_000) / 1000) };
  assertEquals(verifyDeposit(intent("SKR", "1500000"), config, late), "deposit_outside_window");
  assertEquals(verifyDeposit(intent("SKR", "1500000"), config, null), "deposit_not_found");
  assertEquals(verifyDeposit(intent("SKR", "1500000"), config, { meta: { err: null }, transaction: {} }), "deposit_unreadable");
});

Deno.test("SOL deposit needs the exact lamports at the treasury", () => {
  assertEquals(verifyDeposit(intent("SOL", "250000000"), config, solTx(250_000_000)), null);
  assertEquals(verifyDeposit(intent("SOL", "250000000"), config, solTx(249_999_999)), "deposit_wrong_amount");
  assertEquals(verifyDeposit(intent("SOL", "250000000"), config, solTx(250_000_000, [payer, payer.replace("6", "8"), reference])),
    "deposit_wrong_recipient");
});

Deno.test("amount parsing and references", () => {
  assertEquals(parseAmount("1.5", "SKR"), 1_500_000n);
  assertEquals(parseAmount("0.000001", "SKR"), 1n);
  assertEquals(parseAmount("0.0000001", "SKR"), null);
  assertEquals(parseAmount("0.25", "SOL"), 250_000_000n);
  assertEquals(parseAmount("0", "SOL"), null);
  assertEquals(parseAmount("-1", "SKR"), null);
  assertEquals(parseAmount(1 as unknown as string, "SKR"), null);
  assertEquals(base58Encode(new Uint8Array([0, 0, 1])), "112");
  const ref = newReference();
  assertEquals(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ref), true);
});

// Vectors were cross-checked against @solana/web3.js + @solana/spl-token (decoded instructions,
// signer/writable flags, blockhash and fee payer identical) on 2026-10-02.
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
Deno.test("deposit transactions match the reference encoding", () => {
  const base = { payer, reference, blockhash: config.skrMint };
  assertEquals(hex(buildDepositTransaction({ ...base, asset: "SOL", amountMinor: 250_000_000n, treasury: config.treasury })),
    "01" + "00".repeat(64) + "010002044a66e63df174cee5548501ef080df6382698faf2042bd04b42ddf1ce2974f83759ef62039d684668905523db1b52963b2ae6bd05bed5bef49d2a1acfbdc739ab850f2d6e02a47af824d09ab69dc42d70cb28cbfa249fb7ee57b9d256c12762ef00000000000000000000000000000000000000000000000000000000000000002dac26da418907ddf64920d2efa55753e2c5643e84383efb29666740561c9f7e0103030001020c0200000080b2e60e00000000");
  assertEquals(hex(buildDepositTransaction({ ...base, asset: "SKR", amountMinor: 1_500_000n, treasury: config.treasury,
    source: "Ref1111111111111111111111111111111111111111", mint: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3" })),
    "01" + "00".repeat(64) + "010003064a66e63df174cee5548501ef080df6382698faf2042bd04b42ddf1ce2974f837065084296af91b7f8873b378c38df3c7a59c76445eedf86264a8e8000000000059ef62039d684668905523db1b52963b2ae6bd05bed5bef49d2a1acfbdc739ab067c5a3e05fe414712a7a2eafe42be7610bcd90cbf571627758373cb8ad0d8a4850f2d6e02a47af824d09ab69dc42d70cb28cbfa249fb7ee57b9d256c12762ef06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a92dac26da418907ddf64920d2efa55753e2c5643e84383efb29666740561c9f7e01050501030200040a0c60e316000000000006");
  assertEquals(base58Encode(base58Decode(payer)), payer);
  let refused = false;
  try {
    buildDepositTransaction({ ...base, asset: "SOL", amountMinor: 1n, treasury: payer });
  } catch {
    refused = true;
  }
  assertEquals(refused, true);
});
