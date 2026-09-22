CREATE TABLE IF NOT EXISTS public.hero_income_denominator_cache (
  score_version integer PRIMARY KEY,
  total_score numeric NOT NULL CHECK (total_score >= 0),
  player_scores jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(player_scores) = 'object'),
  denominator_as_of timestamptz NOT NULL
);

ALTER TABLE public.hero_income_denominator_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hero_income_denominator_cache FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.canonical_hero_income_score(
  p_power numeric,
  p_highest_location integer,
  p_boost_max_active boolean
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT GREATEST(0, p_power)
    * (1 + 0.10::numeric * (GREATEST(1, p_highest_location) - 1))
    * CASE WHEN p_boost_max_active THEN 2 ELSE 1 END
$$;

CREATE OR REPLACE FUNCTION public.hero_income_training_penalty(p_training_hero_count integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT CASE GREATEST(0, LEAST(10, p_training_hero_count))
    WHEN 0 THEN 0 WHEN 1 THEN 0.10 WHEN 2 THEN 0.25 WHEN 3 THEN 0.50
    WHEN 4 THEN 0.75 ELSE 0.90 END
$$;

CREATE OR REPLACE FUNCTION public.canonical_hero_income_scores(p_players jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'player_id', entry->>'player_id',
    'power', GREATEST(0, COALESCE((entry->>'power')::numeric, 0)),
    'score', public.canonical_hero_income_score(
      COALESCE((entry->>'power')::numeric, 0),
      GREATEST(1, COALESCE((entry->>'highest_location')::integer, 1)),
      COALESCE((entry->>'boost_max_active')::boolean, false)
    ),
    'forfeited', CASE
      WHEN public.hero_income_training_penalty(COALESCE((entry->>'training_hero_count')::integer, 0)) >= 1 THEN 0
      ELSE (
        COALESCE((entry->>'power')::numeric, 0)
          / (1 - public.hero_income_training_penalty(COALESCE((entry->>'training_hero_count')::integer, 0)))
          - COALESCE((entry->>'power')::numeric, 0)
      ) * (1 + 0.10::numeric * (GREATEST(1, COALESCE((entry->>'highest_location')::integer, 1)) - 1))
        * CASE WHEN COALESCE((entry->>'boost_max_active')::boolean, false) THEN 2 ELSE 1 END
    END
  )), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_players) = 'array' THEN p_players ELSE '[]'::jsonb END) entry
$$;

CREATE OR REPLACE FUNCTION public.hero_income_snapshot(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version constant integer := 2;
  v_now timestamptz := statement_timestamp();
  v_player public.players%ROWTYPE;
  v_cache public.hero_income_denominator_cache%ROWTYPE;
  v_scores jsonb := '{}'::jsonb;
  v_total numeric := 0;
  v_cached_own numeric := 0;
  v_my_score numeric := 0;
  v_adjusted_total numeric := 0;
  v_daily numeric := 0;
  v_training_penalty numeric := 0;
  v_location_multiplier numeric := 1;
  v_boost_multiplier integer := 1;
  v_save_revision bigint := 0;
BEGIN
  SELECT * INTO v_player FROM public.players WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  SELECT * INTO v_cache FROM public.hero_income_denominator_cache WHERE score_version = v_version;
  IF NOT FOUND OR v_cache.denominator_as_of <= v_now - interval '60 seconds' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hero-income-denominator-v2', 0));
    SELECT * INTO v_cache FROM public.hero_income_denominator_cache WHERE score_version = v_version;
    IF NOT FOUND OR v_cache.denominator_as_of <= v_now - interval '60 seconds' THEN
      SELECT
        COALESCE(jsonb_object_agg(player_id::text, score), '{}'::jsonb),
        COALESCE(sum(score), 0)
      INTO v_scores, v_total
      FROM (
        SELECT player_id, public.canonical_hero_income_score(power, highest_location, boost_max_active) AS score
        FROM public.players
        WHERE token_eligible = true
          AND (reward_active_until > v_now OR boost_max_active = true)
          AND power > 0
      ) scored;
      INSERT INTO public.hero_income_denominator_cache(score_version, total_score, player_scores, denominator_as_of)
      VALUES (v_version, v_total, v_scores, v_now)
      ON CONFLICT (score_version) DO UPDATE SET
        total_score = EXCLUDED.total_score,
        player_scores = EXCLUDED.player_scores,
        denominator_as_of = EXCLUDED.denominator_as_of
      RETURNING * INTO v_cache;
    END IF;
  END IF;

  IF v_player.token_eligible
    AND (v_player.reward_active_until > v_now OR v_player.boost_max_active = true)
    AND v_player.power > 0 THEN
    v_my_score := public.canonical_hero_income_score(v_player.power, v_player.highest_location, v_player.boost_max_active);
  END IF;
  v_cached_own := COALESCE((v_cache.player_scores->>p_player_id::text)::numeric, 0);
  v_adjusted_total := GREATEST(0, v_cache.total_score - v_cached_own + v_my_score);
  v_daily := CASE WHEN v_adjusted_total > 0 THEN v_my_score / v_adjusted_total * 20000 ELSE 0 END;
  v_training_penalty := public.hero_income_training_penalty(v_player.training_hero_count);
  v_location_multiplier := 1 + 0.10::numeric * (GREATEST(1, v_player.highest_location) - 1);
  v_boost_multiplier := CASE WHEN v_player.boost_max_active THEN 2 ELSE 1 END;
  SELECT revision INTO v_save_revision FROM public.player_saves WHERE player_id = p_player_id;

  RETURN jsonb_build_object(
    'score_version', v_version,
    'player_power', v_player.power,
    'training_hero_count', v_player.training_hero_count,
    'training_penalty', v_training_penalty,
    'highest_location', v_player.highest_location,
    'location_multiplier', v_location_multiplier,
    'boost_multiplier', v_boost_multiplier,
    'my_score', v_my_score,
    'total_score', v_adjusted_total,
    'denominator_as_of', v_cache.denominator_as_of,
    'daily_pool', 20000,
    'my_daily_share', v_daily,
    'my_hourly_share', v_daily / 24,
    'pool_share_percent', v_daily / 20000 * 100,
    'save_revision', COALESCE(v_save_revision, 0),
    'total_power', v_adjusted_total,
    'my_power', v_my_score,
    'pool_amount', 20000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.canonical_hero_income_score(numeric, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hero_income_training_penalty(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.canonical_hero_income_scores(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hero_income_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canonical_hero_income_scores(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.hero_income_snapshot(uuid) TO service_role;

COMMENT ON FUNCTION public.canonical_hero_income_score(numeric, integer, boolean) IS
  'Score v2 single formula used by Income snapshots and token distribution.';
COMMENT ON FUNCTION public.hero_income_snapshot(uuid) IS
  'Revisioned server Income snapshot with a serialized denominator cache no older than 60 seconds.';
