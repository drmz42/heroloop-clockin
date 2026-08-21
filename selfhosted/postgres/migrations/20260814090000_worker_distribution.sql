\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS heroloop_worker AUTHORIZATION supabase_admin;
REVOKE ALL ON SCHEMA heroloop_worker FROM PUBLIC;
GRANT USAGE ON SCHEMA heroloop_worker TO heroloop_worker;

CREATE TABLE IF NOT EXISTS heroloop_worker.tick_events (
  tick_at timestamptz PRIMARY KEY,
  result jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE heroloop_worker.tick_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION heroloop_worker.run_distribution_tick(p_requested_tick timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_worker
AS $function$
DECLARE
  v_tick timestamptz := to_timestamp(floor(extract(epoch FROM p_requested_tick) / 30) * 30);
  v_existing jsonb;
  v_player record;
  v_score numeric;
  v_total_score numeric := 0;
  v_total_power numeric := 0;
  v_total_forfeited numeric := 0;
  v_distributed numeric := 0;
  v_reward numeric;
  v_player_count integer := 0;
  v_tick_amount numeric := 20000::numeric / 2880::numeric;
  v_result jsonb;
BEGIN
  IF p_requested_tick IS NULL OR p_requested_tick > now() + interval '60 seconds' THEN
    RAISE EXCEPTION 'invalid_worker_tick';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('heroloop-worker-distribution', 0));
  SELECT result INTO v_existing FROM heroloop_worker.tick_events WHERE tick_at = v_tick;
  IF FOUND THEN RETURN v_existing || jsonb_build_object('replayed', true); END IF;

  UPDATE public.players
  SET online = false
  WHERE online = true AND last_heartbeat < v_tick - interval '60 seconds';

  FOR v_player IN
    SELECT player_id
    FROM public.players
    WHERE (reward_active_until > v_tick OR boost_max_active = true) AND combat_power > 0
    ORDER BY player_id
    FOR UPDATE
  LOOP
    PERFORM public.settle_periodic_progression(v_player.player_id, v_tick);
  END LOOP;

  CREATE TEMP TABLE worker_scored_players ON COMMIT DROP AS
  SELECT
    player_id,
    power::numeric AS power,
    power::numeric * (1 + 0.10::numeric * (GREATEST(1, highest_location) - 1))
      * CASE WHEN boost_max_active THEN 2 ELSE 1 END AS score,
    GREATEST(0, LEAST(10, training_hero_count)) AS training_count
  FROM public.players
  WHERE token_eligible = true
    AND (reward_active_until > v_tick OR boost_max_active = true)
    AND power > 0;

  SELECT count(*), COALESCE(sum(power), 0), COALESCE(sum(score), 0)
  INTO v_player_count, v_total_power, v_total_score
  FROM worker_scored_players;

  IF v_total_score > 0 THEN
    FOR v_player IN SELECT * FROM worker_scored_players ORDER BY player_id LOOP
      v_reward := v_tick_amount * v_player.score / v_total_score;
      IF v_reward > 0 AND public.credit_token_distribution(v_player.player_id, v_reward) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'worker_token_credit_failed';
      END IF;
      v_distributed := v_distributed + GREATEST(v_reward, 0);
      v_score := CASE v_player.training_count
        WHEN 0 THEN 0 WHEN 1 THEN 0.10 WHEN 2 THEN 0.25 WHEN 3 THEN 0.50
        WHEN 4 THEN 0.75 ELSE 0.90 END;
      IF v_score < 1 THEN
        v_total_forfeited := v_total_forfeited +
          ((v_player.power / (1 - v_score)) - v_player.power) *
          (v_player.score / NULLIF(v_player.power, 0));
      END IF;
    END LOOP;

    UPDATE public.token_pool
    SET pool_amount = 20000,
        total_distributed = total_distributed + v_distributed,
        updated_at = v_tick
    WHERE id = 1;

    INSERT INTO public.distribution_log(
      tick_at, total_power, player_count, amount_distributed, interval_seconds,
      forfeited, total_score, score_version
    ) VALUES (
      v_tick, v_total_power, v_player_count, v_distributed, 30,
      v_total_forfeited, v_total_score, 2
    );
  END IF;

  v_result := jsonb_build_object(
    'tick_at', v_tick,
    'distributed', v_distributed,
    'forfeited', v_total_forfeited,
    'players', v_player_count,
    'total_power', v_total_power,
    'total_score', v_total_score,
    'daily_pool', 20000,
    'tick_amount', v_tick_amount,
    'score_version', 2,
    'replayed', false
  );
  INSERT INTO heroloop_worker.tick_events(tick_at, result) VALUES (v_tick, v_result);
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION heroloop_worker.run_distribution_tick(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_worker.run_distribution_tick(timestamptz) TO heroloop_worker;

COMMENT ON FUNCTION heroloop_worker.run_distribution_tick(timestamptz) IS
  'Idempotent 30-second periodic progression and token distribution settlement.';
