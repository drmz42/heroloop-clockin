CREATE OR REPLACE FUNCTION public.normal_combat_auto_potions_valid(p_initial_units jsonb, p_outcome jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public
AS $$
DECLARE
  v_event jsonb;
  v_previous_ms integer := -1;
  v_restore integer;
  v_cost integer;
  v_total_cost bigint := 0;
BEGIN
  IF jsonb_typeof(p_outcome->'auto_potions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_outcome->'auto_potions') > 6000
    OR COALESCE(p_outcome->>'auto_pot_gold_cost', '') !~ '^[0-9]+$' THEN
    RETURN false;
  END IF;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_outcome->'auto_potions') LOOP
    IF jsonb_typeof(v_event) IS DISTINCT FROM 'object'
      OR v_event - ARRAY['elapsed_ms','hero_uid','tier','hp_restore','from_stock','gold_cost'] <> '{}'::jsonb
      OR COALESCE(v_event->>'elapsed_ms', '') !~ '^[0-9]+$'
      OR (v_event->>'elapsed_ms')::integer NOT BETWEEN 0 AND 120000
      OR (v_event->>'elapsed_ms')::integer < v_previous_ms
      OR COALESCE(v_event->>'hero_uid', '') = ''
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_initial_units) unit
        WHERE unit->>'side' = 'hero' AND unit->>'uid' = v_event->>'hero_uid')
      OR v_event->>'tier' NOT IN ('xs','sm','md','lg','xl','xxl')
      OR jsonb_typeof(v_event->'from_stock') IS DISTINCT FROM 'boolean'
      OR COALESCE(v_event->>'hp_restore', '') !~ '^[1-9][0-9]*$'
      OR COALESCE(v_event->>'gold_cost', '') !~ '^[0-9]+$' THEN
      RETURN false;
    END IF;
    v_restore := CASE v_event->>'tier' WHEN 'xs' THEN 50 WHEN 'sm' THEN 200 WHEN 'md' THEN 1000
      WHEN 'lg' THEN 4000 WHEN 'xl' THEN 15000 WHEN 'xxl' THEN 40000 END;
    v_cost := CASE v_event->>'tier' WHEN 'xs' THEN 15 WHEN 'sm' THEN 50 WHEN 'md' THEN 150
      WHEN 'lg' THEN 450 WHEN 'xl' THEN 1200 WHEN 'xxl' THEN 3000 END;
    IF (v_event->>'hp_restore')::integer > v_restore
      OR (v_event->>'gold_cost')::integer <> (CASE WHEN (v_event->>'from_stock')::boolean THEN 0 ELSE v_cost END) THEN
      RETURN false;
    END IF;
    v_previous_ms := (v_event->>'elapsed_ms')::integer;
    v_total_cost := v_total_cost + (v_event->>'gold_cost')::integer;
  END LOOP;
  RETURN v_total_cost = (p_outcome->>'auto_pot_gold_cost')::bigint;
END;
$$;

ALTER FUNCTION public.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb)
  RENAME TO normal_combat_store_outcome_without_auto_pot;

CREATE FUNCTION public.normal_combat_store_outcome(
  p_player_id uuid, p_start_key uuid, p_initial_units jsonb, p_reward_bonuses jsonb, p_outcome jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.normal_combat_auto_potions_valid(p_initial_units, p_outcome) THEN
    RAISE EXCEPTION 'normal_combat_invalid_outcome';
  END IF;
  RETURN public.normal_combat_store_outcome_without_auto_pot(
    p_player_id, p_start_key, p_initial_units, p_reward_bonuses, p_outcome
  );
END;
$$;

ALTER FUNCTION public.normal_combat_complete(uuid, uuid, uuid)
  RENAME TO normal_combat_complete_without_auto_pot;

CREATE FUNCTION public.normal_combat_complete(
  p_player_id uuid, p_start_key uuid, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_event public.normal_combat_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_potion jsonb;
  v_entries jsonb := '[]'::jsonb;
  v_resource jsonb;
  v_gold_cost bigint;
  v_revision bigint;
BEGIN
  v_result := public.normal_combat_complete_without_auto_pot(p_player_id, p_start_key, p_idempotency_key);
  IF COALESCE((v_result->>'replayed')::boolean, false) THEN RETURN v_result; END IF;
  SELECT * INTO STRICT v_event FROM public.normal_combat_events WHERE start_key = p_start_key FOR UPDATE;
  v_gold_cost := COALESCE((v_event.outcome->>'auto_pot_gold_cost')::bigint, 0);
  IF jsonb_array_length(v_event.outcome->'auto_potions') = 0 THEN
    v_result := v_result || jsonb_build_object('auto_pot', jsonb_build_object(
      'events', '[]'::jsonb, 'gold_spent', 0
    ));
  ELSE
    SELECT * INTO STRICT v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
    IF COALESCE((v_save.state->>'gold')::bigint, 0) < v_gold_cost THEN RAISE EXCEPTION 'normal_combat_auto_pot_gold_changed'; END IF;
    FOR v_potion IN
      SELECT jsonb_build_object(
        'tier', tier,
        'bought', count(*) FILTER (WHERE NOT (event->>'from_stock')::boolean),
        'used', count(*)
      )
      FROM unnest(ARRAY['xs','sm','md','lg','xl','xxl']) tier
      JOIN jsonb_array_elements(v_event.outcome->'auto_potions') event ON event->>'tier' = tier
      GROUP BY tier
    LOOP
      IF (v_potion->>'bought')::bigint > 0 THEN
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
          'resource_id', 'potion_' || (v_potion->>'tier'), 'delta', v_potion->>'bought', 'source_key', 'potion_purchase'
        ));
      END IF;
      v_entries := v_entries || jsonb_build_array(jsonb_build_object(
        'resource_id', 'potion_' || (v_potion->>'tier'), 'delta', '-' || (v_potion->>'used'), 'source_key', 'potion_use'
      ));
    END LOOP;
    v_resource := public.apply_resource_entries(
      p_player_id, p_start_key, 'normal_combat_auto_pot',
      encode(extensions.digest((v_event.outcome->'auto_potions')::text, 'sha256'), 'hex'),
      v_entries, v_save.revision + 1
    );
    v_save.state := jsonb_set(v_save.state, '{gold}', to_jsonb((v_save.state->>'gold')::bigint - v_gold_cost));
    v_save.state := jsonb_set(v_save.state, '{potions,xs}', to_jsonb((v_resource#>>'{balances,potion_xs}')::bigint));
    v_save.state := jsonb_set(v_save.state, '{potions,sm}', to_jsonb((v_resource#>>'{balances,potion_sm}')::bigint));
    v_save.state := jsonb_set(v_save.state, '{potions,md}', to_jsonb((v_resource#>>'{balances,potion_md}')::bigint));
    v_save.state := jsonb_set(v_save.state, '{potions,lg}', to_jsonb((v_resource#>>'{balances,potion_lg}')::bigint));
    v_save.state := jsonb_set(v_save.state, '{potions,xl}', to_jsonb((v_resource#>>'{balances,potion_xl}')::bigint));
    v_save.state := jsonb_set(v_save.state, '{potions,xxl}', to_jsonb((v_resource#>>'{balances,potion_xxl}')::bigint));
    UPDATE public.player_saves SET state = v_save.state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
    v_result := v_result || jsonb_build_object(
      'revision', v_revision, 'state', v_save.state,
      'auto_pot', jsonb_build_object('events', v_event.outcome->'auto_potions', 'gold_spent', v_gold_cost, 'resources', v_resource)
    );
  END IF;
  UPDATE public.normal_combat_events SET result = v_result WHERE start_key = p_start_key;
  UPDATE public.normal_combat_completion_events SET result = v_result WHERE idempotency_key = p_idempotency_key;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.normal_combat_auto_potions_valid(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_store_outcome_without_auto_pot(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.normal_combat_complete_without_auto_pot(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_complete(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.normal_combat_complete(uuid, uuid, uuid) TO service_role;
