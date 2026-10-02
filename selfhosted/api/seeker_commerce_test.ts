import assert from 'node:assert/strict';
import { commitPurchase,quotePurchase,type CommerceAdapters } from './seeker_commerce.ts';
Deno.test('commerce: unknown game outcome never refunds',async()=>{
 const calls:string[]=[];
 const a:CommerceAdapters={ game:async()=>{throw new Error('connection lost after commit');},wallet:async(path)=>{calls.push(path);return {status:'charged'};} };
 await assert.rejects(()=>commitPurchase(a,'player','key'));
 assert.deepEqual(calls,['/wallet/purchase-charge']);
});
Deno.test('commerce: definitive rejection refunds; delivery commits',async()=>{
 for(const status of ['rejected','delivered']) {
  const calls:unknown[]=[];
  const a:CommerceAdapters={game:async()=>({status,result:{}}),wallet:async(path,body)=>{calls.push([path,body.success]);return {status:'charged'};}};
  const r=await commitPurchase(a,'player','key');
  assert.equal(r.status,status);
  assert.deepEqual(calls,[['/wallet/purchase-charge',undefined],['/wallet/purchase-finish',status==='delivered']]);
 }
});
Deno.test('commerce: client cannot provide price, seller or posting legs',async()=>{
 const a:CommerceAdapters={game:async()=>{throw new Error('must not reach game');},wallet:async()=>{throw new Error('must not reach wallet');}};
 await assert.rejects(()=>quotePurchase(a,'player','key','shop_bundle_buy',{bundle:'scroll_1',usd_cents:1}),/invalid_skr_product/);
 await assert.rejects(()=>quotePurchase(a,'player','key','market_buy_listing',{listing_id:'id',seller_id:'attacker'}),/invalid_skr_product/);
});
