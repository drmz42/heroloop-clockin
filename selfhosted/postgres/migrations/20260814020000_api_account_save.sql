\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.account_register(
  p_player_id uuid,
  p_username text,
  p_starter_hero_id text,
  p_registered_state jsonb
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
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_username !~ '^[A-Za-z0-9_]{3,16}$'
    OR p_starter_hero_id NOT IN (
      'shepherd-common', 'assassin-common', 'knight-common', 'druid-common', 'archer-common'
    )
    OR jsonb_typeof(p_registered_state) <> 'object'
    OR octet_length(p_registered_state::text) > 1000000
    OR jsonb_typeof(p_registered_state->'ownedHeroes') <> 'array'
    OR jsonb_array_length(p_registered_state->'ownedHeroes') <> 1
    OR p_registered_state#>>'{ownedHeroes,0,heroId}' <> p_starter_hero_id
    OR jsonb_typeof(p_registered_state->'team') <> 'array'
    OR jsonb_array_length(p_registered_state->'team') <> 1
    OR p_registered_state#>>'{team,0}' <> p_registered_state#>>'{ownedHeroes,0,uid}'
    OR p_registered_state->>'gold' <> '500'
    OR p_registered_state->>'accountLevel' <> '1'
    OR p_registered_state->>'accountXp' <> '0'
    OR p_registered_state->'inventory' <> '[]'::jsonb
    OR p_registered_state->'chests' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'api_invalid_registration';
  END IF;

  PERFORM id FROM auth.users WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_auth_user_missing'; END IF;

  INSERT INTO public.players (player_id, username, online, last_heartbeat, updated_at)
  VALUES (p_player_id, p_username, true, v_now, v_now)
  ON CONFLICT (player_id) DO NOTHING;

  UPDATE public.players
  SET username = p_username, online = true, last_heartbeat = v_now, updated_at = v_now
  WHERE player_id = p_player_id
  RETURNING * INTO v_player;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_registration_account_failed'; END IF;

  SELECT * INTO v_save FROM public.player_saves
  WHERE player_id = p_player_id FOR UPDATE;
  IF FOUND THEN
    v_state := v_save.state || jsonb_build_object(
      'username', p_username,
      'walletAddress', 'game-' || p_player_id::text,
      'bossBattleActive', false,
      'hero', v_player.token_balance,
      'summons', v_player.summons
    );
    UPDATE public.player_saves
    SET state = v_state, revision = revision + 1, updated_at = v_now
    WHERE player_id = p_player_id
    RETURNING * INTO v_save;
  ELSE
    v_state := p_registered_state || jsonb_build_object(
      'username', p_username,
      'walletAddress', 'game-' || p_player_id::text,
      'bossBattleActive', false,
      'hero', v_player.token_balance,
      'summons', v_player.summons
    );
    INSERT INTO public.player_saves (player_id, state, imported_legacy)
    VALUES (p_player_id, v_state, false)
    RETURNING * INTO v_save;
  END IF;

  RETURN jsonb_build_object(
    'created', true,
    'username', p_username,
    'account_id', p_player_id,
    'state', v_save.state,
    'revision', v_save.revision
  );
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.game_state_load_context(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_save jsonb;
  v_items jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.player_saves WHERE player_id = p_player_id) THEN
    RETURN jsonb_build_object('state', NULL, 'revision', NULL, 'migrated_items', 0, 'items', '[]'::jsonb);
  END IF;
  v_save := public.migrate_legacy_player_items(p_player_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'base_item_id', item.base_item_id,
    'item_level', item.item_level,
    'stats', item.stats,
    'power', item.power,
    'locked', item.locked,
    'enchant_level', item.enchant_level,
    'reroll_count', item.reroll_count,
    'enchant_stats_version', item.enchant_stats_version
  ) ORDER BY item.created_at, item.id), '[]'::jsonb)
  INTO v_items
  FROM public.player_items item
  WHERE item.player_id = p_player_id AND item.removed_at IS NULL;
  RETURN v_save || jsonb_build_object('items', v_items);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.game_state_save_context(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'account', CASE WHEN player.player_id IS NULL THEN NULL ELSE jsonb_build_object(
      'username', player.username,
      'token_balance', player.token_balance,
      'summons', player.summons
    ) END,
    'state', save.state,
    'revision', save.revision,
    'training_purchases', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'idempotency_key', event.idempotency_key,
        'action_kind', event.action_kind,
        'created_at', event.created_at
      ) ORDER BY event.created_at)
      FROM public.token_spend_events event
      WHERE event.player_id = p_player_id AND event.action_kind LIKE 'training-%'
    ), '[]'::jsonb),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', item.id,
        'base_item_id', item.base_item_id,
        'item_level', item.item_level,
        'stats', item.stats,
        'power', item.power,
        'locked', item.locked,
        'enchant_level', item.enchant_level,
        'reroll_count', item.reroll_count,
        'enchant_stats_version', item.enchant_stats_version
      ) ORDER BY item.created_at, item.id)
      FROM public.player_items item
      WHERE item.player_id = p_player_id AND item.removed_at IS NULL
    ), '[]'::jsonb)
  )
  FROM (SELECT p_player_id AS requested_id) request
  LEFT JOIN public.players player ON player.player_id = request.requested_id
  LEFT JOIN public.player_saves save ON save.player_id = request.requested_id
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.game_state_save_commit(
  p_player_id uuid,
  p_expected_revision bigint,
  p_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_revision bigint;
  v_migrated jsonb;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 1
    OR jsonb_typeof(p_state) <> 'object'
    OR octet_length(p_state::text) > 1000000 THEN
    RAISE EXCEPTION 'api_invalid_save';
  END IF;
  UPDATE public.player_saves
  SET state = p_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE player_id = p_player_id AND revision = p_expected_revision
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('conflict', true) || COALESCE((
      SELECT jsonb_build_object('state', state, 'revision', revision)
      FROM public.player_saves WHERE player_id = p_player_id
    ), jsonb_build_object('state', NULL, 'revision', NULL));
  END IF;
  v_migrated := public.migrate_legacy_player_items(p_player_id);
  RETURN jsonb_build_object(
    'conflict', false,
    'revision', COALESCE((v_migrated->>'revision')::bigint, v_revision),
    'state', CASE WHEN COALESCE((v_migrated->>'migrated_items')::integer, 0) > 0 THEN v_migrated->'state' ELSE NULL END,
    'migrated_items', COALESCE((v_migrated->>'migrated_items')::integer, 0)
  );
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.account_register(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.game_state_load_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.game_state_save_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.game_state_save_commit(uuid, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.account_register(uuid, text, text, jsonb) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.game_state_load_context(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.game_state_save_context(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.game_state_save_commit(uuid, bigint, jsonb) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.account_register(uuid, text, text, jsonb) IS
  'Atomic v1 registration using only the verified JWT subject and server-normalized state.';
COMMENT ON FUNCTION heroloop_api.game_state_load_context(uuid) IS
  'Bounded v1 save plus canonical item-ledger load context for the verified JWT subject.';
COMMENT ON FUNCTION heroloop_api.game_state_save_context(uuid) IS
  'Read-only authoritative context required before a v1 optimistic save.';
COMMENT ON FUNCTION heroloop_api.game_state_save_commit(uuid, bigint, jsonb) IS
  'Compare-and-swap v1 save commit; concurrent server mutations fail closed.';
