\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.consume_rate_limit(
  p_player_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_limit integer;
  v_window_seconds integer;
  v_allowed boolean;
  v_retry_after integer := 0;
BEGIN
  SELECT limits.request_limit, limits.window_seconds
  INTO v_limit, v_window_seconds
  FROM (VALUES
    ('account_status', 20, 60), ('game_state_load', 20, 60), ('game_state_migrate', 3, 60),
    ('game_state_save', 30, 60), ('account_register', 5, 300), ('account_delete', 3, 300),
    ('sync', 12, 60), ('claim', 2, 60), ('tester_credit_tokens', 5, 60),
    ('promo_redeem', 10, 300), ('spend_tokens', 20, 60), ('hero_summon', 10, 60),
    ('hero_ascend', 20, 60), ('ascension_focus_set', 20, 60), ('chest_open', 10, 60),
    ('item_mutate', 30, 60), ('item_equip', 30, 60), ('item_upgrade', 20, 60),
    ('set_boost_max_active', 10, 60), ('store_snapshot', 20, 60), ('store_buy_item', 20, 60),
    ('leaderboard', 10, 60), ('status', 12, 60), ('summon_boss', 1, 300),
    ('reserve_limited_item', 30, 60), ('remove_limited_item', 30, 60),
    ('market_snapshot', 30, 60), ('market_list_item', 20, 60),
    ('market_cancel_listing', 20, 60), ('market_buy_listing', 20, 60),
    ('market_seed_test_stock', 2, 300), ('dungeon_status', 20, 60),
    ('dungeon_start', 12, 300), ('dungeon_room_start', 20, 60),
    ('dungeon_room_action', 10, 60), ('dungeon_room_complete', 10, 60),
    ('dungeon_room_choose', 10, 60), ('dungeon_abandon', 10, 60)
  ) AS limits(action, request_limit, window_seconds)
  WHERE limits.action = p_action;

  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'api_unknown_rate_limit_action';
  END IF;

  v_allowed := public.consume_edge_rate_limit(
    p_player_id::text,
    p_action,
    v_limit,
    v_window_seconds
  );
  IF NOT v_allowed THEN
    SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
      bucket.window_started_at + make_interval(secs => v_window_seconds) - clock_timestamp()
    )))::integer)
    INTO v_retry_after
    FROM public.edge_rate_limits bucket
    WHERE bucket.subject_key = p_player_id::text AND bucket.action = p_action;
  END IF;

  RETURN jsonb_build_object('allowed', v_allowed, 'retry_after', v_retry_after);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.game_state_migrate(
  p_player_id uuid,
  p_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_player public.players%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
BEGIN
  SELECT * INTO v_player
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_account_required'; END IF;

  IF jsonb_typeof(p_state) <> 'object'
    OR octet_length(p_state::text) > 1000000
    OR jsonb_typeof(p_state->'ownedHeroes') <> 'array'
    OR jsonb_array_length(p_state->'ownedHeroes') NOT BETWEEN 1 AND 500
    OR jsonb_typeof(p_state->'inventory') <> 'array'
    OR jsonb_array_length(p_state->'inventory') > 200
    OR jsonb_typeof(p_state->'chests') <> 'array'
    OR jsonb_array_length(p_state->'chests') > 500
    OR jsonb_typeof(p_state->'team') <> 'array'
    OR jsonb_array_length(p_state->'team') > 3 THEN
    RAISE EXCEPTION 'api_invalid_state';
  END IF;

  SELECT * INTO v_save
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'state', v_save.state,
      'revision', v_save.revision,
      'migrated', false
    );
  END IF;

  v_state := p_state || jsonb_build_object(
    'username', v_player.username,
    'walletAddress', 'game-' || p_player_id::text,
    'bossBattleActive', false,
    'hero', v_player.token_balance,
    'summons', v_player.summons
  );
  INSERT INTO public.player_saves (player_id, state, imported_legacy)
  VALUES (p_player_id, v_state, true)
  RETURNING * INTO v_save;

  RETURN jsonb_build_object(
    'state', v_save.state,
    'revision', v_save.revision,
    'migrated', true
  );
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.formation_recovery_context(
  p_player_id uuid,
  p_missing_uids jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_heroes jsonb;
  v_lineup jsonb;
BEGIN
  IF jsonb_typeof(p_missing_uids) <> 'array'
    OR jsonb_array_length(p_missing_uids) NOT BETWEEN 1 AND 3
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_missing_uids) entry
      WHERE jsonb_typeof(entry) <> 'string'
        OR length(entry #>> '{}') NOT BETWEEN 1 AND 128
    ) THEN
    RAISE EXCEPTION 'api_invalid_missing_formation';
  END IF;

  SELECT COALESCE(jsonb_agg(found.hero ORDER BY missing.ordinality), '[]'::jsonb)
  INTO v_heroes
  FROM jsonb_array_elements_text(p_missing_uids) WITH ORDINALITY AS missing(uid, ordinality)
  JOIN LATERAL (
    SELECT hero.entry AS hero
    FROM public.summon_events event
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(event.result->'heroes') = 'array'
        THEN event.result->'heroes' ELSE '[]'::jsonb END
    ) AS hero(entry)
    WHERE event.player_id = p_player_id
      AND hero.entry->>'uid' = missing.uid
    ORDER BY event.created_at DESC
    LIMIT 1
  ) found ON true;

  SELECT COALESCE(lineup, '[]'::jsonb)
  INTO v_lineup
  FROM public.players
  WHERE player_id = p_player_id;

  RETURN jsonb_build_object(
    'heroes', v_heroes,
    'lineup', COALESCE(v_lineup, '[]'::jsonb)
  );
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.consume_rate_limit(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.game_state_migrate(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.formation_recovery_context(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.consume_rate_limit(uuid, text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.game_state_migrate(uuid, jsonb) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.formation_recovery_context(uuid, jsonb) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.consume_rate_limit(uuid, text) IS
  'Fixed server-owned v1 per-player command limits; callers cannot choose thresholds.';
COMMENT ON FUNCTION heroloop_api.game_state_migrate(uuid, jsonb) IS
  'Atomic one-time browser-save import using the authoritative player account fields.';
COMMENT ON FUNCTION heroloop_api.formation_recovery_context(uuid, jsonb) IS
  'Bounded recovery candidates for at most three missing formation hero UIDs.';
