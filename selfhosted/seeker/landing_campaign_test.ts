import assert from 'node:assert/strict';
import { campaignRoute, campaignSignature, reconcileCampaign, CAMPAIGN_SOL_TREASURY } from './landing_campaign.ts';
import {base58Encode,base58Decode} from './chain.ts';
Deno.test('wallet challenge uses canonical SIWS domain, nonce and expiration fields',async()=>{
 const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
 const wallet=base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
 const result=await campaignRoute('challenge',{wallet,origin:'https://heroloop.xyz',binding:'browser-cookie',ref:''},{call:async(_sql,args)=>{assert.equal(args[0],'challenge');return JSON.parse(String(args[1]));},rpc:()=>{throw new Error('unexpected RPC');},config:{cluster:'mainnet',skrMint:'',treasury:''},paymentsEnabled:false});
 const message=String(result.message);
 assert(message.startsWith(`heroloop.xyz wants you to sign in with your Solana account:\n${wallet}\n\n`));
 assert(message.includes('\nURI: https://heroloop.xyz/\nVersion: 1\nChain ID: mainnet\n'));
 assert.match(message,/\nNonce: [a-f0-9]{32}\n/);
 const issued=message.match(/\nIssued At: (.+)\n/)?.[1];
 const expires=message.match(/\nExpiration Time: (.+)$/)?.[1];
 assert.equal(Date.parse(expires!)-Date.parse(issued!),300000);
 const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,new TextEncoder().encode(message)))));
 assert(await campaignSignature(wallet,message,signature));
 assert(!await campaignSignature(wallet,message.replace('heroloop.xyz','evil.example'),signature));
});
Deno.test('Founder SOL pack recipient is a canonical 32-byte address',()=>{
 const bytes=base58Decode(CAMPAIGN_SOL_TREASURY);assert.equal(bytes.length,32);assert.equal(base58Encode(bytes),CAMPAIGN_SOL_TREASURY);
});
Deno.test('campaign signature binds the exact wallet and invitation message',async()=>{
 const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
 const wallet=base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
 const message='origin + invitation + nonce';
 const signed=new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,new TextEncoder().encode(message)));
 const signature=btoa(String.fromCharCode(...signed));
 assert(await campaignSignature(wallet,message,signature));
 assert(!await campaignSignature(wallet,message+'changed',signature));
 assert(!await campaignSignature(wallet,message,'bad'));
});
Deno.test('new payments are disabled by default before RPC or database work',async()=>{
 await assert.rejects(()=>campaignRoute('intent',{pack:'starter'},{call:()=>{throw new Error('unexpected database call');},rpc:()=>{throw new Error('unexpected RPC');},config:{cluster:'mainnet',skrMint:'',treasury:''},paymentsEnabled:false}),/campaign_payments_paused/);
});
Deno.test('recipient cannot buy a pack from itself before RPC or order creation',async()=>{
 const calls:string[]=[];
 await assert.rejects(()=>campaignRoute('intent',{token:'session',pack:'starter'},{call:async(_sql,args)=>{calls.push(String(args[0]));return{wallet:CAMPAIGN_SOL_TREASURY};},rpc:()=>{throw new Error('unexpected RPC');},config:{cluster:'mainnet',skrMint:'',treasury:''},paymentsEnabled:true}),/campaign_payer_is_treasury/);
 assert.deepEqual(calls,['profile']);
});
Deno.test('RPC outage is reported as payment preparation failure',async()=>{
 await assert.rejects(()=>campaignRoute('intent',{token:'session',pack:'starter'},{call:async()=>({wallet:base58Encode(new Uint8Array(32).fill(2))}),rpc:()=>{throw new Error('rpc_http_503');},config:{cluster:'mainnet',skrMint:'',treasury:''},paymentsEnabled:true}),/campaign_chain_unavailable/);
});
Deno.test('unfinalized transactions do not award points even when new payments are paused',async()=>{
 const calls:string[]=[];
 await assert.rejects(()=>campaignRoute('confirm',{token:'cookie',id:'10000000-0000-4000-8000-000000000001',signature:'B'.repeat(64)},{call:async(_sql,args)=>{calls.push(String(args[0]));return{id:'10000000-0000-4000-8000-000000000001',wallet:'A'.repeat(32),amount_minor:'50000000',reference:'C'.repeat(32),treasury:'T'.repeat(32),created_at:new Date().toISOString(),expires_at:new Date().toISOString()};},rpc:async(method,args)=>{assert.equal(method,'getTransaction');assert.equal((args[1] as {commitment:string}).commitment,'finalized');return null;},config:{cluster:'mainnet',skrMint:'',treasury:'T'.repeat(32)},paymentsEnabled:false}),/campaign_payment_pending/);
 assert.deepEqual(calls,['submit']);
});
Deno.test('closed-browser recovery verifies the snapshotted recipient before settling without a session',async()=>{
 const payer='A'.repeat(32), treasury='T'.repeat(32),reference='C'.repeat(32),signature='B'.repeat(64),now=new Date();
 const order={id:'10000000-0000-4000-8000-000000000001',wallet:payer,amount_minor:'50000000',reference,treasury,submitted_signature:signature,created_at:now.toISOString(),expires_at:new Date(+now+600000).toISOString()};
 const calls:string[]=[];
 await reconcileCampaign({paymentsEnabled:false,config:{cluster:'mainnet',skrMint:'',treasury:'changed-current-treasury'},call:async(_sql,args)=>{calls.push(String(args[0]));if(args[0]==='pending')return{orders:[order]};assert.deepEqual(JSON.parse(String(args[1])),{id:order.id,signature});return{};},rpc:async()=>({blockTime:Math.floor(+now/1000),transaction:{message:{accountKeys:[{pubkey:payer,signer:true},{pubkey:treasury,signer:false},{pubkey:reference,signer:false}]}},meta:{err:null,preBalances:[1000000000,0,0],postBalances:[950000000,50000000,0]}})});
 assert.deepEqual(calls,['pending','settle_pending']);
});
