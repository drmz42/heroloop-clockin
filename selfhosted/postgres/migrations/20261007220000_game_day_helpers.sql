-- Founder 2026-10-07: the game day rolls over at 00:00 UTC instead of 00:00 UTC+3.
-- The switch takes effect at 2026-10-09 00:00 UTC (the client uses the same instant), or at
-- the first 00:00 UTC after this migration runs if that is later. Before that
-- instant every timestamp keeps its legacy UTC+3 date, so the day in progress simply
-- lasts until 00:00 UTC (up to 27 hours) and no daily counter or claim resets twice.
-- The cutover is fixed on first creation and kept if the migration is ever replayed.
BEGIN;
DO $migration$
DECLARE
  v_cutover timestamptz := greatest('2026-10-09 00:00:00+00'::timestamptz,
    (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC');
BEGIN
  IF to_regprocedure('public.heroloop_game_date(timestamptz)') IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format($sql$
    CREATE FUNCTION public.heroloop_game_date(p_at timestamptz) RETURNS date
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $body$
      SELECT CASE WHEN p_at < %1$L::timestamptz
        THEN ((p_at AT TIME ZONE 'UTC') + interval '3 hours')::date
        ELSE (p_at AT TIME ZONE 'UTC')::date END
    $body$;
    CREATE FUNCTION public.heroloop_game_day_start(p_day date) RETURNS timestamptz
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $body$
      SELECT CASE WHEN ((p_day::timestamp - interval '3 hours') AT TIME ZONE 'UTC') < %1$L::timestamptz
        THEN (p_day::timestamp - interval '3 hours') AT TIME ZONE 'UTC'
        ELSE p_day::timestamp AT TIME ZONE 'UTC' END
    $body$;
  $sql$, v_cutover);
END
$migration$;
REVOKE ALL ON FUNCTION public.heroloop_game_date(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heroloop_game_day_start(date) FROM PUBLIC, anon, authenticated;
COMMIT;
