import { useEffect, useRef, useState } from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features';
import { SolanaSignMessage, type SolanaSignMessageFeature, SolanaSignAndSendTransaction, type SolanaSignAndSendTransactionFeature } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
export type CampaignPack='free'|'starter'|'scout'|'veteran'|'elite'|'founder';
export const CAMPAIGN_PRICES: Record<CampaignPack,string>={free:'0 SOL',starter:'0.05 SOL',scout:'0.10 SOL',veteran:'0.25 SOL',elite:'0.50 SOL',founder:'1 SOL'};
type Entitlement={id:string;source:'purchase'|'referral';pack:string;threshold:number|null;delivered_at:string|null};
type Order={id:string;wallet:string;pack:CampaignPack;amount_minor:string;treasury:string;signature:string|null;transaction?:string};
type Profile={wallet:string;code:string;points:number;registered:number;entitlements:Entitlement[];orders:Order[];payments_enabled:boolean};
async function api<T>(action:string,body:Record<string,unknown>={}):Promise<T>{
 const response=await fetch(`/api/v1/landing/${action}`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.code||'campaign_unavailable');return data.result;
}
const messages:Record<string,string>={campaign_sign_in_required:'Connect your wallet to continue.',campaign_payments_paused:'Pack purchases are not open yet.',campaign_payment_pending:'Payment sent. Waiting for final confirmation. Retry confirmation; do not pay again.',campaign_invalid_referral:'This invitation is invalid. Check the original link.',campaign_invalid_proof:'The wallet signature could not be verified.',campaign_rate_limited:'Too many requests. Try again in a minute.'};
function message(error:unknown){return messages[error instanceof Error?error.message:'']??'The request did not finish. If you sent a payment, retry its confirmation before paying again.';}
function base58(bytes:Uint8Array){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of bytes)n=n*256n+BigInt(b);let s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b)break;s='1'+s;}return s;}
const bytes=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const recoveryKey='hl-campaign-payment-v1';
export function useLandingCampaign(){
 const [profile,setProfile]=useState<Profile|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[order,setOrder]=useState<Order|null>(null),[receipt,setReceipt]=useState('');
 const wallet=useRef<Wallet|null>(null);const locked=useRef(false);
 const link=profile?`${window.location.origin}/?ref=${profile.code}#referral`:'';
 useEffect(()=>{let alive=true;const refresh=()=>{void api<Profile>('profile').then(p=>{if(alive)setProfile(p);},()=>{});};refresh();const timer=setInterval(refresh,20000);return()=>{alive=false;clearInterval(timer);};},[]);
 useEffect(()=>{
  if(!profile)return;
  try{const saved=JSON.parse(sessionStorage.getItem(recoveryKey)??'null');if(saved?.wallet===profile.wallet&&saved?.id){const found=profile.orders.find(o=>o.id===saved.id);if(found&&!found.signature){setOrder(found);setReceipt(saved.signature??'');setNotice('A payment needs confirmation. Retry confirmation before paying again.');}}}catch{/* A corrupt browser recovery hint never changes server state. */}
 },[profile]);
 async function perform(work:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setNotice('');try{await work();}catch(error){setNotice(message(error));}finally{locked.current=false;setBusy(false);}}
 async function authorize():Promise<{wallet:Wallet;account:WalletAccount}>{
  const selected=getWallets().get().find(w=>w.name.trim().toLowerCase()==='phantom');
  if(!selected){setNotice('Open this page in the Phantom browser or install the Phantom extension.');throw new Error('wallet_unavailable');}
  const connect=(selected.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect]);
  const result=await connect.connect();const account=result.accounts[0];if(!account||result.accounts.length!==1)throw new Error('wallet_account_unavailable');wallet.current=selected;return{wallet:selected,account};
 }
 const connect=()=>perform(async()=>{
  const {wallet:w,account}=await authorize();
  const challenge=await api<{id:string;message:string}>('challenge',{wallet:account.address,ref:new URLSearchParams(window.location.search).get('ref')??''});
  const signer=w.features[SolanaSignMessage] as SolanaSignMessageFeature[typeof SolanaSignMessage]|undefined;
  if(!signer)throw new Error('wallet_sign_unsupported');
  const [proof]=await signer.signMessage({account,message:new TextEncoder().encode(challenge.message)});
  if(!proof||!w.accounts.some(a=>a.address===account.address))throw new Error('wallet_changed');
  setProfile(await api<Profile>('verify',{id:challenge.id,signature:btoa(String.fromCharCode(...proof.signature))}));setNotice('Wallet verified. Your invitation link is ready.');
 });
 const choose=(pack:CampaignPack)=>perform(async()=>{
  if(!profile){setNotice('Connect your wallet in the Referrals block first.');document.getElementById('referral')?.scrollIntoView({behavior:'smooth'});return;}
  if(order){setNotice('Finish or close the current payment first.');return;}
  setOrder(await api<Order>('intent',{pack}));setReceipt('');
 });
 const confirm=()=>perform(async()=>{
  if(!order||!receipt)return;
  setProfile(await api<Profile>('confirm',{id:order.id,signature:receipt}));sessionStorage.removeItem(recoveryKey);setOrder(null);setReceipt('');setNotice('Purchase confirmed. Your pack is saved for delivery in the game.');
 });
 const pay=()=>perform(async()=>{
  if(!order?.transaction||!profile||receipt)return;
  const w=wallet.current;const account=w?.accounts.find(a=>a.address===profile.wallet);
  const signer=w?.features[SolanaSignAndSendTransaction] as SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]|undefined;
  if(!w||!account||!signer){setNotice('Reconnect the same wallet before paying.');return;}
  sessionStorage.setItem(recoveryKey,JSON.stringify({wallet:profile.wallet,id:order.id}));
  const [sent]=await signer.signAndSendTransaction({account,transaction:bytes(order.transaction),chain:'solana:mainnet'});
  if(!sent?.signature)throw new Error('wallet_send_failed');
  const signature=base58(sent.signature);setReceipt(signature);sessionStorage.setItem(recoveryKey,JSON.stringify({wallet:profile.wallet,id:order.id,signature}));
  try {
   setProfile(await api<Profile>('confirm',{id:order.id,signature}));sessionStorage.removeItem(recoveryKey);setOrder(null);setReceipt('');setNotice('Purchase confirmed. Your pack is saved for delivery in the game.');
  } catch(error) {setNotice(message(error));}
 });
 const copy=()=>perform(async()=>{if(!link)return;await navigator.clipboard.writeText(link);setNotice('Invitation link copied.');});
 const disconnect=()=>perform(async()=>{await api('logout');setProfile(null);setOrder(null);wallet.current=null;setNotice('Wallet disconnected.');});
 return{profile,busy,notice,link,connect,copy,disconnect,choose,order,receipt,setReceipt,pay,confirm,close:()=>{setOrder(null);setReceipt('');}};
}
