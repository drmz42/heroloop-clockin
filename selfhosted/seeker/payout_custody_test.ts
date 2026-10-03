import assert from 'node:assert/strict';
import {custodyBalances} from './payout_custody.ts';
import {TOKEN_PROGRAM} from './chain.ts';
import {mineCustodyLamports} from './mine_service.ts';
const mint='fixture-mint';
function token(owner:string,amount:string){return {account:{owner:TOKEN_PROGRAM,data:{parsed:{info:{owner,mint,state:'initialized',tokenAmount:{amount,decimals:6}}}}}};}
Deno.test('distinct deposit and payout balances cover liabilities without counting repeated owners',async()=>{
 const reads:string[]=[];
 const rpc=async(method:string,params:unknown[])=>{const owner=String(params[0]);reads.push(method+':'+owner);return method==='getBalance'?{value:owner==='deposit'?100:50}:{value:[token(owner,owner==='deposit'?'1000':'300')]};};
 assert.deepEqual(await custodyBalances(['deposit','payout','deposit'],mint,rpc),{SKR:1300n,SOL:150n});
 assert.equal(reads.length,4);
 assert.deepEqual(await custodyBalances(['deposit','deposit'],mint,rpc),{SKR:1000n,SOL:100n});
});
Deno.test('malformed or unavailable payout chain evidence never returns a partial balance',async()=>{
 for(const change of [{owner:'foreign'},{mint:'wrong'},{state:'frozen'},{tokenAmount:{amount:'1',decimals:9}},{tokenAmount:{amount:'-1',decimals:6}}]){
  const rpc=async(method:string,params:unknown[])=>{if(method==='getBalance')return {value:100};const row=token(String(params[0]),'1000');Object.assign(row.account.data.parsed.info,change);return {value:[row]};};
  await assert.rejects(()=>custodyBalances(['deposit','payout'],mint,rpc),/rpc_balance/);
 }
 await assert.rejects(()=>custodyBalances(['deposit','payout'],mint,async(method,params)=>{
  if(params[0]==='payout')throw new Error('rpc_unavailable');
  return method==='getBalance'?{value:100}:{value:[token('deposit','1000')]};
 }),/rpc_unavailable/);
});
Deno.test('Mine reconciliation deduplicates float and session wallets against payout custody',async()=>{
 const master=new Uint8Array(32).fill(7),reads:string[]=[];
 const call=async()=>({sessions:[{custody_address:'payout'},{custody_address:'session'},{custody_address:'session'}]});
 const rpc=async(_method:string,params:unknown[])=>{reads.push(String(params[0]));return {value:10};};
 assert.equal(await mineCustodyLamports(master,call,rpc,new Set(['payout'])),20n);
 assert.equal(reads.filter(a=>a==='payout').length,0);
 assert.equal(reads.filter(a=>a==='session').length,1);
});
