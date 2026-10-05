// Durable custody actions: exact signed bytes survive process death and RPC loss.
import {base58Encode} from './chain.ts';
import {compileMessage, serializeTransaction, type Instruction} from './ore.ts';
import type {MineDeps, MineKey} from './mine_runner.ts';
type Json=Record<string,unknown>;
const record=(v:unknown):v is Json=>!!v&&typeof v==='object'&&!Array.isArray(v);
export async function actionId(scope:string):Promise<string>{
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`mine-action:${scope}`)));
 const hex=Array.from(hash.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function prepareAction(deps:MineDeps,id:string,session:string|null,request:string|null,kind:string,
 payer:MineKey,instructions:Instruction[],authority?:MineKey):Promise<Json>{
 const existing=await deps.call('SELECT seeker_skr.mine_action_get($1::uuid) AS result',[id]);
 if(existing.signature)return existing;
 if(authority?.address===payer.address)authority=undefined;
 const reply=await deps.rpc('getLatestBlockhash',[{commitment:'finalized'}]);
 if(!record(reply)||!record(reply.value)||typeof reply.value.blockhash!=='string'
  ||!Number.isSafeInteger(reply.value.lastValidBlockHeight))throw new Error('rpc_blockhash');
 const message=compileMessage(payer.address,instructions,reply.value.blockhash,authority?[authority.address]:[]);
 if(kind==='ore_payout'){
  const [fee,balance]=await Promise.all([
   deps.rpc('getFeeForMessage',[btoa(String.fromCharCode(...message)),{commitment:'finalized'}]),
   deps.rpc('getBalance',[payer.address,{commitment:'finalized'}])]);
  if(!record(fee)||!record(balance)||!Number.isSafeInteger(fee.value)||!Number.isSafeInteger(balance.value)
   ||Number(fee.value)<=0||Number(balance.value)<Number(fee.value))throw new Error('mine_ore_gas_shortfall');
 }
 const sig=await payer.sign(message);
 const bytes=authority?Uint8Array.from([2,...sig,...await authority.sign(message),...message]):serializeTransaction(sig,message);
 const wire=btoa(String.fromCharCode(...bytes));
 // Concurrent signers must use the first committed action returned by SQL.
 return deps.call('SELECT seeker_skr.mine_action_prepare($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,$7::numeric) AS result',
  [id,session,request,kind,base58Encode(sig),wire,String(reply.value.lastValidBlockHeight)]);
}
export async function resolveAction(deps:MineDeps,a:Json):Promise<Json|null>{
 if(a.status==='attention')throw new Error('mine_action_review_required');
 if(a.status==='confirmed')return null;
 const tx=await deps.rpc('getTransaction',[a.signature,{encoding:'json',commitment:'finalized',maxSupportedTransactionVersion:0}]);
 if(record(tx)&&record(tx.meta)){
  if(!record(tx.transaction)||!Array.isArray(tx.transaction.signatures)||tx.transaction.signatures[0]!==a.signature)throw new Error('rpc_receipt_mismatch');
  if(tx.meta.err===null)return tx;
  await deps.call('SELECT seeker_skr.mine_action_finish($1::uuid,$2::text,$3::numeric,$4::numeric) AS result',[a.id,'attention',null,null]);
  throw new Error('mine_action_failed');
 }
 const response=await deps.rpc('getSignatureStatuses',[[a.signature],{searchTransactionHistory:true}]);
 if(!record(response)||!Array.isArray(response.value))throw new Error('rpc_signatures');
 if(response.value[0]!==null)return null;
 const height=await deps.rpc('getBlockHeight',[{commitment:'finalized'}]);
 if(!Number.isSafeInteger(height))throw new Error('rpc_blockheight');
 if(BigInt(Number(height))>BigInt(String(a.last_valid_height))){
  await deps.call('SELECT seeker_skr.mine_action_finish($1::uuid,$2::text,$3::numeric,$4::numeric) AS result',[a.id,'attention',null,null]);
  throw new Error('mine_action_expired_review_required');
 }
 const signature=await deps.rpc('sendTransaction',[a.wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'finalized',maxRetries:0}]);
 if(signature!==a.signature)throw new Error('rpc_signature_mismatch');
 return null;
}
export async function finishAction(deps:MineDeps,a:Json,amount:bigint|null,sol:bigint|null){
 return deps.call('SELECT seeker_skr.mine_action_finish($1::uuid,$2::text,$3::numeric,$4::numeric) AS result',
  [a.id,'confirmed',amount?.toString()??null,sol?.toString()??null]);
}
