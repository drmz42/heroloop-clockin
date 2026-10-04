// Private Seeker wallet service (docs/game/seeker-skr-payments.md). The only
// process that connects to the seeker_skr database. Reachable on the hackathon
// backend network by the game API, which authenticates the player and forwards
// the verified player id with a shared service token. Holds no signing key:
// deposits are verified read-only against Solana RPC.
import { externalBalances } from "./wallet_display.ts";
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

import { parsePrice, SOL_MINT, type PriceRate } from './pricing.ts';
import { evaluateSkrBoost, type SkrBoostSnapshot } from './boost.ts';
import { authorizationMessage,verifyAuthorization,verifyPayout,FOUNDER_WALLETS,type Withdrawal } from "./withdrawal.ts";
import { SKR_ASSET } from './ledger.ts';
import { mineCustodyLamports, mineRoute, parseMineMaster, startMineRunner } from './mine_service.ts';
import { custodyBalances } from './payout_custody.ts';
type Json = Record<string, unknown>;
const env = (name: string) => Deno.env.get(name) ?? "";
const serviceToken = env("WALLET_SERVICE_TOKEN");
const rpcUrl = env("SOLANA_RPC_URL");
const config: ChainConfig & {payoutTreasury:string} = {
  cluster: "mainnet",
  skrMint: env("SKR_MINT"),
  treasury: env("WALLET_TREASURY"),
  payoutTreasury: env("WALLET_PAYOUT_TREASURY") || env("WALLET_TREASURY"),
};
// Former deposit addresses still holding player funds; reconciliation keeps counting them.
const legacyTreasuries = env("WALLET_LEGACY_TREASURIES").split(",").map((v) => v.trim()).filter(Boolean);
if (legacyTreasuries.some((address) => !ADDRESS.test(address))) throw new Error("invalid legacy treasury configuration");
if (serviceToken.length < 32 || !/^https:\/\//.test(rpcUrl)
  || config.skrMint!==SKR_ASSET.mint || !ADDRESS.test(config.treasury) || !ADDRESS.test(config.payoutTreasury)) {
  throw new Error("invalid wallet service configuration");
}
// Payer allowlist (comma-separated addresses), required: Staging2 is open to any
// wallet login and must not accept strangers' real funds until the Founder opens deposits.
const allowedPayers = new Set(env("WALLET_ALLOWED_PAYERS").split(",").map((v) => v.trim()).filter(Boolean));
if ([...allowedPayers].some((address) => !ADDRESS.test(address)) || allowedPayers.size === 0) {
  throw new Error("invalid wallet payer allowlist");
}
// Optional ORE Mine custody seed; absent means the Mine stays disabled.
const mineMaster = parseMineMaster(env("MINE_MASTER_SEED"));
if (env("MINE_MASTER_SEED") && !mineMaster) throw new Error("invalid mine configuration");
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
    "skr_idempotency_conflict", "skr_insufficient_balance_or_overflow", "skr_quote_not_found", "skr_quote_expired", "skr_purchase_refunded", "skr_purchase_not_charged", "stale_skr_rate", "withdrawal_intent_limit", "withdrawal_not_found", "withdrawal_authorization_expired", "withdrawal_state_conflict", "withdrawal_may_be_paid", "withdrawal_rejection_reason_required", "withdrawal_amount_too_small",
    "mining_terms_required", "mining_session_pending", "mining_budget_exceeded", "mining_budget_below_round_cost",
    "mining_session_not_found", "invalid_mining_policy"].find((code) => message.includes(code)) ?? null;
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

async function snapshot(player: string, address?: unknown): Promise<Response> {
  const result = await call("SELECT seeker_skr.wallet_snapshot($1::uuid) AS result", [player]);
  const pending=await call('SELECT seeker_skr.purchase_pending($1::uuid) AS result',[player]);
  let external = {};
  if (typeof address === 'string' && ADDRESS.test(address)) {
    const [sol, tokens] = await Promise.all([
      rpc('getBalance', [address, { commitment: 'confirmed' }]),
      rpc('getTokenAccountsByOwner', [address, { mint: config.skrMint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    ]);
    external = externalBalances(sol, tokens, LIMITS);
  }
  return json(200, { ok: true, result: { ...result,...pending, ...external, chain: publicConfig() } });
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
  if (allowedPayers.size > 0 && !allowedPayers.has(payer)) return json(403, { ok: false, code: "payer_not_allowed" });
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

// One coalesced price fetch covers SKR and SOL. No key, paid account or swap.
let prices: Record<string, PriceRate> | null = null;
let priceRequest: Promise<Record<string, PriceRate>> | null = null;
async function rates(): Promise<Record<string, PriceRate>> {
  if (prices && Date.now()-Date.parse(prices[SKR_ASSET.mint].observed_at)<15_000) return prices;
  priceRequest ??= (async () => {
    const observed = Date.now();
    const response = await fetch(`https://api.jup.ag/price/v3?ids=${SKR_ASSET.mint},${SOL_MINT}`,{ signal:AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('stale_skr_rate');
    const body=await response.json();
    const result={ [SKR_ASSET.mint]:parsePrice(body,SKR_ASSET.mint,observed), [SOL_MINT]:parsePrice(body,SOL_MINT,observed) };
    prices=result;
    return result;
  })().finally(()=>{priceRequest=null;});
  return priceRequest;
}
async function commerce(path: string,player: string,body: Json): Promise<Response|null> {
  if (path==='/wallet/rates') {
    const prices = await rates();
    const price = prices[SKR_ASSET.mint];
    return json(200,{ok:true,result:{ ...price, asset_rates: { SKR: price, SOL: prices[SOL_MINT] } }});
  }
  if (path==='/wallet/boost') {
    const data=await call('SELECT seeker_skr.boost_snapshot($1::uuid) AS result',[player]);
    let rate: PriceRate|null=null;
    try { rate=(await rates())[SKR_ASSET.mint]; } catch { /* Spending remains verifiable when rates are unavailable. */ }
    return json(200,{ok:true,result:evaluateSkrBoost({ ...data,rate } as unknown as SkrBoostSnapshot)});
  }
  if(path==='/wallet/purchase-get') {
    if(typeof body.quote_id!=='string'||!uuid.test(body.quote_id))return json(400,{ok:false,code:'skr_quote_not_found'});
    return json(200,{ok:true,result:await call('SELECT seeker_skr.purchase_get($1::uuid,$2::uuid) AS result',[player,body.quote_id])});
  }
  if (path==='/wallet/purchase-quote') {
    if (typeof body.request_id!=='string' || !uuid.test(body.request_id) || !isRecord(body.context)
        || !(typeof body.usd_cents==='number'&&Number.isFinite(body.usd_cents)&&body.usd_cents>0&&Number.isSafeInteger(Math.round(body.usd_cents*10000))&&Math.abs(body.usd_cents*10000-Math.round(body.usd_cents*10000))<0.000001)) return json(400,{ok:false,code:'invalid_skr_product'});
    const rate=(await rates())[SKR_ASSET.mint];
    const result=await call('SELECT seeker_skr.purchase_quote($1::uuid,$2::uuid,$3::jsonb,$4::numeric,$5::numeric,$6::timestamptz) AS result',
      [player,body.request_id,JSON.stringify(body.context),body.usd_cents,rate.usd_micros_per_skr,rate.observed_at]);
    return json(200,{ok:true,result});
  }
  if (['/wallet/purchase-charge','/wallet/purchase-finish'].includes(path)) {
    if (typeof body.quote_id!=='string' || !uuid.test(body.quote_id)) return json(400,{ok:false,code:'invalid_intent'});
    const finish=path==='/wallet/purchase-finish';
    if (finish && typeof body.success!=='boolean') return json(400,{ok:false,code:'invalid_intent'});
    const result=finish
      ? await call('SELECT seeker_skr.purchase_finish($1::uuid,$2::uuid,$3::boolean) AS result',[player,body.quote_id,body.success])
      : await call('SELECT seeker_skr.purchase_charge($1::uuid,$2::uuid) AS result',[player,body.quote_id]);
    return json(200,{ok:true,result});
  }
  return null;
}

async function reconcile():Promise<Json> {
  const liabilities=await call('SELECT seeker_skr.liabilities() AS result',[]);
  const owners = new Set([config.treasury, config.payoutTreasury, ...legacyTreasuries]);
  const chain: Record<string,bigint> = await custodyBalances(owners, config.skrMint, rpc);
  // Deduplicate against customer and payout custody, including Mine session wallets.
  chain.SOL += await mineCustodyLamports(mineMaster, call, rpc, owners);
  const assets:Json={};let blocked=false;
  for(const asset of ['SKR','SOL']) {
    const row=isRecord(liabilities[asset])?liabilities[asset] as Json:{};
    const accounted=BigInt(String(row.accounted_minor??'0'));
    const shortfall=chain[asset]<accounted||row.cache_consistent===false;
    blocked ||= shortfall;
    assets[asset]={...row,liabilities_minor:String(row.liabilities_minor??'0'),earned_minor:String(row.earned_minor??'0'),accounted_minor:accounted.toString(),on_chain_minor:chain[asset].toString(),shortfall};
  }
  return {assets,withdrawals_blocked:blocked,checked_at:new Date().toISOString()};
}
async function withdrawals(path:string,player:string,body:Json):Promise<Response|null> {
  if(path==='/wallet/reconcile')return json(200,{ok:true,result:await reconcile()});
  if(path==='/wallet/withdrawals') {
    const result=await call('SELECT seeker_skr.withdrawal_list($1::uuid,false) AS result',[player]);
    return json(200,{ok:true,result});
  }
  if(path==='/wallet/withdraw-intent') {
    const asset=body.asset==='SKR'||body.asset==='SOL'?body.asset:null;
    if(!asset||typeof body.destination!=='string'||!ADDRESS.test(body.destination)||(body.destination===config.treasury||body.destination===config.payoutTreasury))return json(400,{ok:false,code:'invalid_withdrawal'});
    const amount=parseAmount(body.amount,asset);
    if(amount===null||amount>18446744073709551615n)return json(400,{ok:false,code:'invalid_amount'});
    const report=await reconcile();
    if(report.withdrawals_blocked)return json(409,{ok:false,code:'withdrawals_blocked'});
    const rate=(await rates())[asset==='SKR'?SKR_ASSET.mint:SOL_MINT];
    const denominator=10n**BigInt(asset==='SKR'?6:9)*10_000n;
    const n=amount*BigInt(rate.usd_micros_per_skr);
    const cents=(n+denominator-1n)/denominator;
    if(cents>100000000n)return json(400,{ok:false,code:'invalid_amount'});
    const result=await call('SELECT seeker_skr.withdrawal_intent($1::uuid,$2::text,$3::numeric,$4::integer,$5::text) AS result',
      [player,asset,amount.toString(),Number(cents),body.destination]);
    return json(200,{ok:true,result:{...result,message:authorizationMessage(result as unknown as Withdrawal)}});
  }
  if(path==='/wallet/withdraw-get') {
    if(typeof body.request_id!=='string'||!uuid.test(body.request_id))return json(400,{ok:false,code:'invalid_withdrawal'});
    return json(200,{ok:true,result:await call('SELECT seeker_skr.withdrawal_get($1::uuid,$2::uuid) AS result',[player,body.request_id])});
  }
  if(path==='/wallet/withdraw-confirm') {
    if(typeof body.request_id!=='string'||!uuid.test(body.request_id)||typeof body.signature!=='string')return json(400,{ok:false,code:'invalid_withdrawal'});
    const w=await call('SELECT seeker_skr.withdrawal_get($1::uuid,$2::uuid) AS result',[player,body.request_id]);
    if(w.status!=='authorization')return json(200,{ok:true,result:w});
    if(!await verifyAuthorization(w as unknown as Withdrawal,body.signature))return json(403,{ok:false,code:'invalid_withdrawal_signature'});
    if((await reconcile()).withdrawals_blocked)return json(409,{ok:false,code:'withdrawals_blocked'});
    const result=await call('SELECT seeker_skr.withdrawal_reserve($1::uuid,$2::uuid) AS result',[player,body.request_id]);
    return json(200,{ok:true,result});
  }
  if(!['/wallet/founder','/wallet/withdraw-review'].includes(path))return null;
  if(typeof body.founder_address!=='string'||!FOUNDER_WALLETS.has(body.founder_address))return json(403,{ok:false,code:'founder_required'});
  if(path==='/wallet/founder') {
    const result=await call('SELECT seeker_skr.withdrawal_list($1::uuid,true) AS result',[player]);
    return json(200,{ok:true,result:{...result,payout_treasury:config.payoutTreasury,reconciliation:await reconcile()}});
  }
  if(typeof body.request_id!=='string'||!uuid.test(body.request_id))return json(400,{ok:false,code:'invalid_withdrawal'});
  const w=await call('SELECT seeker_skr.withdrawal_admin_get($1::uuid) AS result',[body.request_id]);
  if(body.action==='finalize') {
    if(typeof body.signature!=='string'||!SIGNATURE.test(body.signature))return json(400,{ok:false,code:'invalid_signature'});
    const tx=await rpc('getTransaction',[body.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);
    const refusal=verifyPayout(w as unknown as Withdrawal,config,body.signature,tx);
    if(refusal)return json(409,{ok:false,code:refusal});
    const result=await call('SELECT seeker_skr.withdrawal_finalize($1::uuid,$2::text) AS result',[body.request_id,body.signature]);
    return json(200,{ok:true,result});
  }
  if(body.action==='begin_payout'&&(await reconcile()).withdrawals_blocked)return json(409,{ok:false,code:'withdrawals_blocked'});
  if(!['begin_payout','reject'].includes(String(body.action)))return json(400,{ok:false,code:'invalid_withdrawal_review'});
  const result=await call('SELECT seeker_skr.withdrawal_review($1::uuid,$2::text,$3::text,$4::text) AS result',
    [body.request_id,body.founder_address,body.action,typeof body.reason==='string'?body.reason:'']);
  return json(200,{ok:true,result});
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
    if (url.pathname === "/wallet/payout-config") return json(200, {ok:true,result:{treasury:config.payoutTreasury,depositTreasury:config.treasury,skrMint:config.skrMint}});
    if (url.pathname === "/wallet/snapshot") return await snapshot(body.player_id, body.address);
    if (url.pathname === "/wallet/deposit-intent") return await createIntent(body.player_id, body);
    if (url.pathname === "/wallet/deposit-confirm") return await confirm(body.player_id, body);
    const response=await mineRoute(url.pathname,body.player_id,body,mineMaster,call,rpc)
      ??await commerce(url.pathname,body.player_id,body)??await withdrawals(url.pathname,body.player_id,body);
    if (response) return response;
    return json(404, { ok: false, code: "not_found" });
  } catch (error) {
    const code = knownError(error);
    if (code) return json(409, { ok: false, code });
    const message = error instanceof Error ? error.message : "";
    console.error("wallet service failure", message.startsWith("rpc_") ? message : "database_or_internal");
    return json(503, { ok: false, code: message.startsWith("rpc_") ? "chain_unavailable" : "wallet_unavailable" });
  }
});
startMineRunner(mineMaster, call, rpc);
