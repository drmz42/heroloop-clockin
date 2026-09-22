\set ON_ERROR_STOP on

-- Active reward collection-power function replacement.
--
-- The additive players.collection_power column, backfill and Training Camp
-- power transition arrive in managed/migrations/20260907180000_active_reward_collection_power.sql,
-- which the baseline pipeline applies first. This migration only re-creates the
-- bounded sync_commit and leaderboard functions so they validate, persist and
-- return collection_power, preserving the exact grants, SECURITY DEFINER /
-- search_path, heartbeat, bounds, row limit, ordering and all existing fields.

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
    OR (p_summary->>'collection_power')::bigint NOT BETWEEN 0 AND 10000000
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
      collection_power = (p_summary->>'collection_power')::bigint,
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
      'collection_power', v_player.collection_power,
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

CREATE OR REPLACE FUNCTION heroloop_api.leaderboard(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'players', COALESCE(jsonb_agg(entry.row ORDER BY entry.account_level DESC, entry.total_kills DESC, entry.power DESC), '[]'::jsonb),
    'me', p_player_id
  )
  FROM (
    SELECT player.account_level, player.total_kills, player.power, jsonb_build_object(
      'player_id', player.player_id,
      'username', player.username,
      'account_level', player.account_level,
      'power', player.power,
      'collection_power', player.collection_power,
      'total_kills', player.total_kills,
      'boss_kills', player.boss_kills,
      'heroes_owned', player.heroes_owned,
      'highest_location', player.highest_location,
      'online', player.online,
      'lineup', player.lineup,
      'avatar_hero_id', player.avatar_hero_id,
      'summons', player.summons,
      'total_tokens_earned', player.total_tokens_earned
    ) AS row
    FROM public.players player
    ORDER BY player.account_level DESC, player.total_kills DESC, player.power DESC
    LIMIT 100
  ) entry
$function$;

REVOKE ALL ON FUNCTION heroloop_api.sync_commit(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.leaderboard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.sync_commit(uuid, text, text, jsonb) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.leaderboard(uuid) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.sync_commit(uuid, text, text, jsonb) IS
  'Commits only server-derived profile summary fields and renews the canonical heartbeat window.';
COMMENT ON FUNCTION heroloop_api.leaderboard(uuid) IS
  'Read-only top-100 public profile snapshot plus the verified caller UUID.';