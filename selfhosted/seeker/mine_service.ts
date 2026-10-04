// Wallet-service routes and loop for the Seeker ORE Mine. Disabled unless the
// root-only runtime environment provides MINE_MASTER_SEED (32 bytes, base64url).
import { decodeBoard, decodeRound, ORE_BOARD, roundAddress, winningSquare } from "./ore.ts";
import { custodyKey, floatKey, mineTick, MINE_LIMITS, MINE_TERMS_VERSION, MINE_TIERS, minePolicy, type MineDeps } from "./mine_runner.ts";

type Json = Record<string, unknown>;
type Call = (sql: string, args: unknown[]) => Promise<Json>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
// Total unreleased Mine exposure across all players; the float balance bounds it too.
export const MINE_MAX_IN_FLIGHT = 100_000_000_000n;
const TICK_MS = 6_000;

// Public live board for the Mine screen, cached briefly and shared by all players.
let boardCache: { at: number; value: Json } | null = null;
async function oreAccount(rpc: Rpc, address: string): Promise<Uint8Array | null> {
  const result = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  if (!isRecord(result)) throw new Error("rpc_account");
  const value = result.value;
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  return Uint8Array.from(atob(String(value.data[0])), (c) => c.charCodeAt(0));
}
export async function mineBoard(rpc: Rpc): Promise<Json> {
  if (boardCache && Date.now() - boardCache.at < 3_000) return boardCache.value;
  const boardData = await oreAccount(rpc, ORE_BOARD);
  if (!boardData) throw new Error("rpc_account");
  const board = decodeBoard(boardData);
  const slot = BigInt(Number(await rpc("getSlot", [{ commitment: "confirmed" }])));
  const current = await oreAccount(rpc, await roundAddress(board.roundId));
  const previous = board.roundId > 0n ? await oreAccount(rpc, await roundAddress(board.roundId - 1n)) : null;
  const round = current ? decodeRound(current) : null;
  const last = previous ? decodeRound(previous) : null;
  const winner = last ? winningSquare(last.slotHash) : null;
  // A slot is about 0.4 s; the round has not started until its first deploy.
  const running = board.endSlot !== 18_446_744_073_709_551_615n;
  const value: Json = {
    round_id: board.roundId.toString(),
    ends_in_seconds: running ? Math.max(0, Math.round(Number(board.endSlot - slot) * 0.4)) : null,
    deployed_minor: (round?.deployed ?? []).map(String), miners: (round?.count ?? []).map(Number),
    previous: last ? { round_id: last.id.toString(), winning_square: winner,
      winning_deployed_minor: winner === null ? null : last.deployed[winner].toString(),
      total_deployed_minor: last.deployed.reduce((a, b) => a + b, 0n).toString() } : null,
  };
  boardCache = { at: Date.now(), value };
  return value;
}

export function parseMineMaster(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  return bytes.length === 32 ? bytes : null;
}

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const reply = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function lamports(rpc: Rpc, address: string): Promise<bigint> {
  const result = await rpc("getBalance", [address, { commitment: "finalized" }]);
  if (!isRecord(result) || !Number.isSafeInteger(result.value)) throw new Error("rpc_balance");
  return BigInt(result.value as number);
}

// SOL held in Mine custody (float + custody wallets of unclosed sessions); reconciliation adds it.
export async function mineCustodyLamports(master: Uint8Array | null, call: Call, rpc: Rpc, excluded: ReadonlySet<string> = new Set()): Promise<bigint> {
  if (!master) return 0n;
  const owners = new Set<string>([(await floatKey(master)).address]);
  let total = 0n;
  const work = await call("SELECT seeker_skr.mine_runner_work() AS result", []);
  for (const session of (Array.isArray(work.sessions) ? work.sessions : []) as Json[]) {
    if (typeof session.custody_address === "string") owners.add(session.custody_address);
  }
  for (const owner of owners) if (!excluded.has(owner)) total += await lamports(rpc, owner);
  return total;
}

export async function mineRoute(path: string, player: string, body: Json, master: Uint8Array | null, call: Call, rpc: Rpc):
  Promise<Response | null> {
  if (!path.startsWith("/wallet/mine/")) return null;
  const config = { enabled: master !== null, terms_version: MINE_TERMS_VERSION,
    float_address: master ? (await floatKey(master)).address : null, tiers: Object.keys(MINE_TIERS),
    max_rounds: MINE_LIMITS.maxRounds, session_limit_minor: MINE_LIMITS.sessionLimit.toString(),
    daily_limit_minor: MINE_LIMITS.dailyLimit.toString() };
  // The database reports the player's accepted version; config carries the current one.
  const status = (db: Json) => ({ ...db, ...config, accepted_terms_version: db.terms_version ?? null });
  if (path === "/wallet/mine/status") {
    return reply(200, { ok: true, result: status(await call("SELECT seeker_skr.mine_status($1::uuid) AS result", [player])) });
  }
  if (path === "/wallet/mine/board") return reply(200, { ok: true, result: await mineBoard(rpc) });
  if (path === "/wallet/mine/rounds") {
    return reply(200, { ok: true, result: await call("SELECT seeker_skr.mine_player_rounds($1::uuid) AS result", [player]) });
  }
  if (path === "/wallet/mine/accept-terms") {
    if (body.version !== MINE_TERMS_VERSION) return reply(400, { ok: false, code: "invalid_mining_terms" });
    const result = await call("SELECT seeker_skr.mine_accept_terms($1::uuid,$2::text) AS result", [player, MINE_TERMS_VERSION]);
    return reply(200, { ok: true, result: status(result) });
  }
  if (path === "/wallet/mine/stop") {
    if (typeof body.session_id !== "string") return reply(400, { ok: false, code: "invalid_mining_session" });
    return reply(200, { ok: true, result: await call("SELECT seeker_skr.mine_stop($1::uuid,$2::uuid) AS result", [player, body.session_id]) });
  }
  if (path === "/wallet/mine/start") {
    if (!master) return reply(409, { ok: false, code: "mining_unavailable" });
    const policy = minePolicy(String(body.tier ?? ""), body.squares);
    const rounds = Number(body.rounds);
    if (!policy || !Number.isInteger(rounds) || rounds < 1 || rounds > MINE_LIMITS.maxRounds
      || typeof body.session_id !== "string") return reply(400, { ok: false, code: "invalid_mining_request" });
    const roundCost = BigInt(String(policy.stake_per_round)) + BigInt(String(policy.network_per_round))
      + BigInt(String(policy.protocol_per_round));
    const budget = roundCost * BigInt(rounds);
    // The float must cover this session; total exposure stays under the global cap.
    const work = await call("SELECT seeker_skr.mine_runner_work() AS result", []);
    let exposure = 0n;
    for (const s of (Array.isArray(work.sessions) ? work.sessions : []) as Json[]) {
      exposure += BigInt(String(s.reserved_minor)) - BigInt(String(s.spent_minor));
    }
    if (exposure + budget > MINE_MAX_IN_FLIGHT) return reply(409, { ok: false, code: "mining_capacity_reached" });
    if (await lamports(rpc, (await floatKey(master)).address) < budget) return reply(409, { ok: false, code: "mining_capacity_reached" });
    const custody = (await custodyKey(master, player)).address;
    const result = await call("SELECT seeker_skr.mine_start($1::uuid,$2::uuid,$3::numeric,$4::jsonb,$5::text,$6::text) AS result",
      [player, body.session_id, budget.toString(), JSON.stringify(policy), MINE_TERMS_VERSION, custody]);
    return reply(200, { ok: true, result });
  }
  return reply(404, { ok: false, code: "not_found" });
}

// Single non-overlapping loop inside the wallet service.
export function startMineRunner(master: Uint8Array | null, call: Call, rpc: Rpc): void {
  if (!master) return;
  const deps: MineDeps = { master, call, rpc, log: (event, detail) => console.error(event, JSON.stringify(detail ?? {})) };
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await mineTick(deps);
    } catch (error) {
      console.error("mine_tick_failed", error instanceof Error ? error.message : "unknown");
    } finally {
      running = false;
    }
  }, TICK_MS);
}
