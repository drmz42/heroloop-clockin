import assert from 'node:assert/strict';
import {authorizationMessage,verifyAuthorization,verifyPayout,type Withdrawal} from './withdrawal.ts';
import {base58Encode,SYSTEM_PROGRAM,TOKEN_PROGRAM} from './chain.ts';
async function fixture(){
 const key=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
 const address=base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw',key.publicKey)));
 const w:Withdrawal={request_id:crypto.randomUUID(),player_id:crypto.randomUUID(),asset:'SKR',amount_minor:'1052632',fee_minor:'52632',payout_minor:'1000000',destination:address,expires_at:new Date(Date.now()+600000).toISOString(),created_at:new Date(Date.now()-60000).toISOString()};
 const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key.privateKey,new TextEncoder().encode(authorizationMessage(w))));
 return {w,signature:btoa(String.fromCharCode(...signature))};
}
Deno.test('withdrawal authorization binds amount, asset, account, request, recipient and expiry',async()=>{
 const {w,signature}=await fixture();assert(await verifyAuthorization(w,signature));
 for(const change of [{asset:'SOL' as const},{amount_minor:'1052633',fee_minor:'52633'},{fee_minor:'0',payout_minor:'1052632'},{destination:'11111111111111111111111111111111'},{player_id:crypto.randomUUID()},{request_id:crypto.randomUUID()}]) assert.equal(await verifyAuthorization({...w,...change},signature),false);
 assert.equal(await verifyAuthorization(w,signature,Date.parse(w.expires_at)+1),false);
 assert.equal(await verifyAuthorization(w,'bad'),false);
});
Deno.test('manual SOL payout requires exact finalized sender, destination, amount and fresh transfer',async()=>{
 const {w}=await fixture();w.asset='SOL';w.amount_minor='1052632';w.fee_minor='52632';w.payout_minor='1000000';
 const treasury='11111111111111111111111111111111',signature='sig';
 const config={cluster:'mainnet' as const,treasury,skrMint:'mint'};
 const tx={blockTime:Math.floor(Date.now()/1000),transaction:{signatures:[signature],message:{accountKeys:[{pubkey:treasury,signer:true},{pubkey:w.destination,signer:false}],instructions:[{programId:SYSTEM_PROGRAM,parsed:{type:'transfer',info:{source:treasury,destination:w.destination,lamports:1000000}}}]}},meta:{err:null,preBalances:[2000000,0],postBalances:[995000,1000000]}};
 assert.equal(verifyPayout(w,config,signature,tx),null);
 assert.equal(verifyPayout(w,config,'other',tx),'payout_unreadable');
 tx.meta.postBalances[1]=999999;assert.equal(verifyPayout(w,config,signature,tx),'payout_wrong_amount');
 tx.blockTime=1;assert.equal(verifyPayout(w,config,signature,tx),'payout_before_request');
 tx.meta.err={} as never;assert.equal(verifyPayout(w,config,signature,tx),'payout_not_finalized');
});

Deno.test('manual SKR payout binds classic mint, treasury debit, recipient credit and signature',async()=>{
 const {w}=await fixture();const treasury='11111111111111111111111111111111',signature='skr-sig',mint='mint';
 const balance=(accountIndex:number,owner:string,amount:string)=>({accountIndex,owner,mint,uiTokenAmount:{amount,decimals:6}});
 const tx={blockTime:Math.floor(Date.now()/1000),transaction:{signatures:[signature],message:{accountKeys:[{pubkey:treasury,signer:true},{pubkey:'source',signer:false},{pubkey:'recipient-ata',signer:false}],instructions:[{programId:TOKEN_PROGRAM,parsed:{type:'transferChecked',info:{source:'source',destination:'recipient-ata',authority:treasury,mint,tokenAmount:{amount:'1000000',decimals:6}}}}]}},meta:{err:null,preTokenBalances:[balance(1,treasury,'2000000'),balance(2,w.destination,'0')],postTokenBalances:[balance(1,treasury,'1000000'),balance(2,w.destination,'1000000')]}};
 const config={cluster:'mainnet' as const,treasury,skrMint:mint};
 assert.equal(verifyPayout(w,config,signature,tx),null);
 tx.meta.postTokenBalances[1].uiTokenAmount.amount='999999';assert.equal(verifyPayout(w,config,signature,tx),'payout_wrong_amount');
 tx.meta.postTokenBalances[1].mint='other';assert.equal(verifyPayout(w,config,signature,tx),'payout_wrong_recipient');
 tx.meta.postTokenBalances[1].mint=mint;tx.meta.postTokenBalances[1].uiTokenAmount.amount='1000000';
 tx.meta.postTokenBalances[0].uiTokenAmount.amount='2000000';assert.equal(verifyPayout(w,config,signature,tx),'payout_wrong_amount');
 tx.meta.postTokenBalances[0].uiTokenAmount.amount='1000000';tx.transaction.message.accountKeys[0].pubkey='other';assert.equal(verifyPayout(w,config,signature,tx),'payout_wrong_sender');
});

Deno.test('dedicated payout sender is authoritative while deposit treasury remains separate',async()=>{
 const {w}=await fixture();w.asset='SOL';
 const deposit='deposit',payout='payout',signature='sig';
 const config={cluster:'mainnet' as const,treasury:deposit,payoutTreasury:payout,skrMint:'mint'};
 const tx={blockTime:Math.floor(Date.now()/1000),transaction:{signatures:[signature],message:{accountKeys:[{pubkey:payout,signer:true},{pubkey:w.destination,signer:false}],instructions:[{programId:SYSTEM_PROGRAM,parsed:{type:'transfer',info:{source:payout,destination:w.destination,lamports:1000000}}}]}},meta:{err:null,preBalances:[2000000,0],postBalances:[995000,1000000]}};
 assert.equal(verifyPayout(w,config,signature,tx),null);
 assert.equal(verifyPayout(w,{...config,payoutTreasury:deposit},signature,tx),'payout_wrong_sender');
 tx.transaction.message.accountKeys[0].pubkey=deposit;
 assert.equal(verifyPayout(w,config,signature,tx),'payout_wrong_sender');
});

Deno.test('separate SKR payout binds payout debit rather than deposit treasury debit',async()=>{
 const {w}=await fixture();const sender='payout',signature='sig',mint='mint';
 const balance=(accountIndex:number,owner:string,amount:string)=>({accountIndex,owner,mint,uiTokenAmount:{amount,decimals:6}});
 const tx={blockTime:Math.floor(Date.now()/1000),transaction:{signatures:[signature],message:{accountKeys:[{pubkey:sender,signer:true},{pubkey:'source',signer:false},{pubkey:'destination',signer:false}],instructions:[{programId:TOKEN_PROGRAM,parsed:{type:'transferChecked',info:{source:'source',destination:'destination',authority:sender,mint,tokenAmount:{amount:'1000000',decimals:6}}}}]}},meta:{err:null,preTokenBalances:[balance(1,sender,'2000000')],postTokenBalances:[balance(1,sender,'1000000'),balance(2,w.destination,'1000000')]}};
 const config={cluster:'mainnet' as const,treasury:'deposit',payoutTreasury:sender,skrMint:mint};
 assert.equal(verifyPayout(w,config,signature,tx),null);
 assert.equal(verifyPayout(w,{...config,payoutTreasury:'deposit'},signature,tx),'payout_wrong_sender');
 tx.meta.preTokenBalances[0].owner='deposit';
 assert.equal(verifyPayout(w,config,signature,tx),'payout_wrong_amount');
});
