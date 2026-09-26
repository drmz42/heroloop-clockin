-- Gold/XP bonus parity for Boss Gold and hidden/offline progression.
--
-- The rule is that visible, hidden and offline battles share one reward
-- distribution: the per-lane reward is multiplied by (1 + Gold/XP bonus) and
-- rounded once. Hidden/offline settlement paid no bonus at all, and Boss Gold
-- carried item bonuses but not account bonuses.
--
-- Offline/hidden now use the item bonus the server derived for the player's
-- most recent normal wave (reward_bonuses.item, or the whole payload before
-- account bonuses existed) plus the current account bonus, capped at +1000%
-- like the normal-wave claim. A player with no server wave yet gets only the
-- account bonus. Boss Gold adds the account bonus to its item bonus.
-- Both functions are patched in place and fail closed if their text moved.

CREATE OR REPLACE FUNCTION public.offline_reward_bonus(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH item AS (
    SELECT coalesce(e.reward_bonuses->'item', e.reward_bonuses) AS bonuses
    FROM public.normal_combat_events e
    WHERE e.player_id = p_player_id AND e.reward_bonuses IS NOT NULL
    ORDER BY e.started_at DESC
    LIMIT 1
  ), account AS (
    SELECT public.account_reward_bonus(p_player_id) AS bonuses
  )
  SELECT jsonb_build_object(
    'gold', LEAST(10, GREATEST(0,
      coalesce((SELECT CASE WHEN bonuses->>'gold' ~ '^[0-9]+([.][0-9]+)?$' THEN (bonuses->>'gold')::numeric END FROM item), 0)
      + (SELECT (bonuses->>'gold')::numeric FROM account))),
    'xp', LEAST(10, GREATEST(0,
      coalesce((SELECT CASE WHEN bonuses->>'xp' ~ '^[0-9]+([.][0-9]+)?$' THEN (bonuses->>'xp')::numeric END FROM item), 0)
      + (SELECT (bonuses->>'xp')::numeric FROM account)))
  )
$$;
REVOKE ALL ON FUNCTION public.offline_reward_bonus(uuid) FROM PUBLIC;

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- Hidden/offline normal-wave rewards.
  v_def := pg_get_functiondef('public.settle_periodic_progression_legacy(uuid,timestamptz)'::regprocedure);
  v_new := replace(v_def,
    $f$v_hero_xp := GREATEST(1, ROUND((4 + v_location * 1.2) * 0.55)::integer) * v_battles;$f$,
    $f$v_hero_xp := ROUND(GREATEST(1, ROUND((4 + v_location * 1.2) * 0.55)::integer)
    * (1 + (public.offline_reward_bonus(p_player_id)->>'xp')::numeric))::integer * v_battles;$f$);
  v_new := replace(v_new,
    $f$v_gold := v_battles * (5 + v_location) * v_team_size;$f$,
    $f$v_gold := v_battles * ROUND((5 + v_location)
    * (1 + (public.offline_reward_bonus(p_player_id)->>'gold')::numeric))::integer * v_team_size;$f$);
  IF (length(v_new) - length(replace(v_new, 'public.offline_reward_bonus(p_player_id)', ''))) / length('public.offline_reward_bonus(p_player_id)') <> 2 THEN
    RAISE EXCEPTION 'offline_reward_bonus_patch_target_missing';
  END IF;
  EXECUTE v_new;

  -- Boss Gold: same item math, plus the account bonus.
  v_def := pg_get_functiondef('public.boss_hunt_gold_reward(integer,jsonb)'::regprocedure);
  v_new := replace(v_def,
    'FUNCTION public.boss_hunt_gold_reward(p_location integer, p_roster_snapshot jsonb)',
    'FUNCTION public.boss_hunt_gold_reward_with_account(p_location integer, p_roster_snapshot jsonb, p_account_gold numeric)');
  v_new := replace(v_new, '* (1 + v_bonus)', '* (1 + v_bonus + LEAST(10, GREATEST(0, COALESCE(p_account_gold, 0))))');
  IF v_new NOT LIKE '%boss_hunt_gold_reward_with_account(%' OR v_new NOT LIKE '%v_bonus + LEAST(10%' THEN
    RAISE EXCEPTION 'boss_gold_account_patch_target_missing';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.boss_claim(uuid,uuid,bigint,uuid)'::regprocedure);
  v_new := replace(v_def,
    'v_gold := public.boss_hunt_gold_reward(v_boss.location_id, v_encounter.roster_snapshot);',
    'v_gold := public.boss_hunt_gold_reward_with_account(v_boss.location_id, v_encounter.roster_snapshot,
    (public.account_reward_bonus(p_player_id)->>''gold'')::numeric);');
  IF v_new = v_def THEN RAISE EXCEPTION 'boss_claim_account_patch_target_missing'; END IF;
  EXECUTE v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.boss_hunt_gold_reward_with_account(integer, jsonb, numeric) FROM PUBLIC;
