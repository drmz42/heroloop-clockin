BEGIN;
-- Policy belongs to an immutable wave. Changing edition cannot reprice a pending wave.
CREATE OR REPLACE FUNCTION public.normal_combat_balance_version_gate()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_requested text := nullif(current_setting('heroloop.normal_combat_balance_version', true), '');
BEGIN
  v_requested := coalesce(v_requested, 'balance-v6-2026.09.29-v1-combat-effects-v1');
  IF v_requested NOT IN ('balance-v6-2026.09.29-v1-combat-effects-v1',
    'balance-v4-2026.09.01-v6-combat-effects-v1',
    'balance-v4-2026.09.06-v7-combat-effects-v2-candidate',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v1',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v2',
    'balance-v6-2026.09.29-v1-combat-effects-v2',
    'balance-v6-2026.09.29-v1-combat-effects-v2-auto-healing-v1') THEN
    RAISE EXCEPTION 'normal_combat_balance_version_invalid';
  END IF;
  NEW.balance_version := v_requested;
  RETURN NEW;
END;
$$;
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
  IF p_outcome ? 'healing_policy' AND p_outcome->'healing_policy' IS DISTINCT FROM to_jsonb('automatic-healing-v1'::text) THEN RETURN false; END IF;
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
    IF p_outcome->>'healing_policy' = 'automatic-healing-v1' THEN
      v_cost := CASE v_event->>'tier' WHEN 'xs' THEN 1 WHEN 'sm' THEN 1 WHEN 'md' THEN 1 WHEN 'lg' THEN 2 WHEN 'xl' THEN 4 WHEN 'xxl' THEN 10 END;
    END IF;
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

DO $migration$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  v_definition := pg_get_functiondef('telemetry.stamp_economy_settlement()'::regprocedure);
  v_old := '''balance-v6-2026.09.29-v1-combat-effects-v2''';
  v_new := v_old || ', ''balance-v6-2026.09.29-v1-combat-effects-v2-auto-healing-v1''';
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 THEN
    RAISE EXCEPTION 'automatic_healing_telemetry_guard_mismatch'; END IF;
  EXECUTE replace(v_definition,v_old,v_new);

  v_definition := pg_get_functiondef('public.normal_combat_store_outcome(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  v_old := 'IF NOT public.normal_combat_auto_potions_valid(p_initial_units, p_outcome) THEN';
  v_new := $patch$IF EXISTS (SELECT 1 FROM public.normal_combat_events WHERE start_key=p_start_key AND player_id=p_player_id
    AND ((balance_version='balance-v6-2026.09.29-v1-combat-effects-v2-auto-healing-v1')
      <> COALESCE(p_outcome->>'healing_policy'='automatic-healing-v1',false))) THEN
    RAISE EXCEPTION 'normal_combat_invalid_outcome';
  END IF;
  IF NOT public.normal_combat_auto_potions_valid(p_initial_units, p_outcome) THEN$patch$;
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 THEN
    RAISE EXCEPTION 'automatic_healing_outcome_guard_mismatch'; END IF;
  EXECUTE replace(v_definition,v_old,v_new);

  v_definition := pg_get_functiondef('public.normal_combat_complete_without_auto_pot(uuid,uuid,uuid)'::regprocedure);
  v_old := 'v_gold_per_lane := round((CASE WHEN v_event.location > 10 THEN (ARRAY[16,17,18,19,20,21,22,23,24,25]::integer[])[v_event.location-10] ELSE 5 + v_event.location END) *';
  v_new := v_old || ' (CASE WHEN v_event.balance_version=''balance-v6-2026.09.29-v1-combat-effects-v2-auto-healing-v1'' THEN 2 ELSE 1 END) *';
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 THEN
    RAISE EXCEPTION 'automatic_healing_reward_guard_mismatch'; END IF;
  EXECUTE replace(v_definition,v_old,v_new);
END;
$migration$;
REVOKE ALL ON FUNCTION public.normal_combat_balance_version_gate() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_auto_potions_valid(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
COMMIT;
