-- One canonical server-owned inter-wave handoff caps visible normal-combat
-- settlement at one completed wave per second after deterministic combat ends.
CREATE OR REPLACE FUNCTION public.normal_combat_handoff_ms()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 1000 $$;

REVOKE ALL ON FUNCTION public.normal_combat_handoff_ms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normal_combat_handoff_ms() TO service_role;

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef(
    'public.normal_combat_store_outcome(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure
  );
  v_new := replace(
    v_def,
    $find$+ interval '500 milliseconds'$find$,
    $replace$+ make_interval(secs => public.normal_combat_handoff_ms()::numeric / 1000)$replace$
  );
  IF v_new = v_def
    OR position('normal_combat_handoff_ms()' IN v_new) = 0
    OR position('interval ''500 milliseconds''' IN v_new) > 0 THEN
    RAISE EXCEPTION 'normal_combat_one_second_handoff_patch_failed';
  END IF;
  EXECUTE v_new;
END;
$$;
