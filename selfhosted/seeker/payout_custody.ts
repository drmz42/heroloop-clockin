// Read-only finalized custody totals. A dedicated payout wallet does not change deposits.
import { TOKEN_PROGRAM } from './chain.ts';
type Rpc = (method:string, params:unknown[])=>Promise<unknown>;
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
export async function custodyBalances(owners:Iterable<string>,mint:string,rpc:Rpc):Promise<{SKR:bigint;SOL:bigint}> {
  const total={SKR:0n,SOL:0n};
  for(const owner of new Set(owners)) {
    const sol=await rpc('getBalance',[owner,{commitment:'finalized'}]);
    if(!record(sol)||!Number.isSafeInteger(sol.value)||Number(sol.value)<0)throw new Error('rpc_balance');
    total.SOL+=BigInt(sol.value as number);
    const tokens=await rpc('getTokenAccountsByOwner',[owner,{mint},{encoding:'jsonParsed',commitment:'finalized'}]);
    if(!record(tokens)||!Array.isArray(tokens.value))throw new Error('rpc_balance');
    for(const entry of tokens.value) {
      const account=record(entry)&&record(entry.account)?entry.account:null;
      const data=account&&record(account.data)&&record(account.data.parsed)?account.data.parsed:null;
      const info=data&&record(data.info)?data.info:null;
      if(account?.owner!==TOKEN_PROGRAM||!info||info.owner!==owner||info.mint!==mint
        ||info.state!=='initialized'||!record(info.tokenAmount)||info.tokenAmount.decimals!==6
        ||typeof info.tokenAmount.amount!=='string'||!/^\d+$/.test(info.tokenAmount.amount))throw new Error('rpc_balance');
      total.SKR+=BigInt(info.tokenAmount.amount);
    }
  }
  return total;
}

// Exact finalized classic-token custody for the pinned ORE asset.
export async function tokenCustodyBalance(owners:Iterable<string>,mint:string,decimals:number,rpc:Rpc):Promise<bigint>{
 let total=0n;
 for(const owner of new Set(owners)){
  const response=await rpc('getTokenAccountsByOwner',[owner,{mint},{encoding:'jsonParsed',commitment:'finalized'}]);
  if(!record(response)||!Array.isArray(response.value))throw new Error('rpc_balance');
  const seen=new Set<string>();
  for(const row of response.value){
   const account=record(row)&&record(row.account)?row.account:null;
   const parsed=account&&record(account.data)&&record(account.data.parsed)?account.data.parsed:null;
   const info=parsed&&record(parsed.info)?parsed.info:null;
   const amount=info&&record(info.tokenAmount)?info.tokenAmount:null;
   if(!record(row)||typeof row.pubkey!=='string'||seen.has(row.pubkey)||account?.owner!==TOKEN_PROGRAM
    ||!info||info.owner!==owner||info.mint!==mint||info.state!=='initialized'||!amount||amount.decimals!==decimals
    ||typeof amount.amount!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(amount.amount)
    ||BigInt(amount.amount)>18446744073709551615n)throw new Error('rpc_balance');
   seen.add(row.pubkey);total+=BigInt(amount.amount);
  }
 }
 return total;
}
