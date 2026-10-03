-- Seeker Promote All (Founder 2026-10-03): a Star Up costs exact zero-star duplicates plus a
-- small Gold fee, no SKR and no $HERO. One call promotes every listed target as far as its
-- duplicates and the remaining Gold allow, in the client's order. The client shows the Gold
-- total first; the server recomputes it and refuses any mismatch before writing anything.
-- Gold per star = rarity base x next star; provisional values, rebalanced later.
BEGIN;

CREATE TABLE IF NOT EXISTS public.seeker_gold_promotion_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  target_uids text[] NOT NULL,
  expected_gold bigint NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.seeker_gold_promotion_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.seeker_star_gold_cost(p_rarity text, p_next_star integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT (CASE p_rarity
    WHEN 'common' THEN 5 WHEN 'uncommon' THEN 10 WHEN 'rare' THEN 25 WHEN 'epic' THEN 50
    WHEN 'legendary' THEN 100 WHEN 'mythic' THEN 200 WHEN 'cosmic' THEN 400
    WHEN 'divine' THEN 800 WHEN 'celestial' THEN 1500 ELSE NULL
  END)::bigint * p_next_star;
$$;
REVOKE ALL ON FUNCTION public.seeker_star_gold_cost(text, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_hero_promote_all(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_target_uids jsonb,
  p_expected_gold bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing public.seeker_gold_promotion_events%ROWTYPE;
  v_targets text[];
  v_state jsonb;
  v_owned jsonb;
  v_team jsonb;
  v_training jsonb;
  v_gold_raw numeric;
  v_gold bigint;
  v_budget bigint;
  v_spent bigint := 0;
  v_target_uid text;
  v_target jsonb;
  v_hero_id text;
  v_rarity text;
  v_seen_hero_ids text[] := ARRAY[]::text[];
  v_from integer;
  v_stars integer;
  v_required integer;
  v_cost bigint;
  v_target_gold bigint;
  v_candidates text[];
  v_promotions jsonb := '[]'::jsonb;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_target_uids) <> 'array' OR jsonb_array_length(p_target_uids) < 1 OR jsonb_array_length(p_target_uids) > 45
    OR p_expected_gold IS NULL OR p_expected_gold < 0 THEN
    RAISE EXCEPTION 'invalid_ascension';
  END IF;
  SELECT array_agg(value ORDER BY ordinality) INTO v_targets
  FROM jsonb_array_elements_text(p_target_uids) WITH ORDINALITY AS target(value, ordinality);
  IF (SELECT count(DISTINCT t) FROM unnest(v_targets) AS t) <> array_length(v_targets, 1) THEN RAISE EXCEPTION 'invalid_ascension'; END IF;

  SELECT * INTO v_existing FROM public.seeker_gold_promotion_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.target_uids <> v_targets OR v_existing.expected_gold <> p_expected_gold THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  PERFORM 1 FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  v_team := COALESCE(v_state->'team', '[]'::jsonb);
  v_training := COALESCE(v_state#>'{trainingCamp,heroUids}', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' OR jsonb_typeof(v_team) <> 'array' OR jsonb_typeof(v_training) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;
  v_gold_raw := GREATEST(0, COALESCE((v_state->>'gold')::numeric, 0));
  v_gold := floor(v_gold_raw)::bigint;
  v_budget := v_gold;

  FOREACH v_target_uid IN ARRAY v_targets LOOP
    SELECT hero INTO v_target FROM jsonb_array_elements(v_owned) AS hero WHERE hero->>'uid' = v_target_uid LIMIT 1;
    IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;
    v_hero_id := v_target->>'heroId';
    -- One target per hero kind, so two targets never compete for the same duplicates.
    IF v_hero_id = ANY(v_seen_hero_ids) THEN RAISE EXCEPTION 'invalid_ascension'; END IF;
    v_seen_hero_ids := v_seen_hero_ids || v_hero_id;
    v_rarity := substring(v_hero_id FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$');
    IF v_rarity IS NULL THEN RAISE EXCEPTION 'unsupported_rarity'; END IF;
    v_from := LEAST(20, GREATEST(0, COALESCE((v_target->>'stars')::integer, 0)));
    v_stars := v_from;
    v_target_gold := 0;

    LOOP
      EXIT WHEN v_stars >= 20;
      v_required := public.hero_ascension_required_duplicates(v_rarity, v_stars);
      v_cost := public.seeker_star_gold_cost(v_rarity, v_stars + 1);
      EXIT WHEN v_required IS NULL OR v_cost IS NULL OR v_budget < v_cost;
      SELECT array_agg(candidate.uid ORDER BY candidate.ordinality) INTO v_candidates
      FROM (
        SELECT hero->>'uid' AS uid, ordinality
        FROM jsonb_array_elements(v_owned) WITH ORDINALITY AS owned(hero, ordinality)
        WHERE hero->>'heroId' = v_hero_id
          AND NOT ((hero->>'uid') = ANY(v_targets))
          AND COALESCE((hero->>'stars')::integer, 0) = 0
          AND COALESCE((hero->>'locked')::boolean, false) = false
          AND NOT (v_team ? (hero->>'uid'))
          AND NOT (v_training ? (hero->>'uid'))
        ORDER BY ordinality
        LIMIT v_required
      ) AS candidate;
      EXIT WHEN COALESCE(array_length(v_candidates, 1), 0) < v_required;

      SELECT COALESCE(jsonb_agg(
        CASE WHEN hero->>'uid' = v_target_uid THEN jsonb_set(hero, '{stars}', to_jsonb(v_stars + 1), true) ELSE hero END
        ORDER BY ordinality
      ), '[]'::jsonb) INTO v_owned
      FROM jsonb_array_elements(v_owned) WITH ORDINALITY AS owned(hero, ordinality)
      WHERE NOT ((hero->>'uid') = ANY(v_candidates));

      v_stars := v_stars + 1;
      v_budget := v_budget - v_cost;
      v_spent := v_spent + v_cost;
      v_target_gold := v_target_gold + v_cost;
    END LOOP;

    IF v_stars > v_from THEN
      v_promotions := v_promotions || jsonb_build_array(jsonb_build_object(
        'target_uid', v_target_uid, 'hero_id', v_hero_id, 'from_stars', v_from, 'to_stars', v_stars,
        'stars_added', v_stars - v_from, 'gold', v_target_gold));
    END IF;
  END LOOP;

  -- The price the player saw must be the price charged; nothing is written otherwise.
  IF v_spent <> p_expected_gold THEN RAISE EXCEPTION 'promotion_quote_changed'; END IF;
  IF jsonb_array_length(v_promotions) = 0 THEN RAISE EXCEPTION 'insufficient_duplicates'; END IF;

  v_state := jsonb_set(jsonb_set(v_state, '{ownedHeroes}', v_owned, true), '{gold}', to_jsonb(v_gold_raw - v_spent), true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.players SET heroes_owned = jsonb_array_length(v_owned), updated_at = now() WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'rules_version', 'seeker-gold-promotion-v1', 'promotions', v_promotions, 'gold_spent', v_spent,
    'gold', v_gold_raw - v_spent, 'owned_heroes', v_owned, 'revision', v_revision
  );
  INSERT INTO public.seeker_gold_promotion_events (idempotency_key, player_id, target_uids, expected_gold, result)
  VALUES (p_idempotency_key, p_player_id, v_targets, p_expected_gold, v_result);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.seeker_hero_promote_all(uuid, uuid, jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_hero_promote_all(uuid, uuid, jsonb, bigint) TO heroloop_api;

COMMIT;
