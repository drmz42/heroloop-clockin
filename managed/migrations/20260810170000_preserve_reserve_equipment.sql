CREATE OR REPLACE FUNCTION public.settle_item_equipment(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_assignments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.item_equipment_events%ROWTYPE;
  v_state jsonb;
  v_inventory jsonb;
  v_heroes jsonb := '[]'::jsonb;
  v_hero jsonb;
  v_equipped jsonb;
  v_pair record;
  v_assignment jsonb;
  v_item public.player_items%ROWTYPE;
  v_hero_index integer;
  v_hero_class text;
  v_item_class text;
  v_item_uid uuid;
  v_hero_uid text;
  v_slot text;
  v_team text[];
  v_ledger_ids text[];
  v_seen_items text[] := ARRAY[]::text[];
  v_seen_targets text[] := ARRAY[]::text[];
  v_inventory_ids text[];
  v_equipped_ids text[];
  v_bag_count integer;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_assignments) <> 'array' OR jsonb_array_length(p_assignments) > 64 THEN
    RAISE EXCEPTION 'invalid_equipment_assignments';
  END IF;

  SELECT * INTO v_existing FROM public.item_equipment_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.assignments <> p_assignments THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  PERFORM id FROM public.player_items
    WHERE player_id = p_player_id AND removed_at IS NULL
    ORDER BY id FOR UPDATE;

  SELECT COALESCE(array_agg(id::text ORDER BY id), ARRAY[]::text[])
    INTO v_ledger_ids
  FROM public.player_items
  WHERE player_id = p_player_id AND removed_at IS NULL;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  SELECT COALESCE(array_agg(value->>'uid'), ARRAY[]::text[])
    INTO v_inventory_ids
  FROM jsonb_array_elements(v_inventory);
  SELECT COALESCE(array_agg(value), ARRAY[]::text[])
    INTO v_team
  FROM jsonb_array_elements_text(COALESCE(v_state->'team', '[]'::jsonb));

  FOR v_hero IN SELECT value FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) LOOP
    IF NOT COALESCE(v_hero->>'uid', '') = ANY(v_team) THEN
      FOR v_pair IN SELECT key, value FROM jsonb_each(COALESCE(v_hero->'equipped', '{}'::jsonb)) LOOP
        IF COALESCE(v_pair.value#>>'{}', '') = ANY(v_ledger_ids) THEN
          IF COALESCE(v_pair.value#>>'{}', '') = ANY(v_seen_items) THEN
            RAISE EXCEPTION 'duplicate_equipment_assignment';
          END IF;
          v_seen_items := array_append(v_seen_items, v_pair.value#>>'{}');
        END IF;
      END LOOP;
      v_heroes := v_heroes || jsonb_build_array(v_hero);
      CONTINUE;
    END IF;

    v_equipped := '{}'::jsonb;
    FOR v_pair IN SELECT key, value FROM jsonb_each(COALESCE(v_hero->'equipped', '{}'::jsonb)) LOOP
      IF NOT COALESCE(v_pair.value#>>'{}', '') = ANY(v_ledger_ids) THEN
        v_equipped := v_equipped || jsonb_build_object(v_pair.key, v_pair.value);
      END IF;
    END LOOP;
    v_heroes := v_heroes || jsonb_build_array(jsonb_set(v_hero, '{equipped}', v_equipped, true));
  END LOOP;

  FOR v_assignment IN SELECT value FROM jsonb_array_elements(p_assignments) LOOP
    IF jsonb_typeof(v_assignment) <> 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_assignment) AS fields(key))
        <> ARRAY['hero_uid', 'item_uid', 'slot']::text[] THEN
      RAISE EXCEPTION 'invalid_equipment_assignment';
    END IF;
    v_hero_uid := COALESCE(v_assignment->>'hero_uid', '');
    v_slot := COALESCE(v_assignment->>'slot', '');
    BEGIN v_item_uid := (v_assignment->>'item_uid')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_equipment_assignment'; END;
    IF v_hero_uid = '' OR v_slot NOT IN ('class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet') THEN
      RAISE EXCEPTION 'invalid_equipment_assignment';
    END IF;
    IF v_item_uid::text = ANY(v_seen_items) OR (v_hero_uid || ':' || v_slot) = ANY(v_seen_targets) THEN
      RAISE EXCEPTION 'duplicate_equipment_assignment';
    END IF;
    v_seen_items := array_append(v_seen_items, v_item_uid::text);
    v_seen_targets := array_append(v_seen_targets, v_hero_uid || ':' || v_slot);
    IF NOT v_hero_uid = ANY(v_team) THEN RAISE EXCEPTION 'hero_not_active'; END IF;
    IF NOT v_item_uid::text = ANY(v_inventory_ids) THEN RAISE EXCEPTION 'item_state_mismatch'; END IF;

    SELECT * INTO v_item FROM public.player_items
      WHERE player_id = p_player_id AND id = v_item_uid AND removed_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
    IF v_item.item_level > GREATEST(1, COALESCE((v_state->>'accountLevel')::integer, 1)) THEN
      RAISE EXCEPTION 'item_level_required';
    END IF;
    IF v_item.slot <> v_slot THEN RAISE EXCEPTION 'item_slot_mismatch'; END IF;

    SELECT ordinality::integer, public.server_hero_class(value->>'heroId')
      INTO v_hero_index, v_hero_class
    FROM jsonb_array_elements(v_heroes) WITH ORDINALITY
    WHERE value->>'uid' = v_hero_uid;
    IF v_hero_index IS NULL OR v_hero_class IS NULL THEN RAISE EXCEPTION 'hero_not_found'; END IF;
    IF v_slot IN ('class_weapon', 'offhand') THEN
      v_item_class := CASE split_part(v_item.base_item_id, '-', 2)
        WHEN 'mage' THEN 'shepherd' WHEN 'warrior' THEN 'knight' WHEN 'crossbowman' THEN 'archer'
        WHEN 'assassin' THEN 'assassin' WHEN 'druid' THEN 'druid' ELSE NULL END;
      IF v_item_class IS NULL OR v_item_class <> v_hero_class THEN RAISE EXCEPTION 'item_class_mismatch'; END IF;
    END IF;

    v_hero := v_heroes->(v_hero_index - 1);
    v_equipped := COALESCE(v_hero->'equipped', '{}'::jsonb) || jsonb_build_object(v_slot, v_item_uid::text);
    v_heroes := jsonb_set(v_heroes, ARRAY[(v_hero_index - 1)::text, 'equipped'], v_equipped, true);
  END LOOP;

  SELECT COALESCE(array_agg(DISTINCT slots.value#>>'{}'), ARRAY[]::text[])
    INTO v_equipped_ids
  FROM jsonb_array_elements(v_heroes) hero,
    LATERAL jsonb_each(COALESCE(hero.value->'equipped', '{}'::jsonb)) slots;
  SELECT count(*) INTO v_bag_count
  FROM jsonb_array_elements(v_inventory) item
  WHERE NOT COALESCE(item.value->>'uid', '') = ANY(v_equipped_ids);
  IF v_bag_count > 64 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;

  v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  v_result := jsonb_build_object('assignments', p_assignments, 'owned_heroes', v_heroes, 'revision', v_revision);
  INSERT INTO public.item_equipment_events (idempotency_key, player_id, assignments, result)
    VALUES (p_idempotency_key, p_player_id, p_assignments, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_item_equipment(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_item_equipment(uuid, uuid, jsonb) TO service_role;
