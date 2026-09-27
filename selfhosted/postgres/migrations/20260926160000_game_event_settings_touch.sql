\set ON_ERROR_STOP on

-- Any change to a game event collection switch stamps updated_at, whoever
-- makes it. The daily $HERO reconcile (ops/run-game-events-maintenance.sh)
-- skips a day in which a switch changed: a day collected only in part is a
-- gap in telemetry, not drift in the economy, and must not alert the Founder.

CREATE OR REPLACE FUNCTION telemetry.touch_game_event_settings()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS game_event_settings_touch ON telemetry.game_event_settings;
CREATE TRIGGER game_event_settings_touch BEFORE UPDATE ON telemetry.game_event_settings
FOR EACH ROW EXECUTE FUNCTION telemetry.touch_game_event_settings();

REVOKE ALL ON FUNCTION telemetry.touch_game_event_settings() FROM PUBLIC;
