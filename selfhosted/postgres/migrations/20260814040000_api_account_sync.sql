\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.sync_context(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'account_exists', player.player_id IS NOT NULL,
    'state', save.state,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', item.id,
        'rarity', item.rarity,
        'stats', item.stats,
        'enchant_level', item.enchant_level
      ) ORDER BY item.created_at, item.id)
      FROM public.player_items item
      WHERE item.player_id = p_player_id AND item.removed_at IS NULL
    ), '[]'::jsonb)
  )
  FROM (SELECT p_player_id AS requested_id) request
  LEFT JOIN public.players player ON player.player_id = request.requested_id
  LEFT JOIN public.player_saves save ON save.player_id = request.requested_id
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.sync_commit(
  p_player_id uuid,
  p_username text,
  p_avatar_hero_id text,
  p_summary jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_player public.players%ROWTYPE;
BEGIN
  IF p_username !~ '^[A-Za-z0-9_]{1,16}$'
    OR p_avatar_hero_id !~ '^[A-Za-z0-9_-]{0,64}$'
    OR jsonb_typeof(p_summary) <> 'object'
    OR (p_summary->>'power')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_summary->>'combat_power')::bigint NOT BETWEEN 0 AND 10000000
    OR (p_summary->>'account_level')::integer NOT BETWEEN 1 AND 99
    OR (p_summary->>'training_hero_count')::integer NOT BETWEEN 0 AND 10
    OR (p_summary->>'total_kills')::bigint NOT BETWEEN 0 AND 1000000000
    OR (p_summary->>'boss_kills')::bigint NOT BETWEEN 0 AND 1000000000
    OR (p_summary->>'chests_opened')::bigint NOT BETWEEN 0 AND 1000000000
    OR (p_summary->>'heroes_owned')::integer NOT BETWEEN 1 AND 500
    OR (p_summary->>'highest_location')::integer NOT BETWEEN 1 AND 10000
    OR jsonb_typeof(p_summary->'lineup') <> 'array'
    OR jsonb_array_length(p_summary->'lineup') > 3
    OR (p_summary->>'total_tokens_earned')::numeric NOT BETWEEN 0 AND 1000000000000
    OR jsonb_typeof(p_summary->'token_eligible') <> 'boolean' THEN
    RAISE EXCEPTION 'api_invalid_sync';
  END IF;

  UPDATE public.players
  SET username = p_username,
      power = (p_summary->>'power')::bigint,
      combat_power = (p_summary->>'combat_power')::bigint,
      account_level = (p_summary->>'account_level')::integer,
      training_hero_count = (p_summary->>'training_hero_count')::integer,
      total_kills = (p_summary->>'total_kills')::bigint,
      boss_kills = (p_summary->>'boss_kills')::bigint,
      chests_opened = (p_summary->>'chests_opened')::bigint,
      heroes_owned = (p_summary->>'heroes_owned')::integer,
      highest_location = (p_summary->>'highest_location')::integer,
      lineup = p_summary->'lineup',
      avatar_hero_id = p_avatar_hero_id,
      total_tokens_earned = (p_summary->>'total_tokens_earned')::numeric,
      token_eligible = (p_summary->>'token_eligible')::boolean,
      updated_at = clock_timestamp()
  WHERE player_id = p_player_id
  RETURNING * INTO v_player;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_account_required'; END IF;

  PERFORM * FROM public.record_player_heartbeat(p_player_id);
  SELECT * INTO v_player FROM public.players WHERE player_id = p_player_id;
  RETURN jsonb_build_object(
    'pending_tokens', v_player.pending_tokens,
    'total_claimed', v_player.total_claimed,
    'profile', jsonb_build_object(
      'username', v_player.username,
      'avatar_hero_id', v_player.avatar_hero_id,
      'power', v_player.power,
      'combat_power', v_player.combat_power,
      'account_level', v_player.account_level,
      'heroes_owned', v_player.heroes_owned,
      'highest_location', v_player.highest_location,
      'lineup', v_player.lineup,
      'online', v_player.online,
      'reward_active_until', v_player.reward_active_until
    )
  );
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.account_delete(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_deleted uuid;
BEGIN
  DELETE FROM auth.users
  WHERE id = p_player_id
  RETURNING id INTO v_deleted;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_auth_user_missing'; END IF;

  DELETE FROM public.players WHERE player_id = p_player_id;
  RETURN jsonb_build_object('deleted', true, 'account_id', v_deleted);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.sync_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.sync_commit(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.account_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.sync_context(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.sync_commit(uuid, text, text, jsonb) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.account_delete(uuid) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.sync_context(uuid) IS
  'Bounded save and active-item authority input for the verified player profile sync.';
COMMENT ON FUNCTION heroloop_api.sync_commit(uuid, text, text, jsonb) IS
  'Commits only server-derived profile summary fields and renews the canonical heartbeat window.';
COMMENT ON FUNCTION heroloop_api.account_delete(uuid) IS
  'Permanently deletes only the verified Auth subject and its cascading per-player rows.';
