\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.set_boost_max_active(p_player_id uuid, p_active boolean)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'active', result.active,
    'login_days', result.login_days,
    'online_seconds', result.online_seconds,
    'tokens_earned', result.tokens_earned,
    'tokens_spent', result.tokens_spent,
    'token_balance', result.token_balance
  )
  FROM public.set_boost_max_active(p_player_id, p_active) result
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.summon_boss(p_player_id uuid, p_location integer)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object('encounter_id', result.encounter_id, 'remaining_keys', result.remaining_keys)
  FROM public.summon_boss(p_player_id, p_location) result
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.remove_limited_item(p_player_id uuid, p_item_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object('removed', public.remove_player_item(p_player_id, p_item_id))
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_status(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.dungeon_status(p_player_id)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_start(
  p_player_id uuid, p_depth integer, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.dungeon_start(p_player_id, p_depth, p_idempotency_key)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_room_start(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.dungeon_room_start(p_player_id, p_encounter_id, p_expected_revision, p_idempotency_key)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_room_action(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint,
  p_action_kind text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.dungeon_room_action(
    p_player_id, p_encounter_id, p_expected_revision, p_action_kind, p_idempotency_key
  )
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_room_complete(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.dungeon_room_complete(p_player_id, p_encounter_id, p_expected_revision, p_idempotency_key)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_room_choose(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint,
  p_choice text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.dungeon_room_choose(
    p_player_id, p_encounter_id, p_expected_revision, p_choice, p_idempotency_key
  )
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_abandon(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.dungeon_abandon(p_player_id, p_encounter_id, p_expected_revision, p_idempotency_key)
$function$;

REVOKE ALL ON FUNCTION heroloop_api.set_boost_max_active(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.summon_boss(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.remove_limited_item(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_start(uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_room_start(uuid, uuid, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_room_action(uuid, uuid, bigint, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_room_complete(uuid, uuid, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_room_choose(uuid, uuid, bigint, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_abandon(uuid, uuid, bigint, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION heroloop_api.set_boost_max_active(uuid, boolean) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.summon_boss(uuid, integer) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.remove_limited_item(uuid, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_status(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_start(uuid, integer, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_room_start(uuid, uuid, bigint, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_room_action(uuid, uuid, bigint, text, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_room_complete(uuid, uuid, bigint, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_room_choose(uuid, uuid, bigint, text, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_abandon(uuid, uuid, bigint, uuid) TO heroloop_api;
