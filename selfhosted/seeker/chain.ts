// On-chain deposit verification for the Seeker wallet service. Pure functions:
// the caller fetches `getTransaction` (jsonParsed, finalized) and passes it in.
// Amounts are integer minimal units (BigInt); a float never decides an amount.

export type WalletAsset = "SKR" | "SOL" | "ORE";

export type ChainConfig = {
  cluster: "mainnet";
  skrMint: string;
  treasury: string;
};

export type DepositIntent = {
  intent_id: string;
  asset: WalletAsset;
  amount_minor: string;
  payer: string;
  reference: string;
  created_at: string;
  expires_at: string;
};

export const SKR_DECIMALS = 6;
export const SOL_DECIMALS = 9;
export const ORE_TOKEN_MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
export const ASSET_DECIMALS: Record<WalletAsset, number> = {SKR: 6, SOL: 9, ORE: 11};
export const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(value: string): Uint8Array {
  let number = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("invalid_base58");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number % 256n));
    number /= 256n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A fresh random 32-byte public key used only as a read-only reference account. */
export function newReference(): string {
  return base58Encode(crypto.getRandomValues(new Uint8Array(32)));
}

/** Parses a positive decimal amount ("1.5") into minimal units, refusing excess precision. */
export function parseAmount(value: unknown, asset: WalletAsset): bigint | null {
  const decimals = ASSET_DECIMALS[asset];
  if (typeof value !== "string" || !/^\d{1,12}(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return minor > 0n ? minor : null;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function tokenAmount(balances: unknown, mint: string, owner: string): bigint | null {
  if (!Array.isArray(balances)) return 0n;
  let total = 0n;
  for (const entry of balances) {
    if (!isRecord(entry) || entry.mint !== mint || entry.owner !== owner) continue;
    const ui = entry.uiTokenAmount;
    if (!isRecord(ui) || typeof ui.amount !== "string" || !/^\d+$/.test(ui.amount)) continue;
    if (ui.decimals !== SKR_DECIMALS) return null;
    total += BigInt(ui.amount);
  }
  return total;
}

/**
 * Returns null when the finalized transaction is exactly the deposit the intent
 * describes, otherwise a refusal code. Checks: success, fee payer is the
 * intent's signing payer, the intent reference is present, the treasury
 * received exactly the amount of the asset and the payer lost it, and the
 * transaction landed inside the intent window.
 */
export function verifyDeposit(intent: DepositIntent, config: ChainConfig, tx: unknown): string | null {
  if (!isRecord(tx) || !isRecord(tx.meta) || !isRecord(tx.transaction)) return "deposit_not_found";
  const meta = tx.meta;
  if (meta.err !== null) return "deposit_failed_on_chain";
  const message = (tx.transaction as Json).message;
  if (!isRecord(message) || !Array.isArray(message.accountKeys)) return "deposit_unreadable";
  const keys = message.accountKeys.map((k) => isRecord(k) ? k : {});
  const payerKey = keys[0];
  if (payerKey?.pubkey !== intent.payer || payerKey?.signer !== true) return "deposit_wrong_payer";
  if (!keys.some((k) => k.pubkey === intent.reference)) return "deposit_reference_missing";
  const blockTime = typeof tx.blockTime === "number" ? tx.blockTime * 1000 : NaN;
  const created = Date.parse(intent.created_at);
  const expires = Date.parse(intent.expires_at);
  if (!Number.isFinite(blockTime) || blockTime < created - 60_000 || blockTime > expires + 60_000) {
    return "deposit_outside_window";
  }
  const amount = BigInt(intent.amount_minor);
  if (intent.asset === "SOL") {
    const index = keys.findIndex((k) => k.pubkey === config.treasury);
    const pre = meta.preBalances, post = meta.postBalances;
    if (index < 1 || !Array.isArray(pre) || !Array.isArray(post)) return "deposit_wrong_recipient";
    const delta = BigInt(post[index] as number) - BigInt(pre[index] as number);
    return delta === amount ? null : "deposit_wrong_amount";
  }
  const balances = [
    tokenAmount(meta.preTokenBalances, config.skrMint, config.treasury),
    tokenAmount(meta.postTokenBalances, config.skrMint, config.treasury),
    tokenAmount(meta.preTokenBalances, config.skrMint, intent.payer),
    tokenAmount(meta.postTokenBalances, config.skrMint, intent.payer),
  ];
  if (balances.some((b) => b === null)) return "deposit_wrong_mint";
  const [treasuryPre, treasuryPost, payerPre, payerPost] = balances as bigint[];
  if (treasuryPost - treasuryPre !== amount || payerPre - payerPost !== amount) return "deposit_wrong_amount";
  return null;
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export type DepositTransactionInput = {
  asset: WalletAsset;
  amountMinor: bigint;
  payer: string;
  reference: string;
  blockhash: string;
  treasury: string; // SOL: treasury wallet; SKR: treasury token account
  source?: string; // SKR: payer token account
  mint?: string; // SKR mint
};

function key(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (bytes.length !== 32) throw new Error("invalid_address");
  return bytes;
}

function compactU16(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) return [...out, byte];
    out.push(byte | 0x80);
  }
}

function u64(value: bigint): number[] {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error("invalid_amount");
  return Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));
}

/**
 * The unsigned legacy transaction the player's wallet signs and sends: one
 * SOL transfer or SPL TransferChecked to the treasury, with the intent
 * reference appended as a read-only account (Solana Pay pattern) so the
 * deposit can be found and bound to its intent on chain.
 */
export function buildDepositTransaction(input: DepositTransactionInput): Uint8Array {
  let header: number[], accounts: string[], instruction: number[];
  if (input.asset === "SOL") {
    // payer (signer, writable) | treasury (writable) | reference, system program (read-only)
    header = [1, 0, 2];
    accounts = [input.payer, input.treasury, input.reference, SYSTEM_PROGRAM];
    const data = [2, 0, 0, 0, ...u64(input.amountMinor)];
    instruction = [3, ...compactU16(3), 0, 1, 2, ...compactU16(data.length), ...data];
  } else {
    if (!input.source || !input.mint) throw new Error("invalid_token_accounts");
    // payer (signer) | source, destination (writable) | mint, reference, token program (read-only)
    header = [1, 0, 3];
    accounts = [input.payer, input.source, input.treasury, input.mint, input.reference, TOKEN_PROGRAM];
    const data = [12, ...u64(input.amountMinor), SKR_DECIMALS];
    instruction = [5, ...compactU16(5), 1, 3, 2, 0, 4, ...compactU16(data.length), ...data];
  }
  if (new Set(accounts).size !== accounts.length) throw new Error("duplicate_account");
  const message = [
    ...header,
    ...compactU16(accounts.length),
    ...accounts.flatMap((a) => [...key(a)]),
    ...key(input.blockhash),
    ...compactU16(1),
    ...instruction,
  ];
  return Uint8Array.from([...compactU16(1), ...new Array(64).fill(0), ...message]);
}
