-- Opt-in private wallet commerce. Never install in the game database.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.deposit_intents') IS NULL THEN
    RAISE EXCEPTION 'seeker_commerce_requires_private_wallet';
  END IF;
END $$;
ALTER TABLE seeker_skr.accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE seeker_skr.accounts ADD CONSTRAINT accounts_kind_check CHECK
  -- Same full kind list in every installer file, so re-applying any of them stays valid.
  (kind IN ('player','withdrawal_reserve','fees','merchant','rewards','chain','commerce_escrow',
    'fee_reserve','mining_reserve'));

CREATE TABLE IF NOT EXISTS seeker_skr.purchases (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  context jsonb NOT NULL,
  usd_cents numeric(12,4) NOT NULL CHECK (usd_cents > 0),
  amount_minor numeric(30,0) NOT NULL CHECK (amount_minor BETWEEN 1 AND 18446744073709551615),
  rate_micros numeric(30,0) NOT NULL CHECK (rate_micros > 0),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted','charged','committed','refunded')),
  charge_event uuid REFERENCES seeker_skr.events(id),
  finish_event uuid REFERENCES seeker_skr.events(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS purchases_player ON seeker_skr.purchases(player_id,created_at DESC);

CREATE OR REPLACE FUNCTION seeker_skr.purchase_json(p seeker_skr.purchases) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object('quote_id',p.id,'usd_cents',p.usd_cents,'amount_minor',p.amount_minor::text,
    'rate_micros',p.rate_micros::text,'observed_at',p.observed_at,'expires_at',p.expires_at,
    'status',p.status,'context',p.context)
$$;

CREATE OR REPLACE FUNCTION seeker_skr.purchase_quote(
  p_player uuid,p_key uuid,p_context jsonb,p_cents numeric,p_rate numeric,p_observed timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE p seeker_skr.purchases; v_amount numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase:'||p_key::text,0));
  SELECT * INTO p FROM seeker_skr.purchases WHERE id=p_key;
  IF FOUND THEN
    IF p.player_id<>p_player OR p.context<>p_context OR p.usd_cents<>p_cents THEN
      RAISE EXCEPTION 'skr_idempotency_conflict';
    END IF;
    RETURN seeker_skr.purchase_json(p);
  END IF;
  IF p_context->>'action' NOT IN ('hero_summon','market_list_item','market_buy_listing','store_buy_item','shop_bundle_buy','reward_boost_buy','inventory_bag_buy','hero_ascend','hero_capacity_upgrade','item_upgrade','training_slot_unlock','training_boost_buy')
      OR p_cents IS NULL OR p_cents NOT BETWEEN 0.0001 AND 100000000 OR p_rate IS NULL OR p_rate<=0
      OR p_rate<>trunc(p_rate) OR p_observed IS NULL OR p_observed>clock_timestamp()
      OR p_observed<clock_timestamp()-interval '60 seconds' THEN RAISE EXCEPTION 'stale_skr_rate'; END IF;
  v_amount:=ceil(p_cents::numeric*10000*1000000/p_rate);
  INSERT INTO seeker_skr.purchases(id,player_id,context,usd_cents,amount_minor,rate_micros,observed_at,expires_at)
    VALUES(p_key,p_player,p_context,p_cents,v_amount,p_rate,p_observed,p_observed+interval '60 seconds') RETURNING * INTO p;
  RETURN seeker_skr.purchase_json(p);
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.purchase_get(p_player uuid,p_key uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT seeker_skr.purchase_json(p) FROM seeker_skr.purchases p WHERE id=p_key AND player_id=p_player
$$;

CREATE OR REPLACE FUNCTION seeker_skr.purchase_charge(p_player uuid,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE p seeker_skr.purchases; v_player uuid; v_escrow uuid;
BEGIN
  SELECT * INTO p FROM seeker_skr.purchases WHERE id=p_key AND player_id=p_player FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'skr_quote_not_found'; END IF;
  IF p.status='refunded' THEN RAISE EXCEPTION 'skr_purchase_refunded'; END IF;
  IF p.status<>'quoted' THEN RETURN seeker_skr.purchase_json(p); END IF;
  IF p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'skr_quote_expired'; END IF;
  v_player:=seeker_skr.wallet_account(p_player,'SKR');
  v_escrow:=seeker_skr.system_account('commerce_escrow','SKR');
  p.charge_event:=seeker_skr.post(p_key,'transfer',jsonb_build_array(
    jsonb_build_object('account_id',v_player,'delta_minor',(-p.amount_minor)::text),
    jsonb_build_object('account_id',v_escrow,'delta_minor',p.amount_minor::text)));
  UPDATE seeker_skr.purchases SET status='charged',charge_event=p.charge_event WHERE id=p_key RETURNING * INTO p;
  RETURN seeker_skr.purchase_json(p);
END $$;

-- The game API calls this only after its durable game receipt says delivered or
-- rejected. An unknown/timeout outcome remains charged; it is never refunded.
CREATE OR REPLACE FUNCTION seeker_skr.purchase_finish(p_player uuid,p_key uuid,p_success boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE p seeker_skr.purchases; v_escrow uuid; v_target uuid; v_fee uuid; v_fee_amount numeric; v_legs jsonb;
BEGIN
  SELECT * INTO p FROM seeker_skr.purchases WHERE id=p_key AND player_id=p_player FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'skr_quote_not_found'; END IF;
  IF p_success IS NULL OR p.status='quoted' THEN RAISE EXCEPTION 'skr_purchase_not_charged'; END IF;
  IF p.status IN ('committed','refunded') THEN
    IF (p.status='committed')<>p_success THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
    RETURN seeker_skr.purchase_json(p);
  END IF;
  v_escrow:=seeker_skr.system_account('commerce_escrow','SKR');
  v_legs:=jsonb_build_array(jsonb_build_object('account_id',v_escrow,'delta_minor',(-p.amount_minor)::text));
  IF NOT p_success THEN
    v_target:=seeker_skr.wallet_account(p_player,'SKR');
  ELSIF p.context->>'action'='market_buy_listing' THEN
    IF (p.context->>'seller_id')::uuid=p_player THEN RAISE EXCEPTION 'market_self_purchase'; END IF;
    v_target:=seeker_skr.wallet_account((p.context->>'seller_id')::uuid,'SKR');
    v_fee_amount:=p.amount_minor-floor(p.amount_minor*90/100);
    v_fee:=seeker_skr.system_account('fees','SKR');
    v_legs:=v_legs||jsonb_build_array(jsonb_build_object('account_id',v_fee,'delta_minor',v_fee_amount::text));
  ELSE
    v_target:=seeker_skr.system_account(CASE WHEN p.context->>'action'='market_list_item' THEN 'fees' ELSE 'merchant' END,'SKR');
  END IF;
  IF p.amount_minor-COALESCE(v_fee_amount,0)>0 THEN
    v_legs:=v_legs||jsonb_build_array(jsonb_build_object('account_id',v_target,'delta_minor',(p.amount_minor-COALESCE(v_fee_amount,0))::text));
  END IF;
  p.finish_event:=seeker_skr.post(md5('purchase-finish:'||p_key::text)::uuid,'transfer',v_legs);
  UPDATE seeker_skr.purchases SET status=CASE WHEN p_success THEN 'committed' ELSE 'refunded' END,
    finish_event=p.finish_event WHERE id=p_key RETURNING * INTO p;
  RETURN seeker_skr.purchase_json(p);
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.liabilities() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT COALESCE(jsonb_object_agg(asset,totals),'{}'::jsonb) FROM (
    SELECT asset,jsonb_build_object('liabilities_minor',sum(balance_minor) FILTER (WHERE kind IN ('player','withdrawal_reserve','commerce_escrow'))::text,
      'earned_minor',COALESCE(sum(balance_minor) FILTER (WHERE kind IN ('fees','merchant')),0)::text,
      'accounted_minor',sum(balance_minor) FILTER (WHERE kind<>'chain')::text,
      'cache_consistent',bool_and(balance_minor=COALESCE((SELECT sum(delta_minor) FROM seeker_skr.entries e WHERE e.account_id=a.id),0))) totals
    FROM seeker_skr.accounts a GROUP BY asset
  ) t
$$;

CREATE OR REPLACE FUNCTION seeker_skr.boost_snapshot(p_player uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE v_player uuid; v_events uuid[];
BEGIN
  v_player:=seeker_skr.wallet_account(p_player,'SKR');
  SELECT array_agg(event_id) INTO v_events FROM seeker_skr.entries WHERE account_id=v_player;
  RETURN jsonb_build_object('player_id',p_player,
    'accounts',(SELECT jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'player_id',a.player_id,'balance_minor',a.balance_minor::text)) FROM seeker_skr.accounts a
      WHERE a.id=v_player OR a.id IN (SELECT account_id FROM seeker_skr.entries WHERE event_id=ANY(v_events))),
    'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object('event_id',event_id,'account_id',account_id,'delta_minor',delta_minor::text)) FROM seeker_skr.entries WHERE event_id=ANY(v_events)),'[]'::jsonb),
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'idempotency_key',idempotency_key,'chain_signature',chain_signature,'created_at',created_at)) FROM seeker_skr.events WHERE id=ANY(v_events)),'[]'::jsonb),
    'purchases',COALESCE((SELECT jsonb_agg(jsonb_build_object('event_id',charge_event,'quote_id',id,'category',CASE WHEN context->>'action'='item_upgrade' THEN CASE WHEN context#>>'{params,operation}'='reroll' THEN 'reroll' ELSE 'gear_upgrade' END ELSE 'store' END,'usd_cents',usd_cents::text,
      'mint','SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3','network','solana:mainnet')) FROM seeker_skr.purchases
      WHERE player_id=p_player AND status='committed' AND context->>'action' IN ('store_buy_item','shop_bundle_buy','reward_boost_buy','inventory_bag_buy','item_upgrade','training_slot_unlock','training_boost_buy')),'[]'::jsonb),
    'refunds','[]'::jsonb);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA seeker_skr FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA seeker_skr FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.purchase_quote(uuid,uuid,jsonb,numeric,numeric,timestamptz),
  seeker_skr.purchase_get(uuid,uuid),seeker_skr.purchase_charge(uuid,uuid),seeker_skr.purchase_finish(uuid,uuid,boolean),
  seeker_skr.liabilities(),seeker_skr.boost_snapshot(uuid) TO seeker_wallet_runtime;
COMMIT;
-- Charged operations are recoverable after an app or API restart.
CREATE OR REPLACE FUNCTION seeker_skr.purchase_pending(p_player uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
 SELECT jsonb_build_object('pending_purchases',COALESCE(jsonb_agg(seeker_skr.purchase_json(p) ORDER BY p.created_at),'[]'::jsonb))
 FROM seeker_skr.purchases p WHERE player_id=p_player AND status='charged'
$$;
REVOKE ALL ON FUNCTION seeker_skr.purchase_pending(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.purchase_pending(uuid) TO seeker_wallet_runtime;
