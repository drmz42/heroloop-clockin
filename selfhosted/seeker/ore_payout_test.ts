import assert from 'node:assert/strict';
import {prepareOrePayout} from './ore_payout.ts';
import {custodyKey,floatKey,type MineDeps} from './mine_runner.ts';
import {parseAmount,TOKEN_PROGRAM,base58Decode} from './chain.ts';
import {ORE_MINT,ORE_BOARD,oreTokenAddress} from './ore.ts';
import {verifyPayout,authorizationMessage,type Withdrawal} from './withdrawal.ts';
const master=new Uint8Array(32).fill(11);
const player='10000000-0000-4000-8000-000000000001';
const request='20000000-0000-4000-8000-000000000001';
Deno.test('ORE amounts and authorizations preserve eleven decimals',()=>{
 assert.equal(parseAmount('1.00000000001','ORE'),100000000001n);
 assert.equal(parseAmount('0.000000000001','ORE'),null);
 const w={request_id:request,player_id:player,asset:'ORE',amount_minor:'100000000001',fee_minor:'5000000001',payout_minor:'95000000000',destination:ORE_BOARD,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()} as Withdrawal;
 assert.ok(authorizationMessage(w).includes('Amount: 1.00000000001 ORE'));
});
Deno.test('ORE payout refuses unapproved requests and persists two-signature bytes',async()=>{
 const key=await custodyKey(master,player),float=await floatKey(master);
 const recipient=await custodyKey(master,'recipient');
 let status='pending';let saved:Record<string,unknown>={};let sends=0;
 const deps:MineDeps={master,call:async(sql,args)=>{
  if(sql.includes('withdrawal_admin_get'))return {asset:'ORE',status,player_id:player,destination:recipient.address,payout_minor:'95000000000'};
  if(sql.includes('mine_action_prepare'))saved={signature:args[4],wire:args[5],last_valid_height:args[6],status:'signed'};
  return saved;
 },rpc:async(method,params)=>{
  if(method==='getAccountInfo')return {value:{owner:TOKEN_PROGRAM,data:{parsed:{info:{owner:recipient.address,mint:ORE_MINT,state:'initialized',tokenAmount:{decimals:11}}}}}};
  if(method==='getTokenAccountsByOwner')return {value:[{pubkey:await oreTokenAddress(key.address),account:{owner:TOKEN_PROGRAM,data:{parsed:{info:{owner:key.address,mint:ORE_MINT,state:'initialized',tokenAmount:{amount:'100000000000',decimals:11}}}}}}]};
  if(method==='getLatestBlockhash')return {value:{blockhash:ORE_BOARD,lastValidBlockHeight:100}};
  if(method==='getFeeForMessage')return {value:10000};
  if(method==='getBalance'){assert.equal(params[0],float.address);return {value:1000000};}
  sends++;throw new Error(method);
 }};
 await assert.rejects(prepareOrePayout(deps,request),/withdrawal_state_conflict/);
 assert.deepEqual(saved,{});
 status='paying';
 const a=await prepareOrePayout(deps,request),again=await prepareOrePayout({...deps},request);
 assert.equal(a.transaction,again.transaction);assert.equal(sends,0);
 const wire=Uint8Array.from(atob(String(a.transaction)),c=>c.charCodeAt(0));
 assert.equal(wire[0],2);const message=wire.slice(129);assert.equal(message[0],2);
 for(const [index,owner] of [float.address,key.address].entries()){
  const pub=await crypto.subtle.importKey('raw',base58Decode(owner).slice().buffer,{name:'Ed25519'},false,['verify']);
  assert.equal(await crypto.subtle.verify('Ed25519',pub,wire.slice(1+index*64,65+index*64),message),true);
 }
});
Deno.test('ORE finalized payout binds float, custody signer, exact mint, precision and token deltas',()=>{
 const sender=ORE_BOARD,authority='authority',destination='destination';
 const w={asset:'ORE',destination,payout_minor:'95',created_at:'2026-10-04T00:00:00Z'} as Withdrawal;
 const balances=(owner:string,index:number,amount:string)=>({owner,accountIndex:index,mint:ORE_MINT,programId:TOKEN_PROGRAM,uiTokenAmount:{amount,decimals:11}});
 const tx={blockTime:1791072001,meta:{err:null,fee:10000,preTokenBalances:[balances(authority,2,'100'),balances(destination,3,'0')],postTokenBalances:[balances(authority,2,'5'),balances(destination,3,'95')]},
  transaction:{signatures:['signature','custody-signature'],message:{accountKeys:[{pubkey:sender,signer:true},{pubkey:authority,signer:true},{pubkey:'source',signer:false},{pubkey:'dest-ata',signer:false}],
   instructions:[{programId:TOKEN_PROGRAM,parsed:{type:'transferChecked',info:{authority,destination:'dest-ata',mint:ORE_MINT,tokenAmount:{amount:'95',decimals:11}}}}]}}};
 const config={cluster:'mainnet' as const,skrMint:'skr',treasury:'treasury',payoutTreasury:sender,tokenAuthority:authority};
 assert.equal(verifyPayout(w,config,'signature',tx),null);
 for(const mutate of [
  (v:typeof tx)=>{v.meta.postTokenBalances[1].uiTokenAmount.amount='96';},
  (v:typeof tx)=>{v.meta.postTokenBalances[1].uiTokenAmount.decimals=6;},
  (v:typeof tx)=>{v.meta.postTokenBalances[1].mint='foreign';},
  (v:typeof tx)=>{v.transaction.message.accountKeys[1].signer=false;},
  (v:typeof tx)=>{v.transaction.message.instructions[0].parsed.info.tokenAmount.amount='94';},
 ]){const wrong=structuredClone(tx);mutate(wrong);assert.notEqual(verifyPayout(w,config,'signature',wrong),null);}
});
