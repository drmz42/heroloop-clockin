import assert from 'node:assert/strict';
import {prepareOrePayout,prepareMineSolPayout} from './ore_payout.ts';
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
for(const shared of [false,true])Deno.test(`ORE payout refuses unapproved requests and persists ${shared?'shared':'legacy'} signed bytes`,async()=>{
 let signingMaster=master;
 if(shared){
  const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
  const secret=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).slice(-32);
  const publicKey=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
  signingMaster=new Uint8Array([...secret,...publicKey]);
 }
 const key=await custodyKey(signingMaster,player),float=await floatKey(signingMaster);
 const recipient=await custodyKey(master,'recipient');
 let status='pending';let saved:Record<string,unknown>={};let sends=0;
 const deps:MineDeps={master:signingMaster,call:async(sql,args)=>{
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
 const signers=[...new Set([float.address,key.address])];
 assert.equal(signers.length,shared?1:2);
 assert.equal(wire[0],signers.length);const message=wire.slice(1+64*signers.length);assert.equal(message[0],signers.length);
 for(const [index,owner] of signers.entries()){
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
  (v:typeof tx)=>{v.transaction.signatures.pop();},
  (v:typeof tx)=>{v.transaction.message.accountKeys[2].signer=true;},
  (v:typeof tx)=>{v.transaction.message.instructions[0].parsed.info.tokenAmount.amount='94';},
 ]){const wrong=structuredClone(tx);mutate(wrong);assert.notEqual(verifyPayout(w,config,'signature',wrong),null);}
});

Deno.test('shared-project ORE payout finalizes with one signer and rejects altered receipts',()=>{
 const sender=ORE_BOARD,destination='destination';
 const w={asset:'ORE',destination,payout_minor:'95',created_at:'2026-10-04T00:00:00Z'} as Withdrawal;
 const balances=(owner:string,index:number,amount:string)=>({owner,accountIndex:index,mint:ORE_MINT,programId:TOKEN_PROGRAM,uiTokenAmount:{amount,decimals:11}});
 const tx={blockTime:1791072001,meta:{err:null,fee:5000,
  preTokenBalances:[balances(sender,1,'100'),balances(destination,2,'0')],
  postTokenBalances:[balances(sender,1,'5'),balances(destination,2,'95')]},
  transaction:{signatures:['signature'],message:{accountKeys:[{pubkey:sender,signer:true},{pubkey:'source',signer:false},{pubkey:'dest-ata',signer:false}],
   instructions:[{programId:TOKEN_PROGRAM,parsed:{type:'transferChecked',info:{authority:sender,destination:'dest-ata',mint:ORE_MINT,tokenAmount:{amount:'95',decimals:11}}}}]}}};
 const config={cluster:'mainnet' as const,skrMint:'skr',treasury:'treasury',payoutTreasury:sender,tokenAuthority:sender};
 assert.equal(verifyPayout(w,config,'signature',tx),null);
 assert.equal(verifyPayout(w,{...config,tokenAuthority:'other-owner'},'signature',tx),'payout_wrong_sender');
 for(const mutate of [
  (v:typeof tx)=>{v.transaction.message.accountKeys[0].signer=false;},
  (v:typeof tx)=>{v.transaction.message.accountKeys[1].signer=true;},
  (v:typeof tx)=>{v.transaction.signatures.push('extra-signature');},
  (v:typeof tx)=>{v.transaction.message.instructions.push(structuredClone(v.transaction.message.instructions[0]));},
  (v:typeof tx)=>{v.transaction.message.instructions[0].parsed.info.authority='other-owner';},
  (v:typeof tx)=>{v.meta.postTokenBalances[1].uiTokenAmount.amount='96';},
  (v:typeof tx)=>{v.meta.postTokenBalances[0].uiTokenAmount.amount='6';},
  (v:typeof tx)=>{v.transaction.message.instructions[0].parsed.info.tokenAmount.decimals=6;},
  (v:typeof tx)=>{v.transaction.message.instructions[0].parsed.info.mint='foreign';},
 ]){const wrong=structuredClone(tx);mutate(wrong);assert.notEqual(verifyPayout(w,config,'signature',wrong),null);}
});

Deno.test('SOL float payouts preserve open reservations and signed liabilities and reuse bytes',async()=>{
 const destination=(await custodyKey(master,'recipient')).address;let available=100000;let held='0';let signed:Record<string,unknown>={};
 const deps:MineDeps={master,call:async(sql,args)=>{
  if(sql.includes('withdrawal_admin_get'))return {asset:'SOL',status:'paying',destination,payout_minor:'20000'};
  if(sql.includes('mine_runner_work'))return {sol_payout_pending_minor:held,sessions:[{reserved_minor:'70000',spent_minor:'0'}]};
  if(sql.includes('mine_action_prepare'))signed={kind:'sol_payout',status:'signed',wire:args[5],signature:args[4],last_valid_height:args[6]};
  return signed;
 },rpc:async(method)=>{
  if(method==='getBalance')return {value:available};
  if(method==='getLatestBlockhash')return {value:{blockhash:ORE_BOARD,lastValidBlockHeight:1000}};
  throw Error('no broadcast allowed');
 }};
 held='10000';await assert.rejects(prepareMineSolPayout(deps,request),/mine_sol_liquidity_unavailable/);
 held='0';available=94000;await assert.rejects(prepareMineSolPayout(deps,request),/mine_sol_liquidity_unavailable/);
 available=100000;const a=await prepareMineSolPayout(deps,request);
 const wire=Uint8Array.from(atob(String(a.transaction)),c=>c.charCodeAt(0));assert.equal(wire[0],1);
 const key=await floatKey(master);const pub=await crypto.subtle.importKey('raw',base58Decode(key.address).slice().buffer,{name:'Ed25519'},false,['verify']);
 assert.equal(await crypto.subtle.verify('Ed25519',pub,wire.slice(1,65),wire.slice(65)),true);
 available=0;held='100000';assert.deepEqual(await prepareMineSolPayout(deps,request),a);
});
