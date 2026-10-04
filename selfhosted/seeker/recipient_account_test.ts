import assert from 'node:assert/strict';
import {prepareSkrAccount,hasSkrAccount,skrAccountAddress,ASSOCIATED_PROGRAM} from './recipient_account.ts';
import {base58Decode,base58Encode,TOKEN_PROGRAM} from './chain.ts';
import {SKR_ASSET} from './ledger.ts';
const owner='11111111111111111111111111111111';
const config={cluster:'mainnet' as const,skrMint:SKR_ASSET.mint,treasury:base58Encode(new Uint8Array(32).fill(2))};
function fixture(){
 let exists=false,state='initialized',balance=3000000;const calls:string[]=[];
 const rpc=async(method:string,_params:unknown[])=>{calls.push(method);switch(method){
 case 'getAccountInfo':return {value:exists?{owner:TOKEN_PROGRAM,data:{parsed:{info:{owner,mint:config.skrMint,state,tokenAmount:{decimals:6}}}}}:null};
 case 'getLatestBlockhash':return {value:{blockhash:base58Encode(new Uint8Array(32).fill(3))}};
 case 'getMinimumBalanceForRentExemption':return 2039280;
 case 'getFeeForMessage':return {value:5000};
 case 'getBalance':return {value:balance};
 default:throw new Error(method);
 }};
 return {rpc,calls,setExists:()=>{exists=true;},freeze:()=>{exists=true;state='frozen';},empty:()=>{balance=0;}};
}
Deno.test('canonical SKR ATA matches independent solders vector',async()=>{
 assert.equal(await skrAccountAddress(owner,config.skrMint),'FvDNQxqADNDRXS93jdgDBoQV7zwKSP9yf4dppfZvxqBp');
});
Deno.test('missing account quotes RPC cost and creates only recipient-paid ATA',async()=>{
 const f=fixture();const status=await prepareSkrAccount(owner,config,f.rpc);
 assert.equal(status.ready,false);assert.equal(status.rent_lamports,'2039280');assert.equal(status.network_fee_lamports,'5000');assert.equal(status.required_lamports,'2044280');assert(status.funded);
 const bytes=Uint8Array.from(atob(status.transaction!),c=>c.charCodeAt(0));
 assert.equal(bytes[0],1);assert(bytes.slice(1,65).every(v=>v===0));
 const message=bytes.slice(65);assert.deepEqual([...message.slice(0,4)],[1,0,4,6]);
 const accounts=Array.from({length:6},(_,i)=>base58Encode(message.slice(4+i*32,36+i*32)));
 assert.equal(accounts[0],owner);assert.equal(accounts[1],await skrAccountAddress(owner,config.skrMint));assert.equal(accounts[2],config.skrMint);assert.equal(accounts[5],ASSOCIATED_PROGRAM);assert(!accounts.includes(config.treasury));
 assert.deepEqual([...message.slice(4+6*32+32)],[1,5,6,0,1,0,2,3,4,1,1]);
 assert.deepEqual([...base58Decode(accounts[0])],[...new Uint8Array(32)]);
});
Deno.test('insufficient personal SOL is explicit; finalized valid ATA skips cost RPC; frozen fails closed',async()=>{
 const f=fixture();f.empty();assert.equal((await prepareSkrAccount(owner,config,f.rpc)).funded,false);
 f.setExists();f.calls.length=0;assert.equal((await prepareSkrAccount(owner,config,f.rpc)).ready,true);assert.deepEqual(f.calls,['getAccountInfo']);
 f.freeze();await assert.rejects(()=>hasSkrAccount(owner,config.skrMint,f.rpc),/rpc_invalid_recipient_account/);
 await assert.rejects(()=>hasSkrAccount(owner,config.skrMint,async()=>({})),/rpc_invalid_recipient_account/);
});
