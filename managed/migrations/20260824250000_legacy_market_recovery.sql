CREATE OR REPLACE FUNCTION public.migrate_legacy_market_listings(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_state jsonb;
  v_revision bigint;
  v_listings jsonb;
  v_heroes jsonb;
  v_items jsonb;
  v_compatibility jsonb;
  v_marker boolean;
  v_entity jsonb;
  v_listing jsonb;
  v_asset jsonb;
  v_uid text;
  v_seen text[] := ARRAY[]::text[];
  v_recovered_heroes jsonb := '[]'::jsonb;
  v_recovered_items jsonb := '[]'::jsonb;
  v_hero_count integer := 0;
  v_item_count integer := 0;
BEGIN
  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing', 'blocked', true, 'code', 'legacy_market_state_missing');
  END IF;
  IF jsonb_typeof(v_state) <> 'object'
    OR jsonb_typeof(v_state->'ownedHeroes') <> 'array'
    OR jsonb_typeof(v_state->'inventory') <> 'array'
    OR (v_state ? 'marketListings' AND jsonb_typeof(v_state->'marketListings') <> 'array')
    OR (v_state ? 'compatibilityMigrations' AND jsonb_typeof(v_state->'compatibilityMigrations') <> 'object') THEN
    RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_invalid_state');
  END IF;

  v_listings := COALESCE(v_state->'marketListings', '[]'::jsonb);
  v_heroes := v_state->'ownedHeroes';
  v_items := v_state->'inventory';
  v_compatibility := COALESCE(v_state->'compatibilityMigrations', '{}'::jsonb);
  v_marker := v_compatibility->>'legacyMarketRecoveryV1' = 'true';
  IF v_marker THEN
    IF jsonb_array_length(v_listings) <> 0 THEN
      RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_marker_conflict');
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'blocked', false, 'replayed', true,
      'recovered_heroes', 0, 'recovered_items', 0, 'revision', v_revision);
  END IF;

  FOR v_entity IN
    SELECT value FROM jsonb_array_elements(v_heroes)
    UNION ALL
    SELECT value FROM jsonb_array_elements(v_items)
  LOOP
    v_uid := CASE WHEN jsonb_typeof(v_entity) = 'object' THEN v_entity->>'uid' ELSE NULL END;
    IF v_uid IS NULL OR v_uid = '' THEN
      RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_invalid_uid');
    END IF;
    IF v_uid = ANY(v_seen) THEN
      RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_duplicate_uid');
    END IF;
    v_seen := array_append(v_seen, v_uid);
  END LOOP;

  FOR v_listing IN SELECT value FROM jsonb_array_elements(v_listings)
  LOOP
    IF jsonb_typeof(v_listing) <> 'object'
      OR (v_listing ? 'hero') = (v_listing ? 'item')
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_listing) AS entry_key(key_name) WHERE key_name NOT IN ('id','kind','price','createdAt','hero','item')) THEN
      RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_invalid_asset');
    END IF;
    v_asset := CASE WHEN v_listing ? 'hero' THEN v_listing->'hero' ELSE v_listing->'item' END;
    v_uid := CASE WHEN jsonb_typeof(v_asset) = 'object' THEN v_asset->>'uid' ELSE NULL END;
    IF v_uid IS NULL OR v_uid = '' THEN
      RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_invalid_uid');
    END IF;
    IF v_uid = ANY(v_seen) THEN
      RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_duplicate_uid');
    END IF;
    v_seen := array_append(v_seen, v_uid);
    IF v_listing ? 'hero' THEN
      v_recovered_heroes := v_recovered_heroes || jsonb_build_array(v_asset);
      v_hero_count := v_hero_count + 1;
    ELSE
      v_recovered_items := v_recovered_items || jsonb_build_array(v_asset);
      v_item_count := v_item_count + 1;
    END IF;
  END LOOP;

  v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes || v_recovered_heroes, true);
  v_state := jsonb_set(v_state, '{inventory}', v_items || v_recovered_items, true);
  v_state := jsonb_set(v_state, '{marketListings}', '[]'::jsonb, true);
  v_state := jsonb_set(v_state, '{compatibilityMigrations}',
    v_compatibility || '{"legacyMarketRecoveryV1":true}'::jsonb, true);
  v_state := jsonb_set(v_state, '{save_schema_version}', '2'::jsonb, true);
  IF octet_length(v_state::text) > 1000000 THEN
    RETURN jsonb_build_object('status', 'blocked', 'blocked', true, 'code', 'legacy_market_state_too_large');
  END IF;

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE player_id = p_player_id
  RETURNING revision INTO v_revision;
  RETURN jsonb_build_object('status', 'migrated', 'blocked', false, 'replayed', false,
    'recovered_heroes', v_hero_count, 'recovered_items', v_item_count, 'revision', v_revision);
END
$function$;

REVOKE ALL ON FUNCTION public.migrate_legacy_market_listings(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_legacy_market_listings(uuid) TO service_role;
COMMENT ON FUNCTION public.migrate_legacy_market_listings(uuid) IS
  'Fail-closed once-only compatibility recovery for legacy client Market escrow; service role only.';
