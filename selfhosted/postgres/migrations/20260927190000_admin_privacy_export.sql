\set ON_ERROR_STOP on

-- One linked, open export request; explicit columns only. No table grants,
-- raw Auth/save dump, write to gameplay, durable export file or bearer link.
CREATE OR REPLACE FUNCTION admin.privacy_export(p_actor uuid, p_request_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
SET statement_timeout = '5s'
AS $function$
DECLARE
  r admin.privacy_requests%ROWTYPE;
  v_profile jsonb;
  v_save jsonb;
  v_game jsonb;
  v_ledger jsonb;
  v_attribution jsonb;
  v_result jsonb;
BEGIN
  PERFORM admin.privacy_request_founder(p_actor);
  SELECT * INTO r FROM admin.privacy_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_request' USING ERRCODE = '22023'; END IF;
  IF r.kind <> 'export' THEN RAISE EXCEPTION 'export_request_required' USING ERRCODE = '22023'; END IF;
  IF r.player_id IS NULL THEN RAISE EXCEPTION 'export_player_required' USING ERRCODE = '22023'; END IF;
  IF admin.privacy_request_status(r.id) IN ('done', 'refused') THEN RAISE EXCEPTION 'request_closed' USING ERRCODE = '22023'; END IF;
  SELECT jsonb_build_object(
    'player_id', p.player_id, 'username', p.username, 'email', u.email,
    'registered_at', u.created_at, 'account_level', p.account_level,
    'power', p.power, 'combat_power', p.combat_power,
    'highest_location', p.highest_location, 'total_kills', p.total_kills,
    'boss_kills', p.boss_kills, 'summons', p.summons,
    'token_balance', p.token_balance, 'pending_tokens', p.pending_tokens,
    'total_claimed', p.total_claimed, 'last_heartbeat', p.last_heartbeat
  ) INTO v_profile FROM public.players p JOIN auth.users u ON u.id = p.player_id
  WHERE p.player_id = r.player_id;
  IF v_profile IS NULL THEN RAISE EXCEPTION 'unknown_player' USING ERRCODE = '22023'; END IF;

  IF EXISTS (SELECT 1 FROM public.player_saves WHERE player_id = r.player_id AND octet_length(state::text) > 2097152) THEN
    RAISE EXCEPTION 'export_too_large' USING ERRCODE = '22023';
  END IF;
  SELECT state INTO v_save FROM public.player_saves WHERE player_id = r.player_id;
  -- Scalar fields only; never forward an arbitrary object from a save.
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_game
  FROM jsonb_each(coalesce(v_save, '{}'::jsonb)) WHERE key = ANY(ARRAY[
    'gold','hero','accountXp','accountLevel','heroCapacity','bossKeys','currentLocation',
    'highestLocation','totalGoldEarned','totalTokensEarned','totalKills','totalBossKills',
    'summons','summonScrolls','battleAnimationMode','avatarHeroId'
  ]) AND jsonb_typeof(value) IN ('number','boolean','string','null');
  v_game := v_game || jsonb_build_object(
    'heroes', (SELECT coalesce(jsonb_agg((SELECT coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
      FROM jsonb_each(h) WHERE key = ANY(ARRAY['uid','heroId','level','stars','xp','locked'])
      AND jsonb_typeof(value) IN ('number','boolean','string','null')) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_save->'ownedHeroes')='array' THEN v_save->'ownedHeroes' ELSE '[]'::jsonb END) WITH ORDINALITY a(h,ord)
      WHERE jsonb_typeof(h)='object'),
    'items', (SELECT coalesce(jsonb_agg((SELECT coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
      FROM jsonb_each(item) WHERE key = ANY(ARRAY['uid','itemId','level','power','locked','enchantLevel','rerollCount'])
      AND jsonb_typeof(value) IN ('number','boolean','string','null')) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_save->'inventory')='array' THEN v_save->'inventory' ELSE '[]'::jsonb END) WITH ORDINALITY a(item,ord)
      WHERE jsonb_typeof(item)='object'),
    'save_present', v_save IS NOT NULL
  );
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'flow', flow, 'source_kind', source_kind,
    'amount', amount, 'occurred_at', occurred_at, 'balance_version', economy_balance_version) ORDER BY id), '[]'::jsonb)
  INTO v_ledger FROM (SELECT id, flow, source_kind, amount, occurred_at, economy_balance_version
    FROM public.hero_economy_ledger WHERE player_id = r.player_id ORDER BY id LIMIT 10001) q;
  IF jsonb_array_length(v_ledger) > 10000 THEN RAISE EXCEPTION 'export_too_large' USING ERRCODE = '22023'; END IF;
  SELECT jsonb_build_object('source', source, 'medium', medium, 'campaign', campaign,
    'ref', ref, 'promo', promo, 'recorded_at', recorded_at) INTO v_attribution
    FROM telemetry.signup_attribution WHERE player_id = r.player_id;
  v_result := jsonb_build_object('schema', 'player-privacy-export.v1', 'scope', 'staging',
    'request_id', r.id, 'profile', v_profile, 'game', v_game, 'hero_ledger', v_ledger,
    'signup_attribution', v_attribution,
    'coverage', jsonb_build_object('included', jsonb_build_array('account profile', 'selected progression fields', 'hero and item summaries', 'retained HERO ledger entries', 'signup link labels'),
      'excluded', jsonb_build_array('credentials and sessions', 'raw saves and technical logs', 'internal support and security notes', 'other players data', 'expired records and backups'),
      'notice', 'Selected account data, not a complete archive. Review any additional requested categories separately before closing the request.'));
  IF octet_length(v_result::text) > 4194304 THEN RAISE EXCEPTION 'export_too_large' USING ERRCODE = '22023'; END IF;
  RETURN v_result;
END
$function$;
REVOKE ALL ON FUNCTION admin.privacy_export(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.privacy_export(uuid, bigint) TO heroloop_admin;
COMMENT ON FUNCTION admin.privacy_export(uuid, bigint) IS 'Bounded allowlisted Staging JSON for one open export request. Founder only; no stored file and no direct game table grants.';
