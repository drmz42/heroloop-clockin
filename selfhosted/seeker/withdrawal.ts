import { ADDRESS,base58Decode,type ChainConfig,type WalletAsset,TOKEN_PROGRAM,SYSTEM_PROGRAM } from './chain.ts';
export type Withdrawal = { request_id:string;player_id:string;asset:WalletAsset;amount_minor:string;destination:string;expires_at:string;created_at:string };
export const WITHDRAWAL_DOMAIN='staging2.heroloop.xyz';
export const FOUNDER_WALLETS=new Set(['5vWcJZVsh1KTfp8bRMhGawoibYMfMfRu7ZoDdMWZjtWR','714yHZvDGqvtDHvmFZMufhECdXVfhPSjEPqFXndKbYwa']);
export function authorizationMessage(w:Withdrawal):string {
  if(!ADDRESS.test(w.destination)||!['SKR','SOL'].includes(w.asset)||!/^[1-9][0-9]{0,19}$/.test(w.amount_minor)
    ||![w.request_id,w.player_id].every(v=>/^[0-9a-f-]{36}$/.test(v))||!Number.isFinite(Date.parse(w.expires_at))) throw new Error('invalid_withdrawal');
  const decimals=w.asset==='SKR'?6:9;
  const digits=w.amount_minor.padStart(decimals+1,'0');
  const display=`${digits.slice(0,-decimals)}.${digits.slice(-decimals)}`;
  return `HeroLoop withdrawal authorization\nDomain: ${WITHDRAWAL_DOMAIN}\nAccount: ${w.player_id}\nAsset: ${w.asset}\nAmount: ${display} ${w.asset}\nAmount (atomic units): ${w.amount_minor}\nDestination: ${w.destination}\nRequest: ${w.request_id}\nExpires: ${w.expires_at}\n\nReserve this in-game balance for a manual payout. This signature sends no transaction.`;
}
export async function verifyAuthorization(w:Withdrawal,signature:string,now=Date.now()):Promise<boolean> {
  if(now>Date.parse(w.expires_at))return false;
  try {
    const bytes=Uint8Array.from(atob(signature),c=>c.charCodeAt(0));
    if(bytes.length!==64)return false;
    const key=await crypto.subtle.importKey('raw',Uint8Array.from(base58Decode(w.destination)).buffer,{name:'Ed25519'},false,['verify']);
    return await crypto.subtle.verify('Ed25519',key,bytes,new TextEncoder().encode(authorizationMessage(w)));
  }catch{return false;}
}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
// The RPC caller requests finalized commitment by the exact supplied signature.
// Require one direct transfer instruction as well as exact balance deltas; a
// pre-request payment or a third-party inflow cannot discharge this liability.
export function verifyPayout(w:Withdrawal,config:ChainConfig,signature:string,tx:unknown):string|null {
  if(!record(tx)||!record(tx.meta)||!record(tx.transaction)||tx.meta.err!==null)return 'payout_not_finalized';
  const transaction=tx.transaction,meta=tx.meta,message=transaction.message;
  if(!Array.isArray(transaction.signatures)||transaction.signatures[0]!==signature||!record(message)||!Array.isArray(message.accountKeys))return 'payout_unreadable';
  const keys=message.accountKeys.filter(record);
  if(keys[0]?.pubkey!==config.treasury||keys[0]?.signer!==true)return 'payout_wrong_sender';
  const time=typeof tx.blockTime==='number'?tx.blockTime*1000:0;
  if(time<Date.parse(w.created_at))return 'payout_before_request';
  const instructions=Array.isArray(message.instructions)?message.instructions.filter(record):[];
  const amount=BigInt(w.amount_minor);
  if(w.asset==='SOL') {
    const hit=instructions.some(i=>i.programId===SYSTEM_PROGRAM&&record(i.parsed)&&i.parsed.type==='transfer'&&record(i.parsed.info)
      &&i.parsed.info.source===config.treasury&&i.parsed.info.destination===w.destination&&String(i.parsed.info.lamports)===w.amount_minor);
    const index=keys.findIndex(k=>k.pubkey===w.destination);
    if(!hit||index<1||!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances))return 'payout_wrong_recipient';
    const before=meta.preBalances[index],after=meta.postBalances[index];
    if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||BigInt(after as number)-BigInt(before as number)!==amount)return 'payout_wrong_amount';
    return null;
  }
  const total=(balances:unknown,owner:string)=>{
    if(!Array.isArray(balances))return 0n;
    let result=0n;
    for(const b of balances){if(!record(b)||b.owner!==owner||b.mint!==config.skrMint)continue;
      if(!record(b.uiTokenAmount)||b.uiTokenAmount.decimals!==6||typeof b.uiTokenAmount.amount!=='string'||!/^\d+$/.test(b.uiTokenAmount.amount))throw new Error('payout_wrong_mint');
      result+=BigInt(b.uiTokenAmount.amount);
    }return result;
  };
  const destinationAccounts=new Set((Array.isArray(meta.postTokenBalances)?meta.postTokenBalances:[]).filter(record)
    .filter(b=>b.owner===w.destination&&b.mint===config.skrMint).map(b=>keys[Number(b.accountIndex)]?.pubkey));
  const hit=instructions.some(i=>i.programId===TOKEN_PROGRAM&&record(i.parsed)&&['transfer','transferChecked'].includes(String(i.parsed.type))
    &&record(i.parsed.info)&&i.parsed.info.authority===config.treasury&&destinationAccounts.has(i.parsed.info.destination));
  if(!hit)return 'payout_wrong_recipient';
  try {
    return total(meta.postTokenBalances,w.destination)-total(meta.preTokenBalances,w.destination)===amount
      &&total(meta.preTokenBalances,config.treasury)-total(meta.postTokenBalances,config.treasury)===amount?null:'payout_wrong_amount';
  }catch{return 'payout_wrong_mint';}
}
