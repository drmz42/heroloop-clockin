\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.consume_rate_limit(p_player_id uuid, p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_limit integer; v_window_seconds integer; v_allowed boolean; v_retry_after integer:=0;
BEGIN
  SELECT limits.request_limit,limits.window_seconds INTO v_limit,v_window_seconds FROM (VALUES
    ('account_status',20,60),('game_state_load',20,60),('game_state_migrate',3,60),('game_state_save',30,60),('account_register',5,300),('account_delete',3,300),('sync',30,60),('claim',12,60),('tester_credit_tokens',5,60),('tester_credit_gold',5,60),('promo_redeem',10,300),('spend_tokens',20,60),('hero_summon',10,60),('hero_ascend',20,60),('hero_release',10,60),('ascension_focus_set',20,60),('chest_open',10,60),('tutorial_quest_claim',20,60),('quest_claim',20,60),('tutorial_chest_open',10,60),('item_mutate',30,60),('item_equip',30,60),('item_upgrade',20,60),('set_boost_max_active',10,60),('store_snapshot',20,60),('store_buy_item',20,60),('leaderboard',10,60),('status',60,60),('summon_boss',2,300),('boss_claim',5,60),('reserve_limited_item',30,60),('remove_limited_item',30,60),('market_snapshot',30,60),('market_list_item',20,60),('market_cancel_listing',20,60),('market_buy_listing',20,60),('market_seed_test_stock',2,300),('dungeon_status',20,60),('dungeon_start',12,300),('dungeon_room_start',20,60),('dungeon_room_action',10,60),('dungeon_room_complete',10,60),('dungeon_room_choose',10,60),('dungeon_abandon',10,60),('normal_combat_start',20,60),('normal_combat_complete',30,60)
  ) AS limits(action,request_limit,window_seconds) WHERE limits.action=p_action;
  IF v_limit IS NULL THEN RAISE EXCEPTION 'api_unknown_rate_limit_action'; END IF;
  v_allowed:=public.consume_edge_rate_limit(p_player_id::text,p_action,v_limit,v_window_seconds);
  IF NOT v_allowed THEN SELECT GREATEST(1,CEIL(EXTRACT(EPOCH FROM (bucket.window_started_at+make_interval(secs=>v_window_seconds)-clock_timestamp())))::integer) INTO v_retry_after FROM public.edge_rate_limits bucket WHERE bucket.subject_key=p_player_id::text AND bucket.action=p_action; END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'retry_after',v_retry_after);
END;
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.hero_release(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_hero_uid text,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_hero_release(p_player_id, p_idempotency_key, p_hero_uid, p_expected_revision)
$function$;

REVOKE ALL ON FUNCTION heroloop_api.consume_rate_limit(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.hero_release(uuid,uuid,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.consume_rate_limit(uuid,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_release(uuid,uuid,text,bigint) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.hero_release(uuid,uuid,text,bigint) IS
  'Bounded API wrapper for the no-reward server-authoritative Hero Release settlement.';
