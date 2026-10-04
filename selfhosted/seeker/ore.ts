// ORE v3 protocol adapter for the Seeker Mine: pinned addresses, PDA derivation,
// instruction builders, account decoders, legacy transaction encoding and
// finalized-receipt verification. No RPC, key storage or ledger writes here;
// callers own I/O and must record outcomes through mining_sessions.sql.
// Source pinned: github.com/regolith-labs/ore@48c203bd75db3cc45105ec29d8f8db719e5a2263.
import { base58Decode, base58Encode } from "./chain.ts";

export const ORE_PROGRAM = "oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv";
export const ORE_MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
export const ORE_BOARD = "BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi";
export const ORE_CONFIG = "9c9X7aDRAF41faiDs94ELjT19UrGnn72wBW9hPsS4Awy";
export const ORE_TREASURY = "45db2FSR4mcXdSVVZbKbwojU6uYDpMyhpEi7cC8nHaWG";
export const ORE_ENTROPY_PROGRAM = "3jSkUuYBoJzQPMEzTvkDFXCZUBksPamrVhrnHR9igu2X";
export const ORE_ENTROPY_VAR = "BWCaDY96Xe4WkFq1M7UiCCRcChsJ3p51L5KrGzhxgm2E";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
// Paid once into the miner account by the protocol; refunded to whoever checkpoints.
export const ORE_CHECKPOINT_FEE = 10_000n;
const U64_MAX = 18_446_744_073_709_551_615n;

const IX = { checkpoint: 2, claimSol: 3, deploy: 6 } as const;
const ACCOUNT = { board: 105, miner: 103, round: 109 } as const;

export class OreError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new OreError(code);
};

// ---- ed25519 curve membership (PDA validity) ----
const P = 2n ** 255n - 19n;
const D = (-121665n * inverse(121666n)) % P + P;
function mod(a: bigint) {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function pow(base: bigint, exp: bigint) {
  let result = 1n, b = mod(base), e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}
function inverse(a: bigint) {
  return pow(a, P - 2n);
}
// True when the 32 bytes decode to a point on the curve (RFC 8032 §5.1.3).
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const copy = bytes.slice();
  copy[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(copy[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x^2 = u / v has a root iff (u/v)^((p-1)/2) is 0 or 1.
  const x2 = mod(u * inverse(v));
  if (x2 === 0n) return (bytes[31] & 0x80) === 0;
  return pow(x2, (P - 1n) / 2n) === 1n;
}

async function sha256(parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
export async function findProgramAddress(seeds: Uint8Array[], program: string): Promise<string> {
  const programKey = base58Decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = await sha256([...seeds, Uint8Array.of(bump), programKey, PDA_MARKER]);
    if (!isOnCurve(hash)) return base58Encode(hash);
  }
  return fail("pda_not_found");
}
const text = (s: string) => new TextEncoder().encode(s);
const pubkey = (address: string) => {
  const bytes = base58Decode(address);
  if (bytes.length !== 32) fail("invalid_address");
  return bytes;
};
function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) fail("invalid_u64");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}
export const minerAddress = (authority: string) => findProgramAddress([text("miner"), pubkey(authority)], ORE_PROGRAM);
export const automationAddress = (authority: string) =>
  findProgramAddress([text("automation"), pubkey(authority)], ORE_PROGRAM);
export const roundAddress = (roundId: bigint) => findProgramAddress([text("round"), u64le(roundId)], ORE_PROGRAM);

// ---- instructions ----
export type AccountMeta = { address: string; signer: boolean; writable: boolean };
export type Instruction = { program: string; accounts: AccountMeta[]; data: Uint8Array };
const w = (address: string, signer = false): AccountMeta => ({ address, signer, writable: true });
const r = (address: string): AccountMeta => ({ address, signer: false, writable: false });

// Bit i of the mask selects square i (0..24) of the 5x5 grid.
export function squareMask(squares: number[]): number {
  if (!squares.length || squares.length > 25) fail("invalid_squares");
  let mask = 0;
  for (const s of squares) {
    if (!Number.isInteger(s) || s < 0 || s > 24 || mask & (1 << s)) fail("invalid_squares");
    mask |= 1 << s;
  }
  return mask >>> 0;
}
// `amountPerSquare` lamports are deployed on every selected square.
export async function deployInstruction(
  authority: string, roundId: bigint, amountPerSquare: bigint, squares: number[],
): Promise<Instruction> {
  if (amountPerSquare < 1n) fail("invalid_amount");
  const mask = squareMask(squares);
  const data = new Uint8Array(13);
  data[0] = IX.deploy;
  data.set(u64le(amountPerSquare), 1);
  new DataView(data.buffer).setUint32(9, mask, true);
  return {
    program: ORE_PROGRAM,
    accounts: [
      w(authority, true), w(authority), w(await automationAddress(authority)), w(ORE_BOARD), w(ORE_CONFIG),
      w(await minerAddress(authority)), w(await roundAddress(roundId)), w(ORE_TREASURY), r(SYSTEM_PROGRAM),
      r(ORE_PROGRAM), w(ORE_ENTROPY_VAR), r(ORE_ENTROPY_PROGRAM),
    ],
    data,
  };
}
export async function checkpointInstruction(authority: string, roundId: bigint): Promise<Instruction> {
  return {
    program: ORE_PROGRAM,
    accounts: [
      w(authority, true), w(authority), w(await automationAddress(authority)), w(ORE_BOARD),
      w(await minerAddress(authority)), w(await roundAddress(roundId)), w(ORE_TREASURY), r(SYSTEM_PROGRAM),
    ],
    data: Uint8Array.of(IX.checkpoint),
  };
}
export async function claimSolInstruction(authority: string): Promise<Instruction> {
  return {
    program: ORE_PROGRAM,
    accounts: [w(authority, true), w(ORE_BOARD), w(await minerAddress(authority)), r(SYSTEM_PROGRAM), r(ORE_PROGRAM)],
    data: Uint8Array.of(IX.claimSol),
  };
}
export function computeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units < 1 || units > 1_400_000) fail("invalid_compute_units");
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

// ---- accounts ----
function view(data: Uint8Array, kind: number, size: number) {
  if (data.length < size || data[0] !== kind) fail("invalid_ore_account");
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
const u64s = (dv: DataView, offset: number, n: number) =>
  Array.from({ length: n }, (_, i) => dv.getBigUint64(offset + i * 8, true));
export type OreBoard = { roundId: bigint; startSlot: bigint; endSlot: bigint };
export function decodeBoard(data: Uint8Array): OreBoard {
  const dv = view(data, ACCOUNT.board, 40);
  return { roundId: dv.getBigUint64(8, true), startSlot: dv.getBigUint64(16, true), endSlot: dv.getBigUint64(24, true) };
}
export type OreRound = {
  id: bigint; deployed: bigint[]; count: bigint[]; slotHash: Uint8Array; expiresAt: bigint; totalVaulted: bigint;
  totalReturned: bigint; totalMiners: bigint;
};
export function decodeRound(data: Uint8Array): OreRound {
  const dv = view(data, ACCOUNT.round, 952);
  return {
    id: dv.getBigUint64(8, true), deployed: u64s(dv, 16, 25), count: u64s(dv, 416, 25), slotHash: data.slice(616, 648),
    expiresAt: dv.getBigUint64(648, true), totalVaulted: dv.getBigUint64(896, true),
    totalReturned: dv.getBigUint64(904, true), totalMiners: dv.getBigUint64(912, true),
  };
}
export type OreMiner = {
  authority: string; checkpointId: bigint; checkpointFee: bigint; deployed: bigint[]; roundId: bigint;
  rewardsSol: bigint; rewardsOre: bigint; refinedOre: bigint; lifetimeDeployed: bigint; lifetimeRewardsSol: bigint;
};
export function decodeMiner(data: Uint8Array): OreMiner {
  const dv = view(data, ACCOUNT.miner, 752);
  return {
    authority: base58Encode(data.slice(8, 40)), checkpointId: dv.getBigUint64(48, true),
    checkpointFee: dv.getBigUint64(56, true), deployed: u64s(dv, 64, 25), roundId: dv.getBigUint64(664, true),
    rewardsSol: dv.getBigUint64(688, true), refinedOre: dv.getBigUint64(696, true),
    rewardsOre: dv.getBigUint64(704, true), lifetimeDeployed: dv.getBigUint64(736, true),
    lifetimeRewardsSol: dv.getBigUint64(744, true),
  };
}

// Winning square of a revealed round (Round::rng/winning_square in the ORE program); null until revealed.
export function winningSquare(slotHash: Uint8Array): number | null {
  if (slotHash.length !== 32 || slotHash.every((b) => b === 0) || slotHash.every((b) => b === 255)) return null;
  const dv = new DataView(slotHash.buffer, slotHash.byteOffset, 32);
  const r = dv.getBigUint64(0, true) ^ dv.getBigUint64(8, true) ^ dv.getBigUint64(16, true) ^ dv.getBigUint64(24, true);
  return Number(r % 25n);
}

// ---- legacy transaction message ----
function shortVec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) return out;
  }
}
// Single-signer legacy message: the fee payer is the only signer.
export function compileMessage(feePayer: string, instructions: Instruction[], recentBlockhash: string): Uint8Array {
  const keys = new Map<string, { signer: boolean; writable: boolean }>();
  keys.set(feePayer, { signer: true, writable: true });
  for (const ix of instructions) {
    for (const a of ix.accounts) {
      if (a.signer && a.address !== feePayer) fail("unsupported_extra_signer");
      const k = keys.get(a.address) ?? { signer: false, writable: false };
      keys.set(a.address, { signer: k.signer || a.signer, writable: k.writable || a.writable });
    }
    if (!keys.has(ix.program)) keys.set(ix.program, { signer: false, writable: false });
  }
  const entries = [...keys.entries()];
  const rank = ([, k]: [string, { signer: boolean; writable: boolean }]) =>
    (k.signer ? 0 : 2) + (k.writable ? 0 : 1);
  const ordered = [entries[0], ...entries.slice(1).sort((a, b) => rank(a) - rank(b))];
  const index = new Map(ordered.map(([address], i) => [address, i]));
  const readonlySigned = ordered.filter(([, k]) => k.signer && !k.writable).length;
  const readonlyUnsigned = ordered.filter(([, k]) => !k.signer && !k.writable).length;
  const bytes: number[] = [1, readonlySigned, readonlyUnsigned, ...shortVec(ordered.length)];
  for (const [address] of ordered) bytes.push(...pubkey(address));
  bytes.push(...pubkey(recentBlockhash), ...shortVec(instructions.length));
  for (const ix of instructions) {
    bytes.push(index.get(ix.program)!, ...shortVec(ix.accounts.length));
    for (const a of ix.accounts) bytes.push(index.get(a.address)!);
    bytes.push(...shortVec(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(bytes);
}
export function serializeTransaction(signature: Uint8Array, message: Uint8Array): Uint8Array {
  if (signature.length !== 64) fail("invalid_signature");
  return Uint8Array.from([...shortVec(1), ...signature, ...message]);
}

// ---- finalized receipt verification ----
// `tx` is getTransaction(signature, {encoding:"json", commitment:"finalized",
// maxSupportedTransactionVersion:0}). Returns the authority's exact lamport delta.
export type OreReceipt = { signature: string; slot: number; lamportDelta: bigint; fee: bigint };
type RawTx = {
  slot?: number;
  meta?: { err?: unknown; fee?: number; preBalances?: number[]; postBalances?: number[] } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: string[]; header?: { numRequiredSignatures?: number };
    instructions?: { programIdIndex: number }[] } };
};
export function verifyOreReceipt(tx: RawTx | null, signature: string, authority: string): OreReceipt {
  if (!tx?.meta || tx.meta.err !== null || !tx.transaction?.message) fail("ore_tx_not_successful");
  const message = tx!.transaction!.message!;
  const keys = message.accountKeys ?? [];
  if (tx!.transaction!.signatures?.[0] !== signature || keys[0] !== authority
    || message.header?.numRequiredSignatures !== 1) fail("ore_tx_wrong_signer");
  // Only ORE and compute-budget instructions: nothing else may move the authority's SOL.
  for (const ix of message.instructions ?? []) {
    const program = keys[ix.programIdIndex];
    if (program !== ORE_PROGRAM && program !== COMPUTE_BUDGET_PROGRAM) fail("ore_tx_foreign_instruction");
  }
  const pre = tx!.meta!.preBalances?.[0], post = tx!.meta!.postBalances?.[0], fee = tx!.meta!.fee;
  if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post) || !Number.isSafeInteger(fee)) fail("ore_tx_balances");
  return { signature, slot: tx!.slot ?? 0, lamportDelta: BigInt(post!) - BigInt(pre!), fee: BigInt(fee!) };
}
