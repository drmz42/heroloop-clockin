import assert from 'node:assert/strict';
import { commitPurchase,quotePurchase,type CommerceAdapters } from './seeker_commerce.ts';
Deno.test('commerce: unknown game outcome never refunds',async()=>{
 const calls:string[]=[];
 const a:CommerceAdapters={ game:async(sql)=>{if(sql.includes('assert_payable'))return {allowed:true};throw new Error('connection lost after commit');},wallet:async(path)=>{calls.push(path);return {status:'charged'};} };
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

Deno.test('commerce: only committed wallet receipts record quest progress; retry uses same key',async()=>{
 const calls:unknown[]=[];
 const a:CommerceAdapters={
  game:async(sql,args)=>{if(sql.includes('assert_payable'))return {allowed:true};calls.push([sql.includes('record_payment')?'receipt':'delivery',args]);return {status:'delivered',result:{heroes:[]}};},
  wallet:async(path)=>({status:path.endsWith('finish')?'committed':'charged',amount_minor:'123000000'}),
 };
 await commitPurchase(a,'player','key');
 assert.equal((calls[1] as unknown[])[0],'receipt');
 assert.deepEqual((calls[1] as unknown[])[1],['player','key','123000000']);
});
Deno.test('commerce: SKR summon accepts count only',async()=>{
 const a:CommerceAdapters={game:async()=>({context:{},usd_cents:20}),wallet:async()=>({status:'quoted'})};
 assert.equal((await quotePurchase(a,'player','key','hero_summon',{count:10})).status,'quoted');
 await assert.rejects(()=>quotePurchase(a,'player','key','hero_summon',{count:10,price:1}),/invalid_skr_product/);
});

Deno.test('commerce: full training queue is rejected before any wallet charge',async()=>{
 const calls:string[]=[];
 const a:CommerceAdapters={game:async(sql)=>{assert(sql.includes('assert_payable'));throw new Error('training_boost_queue_full');},wallet:async(path)=>{calls.push(path);return {status:'charged'};}};
 await assert.rejects(()=>commitPurchase(a,'player','key'),/training_boost_queue_full/);
 assert.deepEqual(calls,[]);
});
