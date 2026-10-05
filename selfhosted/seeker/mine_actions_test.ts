import assert from 'node:assert/strict';
import {prepareAction,resolveAction} from './mine_actions.ts';
import {custodyKey,transferInstruction,type MineDeps} from './mine_runner.ts';
import {ORE_BOARD} from './ore.ts';
import {finish,floatKey} from './mine_runner.ts';
import {claimOreInstruction,ORE_MINT,ORE_TREASURY,ORE_PROGRAM} from './ore.ts';
import {base58Encode,TOKEN_PROGRAM} from './chain.ts';
import {actionId} from './mine_actions.ts';
const master=new Uint8Array(32).fill(9);
Deno.test('shared project authority produces a valid single-signature payout',async()=>{
 const key=await floatKey(master);let saved:Record<string,unknown>={};
 const deps:MineDeps={master,call:async(sql,args)=>{
  if(sql.includes('mine_action_prepare'))saved={wire:args[5],signature:args[4]};
  return saved;
 },rpc:async(method)=>{
  if(method==='getLatestBlockhash')return {value:{blockhash:ORE_BOARD,lastValidBlockHeight:100}};
  if(method==='getFeeForMessage')return {value:5000};
  if(method==='getBalance')return {value:85000000};
  throw new Error(method);
 }};
 await prepareAction(deps,'id',null,'request','ore_payout',key,[transferInstruction(key.address,ORE_BOARD,1n)],key);
 const wire=Uint8Array.from(atob(String(saved.wire)),c=>c.charCodeAt(0));
 assert.equal(wire[0],1);assert.equal(wire[65],1);
});
Deno.test('durable action stores before send and reuses committed bytes after restart',async()=>{
 let saved:Record<string,unknown>={};const sent:unknown[]=[];let signed=0;
 const key=await custodyKey(master,'fixture');
 const payer={address:key.address,sign:async(m:Uint8Array)=>{signed++;return key.sign(m);}};
 const deps:MineDeps={master,call:async(sql,args)=>{
  if(sql.includes('mine_action_prepare'))saved={id:args[0],signature:args[4],wire:args[5],last_valid_height:args[6],status:'signed'};
  return saved;
 },rpc:async(method,params)=>{
  if(method==='getLatestBlockhash')return {value:{blockhash:ORE_BOARD,lastValidBlockHeight:100}};
  if(method==='getTransaction')return null;
  if(method==='getSignatureStatuses')return {value:[null]};
  if(method==='getBlockHeight')return 50;
  if(method==='sendTransaction'){assert.ok(saved.signature);sent.push(params[0]);return saved.signature;}
  throw new Error(method);
 }};
 const id='10000000-0000-4000-8000-000000000001';
 const first=await prepareAction(deps,id,id,null,'sweep',payer,[transferInstruction(key.address,ORE_BOARD,5n)]);
 assert.equal(sent.length,0);
 await resolveAction(deps,first);
 const replay=await prepareAction({...deps},id,id,null,'sweep',payer,[]);
 await resolveAction(deps,replay);
 assert.equal(signed,1);assert.deepEqual(sent,[saved.wire,saved.wire]);
});
Deno.test('expired or failed actions retain reservations and require review',async()=>{
 const a={id:'fixture',signature:'sig',wire:'wire',last_valid_height:'10',status:'signed'};
 let attention=0,sends=0;
 const deps:MineDeps={master,call:async(sql,args)=>{assert.ok(sql.includes('mine_action_finish'));assert.equal(args[1],'attention');attention++;return {};},
 rpc:async(method)=>{
  if(method==='getTransaction')return null;
  if(method==='getSignatureStatuses')return {value:[null]};
  if(method==='getBlockHeight')return 11;
  sends++;throw new Error('unexpected_send');
 }};
 await assert.rejects(resolveAction(deps,a),/expired_review_required/);
 assert.equal(attention,1);assert.equal(sends,0);
 deps.rpc=async()=>({meta:{err:{InstructionError:[0,'error']}},transaction:{signatures:['sig']}});
 await assert.rejects(resolveAction(deps,a),/mine_action_failed/);
 assert.equal(attention,2);
});
Deno.test('a known pending transaction is never replaced or rebroadcast',async()=>{
 const deps:MineDeps={master,call:async()=>{throw new Error('unexpected_write');},rpc:async(method)=>{
  if(method==='getTransaction')return null;
  if(method==='getSignatureStatuses')return {value:[{confirmationStatus:'confirmed'}]};
  throw new Error('unexpected_resend');
 }};
 assert.equal(await resolveAction(deps,{signature:'sig',status:'signed'}),null);
});
Deno.test('session finish recovers a finalized ORE claim after miner counters cleared, credits once',async()=>{
 const key=await custodyKey(master,'fixture'),float=await floatKey(master);
 const session={id:'10000000-0000-4000-8000-000000000003'};
 const id=await actionId(`${session.id}:ore_claim`),ix=await claimOreInstruction(key.address);
 const keys=ix.accounts.map(a=>a.address);
 const token=(index:number,owner:string,amount:string)=>({accountIndex:index,owner,mint:ORE_MINT,programId:TOKEN_PROGRAM,uiTokenAmount:{amount,decimals:11}});
 const tx={slot:100,meta:{err:null,fee:5000,preBalances:keys.map(()=>10000000),postBalances:keys.map((_,i)=>i===0?9995000:10000000),
  preTokenBalances:[token(4,key.address,'0'),token(6,ORE_TREASURY,'1000')],
  postTokenBalances:[token(4,key.address,'900'),token(6,ORE_TREASURY,'100')]},
  transaction:{signatures:['signature'],message:{accountKeys:keys,header:{numRequiredSignatures:1},
   instructions:[{programIdIndex:keys.indexOf(ORE_PROGRAM),accounts:keys.map((_,i)=>i),data:base58Encode(ix.data)}]}}};
 let saved={id,signature:'signature',status:'signed'},credits=0,closes=0;
 const deps:MineDeps={master,oreEnabled:true,call:async(sql,args)=>{
  if(sql.includes('mine_action_get'))return args[0]===id?saved:{};
  if(sql.includes('mine_action_finish')){assert.equal(args[2],'900');credits++;saved={...saved,status:'confirmed'};return saved;}
  if(sql.includes('mine_session_close')){closes++;return {};}
  throw new Error(sql);
 },rpc:async(method)=>{
  if(method==='getTransaction')return tx;
  if(method==='getAccountInfo')return {value:null};
  if(method==='getSignaturesForAddress')return [];
  if(method==='getBalance')return {value:5000};
  throw new Error('unexpected_send_or_sign');
 }};
 const board={roundId:100n,startSlot:0n,endSlot:0n};
 await finish(deps,session,key,float,board);await finish({...deps},session,key,float,board);
 assert.equal(credits,1);assert.equal(closes,2);
});
