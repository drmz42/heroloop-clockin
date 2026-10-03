// Server-only saga. An unknown game outcome never authorizes a refund.
type Json = Record<string, unknown>;
export type CommerceAdapters = {
  game: (sql: string,args: unknown[]) => Promise<Json>;
  wallet: (path: string,body: Json) => Promise<Json>;
};
export const SKR_PRODUCTS: Record<string, readonly string[]> = {
  // Star Up is not an SKR product: it costs duplicates plus Gold (seeker_hero_promote_all).
  hero_summon:['count'],hero_capacity_upgrade:['previous_capacity'],item_upgrade:['operation','item_uid','use_charm'],
  market_list_item: ['item_id','price'], market_buy_listing: ['listing_id'],
  store_buy_item: ['slot_index','refresh_at'], inventory_bag_buy:['bag','kind'], shop_bundle_buy: ['bundle'], reward_boost_buy: ['plan'],
  training_slot_unlock: ['unlocked_slots'], training_boost_buy: ['boost'],
};
export async function quotePurchase(a: CommerceAdapters,player: string,key: string,action: string,params: Json) {
  const fields=SKR_PRODUCTS[action];
  if (!fields || Object.keys(params).length!==fields.length || fields.some(k=>!Object.hasOwn(params,k))) throw new Error('invalid_skr_product');
  const prepared=await a.game('SELECT heroloop_api.seeker_purchase_prepare($1::uuid,$2::uuid,$3::text,$4::jsonb) AS result',
    [player,key,action,JSON.stringify(params)]);
  return await a.wallet('/wallet/purchase-quote',{ player_id:player,request_id:key,...prepared });
}
export async function commitPurchase(a: CommerceAdapters,player: string,key: string): Promise<Json> {
  const payment=await a.wallet('/wallet/purchase-charge',{ player_id:player,quote_id:key });
  if (payment.status==='refunded') throw new Error('skr_purchase_refunded');
  // This SQL persists the delivered/rejected receipt atomically with the grant.
  // If its response is lost, retry the same key and read the receipt.
  const delivered=await a.game('SELECT heroloop_api.seeker_purchase_deliver($1::uuid,$2::uuid) AS result',[player,key]);
  if (!['delivered','rejected'].includes(String(delivered.status))) throw new Error('skr_purchase_pending');
  const finished=await a.wallet('/wallet/purchase-finish',{
    player_id:player,quote_id:key,success:delivered.status==='delivered',
  });
  if (delivered.status==='delivered' && finished.status==='committed') {
    if (typeof finished.amount_minor!=='string' || !/^[1-9][0-9]*$/.test(finished.amount_minor)) throw new Error('invalid_skr_payment_receipt');
    await a.game('SELECT heroloop_api.seeker_purchase_record_payment($1::uuid,$2::uuid,$3::numeric) AS result',[player,key,finished.amount_minor]);
  }
  return { ...delivered,payment:finished };
}
