ALTER FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  RENAME TO settle_item_upgrade_v1;

REVOKE ALL ON FUNCTION public.settle_item_upgrade_v1(uuid, uuid, text, uuid, boolean)
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
  v_revision bigint;
  v_gold bigint;
  v_token_balance numeric;
  v_token_spent numeric;
  v_gold_cost bigint := 0;
  v_token_cost bigint := 0;
  v_chance numeric := 1;
  v_success boolean := true;
  v_target integer;
  v_rarity_multiplier numeric;
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

  SELECT * INTO v_existing FROM public.item_upgrade_events
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

  SELECT * INTO v_existing FROM public.item_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action_kind <> p_action_kind
      OR v_existing.item_id <> p_item_id OR v_existing.use_charm <> p_use_charm THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_item FROM public.player_items
  WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF p_action_kind = 'enchant' AND (v_item.enchant_level < 0 OR v_item.enchant_level >= 10) THEN
    RAISE EXCEPTION 'maximum_enchant';
  END IF;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  SELECT entry.item INTO v_item_json
  FROM jsonb_array_elements(v_inventory) entry(item)
  WHERE entry.item->>'uid' = p_item_id::text LIMIT 1;
  IF v_item_json IS NULL THEN RAISE EXCEPTION 'item_state_mismatch'; END IF;
  v_item_json := v_item_json || jsonb_build_object(
    'uid', v_item.id, 'itemId', v_item.base_item_id, 'level', v_item.item_level,
    'stats', v_item.stats, 'power', v_item.power, 'locked', v_item.locked,
    'enchantLevel', v_item.enchant_level, 'rerollCount', v_item.reroll_count,
    'enchantStatsVersion', v_item.enchant_stats_version, 'serverOwned', true
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
  ELSIF v_target <= 3 THEN
    IF p_use_charm THEN RAISE EXCEPTION 'charm_unavailable'; END IF;
    v_rarity_multiplier := CASE v_item.rarity
      WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1.25 WHEN 'rare' THEN 1.5
      WHEN 'epic' THEN 2 WHEN 'legendary' THEN 3 WHEN 'mythic' THEN 4
      WHEN 'relic' THEN 4 WHEN 'cosmic' THEN 5 WHEN 'divine' THEN 6
      WHEN 'celestial' THEN 7 WHEN 'cursed' THEN 8 WHEN 'immortal' THEN 9
      WHEN 'god' THEN 10 ELSE NULL END;
    IF v_rarity_multiplier IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
    v_gold_cost := ceil(
      (ARRAY[50,100,200]::numeric[])[v_target]
      * v_rarity_multiplier
      * (1 + 0.01 * (LEAST(100, GREATEST(1, v_item.item_level)) - 1))
      / 10
    )::bigint * 10;
    v_chance := 1;
  ELSE
    v_chance := (ARRAY[0.85,0.70,0.55,0.40,0.25,0.15,0.10]::numeric[])[v_target - 3];
    CASE v_item.rarity
      WHEN 'common' THEN v_gold_cost := (ARRAY[400,1000,3000,10000,25000,50000,100000]::bigint[])[v_target - 3];
      WHEN 'uncommon' THEN v_gold_cost := (ARRAY[800,2500,7500,25000,75000,150000,250000]::bigint[])[v_target - 3];
      WHEN 'rare' THEN v_gold_cost := (ARRAY[2000,7500,25000,75000,250000,500000,1000000]::bigint[])[v_target - 3];
      WHEN 'epic' THEN v_gold_cost := (ARRAY[5000,20000,75000,250000,1000000,2500000,5000000]::bigint[])[v_target - 3];
      WHEN 'legendary' THEN v_gold_cost := (ARRAY[25000,100000,400000,1500000,5000000,12000000,25000000]::bigint[])[v_target - 3];
      WHEN 'mythic' THEN v_gold_cost := (ARRAY[50000,200000,800000,3000000,10000000,25000000,50000000]::bigint[])[v_target - 3];
      WHEN 'relic' THEN v_gold_cost := (ARRAY[50000,200000,800000,3000000,10000000,25000000,50000000]::bigint[])[v_target - 3];
      WHEN 'cosmic' THEN v_gold_cost := (ARRAY[100000,400000,1500000,6000000,20000000,50000000,100000000]::bigint[])[v_target - 3];
      WHEN 'divine' THEN v_catalogue_usd_micros := (ARRAY[500000,1500000,4000000,10000000,25000000,60000000,150000000]::bigint[])[v_target - 3];
      WHEN 'celestial' THEN v_catalogue_usd_micros := (ARRAY[1000000,3000000,8000000,20000000,50000000,120000000,250000000]::bigint[])[v_target - 3];
      WHEN 'cursed' THEN v_catalogue_usd_micros := (ARRAY[2000000,5000000,15000000,35000000,80000000,180000000,300000000]::bigint[])[v_target - 3];
      WHEN 'immortal' THEN v_catalogue_usd_micros := (ARRAY[5000000,10000000,25000000,50000000,100000000,200000000,350000000]::bigint[])[v_target - 3];
      WHEN 'god' THEN v_catalogue_usd_micros := (ARRAY[10000000,20000000,40000000,80000000,150000000,300000000,400000000]::bigint[])[v_target - 3];
      ELSE RAISE EXCEPTION 'invalid_item_upgrade';
    END CASE;
    IF p_use_charm THEN v_catalogue_usd_micros := v_catalogue_usd_micros + 2000000; END IF;
    v_token_cost := ceil(v_catalogue_usd_micros::numeric / v_hero_usd_quote_micros)::bigint;
  END IF;

  IF v_gold < v_gold_cost THEN RAISE EXCEPTION 'insufficient_gold'; END IF;
  IF v_token_balance < v_token_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
  v_success := p_action_kind = 'reroll' OR p_use_charm OR random() < v_chance;
  v_gold := v_gold - v_gold_cost;

  IF p_action_kind = 'reroll' THEN
    v_stats := public.roll_item_stats(v_item.slot, v_item.rarity, v_item.item_level);
    v_new_reroll := v_item.reroll_count + 1;
    v_new_power := public.calculate_item_power(v_stats, v_item.enchant_level);
    UPDATE public.player_items
    SET stats = v_stats, power = v_new_power, reroll_count = v_new_reroll,
        enchant_stats_version = 2
    WHERE id = p_item_id;
    v_item_json := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_item_json,
      '{stats}', v_stats, true), '{power}', to_jsonb(v_new_power), true),
      '{rerollCount}', to_jsonb(v_new_reroll), true), '{enchantStatsVersion}', '2'::jsonb, true);
    SELECT jsonb_agg(CASE WHEN entry.item->>'uid' = p_item_id::text THEN v_item_json ELSE entry.item END ORDER BY entry.ordinality)
    INTO v_next_inventory FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(item, ordinality);
    v_inventory := COALESCE(v_next_inventory, '[]'::jsonb);
  ELSIF v_success THEN
    v_new_enchant := v_target;
    v_new_power := public.calculate_item_power(v_item.stats, v_new_enchant);
    UPDATE public.player_items
    SET enchant_level = v_new_enchant, power = v_new_power WHERE id = p_item_id;
    v_item_json := jsonb_set(jsonb_set(jsonb_set(v_item_json,
      '{enchantLevel}', to_jsonb(v_new_enchant), true),
      '{enchantStatsVersion}', '2'::jsonb, true), '{power}', to_jsonb(v_new_power), true);
    SELECT jsonb_agg(CASE WHEN entry.item->>'uid' = p_item_id::text THEN v_item_json ELSE entry.item END ORDER BY entry.ordinality)
    INTO v_next_inventory FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(item, ordinality);
    v_inventory := COALESCE(v_next_inventory, '[]'::jsonb);
  END IF;

  IF v_token_cost > 0 THEN
    v_token_balance := v_token_balance - v_token_cost;
    v_token_spent := v_token_spent + v_token_cost;
    UPDATE public.players
    SET token_balance = v_token_balance, boost_tokens_spent = v_token_spent, updated_at = now()
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
    'action', p_action_kind, 'item_id', p_item_id, 'success', v_success,
    'destroyed', false, 'guaranteed', p_use_charm, 'success_chance', v_chance,
    'item', v_item_json, 'inventory', v_inventory, 'owned_heroes', v_owned,
    'gold', v_gold, 'token_balance', v_token_balance, 'gold_cost', v_gold_cost,
    'token_cost', v_token_cost, 'catalogue_usd_micros', v_catalogue_usd_micros,
    'hero_usd_quote_micros', v_hero_usd_quote_micros, 'revision', v_revision
  );
  INSERT INTO public.item_upgrade_events(idempotency_key, player_id, action_kind, item_id, use_charm, result)
  VALUES (p_idempotency_key, p_player_id, p_action_kind, p_item_id, p_use_charm, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.credit_tester_gold(p_player_id uuid, p_amount bigint DEFAULT 10000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state jsonb;
  v_revision bigint;
  v_gold bigint;
  v_total bigint;
BEGIN
  IF p_amount <> 10000 THEN RAISE EXCEPTION 'invalid_tester_credit'; END IF;
  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_gold := GREATEST(0, floor(COALESCE((v_state->>'gold')::numeric, 0)))::bigint + p_amount;
  v_total := GREATEST(0, floor(COALESCE((v_state->>'totalGoldEarned')::numeric, 0)))::bigint + p_amount;
  v_state := jsonb_set(jsonb_set(v_state, '{gold}', to_jsonb(v_gold), true),
    '{totalGoldEarned}', to_jsonb(v_total), true);
  v_revision := v_revision + 1;
  UPDATE public.player_saves
  SET state = v_state, revision = v_revision, updated_at = now()
  WHERE player_id = p_player_id;
  RETURN jsonb_build_object('gold', v_gold, 'total_gold_earned', v_total, 'revision', v_revision);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_tester_gold(uuid, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_tester_gold(uuid, bigint) TO service_role;

COMMENT ON FUNCTION public.credit_tester_gold(uuid, bigint) IS
  'Fixed 10,000-Gold Staging tester command; transport must reject it outside Staging.';
