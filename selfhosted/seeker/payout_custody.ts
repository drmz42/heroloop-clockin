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
