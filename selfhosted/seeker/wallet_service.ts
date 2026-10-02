// Private Seeker wallet service (docs/game/seeker-skr-payments.md). The only
// process that connects to the seeker_skr database. Reachable on the hackathon
// backend network by the game API, which authenticates the player and forwards
// the verified player id with a shared service token. Holds no signing key:
// deposits are verified read-only against Solana RPC.
import { Pool } from "@db/postgres";
import {
  ADDRESS,
  buildDepositTransaction,
  type ChainConfig,
  type DepositIntent,
  newReference,
  parseAmount,
  SIGNATURE,
  verifyDeposit,
  type WalletAsset,
} from "./chain.ts";

type Json = Record<string, unknown>;
const env = (name: string) => Deno.env.get(name) ?? "";
const serviceToken = env("WALLET_SERVICE_TOKEN");
const rpcUrl = env("SOLANA_RPC_URL");
const cluster = env("SEEKER_CLUSTER");
const config: ChainConfig = {
  cluster: cluster === "mainnet" ? "mainnet" : "devnet",
  skrMint: env("SKR_MINT"),
  treasury: env("WALLET_TREASURY"),
};
if (serviceToken.length < 32 || !/^https:\/\//.test(rpcUrl) || !["devnet", "mainnet"].includes(cluster)
  || !ADDRESS.test(config.skrMint) || !ADDRESS.test(config.treasury)) {
  throw new Error("invalid wallet service configuration");
}
const DEPOSIT_TTL_SECONDS = 600;
const LIMITS: Record<WalletAsset, bigint> = {
  SKR: 10_000n * 10n ** 6n, // 10 000 SKR per deposit
  SOL: 2n * 10n ** 9n, // 2 SOL per deposit
};
const MINIMUMS: Record<WalletAsset, bigint> = { SKR: 10_000n, SOL: 1_000_000n }; // 0.01 SKR, 0.001 SOL

const pool = new Pool({
  applicationName: "heroloop-seeker-wallet",
  database: "seeker_skr",
  hostname: env("PGHOST"),
  password: env("PGPASSWORD"),
  port: Number(env("PGPORT") || "5432"),
  user: env("PGUSER"),
  connection: { attempts: 1, interval: 250 },
  options: { idle_in_transaction_session_timeout: "5000", lock_timeout: "3000", statement_timeout: "5000" },
  tls: { enabled: false, enforce: false },
}, 2, true);

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function call(sql: string, args: unknown[]): Promise<Json> {
  const client = await pool.connect();
  try {
    const rows = (await client.queryObject<{ result: unknown }>(sql, args)).rows;
    const result = rows[0]?.result;
    if (rows.length !== 1 || !isRecord(result)) throw new Error("invalid wallet database response");
    return result;
  } finally {
    client.release();
  }
}

function knownError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return ["deposit_intent_limit", "deposit_intent_not_found", "deposit_already_settled", "deposit_signature_used",
    "skr_idempotency_conflict"].find((code) => message.includes(code)) ?? null;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`rpc_http_${response.status}`);
  const body = await response.json();
  if (!isRecord(body) || body.error) throw new Error("rpc_error");
  return body.result;
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function publicConfig(): Json {
  return { cluster: config.cluster, skr_mint: config.skrMint, treasury: config.treasury, decimals: { SKR: 6, SOL: 9 } };
}

async function snapshot(player: string): Promise<Response> {
  const result = await call("SELECT seeker_skr.wallet_snapshot($1::uuid) AS result", [player]);
  return json(200, { ok: true, result: { ...result, chain: publicConfig() } });
}

async function createIntent(player: string, body: Json): Promise<Response> {
  const asset = body.asset === "SKR" || body.asset === "SOL" ? body.asset : null;
  if (!asset) return json(400, { ok: false, code: "invalid_asset" });
  const amount = parseAmount(body.amount, asset);
  if (amount === null || amount < MINIMUMS[asset] || amount > LIMITS[asset]) {
    return json(400, { ok: false, code: "invalid_amount" });
  }
  if (typeof body.payer !== "string" || !ADDRESS.test(body.payer) || body.payer === config.treasury) {
    return json(400, { ok: false, code: "invalid_payer" });
  }
  const payer = body.payer;
  const reference = newReference();
  // Build the unsigned transfer first, so an RPC failure or missing balance never uses an intent slot.
  const latest = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const blockhash = isRecord(latest) && isRecord(latest.value) ? latest.value.blockhash : null;
  if (typeof blockhash !== "string" || !ADDRESS.test(blockhash)) throw new Error("rpc_blockhash");
  let transaction: Uint8Array;
  if (asset === "SOL") {
    transaction = buildDepositTransaction({ asset, amountMinor: amount, payer, reference, blockhash, treasury: config.treasury });
  } else {
    const source = await tokenAccount(payer, amount);
    if (!source) return json(409, { ok: false, code: "insufficient_skr" });
    const destination = await tokenAccount(config.treasury, 0n);
    if (!destination) throw new Error("rpc_treasury_token_account");
    transaction = buildDepositTransaction({
      asset, amountMinor: amount, payer, reference, blockhash, treasury: destination, source, mint: config.skrMint,
    });
  }
  const result = await call(
    "SELECT seeker_skr.deposit_intent_create($1::uuid,$2::text,$3::numeric,$4::text,$5::text,$6::text,$7::integer) AS result",
    [player, asset, amount.toString(), payer, reference, config.cluster, DEPOSIT_TTL_SECONDS],
  );
  return json(200, {
    ok: true,
    result: { ...result, transaction: btoa(String.fromCharCode(...transaction)), chain: publicConfig() },
  });
}

/** The owner's SKR token account holding at least `minimum`, or null. */
async function tokenAccount(owner: string, minimum: bigint): Promise<string | null> {
  const result = await rpc("getTokenAccountsByOwner", [owner, { mint: config.skrMint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const list = isRecord(result) && Array.isArray(result.value) ? result.value : [];
  let best: { address: string; amount: bigint } | null = null;
  for (const row of list) {
    const info = isRecord(row) && isRecord(row.account) && isRecord(row.account.data) && isRecord(row.account.data.parsed)
      ? row.account.data.parsed.info : null;
    const raw = isRecord(info) && isRecord(info.tokenAmount) ? info.tokenAmount.amount : null;
    if (!isRecord(row) || typeof row.pubkey !== "string" || typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
    if (isRecord(info) && info.state !== "initialized") continue;
    const amount = BigInt(raw);
    if (amount >= minimum && (!best || amount > best.amount)) best = { address: row.pubkey, amount };
  }
  return best?.address ?? null;
}

async function findSignature(intent: DepositIntent): Promise<string | null> {
  const list = await rpc("getSignaturesForAddress", [intent.reference, { commitment: "finalized", limit: 5 }]);
  if (!Array.isArray(list)) return null;
  const hit = list.find((row) => isRecord(row) && row.err === null && typeof row.signature === "string");
  return hit ? String((hit as Json).signature) : null;
}

async function confirm(player: string, body: Json): Promise<Response> {
  if (typeof body.intent_id !== "string" || !uuid.test(body.intent_id)) return json(400, { ok: false, code: "invalid_intent" });
  const supplied = body.signature;
  if (supplied !== undefined && (typeof supplied !== "string" || !SIGNATURE.test(supplied))) {
    return json(400, { ok: false, code: "invalid_signature" });
  }
  let intent: Json;
  try {
    intent = await call("SELECT seeker_skr.deposit_intent_get($1::uuid,$2::uuid) AS result", [player, body.intent_id]);
  } catch {
    return json(404, { ok: false, code: "deposit_intent_not_found" });
  }
  if (typeof intent.settled_event === "string") {
    return json(200, { ok: true, result: { status: "settled", event_id: intent.settled_event, replayed: true } });
  }
  const signature = (supplied as string | undefined) ?? await findSignature(intent as unknown as DepositIntent);
  if (!signature) {
    const expired = Date.parse(String(intent.expires_at)) + 120_000 < Date.now();
    return json(200, { ok: true, result: { status: expired ? "expired" : "pending" } });
  }
  const tx = await rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  if (tx === null) return json(200, { ok: true, result: { status: "pending", signature } });
  const refusal = verifyDeposit(intent as unknown as DepositIntent, config, tx);
  if (refusal) return json(409, { ok: false, code: refusal });
  const settled = await call("SELECT seeker_skr.deposit_settle($1::uuid,$2::uuid,$3::text) AS result", [player, body.intent_id, signature]);
  return json(200, { ok: true, result: { status: "settled", signature, ...settled } });
}

Deno.serve({ hostname: "0.0.0.0", port: 8090 }, async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json(200, { ok: true });
  if (request.method !== "POST" || !constantTimeEqual(request.headers.get("x-wallet-token") ?? "", serviceToken)) {
    return json(404, { ok: false, code: "not_found" });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, code: "invalid_json" });
  }
  if (!isRecord(body) || typeof body.player_id !== "string" || !uuid.test(body.player_id)) {
    return json(400, { ok: false, code: "invalid_player" });
  }
  try {
    if (url.pathname === "/wallet/snapshot") return await snapshot(body.player_id);
    if (url.pathname === "/wallet/deposit-intent") return await createIntent(body.player_id, body);
    if (url.pathname === "/wallet/deposit-confirm") return await confirm(body.player_id, body);
    return json(404, { ok: false, code: "not_found" });
  } catch (error) {
    const code = knownError(error);
    if (code) return json(409, { ok: false, code });
    const message = error instanceof Error ? error.message : "";
    console.error("wallet service failure", message.startsWith("rpc_") ? message : "database_or_internal");
    return json(503, { ok: false, code: message.startsWith("rpc_") ? "chain_unavailable" : "wallet_unavailable" });
  }
});
