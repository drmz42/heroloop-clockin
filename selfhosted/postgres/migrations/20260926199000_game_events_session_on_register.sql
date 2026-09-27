\set ON_ERROR_STOP on

-- A new account is created with its first heartbeat already set
-- (heroloop_api account registration inserts players with last_heartbeat), so
-- the gap trigger on UPDATE never saw its first session. The same collector now
-- also runs on INSERT when the row carries a heartbeat: that heartbeat starts
-- the first session. OLD is null on INSERT, which capture_session_gap already
-- treats as "no session before".

CREATE OR REPLACE FUNCTION telemetry.capture_session_gap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_started timestamptz;
  v_previous timestamptz;
BEGIN
  IF NOT telemetry.activity_collection_enabled() THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN v_previous := OLD.last_heartbeat; END IF;
  BEGIN
    -- The session before the gap, if the closer has not ended it yet.
    DELETE FROM telemetry.player_session_state WHERE player_id = NEW.player_id RETURNING started_at INTO v_started;
    IF v_started IS NOT NULL AND v_previous IS NOT NULL THEN
      PERFORM telemetry.record_session_event(NEW.player_id, 'session_ended', v_previous,
        extract(epoch FROM (v_previous - v_started)));
    END IF;
    INSERT INTO telemetry.player_session_state(player_id, started_at) VALUES (NEW.player_id, NEW.last_heartbeat);
    PERFORM telemetry.record_session_event(NEW.player_id, 'session_started', NEW.last_heartbeat, 1);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'game_event_skipped event=session sqlstate=%', SQLSTATE;
  END;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS game_event_session_insert ON public.players;
CREATE TRIGGER game_event_session_insert AFTER INSERT ON public.players
FOR EACH ROW WHEN (NEW.last_heartbeat IS NOT NULL)
EXECUTE FUNCTION telemetry.capture_session_gap();

REVOKE ALL ON FUNCTION telemetry.capture_session_gap() FROM PUBLIC;
