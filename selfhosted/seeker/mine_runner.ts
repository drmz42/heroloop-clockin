// Seeker ORE Mine runner. Owns custody keys derived from one root-only master seed,
// funds a per-player custody wallet from the Mine float, deploys each ORE round,
// verifies finalized receipts, records outcomes through mining_runtime.sql, claims
// winnings and sweeps the custody wallet back. All I/O is injected for tests.
import {actionId,prepareAction,resolveAction,finishAction} from "./mine_actions.ts";
import { base58Decode, base58Encode } from "./chain.ts";
import {
  checkpointInstruction, claimSolInstruction, claimOreInstruction, verifyOreClaimReceipt, compileMessage, computeUnitLimitInstruction, decodeBoard, decodeMiner,
  decodeRound, deployInstruction, type Instruction, minerAddress, ORE_BOARD, ORE_PROGRAM, COMPUTE_BUDGET_PROGRAM,
  roundAddress, serializeTransaction, SYSTEM_PROGRAM,
} from "./ore.ts";

type Json = Record<string, unknown>;
export const MINE_TERMS_VERSION = "2026-10-04-withdrawals";
// Stake per round in lamports, spread evenly over all 25 squares.
export const MINE_TIERS: Record<string, bigint> = { "0.01": 10_000_000n, "0.1": 100_000_000n, "1": 1_000_000_000n };
const ALL_SQUARES = Array.from({ length: 25 }, (_, i) => i);
// The session's chosen squares (policy.square_mask) and the stake on each; default all 25.
export function sessionSquares(policy: Json): { squares: number[]; perSquare: bigint } {
  const mask = policy.square_mask === undefined ? (1 << 25) - 1 : Number(policy.square_mask);
  const squares = ALL_SQUARES.filter((i) => mask & (1 << i));
  if (!squares.length) throw new Error("invalid_mining_policy");
  return { squares, perSquare: BigInt(String(policy.stake_per_round)) / BigInt(squares.length) };
}
const NETWORK_PER_ROUND = 10_000n; // two signatures' worth of base fee headroom
// First deploy creates the Miner account (~4.47M lamports rent + 10k checkpoint fee).
const PROTOCOL_PER_ROUND = 4_500_000n;
export const MINE_LIMITS = { sessionLimit: 10_000_000_000n, dailyLimit: 25_000_000_000n, maxRounds: 60 };
const TX_FEE = 5_000n;
const COMPUTE_UNITS = 400_000;

// Without squares the tier is the whole round's stake, spread over all 25 squares.
// With chosen squares the tier is the stake on each chosen square.
export function minePolicy(tier: string, squares?: unknown): Json | null {
  const stake = MINE_TIERS[tier];
  if (!stake) return null;
  let mask: number | null = null;
  if (squares !== undefined) {
    if (!Array.isArray(squares) || !squares.length || squares.length > 25) return null;
    mask = 0;
    for (const s of squares) {
      if (!Number.isInteger(s) || s < 0 || s > 24 || mask & (1 << s)) return null;
      mask |= 1 << s;
    }
  }
  const policy: Json = {
    session_limit: MINE_LIMITS.sessionLimit.toString(), daily_limit: MINE_LIMITS.dailyLimit.toString(),
    stake_per_round: (mask === null ? stake : stake * BigInt((squares as number[]).length)).toString(),
    network_per_round: NETWORK_PER_ROUND.toString(),
    protocol_per_round: PROTOCOL_PER_ROUND.toString(), max_rounds: String(MINE_LIMITS.maxRounds), fee_bps: "0",
  };
  if (mask !== null) policy.square_mask = String(mask);
  return policy;
}

// ---- keys ----
export type MineKey = { address: string; sign: (message: Uint8Array) => Promise<Uint8Array> };
// Copies into a plain ArrayBuffer, as WebCrypto typings require.
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
export async function deriveMineKey(master: Uint8Array, label: string): Promise<MineKey> {
  if (master.length !== 32) throw new Error("invalid_mine_master");
  const hmac = await crypto.subtle.importKey("raw", ab(master), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const seed = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`heroloop-mine:${label}`)));
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519);
  pkcs8.set(seed, 16);
  const key = await crypto.subtle.importKey("pkcs8", ab(pkcs8), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const pub = Uint8Array.from(atob(String(jwk.x).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return {
    address: base58Encode(pub),
    sign: async (message) => new Uint8Array(await crypto.subtle.sign("Ed25519", key, ab(message))),
  };
}
export const floatKey = (master: Uint8Array) => deriveMineKey(master, "float");
export const custodyKey = (master: Uint8Array, playerId: string) => deriveMineKey(master, `player:${playerId}`);

export function transferInstruction(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, lamports, true);
  return {
    program: SYSTEM_PROGRAM,
    accounts: [{ address: from, signer: true, writable: true }, { address: to, signer: false, writable: true }],
    data,
  };
}

// ---- runner ----
export type MineDeps = {
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  call: (sql: string, args: unknown[]) => Promise<Json>;
  master: Uint8Array;
  oreEnabled?: boolean;
  log?: (event: string, detail?: Json) => void;
};
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
async function accountData(deps: MineDeps, address: string): Promise<Uint8Array | null> {
  const result = await deps.rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  if (!isRecord(result)) throw new Error("rpc_account");
  const value = result.value;
  if (value === null) return null;
  if (!isRecord(value) || value.owner !== ORE_PROGRAM || !Array.isArray(value.data)) throw new Error("rpc_account");
  return b64(String(value.data[0]));
}
async function balance(deps: MineDeps, address: string): Promise<bigint> {
  const result = await deps.rpc("getBalance", [address, { commitment: "confirmed" }]);
  if (!isRecord(result) || !Number.isSafeInteger(result.value)) throw new Error("rpc_balance");
  return BigInt(result.value as number);
}
async function signAndSend(deps: MineDeps, key: MineKey, instructions: Instruction[]): Promise<{ signature: string; wire: string; height: string }> {
  const latest = await deps.rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  if (!isRecord(latest) || !isRecord(latest.value) || typeof latest.value.blockhash !== "string" || !Number.isSafeInteger(latest.value.lastValidBlockHeight)) throw new Error("rpc_blockhash");
  const message = compileMessage(key.address, instructions, latest.value.blockhash);
  const signature = await key.sign(message);
  return { signature: base58Encode(signature), wire: toB64(serializeTransaction(signature, message)), height: String(latest.value.lastValidBlockHeight) };
}
async function submit(deps: MineDeps, wire: string) {
  await deps.rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
}
type Landed = { status: "missing" } | { status: "pending" } | { status: "final"; tx: Json };
async function landed(deps: MineDeps, signature: string): Promise<Landed> {
  const statuses = await deps.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const entry = isRecord(statuses) && Array.isArray(statuses.value) ? statuses.value[0] : undefined;
  if (entry === null || entry === undefined) return { status: "missing" };
  if (!isRecord(entry) || entry.confirmationStatus !== "finalized") return { status: "pending" };
  const tx = await deps.rpc("getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  if (!isRecord(tx)) return { status: "pending" };
  return { status: "final", tx };
}
// Exact lamport change of the custody signer; failed transactions still cost their fee.
export function custodyDelta(tx: Json, signature: string, authority: string): bigint {
  const meta = isRecord(tx.meta) ? tx.meta : null;
  const transaction = isRecord(tx.transaction) ? tx.transaction : null;
  const message = transaction && isRecord(transaction.message) ? transaction.message : null;
  const keys = message && Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const sigs = transaction && Array.isArray(transaction.signatures) ? transaction.signatures : [];
  if (!meta || sigs[0] !== signature || keys[0] !== authority) throw new Error("mine_receipt_mismatch");
  for (const ix of (message && Array.isArray(message.instructions) ? message.instructions : []) as Json[]) {
    const program = keys[Number(ix.programIdIndex)];
    if (program !== ORE_PROGRAM && program !== COMPUTE_BUDGET_PROGRAM && program !== SYSTEM_PROGRAM) {
      throw new Error("mine_receipt_foreign_program");
    }
  }
  const pre = (meta.preBalances as number[] | undefined)?.[0], post = (meta.postBalances as number[] | undefined)?.[0];
  if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post)) throw new Error("mine_receipt_balances");
  return BigInt(post!) - BigInt(pre!);
}

async function claimUuid(signature: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mine-claim:${signature}`)));
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// One idempotent pass over unclosed sessions. Safe to call repeatedly and after a restart.
export async function mineTick(deps: MineDeps): Promise<void> {
  const work = await deps.call("SELECT seeker_skr.mine_runner_work() AS result", []);
  const sessions = Array.isArray(work.sessions) ? work.sessions as Json[] : [];
  if (!sessions.length) return;
  const boardData = await accountData(deps, ORE_BOARD);
  if (!boardData) throw new Error("rpc_account");
  const board = decodeBoard(boardData);
  const slotResult = await deps.rpc("getSlot", [{ commitment: "confirmed" }]);
  const slot = BigInt(Number(slotResult));
  const float = await floatKey(deps.master);
  for (const session of sessions) {
    try {
      await step(deps, session, board, slot, float);
    } catch (error) {
      deps.log?.("mine_session_step_failed", { session: String(session.id), error: error instanceof Error ? error.message : "unknown" });
    }
  }
}

async function step(
  deps: MineDeps, session: Json, board: ReturnType<typeof decodeBoard>, slot: bigint, float: MineKey,
): Promise<void> {
  const key = await custodyKey(deps.master, String(session.player_id));
  if (key.address !== session.custody_address) throw new Error("mine_custody_mismatch");
  const pending = isRecord(session.pending) ? session.pending : null;
  if (pending) return await resolvePending(deps, session, pending, key, board);

  const reserved = BigInt(String(session.reserved_minor)), spent = BigInt(String(session.spent_minor));
  const roundCost = BigInt(String(session.round_cost_minor));
  const exhausted = Number(session.completed) >= Number(session.round_limit) || spent + roundCost > reserved;
  if (session.status === "active" && exhausted) {
    await deps.call("SELECT seeker_skr.mine_runner_stop($1::uuid) AS result", [session.id]);
    return;
  }
  if (session.status === "stopped") return await finish(deps, session, key, float, board);
  if (session.status !== "active") return;

  // Fund the custody wallet once with the unspent budget (custody-internal transfer).
  const held = await balance(deps, key.address);
  const needed = reserved - spent;
  if (held < roundCost) {
    const a=await prepareAction(deps,await actionId(`${session.id}:fund`),String(session.id),null,'fund',float,
      [transferInstruction(float.address,key.address,needed-held)]);
    if(a.status==='confirmed')throw new Error('mine_custody_shortfall');
    const tx=await resolveAction(deps,a);
    if(tx)await finishAction(deps,a,null,null);
    return;
  }
  const funding=await deps.call('SELECT seeker_skr.mine_action_get($1::uuid) AS result',[await actionId(`${session.id}:fund`)]);
  if(funding.signature&&funding.status!=='confirmed'){
    const tx=await resolveAction(deps,funding);if(!tx)return;
    await finishAction(deps,funding,null,null);
  }
  const last = session.last_ore_round_id == null ? -1n : BigInt(String(session.last_ore_round_id));
  if (board.roundId <= last || slot < board.startSlot || slot + 8n >= board.endSlot) return;
  const instructions: Instruction[] = [computeUnitLimitInstruction(COMPUTE_UNITS)];
  const miner = await accountData(deps, await minerAddress(key.address));
  if (miner) {
    const m = decodeMiner(miner);
    if (m.checkpointId !== m.roundId) {
      // Deploy requires the previous round checkpointed, which needs its revealed entropy.
      if (!(await roundRevealed(deps, m.roundId))) return;
      instructions.push(await checkpointInstruction(key.address, m.roundId));
    }
  }
  const plan = sessionSquares(session.policy as Json);
  instructions.push(await deployInstruction(key.address, board.roundId, plan.perSquare, plan.squares));
  const { signature, wire, height } = await signAndSend(deps, key, instructions);
  const prepared=await deps.call("SELECT seeker_skr.mine_round_prepare($1::uuid,$2::uuid,$3::numeric,$4::text,$5::text,$6::numeric) AS result",
    [session.id, crypto.randomUUID(), board.roundId.toString(), signature, wire, height]);
  await submit(deps, String(prepared.submitted_wire??wire));
}

async function resolvePending(
  deps: MineDeps, session: Json, pending: Json, key: MineKey, board: ReturnType<typeof decodeBoard>,
): Promise<void> {
  const signature = String(pending.submitted_signature ?? "");
  const oreRound = BigInt(String(pending.ore_round_id));
  const outcome = await landed(deps, signature);
  if (outcome.status === "final") {
    const delta = custodyDelta(outcome.tx, signature, key.address);
    // A checkpoint refund can exceed a failed deploy's fee; never record a negative cost.
    const cost = delta < 0n ? -delta : 0n;
    await deps.call("SELECT seeker_skr.mine_round_settle($1::uuid,$2::numeric,$3::text) AS result", [pending.id, cost.toString(), signature]);
    return;
  }
  if (outcome.status === "pending") return;
  if(typeof pending.submitted_wire!=='string'||typeof pending.last_valid_height!=='string')throw new Error('mine_action_review_required');
  const height=await deps.rpc('getBlockHeight',[{commitment:'finalized'}]);
  if(!Number.isSafeInteger(height))throw new Error('rpc_blockheight');
  if(BigInt(Number(height))<=BigInt(pending.last_valid_height)){
    if(board.roundId===oreRound)await submit(deps,pending.submitted_wire);
    return;
  }
  // Both chain finality and actual blockhash expiry are required. Never infer
  // expiry solely from ORE round count, and never sign a second deploy.
  if(board.roundId>=oreRound+2n)await deps.call("SELECT seeker_skr.mine_round_settle($1::uuid,$2::numeric,$3::text) AS result",
    [pending.id,'0',signature]);
}

// All finish actions persist their exact signed bytes before broadcast.
export async function finish(
  deps: MineDeps, session: Json, key: MineKey, float: MineKey, board: ReturnType<typeof decodeBoard>,
): Promise<void> {
  const run = async (kind:string,payer:MineKey,ixs:Instruction[],creditOre=false):Promise<boolean> => {
    const a=await prepareAction(deps,await actionId(`${session.id}:${kind}`),String(session.id),null,kind,payer,ixs);
    if(a.status==='confirmed')return true;
    const tx=await resolveAction(deps,a);
    if(!tx)return false;
    if(creditOre){
      const receipt=await verifyOreClaimReceipt(tx,String(a.signature),key.address);
      await finishAction(deps,a,receipt.amountMinor,receipt.lamportDelta);
    }else{
      const delta=kind==='ore_gas'?null:custodyDelta(tx,String(a.signature),payer.address);
      if(kind==='sol_claim'&&delta!==null&&delta>0n){
        await deps.call('SELECT seeker_skr.mine_credit($1::uuid,$2::uuid,$3::numeric,$4::text) AS result',
          [await claimUuid(String(a.signature)),session.id,delta.toString(),a.signature]);
      }
      await finishAction(deps,a,null,delta);
    }
    return true;
  };
  // Resolve existing actions BEFORE reading miner counters. A successful claim
  // may have zeroed them just before a crash, while its ledger credit is absent.
  for(const kind of ['checkpoint','sol_claim','ore_gas','ore_claim','sweep']){
    const a=await deps.call('SELECT seeker_skr.mine_action_get($1::uuid) AS result',[await actionId(`${session.id}:${kind}`)]);
    if(a.signature&&a.status!=='confirmed'){
      const tx=await resolveAction(deps,a);
      if(!tx)return;
      if(kind==='ore_claim'){
        const receipt=await verifyOreClaimReceipt(tx,String(a.signature),key.address);
        await finishAction(deps,a,receipt.amountMinor,receipt.lamportDelta);
      }else{
        const delta=kind==='ore_gas'?null:custodyDelta(tx,String(a.signature),key.address);
        if(kind==='sol_claim'&&delta!==null&&delta>0n)await deps.call('SELECT seeker_skr.mine_credit($1::uuid,$2::uuid,$3::numeric,$4::text) AS result',
          [await claimUuid(String(a.signature)),session.id,delta.toString(),a.signature]);
        await finishAction(deps,a,null,delta);
      }
    }
  }
  const minerBytes=await accountData(deps,await minerAddress(key.address));
  if(minerBytes){
    const miner=decodeMiner(minerBytes);
    if(miner.authority!==key.address)throw new Error("mine_custody_mismatch");
    if(miner.checkpointId!==miner.roundId){
      if(board.roundId<=miner.roundId||!(await roundRevealed(deps,miner.roundId)))return;
      await run('checkpoint',key,[await checkpointInstruction(key.address,miner.roundId)]);return;
    }
    if(miner.rewardsSol>TX_FEE){await run('sol_claim',key,[await claimSolInstruction(key.address)]);return;}
    if(miner.rewardsOre+miner.refinedOre>0n){
      // Do not silently close and strand ORE when activation has not been approved.
      if(!deps.oreEnabled)throw new Error('ore_activation_required');
      const held=await balance(deps,key.address);
      if(held<3_000_000n){
        const funded=await deps.call('SELECT seeker_skr.mine_action_get($1::uuid) AS result',[await actionId(`${session.id}:ore_gas`)]);
        if(funded.status==='confirmed')throw new Error('mine_ore_gas_shortfall');
        await run('ore_gas',float,[transferInstruction(float.address,key.address,3_000_000n-held)]);return;
      }
      await run('ore_claim',key,[computeUnitLimitInstruction(COMPUTE_UNITS),await claimOreInstruction(key.address)],true);return;
    }
  }
  if(!(await custodySettled(deps,key.address)))return;
  await creditClaims(deps,session,key);
  const held=await balance(deps,key.address);
  if(held>TX_FEE){await run('sweep',key,[transferInstruction(key.address,float.address,held-TX_FEE)]);return;}
  await deps.call('SELECT seeker_skr.mine_session_close($1::uuid) AS result',[session.id]);
}

async function roundRevealed(deps: MineDeps, roundId: bigint): Promise<boolean> {
  const data = await accountData(deps, await roundAddress(roundId));
  // A closed (expired) round can still be checkpointed; ORE then forfeits its rewards.
  return data === null || decodeRound(data).slotHash.some((b) => b !== 0);
}
async function custodySettled(deps: MineDeps, address: string): Promise<boolean> {
  const newest = async (commitment: string) => {
    const list = await deps.rpc("getSignaturesForAddress", [address, { limit: 1, commitment }]);
    if (!Array.isArray(list)) throw new Error("rpc_signatures");
    return isRecord(list[0]) ? String(list[0].signature) : "";
  };
  return (await newest("confirmed")) === (await newest("finalized"));
}

// Credits each finalized claim_sol transaction of this custody wallet exactly once.
async function creditClaims(deps: MineDeps, session: Json, key: MineKey): Promise<void> {
  const list = await deps.rpc("getSignaturesForAddress", [key.address, { limit: 100, commitment: "finalized" }]);
  if (!Array.isArray(list)) throw new Error("rpc_signatures");
  for (const entry of list as Json[]) {
    if (entry.err !== null || typeof entry.signature !== "string") continue;
    const tx = await deps.rpc("getTransaction", [entry.signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!isRecord(tx) || !isClaim(tx)) continue;
    const delta = custodyDelta(tx, entry.signature, key.address);
    if (delta <= 0n) continue;
    await deps.call("SELECT seeker_skr.mine_credit($1::uuid,$2::uuid,$3::numeric,$4::text) AS result",
      [await claimUuid(entry.signature), session.id, delta.toString(), entry.signature]);
  }
}
function isClaim(tx: Json): boolean {
  const message = isRecord(tx.transaction) && isRecord(tx.transaction.message) ? tx.transaction.message : null;
  const keys = message && Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const ixs = message && Array.isArray(message.instructions) ? message.instructions as Json[] : [];
  return ixs.length === 1 && keys[Number(ixs[0].programIdIndex)] === ORE_PROGRAM
    && base58Decode(String(ixs[0].data ?? ""))[0] === 3;
}
