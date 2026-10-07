import { ADDRESS, base58Decode, buildDepositTransaction, newReference, SIGNATURE, verifyDeposit, type ChainConfig, type DepositIntent } from './chain.ts';
type Json = Record<string, unknown>;
type Adapters = { call: (sql: string, args: unknown[]) => Promise<Json>; rpc: (method: string, args: unknown[]) => Promise<unknown>; config: ChainConfig; paymentsEnabled: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CAMPAIGN_SOL_TREASURY='7WbERESYT8ENKpe4bQBBbRpySFDbxScT9rhDjeE1nUP6';
export async function campaignHash(value: string): Promise<string> {
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function campaignSignature(wallet: string, message: string, signature: string): Promise<boolean> {
 try {
  const publicKey=base58Decode(wallet), bytes=Uint8Array.from(atob(signature),c=>c.charCodeAt(0));
  if(publicKey.length!==32 || bytes.length!==64) return false;
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(publicKey),'Ed25519',false,['verify']);
  return await crypto.subtle.verify('Ed25519',key,bytes,new TextEncoder().encode(message));
 } catch { return false; }
}
export async function campaignRoute(action: string, body: Json, a: Adapters): Promise<Json> {
 const run=(operation:string,p:Json)=>a.call('SELECT seeker_skr.campaign($1::text,$2::jsonb) AS result',[operation,JSON.stringify(p)]);
 const binding=typeof body.binding==='string'?await campaignHash(body.binding):'';
 const token=typeof body.token==='string'?await campaignHash(body.token):'';
 if(action==='challenge') {
  if(typeof body.wallet!=='string'||!ADDRESS.test(body.wallet)||base58Decode(body.wallet).length!==32||!binding) throw new Error('campaign_invalid_wallet');
  if(body.ref!==undefined && body.ref!=='' && (typeof body.ref!=='string'||!UUID.test(body.ref))) throw new Error('campaign_invalid_referral');
  if(typeof body.origin!=='string'||!/^https:\/\/[a-z0-9.-]+$/.test(body.origin)) throw new Error('campaign_invalid_origin');
  const id=crypto.randomUUID();
  const issuedAt=new Date();
  // SIWS domain is the host, not the HTTPS origin; optional fields use canonical names.
  const message=`${new URL(body.origin).host} wants you to sign in with your Solana account:\n${body.wallet}\n\nRegister for HeroLoop. No transaction or payment is authorized. Invitation: ${body.ref||'direct'}.\n\nURI: ${body.origin}/\nVersion: 1\nChain ID: mainnet\nNonce: ${id.replaceAll('-','')}\nIssued At: ${issuedAt.toISOString()}\nExpiration Time: ${new Date(+issuedAt+300000).toISOString()}`;
  return await run('challenge',{wallet:body.wallet,ref:body.ref,id,binding,message});
 }
 if(action==='verify') {
  if(typeof body.id!=='string'||!UUID.test(body.id)||typeof body.signature!=='string'||body.signature.length>100) throw new Error('campaign_invalid_proof');
  const challenge=await run('challenge_get',{id:body.id,binding});
  if(!await campaignSignature(String(challenge.wallet),String(challenge.message),body.signature)) throw new Error('campaign_invalid_proof');
  const session=newReference();
  await run('verify',{id:body.id,binding,token_hash:await campaignHash(session)});
  return {...await run('profile',{token_hash:await campaignHash(session)}),session,payments_enabled:a.paymentsEnabled};
 }
 if(action==='profile'||action==='logout') return {...await run(action,{token_hash:token}),payments_enabled:a.paymentsEnabled};
 if(action==='intent') {
  if(!a.paymentsEnabled) throw new Error('campaign_payments_paused');
  const profile=await run('profile',{token_hash:token});
  if(profile.wallet===CAMPAIGN_SOL_TREASURY) throw new Error('campaign_payer_is_treasury');
  // Both catalogue amount and recipient come from the server.
  let latest:{value?:{blockhash?:string}};
  try {latest=await a.rpc('getLatestBlockhash',[{commitment:'confirmed'}]) as typeof latest;} catch {throw new Error('campaign_chain_unavailable');}
  if(!latest?.value?.blockhash||!ADDRESS.test(latest.value.blockhash)) throw new Error('campaign_chain_unavailable');
  const order=await run('intent',{token_hash:token,pack:body.pack,reference:newReference(),treasury:CAMPAIGN_SOL_TREASURY});
  const bytes=buildDepositTransaction({asset:'SOL',amountMinor:BigInt(String(order.amount_minor)),payer:String(order.wallet),reference:String(order.reference),treasury:String(order.treasury),blockhash:latest.value.blockhash});
  return {...order,transaction:btoa(String.fromCharCode(...bytes))};
 }
 if(action==='confirm') {
  // Keep recovery available while creation of new payments is paused.
  if(typeof body.id!=='string'||!UUID.test(body.id)||typeof body.signature!=='string'||!SIGNATURE.test(body.signature)) throw new Error('campaign_invalid_payment');
  const order=await run('submit',{token_hash:token,id:body.id,signature:body.signature});
  if(order.signature && order.signature!==body.signature) throw new Error('campaign_signature_conflict');
  if(!order.signature) {
   let tx:unknown;
   try {tx=await a.rpc('getTransaction',[body.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);} catch {throw new Error('campaign_chain_unavailable');}
   const intent:DepositIntent={intent_id:String(order.id),asset:'SOL',amount_minor:String(order.amount_minor),payer:String(order.wallet),reference:String(order.reference),created_at:String(order.created_at),expires_at:String(order.expires_at)};
   const refusal=verifyDeposit(intent,{...a.config,treasury:String(order.treasury)},tx);
   if(refusal) throw new Error(refusal==='deposit_not_found'?'campaign_payment_pending':`campaign_${refusal}`);
  }
  return {...await run('settle',{token_hash:token,id:body.id,signature:body.signature}),payments_enabled:a.paymentsEnabled};
 }
 throw new Error('campaign_invalid_action');
}

// Receipt recovery survives closing the browser and expiring a campaign session.
export async function reconcileCampaign(a: Adapters): Promise<void> {
 const pending=await a.call('SELECT seeker_skr.campaign($1::text,$2::jsonb) AS result',['pending','{}']);
 for(const order of (pending.orders??[]) as Json[]) {
  try {
   const signature=String(order.submitted_signature);
   const tx=await a.rpc('getTransaction',[signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);
   const intent:DepositIntent={intent_id:String(order.id),asset:'SOL',amount_minor:String(order.amount_minor),payer:String(order.wallet),reference:String(order.reference),created_at:String(order.created_at),expires_at:String(order.expires_at)};
   if(verifyDeposit(intent,{...a.config,treasury:String(order.treasury)},tx)) continue;
   await a.call('SELECT seeker_skr.campaign($1::text,$2::jsonb) AS result',['settle_pending',JSON.stringify({id:order.id,signature})]);
  } catch { /* Retain the receipt and rotate to the next order on the next bounded scan. */ }
 }
}
