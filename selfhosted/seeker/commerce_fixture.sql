\set ON_ERROR_STOP 1
DO $$
DECLARE p uuid:='50000000-0000-4000-8000-000000000001'; q uuid:='50000000-0000-4000-8000-000000000002';
 k uuid:=gen_random_uuid(); k2 uuid:=gen_random_uuid(); r jsonb; context jsonb; failed boolean;
BEGIN
 SET LOCAL ROLE seeker_wallet_runtime;
 context:=jsonb_build_object('action','market_buy_listing','seller_id',q,'params',jsonb_build_object('listing_id',gen_random_uuid()));
 r:=seeker_skr.purchase_quote(p,k,context,100,1000000,clock_timestamp());
 IF r->>'amount_minor'<>'1000000' THEN RAISE EXCEPTION 'wrong quote'; END IF;
 PERFORM seeker_skr.purchase_charge(p,k);
 PERFORM seeker_skr.purchase_charge(p,k);
 IF seeker_skr.wallet_snapshot(p)#>>'{balances,SKR}'<>'500000' THEN RAISE EXCEPTION 'charged twice'; END IF;
 IF seeker_skr.wallet_snapshot(q)#>>'{balances,SKR}'<>'0' THEN RAISE EXCEPTION 'seller credited before delivery'; END IF;
 PERFORM seeker_skr.purchase_finish(p,k,true);
 PERFORM seeker_skr.purchase_finish(p,k,true);
 IF seeker_skr.wallet_snapshot(q)#>>'{balances,SKR}'<>'900000' THEN RAISE EXCEPTION 'seller split'; END IF;
 BEGIN PERFORM seeker_skr.purchase_finish(p,k,false); failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='skr_idempotency_conflict'; END;
 IF NOT failed THEN RAISE EXCEPTION 'paid purchase refunded'; END IF;
 BEGIN PERFORM seeker_skr.purchase_quote(p,k,context,101,1000000,clock_timestamp()); failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='skr_idempotency_conflict'; END;
 IF NOT failed THEN RAISE EXCEPTION 'changed replay'; END IF;
 r:=seeker_skr.purchase_quote(p,k2,'{"action":"shop_bundle_buy"}',20,1000000,clock_timestamp());
 PERFORM seeker_skr.purchase_charge(p,k2);
 PERFORM seeker_skr.purchase_finish(p,k2,false);
 PERFORM seeker_skr.purchase_finish(p,k2,false);
 IF seeker_skr.wallet_snapshot(p)#>>'{balances,SKR}'<>'500000' THEN RAISE EXCEPTION 'refund twice'; END IF;
 BEGIN PERFORM seeker_skr.purchase_charge(q,k2); failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='skr_quote_not_found'; END;
 IF NOT failed THEN RAISE EXCEPTION 'foreign quote'; END IF;
 k2:=gen_random_uuid();
 PERFORM seeker_skr.purchase_quote(p,k2,'{"action":"store_buy_item"}',100,1000000,clock_timestamp());
 BEGIN PERFORM seeker_skr.purchase_charge(p,k2); failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='skr_insufficient_balance_or_overflow'; END;
 IF NOT failed THEN RAISE EXCEPTION 'insufficient debit accepted'; END IF;
 BEGIN PERFORM seeker_skr.purchase_quote(p,gen_random_uuid(),' {"action":"store_buy_item"}',1,1000000,clock_timestamp()-interval '61 seconds'); failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='stale_skr_rate'; END;
 IF NOT failed THEN RAISE EXCEPTION 'stale quote'; END IF;
 -- One atomic SKR rounds the seller share down to zero; the remainder is the fee.
 k2:=gen_random_uuid();
 PERFORM seeker_skr.purchase_quote(p,k2,context,0.0001,1000000,clock_timestamp());
 PERFORM seeker_skr.purchase_charge(p,k2);
 PERFORM seeker_skr.purchase_finish(p,k2,true);
 PERFORM seeker_skr.purchase_finish(p,k2,true);
 IF seeker_skr.wallet_snapshot(p)#>>'{balances,SKR}'<>'499999' THEN RAISE EXCEPTION 'atomic buyer debit'; END IF;
 IF seeker_skr.wallet_snapshot(q)#>>'{balances,SKR}'<>'900000' THEN RAISE EXCEPTION 'atomic seller rounding'; END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT asset FROM seeker_skr.accounts GROUP BY asset HAVING sum(balance_minor)<>0) THEN RAISE EXCEPTION 'lost conservation'; END IF;
 IF (SELECT balance_minor FROM seeker_skr.accounts WHERE kind='commerce_escrow')<>0 THEN RAISE EXCEPTION 'escrow retained finished payment'; END IF;
 IF (SELECT balance_minor FROM seeker_skr.accounts WHERE kind='fees')<>110001 THEN RAISE EXCEPTION 'fee split'; END IF;
END $$;
