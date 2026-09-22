-- Balance v4 Enchant activation for VPS1 Staging.
-- Config: enchant-v4-2026.08.27-v2
-- SHA-256: 4c18f4186df22256327f9377c373335cf63a83517fc38a3d20e393ff9abfc359
-- Gold config SHA-256: 889b5048505e913d6bddad218db8425ddcb24196ceedc7e7e8423b6447832495

CREATE OR REPLACE FUNCTION public.enchant_v4_multiplier(p_enchant integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT 1
    + LEAST(5, GREATEST(0, p_enchant)) * .10
    + GREATEST(0, LEAST(10, p_enchant) - 5) * .15
    + GREATEST(0, LEAST(15, p_enchant) - 10) * .20
    + GREATEST(0, LEAST(20, p_enchant) - 15) * .25
$$;

CREATE OR REPLACE FUNCTION public.calculate_item_power_v4(p_stats jsonb, p_enchant integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT round(COALESCE(sum(
    (stat->>'value')::numeric * CASE stat->>'key'
      WHEN 'atk' THEN 4 WHEN 'critChance' THEN 200 WHEN 'critDamage' THEN 100 WHEN 'atkSpeed' THEN .5
      WHEN 'hp' THEN .15 WHEN 'def' THEN 2 WHEN 'goldBonus' THEN 150 WHEN 'xpBonus' THEN 100 WHEN 'dodge' THEN 150 ELSE 1 END
    * public.enchant_v4_multiplier(LEAST(20, GREATEST(0, p_enchant)))
  ), 0))::bigint
  FROM jsonb_array_elements(p_stats) stat
$$;

-- Existing item identity, rolls, ownership and listings remain unchanged. Only the
-- derived version/Power and matching save snapshot are migrated, with no charge or risk.
UPDATE public.player_items
SET power = public.calculate_item_power_v4(stats, enchant_level),
    enchant_stats_version = 4
WHERE removed_at IS NULL;

UPDATE public.player_saves save
SET state = jsonb_set(save.state, '{inventory}', COALESCE((
      SELECT jsonb_agg(
        CASE WHEN item.id IS NULL THEN entry.value ELSE entry.value || jsonb_build_object(
          'power', item.power,
          'enchantLevel', item.enchant_level,
          'enchantStatsVersion', 4,
          'serverOwned', true
        ) END
        ORDER BY entry.ordinality
      )
      FROM jsonb_array_elements(COALESCE(save.state->'inventory', '[]'::jsonb))
        WITH ORDINALITY entry(value, ordinality)
      LEFT JOIN public.player_items item
        ON item.id::text = entry.value->>'uid'
       AND item.player_id = save.player_id
       AND item.removed_at IS NULL
    ), '[]'::jsonb), true),
    revision = save.revision + 1,
    updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM public.player_items item
  WHERE item.player_id = save.player_id AND item.removed_at IS NULL
);

ALTER FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  RENAME TO settle_item_upgrade_v3;

REVOKE ALL ON FUNCTION public.settle_item_upgrade_v3(uuid, uuid, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.settle_item_upgrade(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_action_kind text,
  p_item_id uuid,
  p_use_charm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.item_upgrade_events%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_state jsonb;
  v_inventory jsonb;
  v_owned jsonb;
  v_item_json jsonb;
  v_next_inventory jsonb;
  v_next_owned jsonb;
  v_revision bigint;
  v_gold bigint;
  v_token_balance numeric;
  v_token_spent numeric;
  v_gold_cost bigint := 0;
  v_token_cost bigint := 0;
  v_chance numeric := 1;
  v_success boolean := true;
  v_destroyed boolean := false;
  v_target integer;
  v_catalogue_usd_micros bigint := 0;
  v_hero_usd_quote_micros integer := 1000;
  v_reroll_base_usd_micros bigint;
  v_stats jsonb;
  v_new_reroll integer;
  v_new_enchant integer;
  v_new_power bigint;
  v_result jsonb;
BEGIN
  IF p_action_kind NOT IN ('enchant', 'reroll') OR (p_action_kind = 'reroll' AND p_use_charm) THEN
    RAISE EXCEPTION 'invalid_item_upgrade';
  END IF;

  SELECT * INTO v_existing
  FROM public.item_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action_kind <> p_action_kind
      OR v_existing.item_id <> p_item_id OR v_existing.use_charm <> p_use_charm THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  SELECT token_balance, boost_tokens_spent INTO v_token_balance, v_token_spent
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;

  SELECT * INTO v_existing
  FROM public.item_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action_kind <> p_action_kind
      OR v_existing.item_id <> p_item_id OR v_existing.use_charm <> p_use_charm THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_item
  FROM public.player_items
  WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  IF p_action_kind = 'enchant' AND (v_item.enchant_level < 0 OR v_item.enchant_level >= 20) THEN
    RAISE EXCEPTION 'maximum_enchant';
  END IF;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  SELECT entry.value INTO v_item_json
  FROM jsonb_array_elements(v_inventory) entry(value)
  WHERE entry.value->>'uid' = p_item_id::text
  LIMIT 1;
  IF v_item_json IS NULL THEN RAISE EXCEPTION 'item_state_mismatch'; END IF;

  v_item_json := v_item_json || jsonb_build_object(
    'uid', v_item.id,
    'itemId', v_item.base_item_id,
    'level', v_item.item_level,
    'stats', v_item.stats,
    'power', v_item.power,
    'locked', v_item.locked,
    'enchantLevel', v_item.enchant_level,
    'rerollCount', v_item.reroll_count,
    'enchantStatsVersion', 4,
    'serverOwned', true
  );

  v_gold := GREATEST(0, floor(COALESCE((v_state->>'gold')::numeric, 0)))::bigint;
  v_target := v_item.enchant_level + 1;

  IF p_action_kind = 'reroll' THEN
    v_reroll_base_usd_micros := CASE v_item.rarity
      WHEN 'common' THEN 5000 WHEN 'uncommon' THEN 10000 WHEN 'rare' THEN 20000
      WHEN 'epic' THEN 40000 WHEN 'legendary' THEN 80000 WHEN 'mythic' THEN 150000
      WHEN 'relic' THEN 150000 WHEN 'cosmic' THEN 300000 WHEN 'divine' THEN 600000
      WHEN 'celestial' THEN 1000000 WHEN 'cursed' THEN 1500000
      WHEN 'immortal' THEN 2500000 WHEN 'god' THEN 4000000 ELSE NULL END;
    IF v_reroll_base_usd_micros IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
    v_catalogue_usd_micros := v_reroll_base_usd_micros
      * LEAST(5, GREATEST(1, v_item.reroll_count + 1));
    v_token_cost := ceil(v_catalogue_usd_micros::numeric / v_hero_usd_quote_micros)::bigint;
  ELSE
    v_gold_cost := CASE v_item.rarity
      WHEN 'common' THEN (ARRAY[100,300,800,2000,4000,7000,11000,17000,25000,36000,50000,68000,90000,115000,150000,190000,240000,295000,360000,435000]::bigint[])[v_target]
      WHEN 'uncommon' THEN (ARRAY[150,450,1200,3100,6200,11000,17500,27500,40500,59000,82500,115000,150000,200000,255000,330000,415000,520000,640000,785000]::bigint[])[v_target]
      WHEN 'rare' THEN (ARRAY[200,650,1800,4600,9300,16500,26000,41000,61000,89000,125000,170000,230000,305000,395000,505000,640000,805000,995000,1200000]::bigint[])[v_target]
      WHEN 'epic' THEN (ARRAY[300,1000,2600,6700,13500,24500,39000,61000,91500,135000,190000,260000,350000,465000,605000,780000,995000,1300000,1600000,1900000]::bigint[])[v_target]
      WHEN 'legendary' THEN (ARRAY[500,1500,4200,10500,22000,39000,62500,98500,150000,220000,310000,430000,580000,770000,1000000,1300000,1700000,2100000,2600000,3300000]::bigint[])[v_target]
      WHEN 'mythic' THEN (ARRAY[800,2500,6700,17500,35500,63500,105000,165000,245000,360000,515000,720000,980000,1300000,1700000,2200000,2900000,3600000,4600000,5700000]::bigint[])[v_target]
      WHEN 'relic' THEN (ARRAY[800,2500,6700,17500,35500,63500,105000,165000,245000,360000,515000,720000,980000,1300000,1700000,2200000,2900000,3600000,4600000,5700000]::bigint[])[v_target]
      WHEN 'cosmic' THEN (ARRAY[1300,4000,11000,28500,58000,105000,170000,270000,405000,600000,855000,1200000,1600000,2200000,2900000,3700000,4800000,6100000,7700000,9600000]::bigint[])[v_target]
      WHEN 'divine' THEN (ARRAY[2000,6200,17000,44500,92500,170000,275000,440000,670000,1000000,1400000,2000000,2800000,3800000,5000000,6600000,8500000,11000000,13900000,17400000]::bigint[])[v_target]
      WHEN 'celestial' THEN (ARRAY[3000,9400,26000,68000,140000,255000,420000,680000,1000000,1600000,2300000,3200000,4400000,6000000,8000000,10500000,13700000,17700000,22500000,28300000]::bigint[])[v_target]
      WHEN 'cursed' THEN (ARRAY[4500,14000,39000,100000,215000,390000,635000,1000000,1600000,2400000,3400000,4900000,6700000,9100000,12200000,16100000,21000000,27100000,34500000,43500000]::bigint[])[v_target]
      WHEN 'immortal' THEN (ARRAY[7000,22000,61000,160000,335000,610000,1000000,1600000,2500000,3700000,5400000,7700000,10600000,14400000,19300000,25500000,33400000,43300000,55100000,69600000]::bigint[])[v_target]
      WHEN 'god' THEN (ARRAY[11000,34500,96000,250000,525000,955000,1600000,2500000,3900000,5800000,8500000,12000000,16600000,22600000,30200000,40000000,52300000,67600000,86200000,110000000]::bigint[])[v_target]
      ELSE NULL END;
    IF v_gold_cost IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;

    IF v_target <= 6 THEN
      IF p_use_charm THEN RAISE EXCEPTION 'charm_unavailable'; END IF;
      v_chance := 1;
    ELSE
      v_chance := (ARRAY[.85,.79,.73,.67,.61,.55,.49,.43,.37,.31,.25,.19,.13,.10]::numeric[])[v_target - 6];
      IF p_use_charm THEN
        v_catalogue_usd_micros := (ARRAY[100000,200000,400000,800000,1600000,3000000,6000000,12000000,30000000,80000000,200000000,450000000,700000000,1000000000]::bigint[])[v_target - 6];
        v_token_cost := ceil(v_catalogue_usd_micros::numeric / v_hero_usd_quote_micros)::bigint;
      END IF;
    END IF;
  END IF;

  IF v_gold < v_gold_cost THEN RAISE EXCEPTION 'insufficient_gold'; END IF;
  IF v_token_balance < v_token_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  v_success := p_action_kind = 'reroll' OR p_use_charm OR random() < v_chance;
  v_gold := v_gold - v_gold_cost;

  IF p_action_kind = 'reroll' THEN
    v_stats := public.roll_item_stats_v3(v_item.slot, v_item.rarity, v_item.item_level, v_item.base_item_id);
    v_new_reroll := v_item.reroll_count + 1;
    v_new_power := public.calculate_item_power_v4(v_stats, v_item.enchant_level);
    UPDATE public.player_items
    SET stats = v_stats,
        power = v_new_power,
        reroll_count = v_new_reroll,
        enchant_stats_version = 4
    WHERE id = p_item_id;
    v_item_json := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_item_json,
      '{stats}', v_stats, true), '{power}', to_jsonb(v_new_power), true),
      '{rerollCount}', to_jsonb(v_new_reroll), true), '{enchantStatsVersion}', '4'::jsonb, true);
  ELSIF v_success THEN
    v_new_enchant := v_target;
    v_new_power := public.calculate_item_power_v4(v_item.stats, v_new_enchant);
    UPDATE public.player_items
    SET enchant_level = v_new_enchant,
        power = v_new_power,
        enchant_stats_version = 4
    WHERE id = p_item_id;
    v_item_json := jsonb_set(jsonb_set(jsonb_set(v_item_json,
      '{enchantLevel}', to_jsonb(v_new_enchant), true),
      '{enchantStatsVersion}', '4'::jsonb, true), '{power}', to_jsonb(v_new_power), true);
  ELSE
    v_destroyed := true;
    UPDATE public.player_items
    SET removed_at = now()
    WHERE id = p_item_id;

    IF v_item.rarity IN ('divine','celestial','cursed','immortal','god') THEN
      UPDATE public.rarity_supply
      SET existing_count = GREATEST(0, existing_count - 1), updated_at = now()
      WHERE rarity = v_item.rarity;
    END IF;
  END IF;

  IF v_destroyed THEN
    SELECT COALESCE(jsonb_agg(entry.value ORDER BY entry.ordinality), '[]'::jsonb)
    INTO v_inventory
    FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(value, ordinality)
    WHERE entry.value->>'uid' <> p_item_id::text;

    SELECT COALESCE(jsonb_agg(jsonb_set(hero.value, '{equipped}', COALESCE((
      SELECT jsonb_object_agg(pair.key, pair.value)
      FROM jsonb_each(COALESCE(hero.value->'equipped', '{}'::jsonb)) pair
      WHERE pair.value #>> '{}' <> p_item_id::text
    ), '{}'::jsonb), true) ORDER BY hero.ordinality), '[]'::jsonb)
    INTO v_next_owned
    FROM jsonb_array_elements(v_owned) WITH ORDINALITY hero(value, ordinality);
    v_owned := v_next_owned;
    v_item_json := NULL;
  ELSE
    SELECT jsonb_agg(CASE WHEN entry.value->>'uid' = p_item_id::text THEN v_item_json ELSE entry.value END ORDER BY entry.ordinality)
    INTO v_next_inventory
    FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(value, ordinality);
    v_inventory := COALESCE(v_next_inventory, '[]'::jsonb);
  END IF;

  IF v_token_cost > 0 THEN
    v_token_balance := v_token_balance - v_token_cost;
    v_token_spent := v_token_spent + v_token_cost;
    UPDATE public.players
    SET token_balance = v_token_balance,
        boost_tokens_spent = v_token_spent,
        updated_at = now()
    WHERE player_id = p_player_id;
    INSERT INTO public.token_spend_events(idempotency_key, player_id, amount, action_kind)
    VALUES (p_idempotency_key, p_player_id, v_token_cost,
      CASE WHEN p_action_kind = 'reroll' THEN 'item-reroll' ELSE 'item-enchant' END);
  END IF;

  v_state := jsonb_set(jsonb_set(jsonb_set(v_state, '{inventory}', v_inventory, true),
    '{ownedHeroes}', v_owned, true), '{gold}', to_jsonb(v_gold), true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_token_balance), true);
  v_revision := v_revision + 1;
  UPDATE public.player_saves
  SET state = v_state, revision = v_revision, updated_at = now()
  WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'action', p_action_kind,
    'item_id', p_item_id,
    'success', v_success,
    'destroyed', v_destroyed,
    'guaranteed', p_use_charm,
    'success_chance', v_chance,
    'item', v_item_json,
    'inventory', v_inventory,
    'owned_heroes', v_owned,
    'gold', v_gold,
    'token_balance', v_token_balance,
    'gold_cost', v_gold_cost,
    'token_cost', v_token_cost,
    'catalogue_usd_micros', v_catalogue_usd_micros,
    'hero_usd_quote_micros', v_hero_usd_quote_micros,
    'balance_version', 'balance-v4',
    'enchant_config_sha256', '4c18f4186df22256327f9377c373335cf63a83517fc38a3d20e393ff9abfc359',
    'gold_config_sha256', '889b5048505e913d6bddad218db8425ddcb24196ceedc7e7e8423b6447832495',
    'revision', v_revision
  );

  INSERT INTO public.item_upgrade_events(idempotency_key, player_id, action_kind, item_id, use_charm, result)
  VALUES (p_idempotency_key, p_player_id, p_action_kind, p_item_id, p_use_charm, v_result);
  RETURN v_result;
END;
$$;

ALTER TABLE public.normal_combat_events
  ALTER COLUMN balance_version SET DEFAULT 'balance-v4-2026.08.28-v5@sha256:1582812293bdea86b040e700b30175dca52d0d3258ca8bafdf01ede082e81b53';

ALTER TABLE public.boss_encounters
  ALTER COLUMN balance_version SET DEFAULT 'balance-v4-2026.08.28-v5@sha256:1582812293bdea86b040e700b30175dca52d0d3258ca8bafdf01ede082e81b53';

-- Compile the same tiered curve and +1…+20 Resonance into the server-owned
-- Dungeon/Boss snapshots. These definitions already contain the accepted v3 core.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.dungeon_roster_snapshot(uuid,jsonb)'::regprocedure);
  v_new := replace(v_def,
    $find$v_item_hp numeric;
  v_item_atk numeric;
  v_item_def numeric;
  v_item_attack_speed numeric;$find$,
    $find$v_item_hp numeric;
  v_item_atk numeric;
  v_item_def numeric;
  v_item_attack_speed numeric;
  v_raw_item_hp numeric;
  v_raw_item_atk numeric;
  v_raw_item_def numeric;
  v_raw_item_attack_speed numeric;
  v_min_enchant integer;
  v_resonance numeric;$find$);
  v_new := replace(v_new,
    'v_item_hp := 0; v_item_atk := 0; v_item_def := 0; v_item_attack_speed := 0;',
    'v_item_hp := 0; v_item_atk := 0; v_item_def := 0; v_item_attack_speed := 0; v_raw_item_hp := 0; v_raw_item_atk := 0; v_raw_item_def := 0; v_raw_item_attack_speed := 0; v_min_enchant := 20;');
  v_new := regexp_replace(v_new,
    E'v_enchant_multiplier := 1;\\s+FOR v_stat',
    E'v_enchant_multiplier := public.enchant_v4_multiplier(v_item.enchant_level);\n      v_min_enchant := LEAST(v_min_enchant, LEAST(20, GREATEST(0, v_item.enchant_level)));\n\n      FOR v_stat');
  v_new := regexp_replace(v_new,
    E'v_enchant_multiplier := 1 \\+ LEAST\\(10, GREATEST\\(0, v_item.enchant_level\\)\\) \\* CASE\\s+WHEN v_item.enchant_stats_version <> 3 THEN \\.1\\s+WHEN v_stat->>\'key\' IN \\(\'hp\',\'atk\',\'def\'\\) THEN \\.1\\s+WHEN v_stat->>\'key\' IN \\(\'goldBonus\',\'xpBonus\'\\) THEN \\.025 ELSE \\.05 END;',
    'v_enchant_multiplier := public.enchant_v4_multiplier(v_item.enchant_level);');
  v_new := replace(v_new,
    $find$v_stat_value := CASE WHEN COALESCE((v_stat->>'isPercent')::boolean, false)
          THEN round(v_stat_value * v_enchant_multiplier, 3) ELSE round(v_stat_value * v_enchant_multiplier) END;
        CASE v_stat->>'key'
          WHEN 'hp' THEN v_item_hp := v_item_hp + v_stat_value;
          WHEN 'atk' THEN v_item_atk := v_item_atk + v_stat_value;
          WHEN 'def' THEN v_item_def := v_item_def + v_stat_value;
          WHEN 'atkSpeed' THEN v_item_attack_speed := v_item_attack_speed + v_stat_value;$find$,
    $find$CASE v_stat->>'key'
          WHEN 'hp' THEN v_raw_item_hp := v_raw_item_hp + v_stat_value; v_item_hp := v_item_hp + v_stat_value * v_enchant_multiplier;
          WHEN 'atk' THEN v_raw_item_atk := v_raw_item_atk + v_stat_value; v_item_atk := v_item_atk + v_stat_value * v_enchant_multiplier;
          WHEN 'def' THEN v_raw_item_def := v_raw_item_def + v_stat_value; v_item_def := v_item_def + v_stat_value * v_enchant_multiplier;
          WHEN 'atkSpeed' THEN v_raw_item_attack_speed := v_raw_item_attack_speed + v_stat_value; v_item_attack_speed := v_item_attack_speed + v_stat_value * v_enchant_multiplier;$find$);
  v_new := replace(v_new,
    $find$v_set_multiplier := 1 + CASE WHEN v_item_count = 8 THEN CASE v_set_rarity
      WHEN 'common' THEN 0.02 WHEN 'uncommon' THEN 0.04 WHEN 'rare' THEN 0.06 WHEN 'epic' THEN 0.08
      WHEN 'legendary' THEN 0.10 WHEN 'mythic' THEN 0.12 WHEN 'cosmic' THEN 0.14
      WHEN 'divine' THEN 0.16 WHEN 'celestial' THEN 0.18 WHEN 'cursed' THEN 0.20
      WHEN 'immortal' THEN 0.22 WHEN 'god' THEN 0.25 ELSE 0 END ELSE 0 END;
    v_item_hp := v_item_hp * v_set_multiplier; v_item_atk := v_item_atk * v_set_multiplier;
    v_item_def := v_item_def * v_set_multiplier; v_item_attack_speed := v_item_attack_speed * v_set_multiplier;$find$,
    $find$v_set_multiplier := CASE WHEN v_item_count = 8 THEN CASE v_set_rarity
      WHEN 'common' THEN 0.05 WHEN 'uncommon' THEN 0.10 WHEN 'rare' THEN 0.15 WHEN 'epic' THEN 0.20
      WHEN 'legendary' THEN 0.30 WHEN 'mythic' THEN 0.40 WHEN 'cosmic' THEN 0.50
      WHEN 'divine' THEN 0.60 WHEN 'celestial' THEN 0.70 WHEN 'cursed' THEN 0.80
      WHEN 'immortal' THEN 0.90 WHEN 'god' THEN 1.00 ELSE 0 END ELSE 0 END;
    v_resonance := CASE WHEN v_item_count = 8 THEN
      (ARRAY[0,1,2,4,7,11,16,22,30,39,50,60,70,80,90,100,110,120,130,140,150]::numeric[])[v_min_enchant + 1] / 100
      ELSE 0 END;
    v_item_hp := round(v_item_hp + v_raw_item_hp * (v_set_multiplier + v_resonance));
    v_item_atk := round(v_item_atk + v_raw_item_atk * (v_set_multiplier + v_resonance));
    v_item_def := round(v_item_def + v_raw_item_def * (v_set_multiplier + v_resonance));
    v_item_attack_speed := round(v_item_attack_speed + v_raw_item_attack_speed * (v_set_multiplier + v_resonance), 3);$find$);
  IF v_new = v_def OR v_new NOT LIKE '%public.enchant_v4_multiplier%' OR v_new NOT LIKE '%v_resonance%' THEN
    RAISE EXCEPTION 'balance_v4_dungeon_snapshot_patch_failed';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.dungeon_start(uuid,integer,uuid)'::regprocedure);
  v_new := replace(v_def,
    '''hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc''',
    '''balance-v4-2026.08.28-v5@sha256:1582812293bdea86b040e700b30175dca52d0d3258ca8bafdf01ede082e81b53''');
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v4_dungeon_start_patch_failed'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.summon_boss(uuid,integer,uuid)'::regprocedure);
  v_new := replace(v_def,
    '''hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc''',
    '''balance-v4-2026.08.28-v5@sha256:1582812293bdea86b040e700b30175dca52d0d3258ca8bafdf01ede082e81b53''');
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v4_boss_start_patch_failed'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.boss_hunt_gold_reward(integer,jsonb)'::regprocedure);
  v_new := replace(v_def,
    $find$v_set_bonus := CASE v_set_rarity
      WHEN 'common' THEN 0.02 WHEN 'uncommon' THEN 0.04 WHEN 'rare' THEN 0.06
      WHEN 'epic' THEN 0.08 WHEN 'legendary' THEN 0.10 WHEN 'mythic' THEN 0.12
      WHEN 'relic' THEN 0.12 WHEN 'cosmic' THEN 0.14 WHEN 'divine' THEN 0.16
      WHEN 'celestial' THEN 0.18 WHEN 'cursed' THEN 0.20 WHEN 'immortal' THEN 0.22
      WHEN 'god' THEN 0.25 ELSE 0 END;$find$,
    $find$v_set_bonus := CASE v_set_rarity
      WHEN 'common' THEN 0.05 WHEN 'uncommon' THEN 0.10 WHEN 'rare' THEN 0.15
      WHEN 'epic' THEN 0.20 WHEN 'legendary' THEN 0.30 WHEN 'mythic' THEN 0.40
      WHEN 'relic' THEN 0.40 WHEN 'cosmic' THEN 0.50 WHEN 'divine' THEN 0.60
      WHEN 'celestial' THEN 0.70 WHEN 'cursed' THEN 0.80 WHEN 'immortal' THEN 0.90
      WHEN 'god' THEN 1.00 ELSE 0 END;$find$);
  v_new := replace(v_new,
    'LEAST(10, GREATEST(0, min(COALESCE((item->>''enchant_level'')::integer, 0))))',
    'LEAST(20, GREATEST(0, min(COALESCE((item->>''enchant_level'')::integer, 0))))');
  v_new := replace(v_new,
    '(ARRAY[0,1,2,4,7,11,16,22,30,39,50])[v_min_enchant + 1]',
    '(ARRAY[0,1,2,4,7,11,16,22,30,39,50,60,70,80,90,100,110,120,130,140,150])[v_min_enchant + 1]');
  v_new := replace(v_new,
    '1 + LEAST(10, GREATEST(0, COALESCE((v_item->>''enchant_level'')::integer, 0))) * 0.1',
    'public.enchant_v4_multiplier(COALESCE((v_item->>''enchant_level'')::integer, 0))');
  IF v_new = v_def OR v_new NOT LIKE '%public.enchant_v4_multiplier%' OR v_new NOT LIKE '%150]%' THEN
    RAISE EXCEPTION 'balance_v4_boss_gold_patch_failed';
  END IF;
  EXECUTE v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.dungeon_equipment_combat_stat(p_hero jsonb, p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  WITH equipment AS (
    SELECT item
    FROM jsonb_array_elements(COALESCE(p_hero->'equipment', '[]'::jsonb)) entry(item)
  ), bonuses AS (
    SELECT
      CASE WHEN count(*) = 8 AND count(DISTINCT item->>'rarity') = 1 THEN CASE min(item->>'rarity')
        WHEN 'common' THEN .05 WHEN 'uncommon' THEN .10 WHEN 'rare' THEN .15 WHEN 'epic' THEN .20
        WHEN 'legendary' THEN .30 WHEN 'mythic' THEN .40 WHEN 'relic' THEN .40 WHEN 'cosmic' THEN .50
        WHEN 'divine' THEN .60 WHEN 'celestial' THEN .70 WHEN 'cursed' THEN .80
        WHEN 'immortal' THEN .90 WHEN 'god' THEN 1.00 ELSE 0 END ELSE 0 END AS set_bonus,
      CASE WHEN count(*) = 8 THEN
        (ARRAY[0,1,2,4,7,11,16,22,30,39,50,60,70,80,90,100,110,120,130,140,150]::numeric[])
          [LEAST(20, GREATEST(0, min(COALESCE((item->>'enchant_level')::integer, 0)))) + 1] / 100
        ELSE 0 END AS resonance
    FROM equipment
  )
  SELECT round(COALESCE(sum(CASE WHEN stat->>'key' = p_key THEN
    (stat->>'value')::numeric * (
      public.enchant_v4_multiplier(COALESCE((item->>'enchant_level')::integer, 0))
      + bonuses.set_bonus + bonuses.resonance
    ) ELSE 0 END), 0), 3)
  FROM equipment
  CROSS JOIN bonuses
  LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item->'stats') = 'array'
    THEN item->'stats' ELSE '[]'::jsonb END) item_stats(stat) ON true
$$;

REVOKE ALL ON FUNCTION public.enchant_v4_multiplier(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calculate_item_power_v4(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_equipment_combat_stat(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  TO service_role;
