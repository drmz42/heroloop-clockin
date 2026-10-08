\set ON_ERROR_STOP 1
BEGIN;
-- Synthetic receipts only; rollback keeps the surrounding wallet fixtures intact.
CREATE TEMP TABLE boost_checks (seq serial, label text, snapshot jsonb, spent text, holding boolean);
CREATE FUNCTION pg_temp.boost_check(p_label text, p_player uuid, p_spent text, p_holding boolean)
RETURNS void LANGUAGE sql AS $$
 INSERT INTO boost_checks(label,snapshot,spent,holding)
 SELECT p_label,seeker_skr.boost_snapshot(p_player)||jsonb_build_object('rate',jsonb_build_object(
  'mint','SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3','network','solana:mainnet',
  'usd_micros_per_skr','10000','observed_at',clock_timestamp())),p_spent,p_holding
$$;
DO $$
DECLARE p uuid:='b0057000-0000-4000-8000-000000000001';
 peer uuid:='b0057000-0000-4000-8000-000000000002';
 k uuid; account uuid; reserve uuid; ctx jsonb;
BEGIN
 account:=seeker_skr.wallet_account(p,'SKR');
 PERFORM seeker_skr.post(gen_random_uuid(),'deposit',jsonb_build_array(
  jsonb_build_object('account_id',account,'delta_minor','5000000000'),
  jsonb_build_object('account_id',seeker_skr.system_account('chain','SKR'),'delta_minor','-5000000000')),repeat('B',88));
 PERFORM pg_temp.boost_check('deposit',p,'0',true);
 -- Fractional cents, pending charge, committed receipt and exact replay.
 k:=gen_random_uuid();ctx:='{"action":"store_buy_item"}';
 PERFORM seeker_skr.purchase_quote(p,k,ctx,999.5000,10000,clock_timestamp());
 PERFORM pg_temp.boost_check('quoted',p,'0',true);
 PERFORM seeker_skr.purchase_charge(p,k);
 PERFORM pg_temp.boost_check('charged',p,'0',true);
 PERFORM seeker_skr.purchase_finish(p,k,true);
 PERFORM pg_temp.boost_check('committed',p,'999',true);
 PERFORM seeker_skr.purchase_charge(p,k);
 PERFORM seeker_skr.purchase_finish(p,k,true);
 PERFORM pg_temp.boost_check('replay',p,'999',true);
 -- A failed delivery refunds the charge and never creates spending credit.
 k:=gen_random_uuid();
 PERFORM seeker_skr.purchase_quote(p,k,ctx,1,10000,clock_timestamp());
 PERFORM seeker_skr.purchase_charge(p,k);
 PERFORM seeker_skr.purchase_finish(p,k,false);
 PERFORM seeker_skr.purchase_finish(p,k,false);
 PERFORM pg_temp.boost_check('refunded',p,'999',true);
 -- Summon is gacha; its settled half cent completes exactly $10.
 k:=gen_random_uuid();
 PERFORM seeker_skr.purchase_quote(p,k,'{"action":"hero_summon"}',0.5000,10000,clock_timestamp());
 PERFORM seeker_skr.purchase_charge(p,k);
 PERFORM seeker_skr.purchase_finish(p,k,true);
 PERFORM pg_temp.boost_check('gacha',p,'1000',true);
 -- Neither peer nor game-owned merchant Market purchases count as Store spend.
 ctx:=jsonb_build_object('action','market_buy_listing','seller_id',peer);
 FOR i IN 1..2 LOOP
  k:=gen_random_uuid();
  PERFORM seeker_skr.purchase_quote(p,k,ctx,1,10000,clock_timestamp());
  PERFORM seeker_skr.purchase_charge(p,k);
  PERFORM seeker_skr.purchase_finish(p,k,true);
  ctx:=ctx||'{"house_seller":true}';
 END LOOP;
 PERFORM pg_temp.boost_check('market',p,'1000',true);
 PERFORM pg_temp.boost_check('foreign-player',peer,'0',false);
 -- Pending withdrawal immediately removes available holding eligibility.
 INSERT INTO seeker_skr.accounts(id,kind,player_id,asset)
 VALUES(gen_random_uuid(),'withdrawal_reserve',p,'SKR') RETURNING id INTO reserve;
 PERFORM seeker_skr.post(gen_random_uuid(),'withdraw_reserve',jsonb_build_array(
  jsonb_build_object('account_id',account,'delta_minor','-1000000001'),
  jsonb_build_object('account_id',reserve,'delta_minor','1000000001')));
 PERFORM pg_temp.boost_check('reserved',p,'1000',false);
 PERFORM seeker_skr.post(gen_random_uuid(),'withdraw_release',jsonb_build_array(
  jsonb_build_object('account_id',account,'delta_minor','1000000001'),
  jsonb_build_object('account_id',reserve,'delta_minor','-1000000001')));
 PERFORM pg_temp.boost_check('released',p,'1000',true);
END $$;
SELECT jsonb_build_object('label',label,'snapshot',snapshot,'spent',spent,'holding',holding)
FROM boost_checks ORDER BY seq;
ROLLBACK;
