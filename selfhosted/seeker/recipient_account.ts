// Recipient-funded SKR account preparation. No project signer or ledger writes.
import { ADDRESS, base58Decode, SYSTEM_PROGRAM, TOKEN_PROGRAM, type ChainConfig } from './chain.ts';
import { findProgramAddress } from './ore.ts';
export const ASSOCIATED_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
type Rpc = (method:string,params:unknown[])=>Promise<unknown>;
type Json = Record<string,unknown>;
const record=(v:unknown):v is Json=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const key=(address:string)=>{const bytes=base58Decode(address);if(bytes.length!==32)throw new Error('invalid_wallet_address');return bytes;};
const integer=(v:unknown)=>{if(!Number.isSafeInteger(v)||Number(v)<0)throw new Error('rpc_invalid_account_cost');return BigInt(v as number);};
export async function skrAccountAddress(owner:string,mint:string):Promise<string>{
 return findProgramAddress([key(owner),key(TOKEN_PROGRAM),key(mint)],ASSOCIATED_PROGRAM);
}
export async function hasSkrAccount(owner:string,mint:string,rpc:Rpc):Promise<boolean>{
 const address=await skrAccountAddress(owner,mint);
 const reply=await rpc('getAccountInfo',[address,{encoding:'jsonParsed',commitment:'finalized'}]);
 if(!record(reply)||!('value' in reply))throw new Error('rpc_invalid_recipient_account');
 if(reply.value===null)return false;
 const account=reply.value;
 const info=record(account)&&record(account.data)&&record(account.data.parsed)?account.data.parsed.info:null;
 if(!record(account)||account.owner!==TOKEN_PROGRAM||!record(info)||info.owner!==owner||info.mint!==mint||info.state!=='initialized'||!record(info.tokenAmount)||info.tokenAmount.decimals!==6)throw new Error('rpc_invalid_recipient_account');
 return true;
}
export async function prepareSkrAccount(owner:string,config:ChainConfig,rpc:Rpc){
 if(!ADDRESS.test(owner)||owner===config.treasury)throw new Error('invalid_wallet_address');
 if(await hasSkrAccount(owner,config.skrMint,rpc))return {ready:true,owner,chain:config};
 const address=await skrAccountAddress(owner,config.skrMint);
 const latest=await rpc('getLatestBlockhash',[{commitment:'finalized'}]);
 if(!record(latest)||!record(latest.value)||typeof latest.value.blockhash!=='string')throw new Error('rpc_invalid_blockhash');
 // Payer/owner is the authenticated linked wallet. CreateIdempotent has one
 // signer, two writable accounts, and no project-owned account or transfer.
 const accounts=[owner,address,config.skrMint,SYSTEM_PROGRAM,TOKEN_PROGRAM,ASSOCIATED_PROGRAM];
 const message=Uint8Array.from([1,0,4,6,...accounts.flatMap(a=>[...key(a)]),...key(latest.value.blockhash),1,5,6,0,1,0,2,3,4,1,1]);
 const encoded=btoa(String.fromCharCode(...message));
 const [rentReply,feeReply,balanceReply]=await Promise.all([
  rpc('getMinimumBalanceForRentExemption',[165,{commitment:'finalized'}]),
  rpc('getFeeForMessage',[encoded,{commitment:'finalized'}]),
  rpc('getBalance',[owner,{commitment:'finalized'}]),
 ]);
 if(!record(feeReply)||!record(balanceReply)||feeReply.value===null)throw new Error('rpc_invalid_account_cost');
 const rent=integer(rentReply),fee=integer(feeReply.value),balance=integer(balanceReply.value);
 const transaction=Uint8Array.from([1,...new Array(64).fill(0),...message]);
 return {ready:false,owner,chain:config,rent_lamports:rent.toString(),network_fee_lamports:fee.toString(),required_lamports:(rent+fee).toString(),balance_lamports:balance.toString(),funded:balance>=rent+fee,transaction:btoa(String.fromCharCode(...transaction))};
}
