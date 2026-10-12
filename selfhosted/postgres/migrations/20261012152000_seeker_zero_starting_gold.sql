-- Founder 2026-10-12: new Seeker accounts start with zero Gold.
-- Preserve existing saves, identities, balances, locking and function grants.
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
    OR p_registered_state->>'gold' <> '0'
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

