-- Visible normal combat now rewards each server-resolved wave immediately.
-- The legacy fractional column remains at zero for rollback/save compatibility;
-- periodic hidden/offline progression keeps its separate bounded time clock.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef(
    'public.normal_combat_complete_without_auto_pot(uuid,uuid,uuid)'::regprocedure
  );
  v_new := replace(v_def,
    $find$  v_wave_seconds := LEAST(12::numeric, GREATEST(0::numeric, extract(epoch FROM (now() - v_event.started_at))));
  v_reward_progress := v_reward_progress + v_wave_seconds;
  v_rewarded_wave := LEAST(1, floor(v_reward_progress / 12)::integer);
  v_reward_progress := v_reward_progress - v_rewarded_wave * 12;
  v_outcome_cleared := GREATEST(0, LEAST(3, COALESCE((v_event.outcome->>'cleared_lanes')::integer, 0)));
  v_cleared := v_outcome_cleared * v_rewarded_wave;$find$,
    $replace$  v_wave_seconds := 0;
  v_reward_progress := 0;
  v_outcome_cleared := GREATEST(0, LEAST(3, COALESCE((v_event.outcome->>'cleared_lanes')::integer, 0)));
  v_rewarded_wave := CASE WHEN v_outcome_cleared > 0 THEN 1 ELSE 0 END;
  v_cleared := v_outcome_cleared;$replace$);
  IF v_new = v_def
    OR position('v_reward_progress := 0;' IN v_new) = 0
    OR position('v_cleared := v_outcome_cleared;' IN v_new) = 0
    OR position('floor(v_reward_progress / 12)' IN v_new) > 0 THEN
    RAISE EXCEPTION 'normal_combat_immediate_reward_patch_failed';
  END IF;
  EXECUTE v_new;
END;
$$;
