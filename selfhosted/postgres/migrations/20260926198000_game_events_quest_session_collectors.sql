\set ON_ERROR_STOP on

-- Game event collectors for quests and sessions
-- (docs/game/admin-game-analytics-proposal.md, stage 2; HL-TASK-20260924112113-1C21CA).
--
--   quest_claim_events           insert   quest_completed (kind daily|milestone)
--   tutorial_quest_claim_events  insert   quest_completed (kind tutorial)
--   players.last_heartbeat       gap      session_started / session_ended (qty seconds)
--
-- Same guarantees as the other collectors: a trigger on the row the server
-- writes, in its transaction, gated by the activity switch, and any fault is
-- swallowed with a warning so it can never roll back a claim or a heartbeat.
--
-- A session is a run of heartbeats with no gap longer than 30 minutes. The
-- heartbeat trigger fires only on such a gap (its WHEN clause), so the hot path
-- pays nothing on an ordinary heartbeat. The open session's start is kept in
-- telemetry.player_session_state; telemetry.close_idle_sessions(), run every ten
-- minutes by the activity sampler, ends sessions idle past the gap. Both
-- session events carry the moment they describe (the first and the last
-- heartbeat), not the moment they were written, so a session appears on the day
-- it happened. The length is server time between heartbeats, never a client
-- value.

CREATE TABLE IF NOT EXISTS telemetry.player_session_state (
  player_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL
);
REVOKE ALL ON telemetry.player_session_state FROM PUBLIC;
COMMENT ON TABLE telemetry.player_session_state IS
  'The start of each open play session, one row per player while a session is open; removed when the session is closed.';

-- A session event at the moment it describes. Same checks as
-- telemetry.record_game_event (known event, activity switch), written directly
-- so occurred_at can be the heartbeat rather than now().
CREATE OR REPLACE FUNCTION telemetry.record_session_event(p_player_id uuid, p_event text, p_at timestamptz, p_seconds numeric DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  IF p_event NOT IN ('session_started', 'session_ended') OR p_at IS NULL THEN RETURN; END IF;
  IF NOT telemetry.activity_collection_enabled() THEN RETURN; END IF;
  BEGIN
    INSERT INTO telemetry.game_events(occurred_at, player_id, event, qty)
    VALUES (p_at, p_player_id, p_event, greatest(round(coalesce(p_seconds, 1)), 1));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'game_event_skipped event=% sqlstate=%', p_event, SQLSTATE;
  END;
END
$function$;

CREATE OR REPLACE FUNCTION telemetry.capture_session_gap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_started timestamptz;
BEGIN
  IF NOT telemetry.activity_collection_enabled() THEN RETURN NULL; END IF;
  BEGIN
    -- The session before the gap, if the closer has not ended it yet.
    DELETE FROM telemetry.player_session_state WHERE player_id = NEW.player_id RETURNING started_at INTO v_started;
    IF v_started IS NOT NULL AND OLD.last_heartbeat IS NOT NULL THEN
      PERFORM telemetry.record_session_event(NEW.player_id, 'session_ended', OLD.last_heartbeat,
        extract(epoch FROM (OLD.last_heartbeat - v_started)));
    END IF;
    INSERT INTO telemetry.player_session_state(player_id, started_at) VALUES (NEW.player_id, NEW.last_heartbeat);
    PERFORM telemetry.record_session_event(NEW.player_id, 'session_started', NEW.last_heartbeat, 1);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'game_event_skipped event=session sqlstate=%', SQLSTATE;
  END;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS game_event_session ON public.players;
CREATE TRIGGER game_event_session AFTER UPDATE OF last_heartbeat ON public.players
FOR EACH ROW WHEN (NEW.last_heartbeat IS NOT NULL
  AND (OLD.last_heartbeat IS NULL OR NEW.last_heartbeat > OLD.last_heartbeat + interval '30 minutes'))
EXECUTE FUNCTION telemetry.capture_session_gap();

-- Ends every open session whose last heartbeat is older than the gap, at that
-- heartbeat. A player deleted meanwhile has no heartbeat left: the state row is
-- dropped without an event. Returns how many sessions it ended.
CREATE OR REPLACE FUNCTION telemetry.close_idle_sessions(p_idle_minutes integer DEFAULT 30)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_row record;
  v_closed integer := 0;
BEGIN
  FOR v_row IN
    SELECT s.player_id, s.started_at, p.last_heartbeat
    FROM telemetry.player_session_state s
    LEFT JOIN public.players p ON p.player_id = s.player_id
    WHERE p.player_id IS NULL
       OR p.last_heartbeat < now() - make_interval(mins => least(greatest(coalesce(p_idle_minutes, 30), 5), 240))
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    DELETE FROM telemetry.player_session_state WHERE player_id = v_row.player_id;
    IF v_row.last_heartbeat IS NOT NULL THEN
      PERFORM telemetry.record_session_event(v_row.player_id, 'session_ended', v_row.last_heartbeat,
        extract(epoch FROM (v_row.last_heartbeat - v_row.started_at)));
      v_closed := v_closed + 1;
    END IF;
  END LOOP;
  RETURN v_closed;
END
$function$;

-- Quests: one event per first claim (a replay writes no new claim row).
CREATE OR REPLACE FUNCTION telemetry.capture_quest_activity_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  PERFORM telemetry.record_activity_event(NEW.player_id, 'quest_completed',
    CASE WHEN TG_ARGV[0] = 'tutorial' THEN 'tutorial'
         WHEN NEW.result->>'family' IN ('daily', 'milestone') THEN NEW.result->>'family'
         ELSE 'daily' END);
  RETURN NULL;
END
$function$;

DO $quests$
BEGIN
  IF to_regclass('public.quest_claim_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_quest ON public.quest_claim_events;
    CREATE TRIGGER game_event_quest AFTER INSERT ON public.quest_claim_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_quest_activity_event('quest');
  END IF;
  IF to_regclass('public.tutorial_quest_claim_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_quest ON public.tutorial_quest_claim_events;
    CREATE TRIGGER game_event_quest AFTER INSERT ON public.tutorial_quest_claim_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_quest_activity_event('tutorial');
  END IF;
END
$quests$;

UPDATE telemetry.game_event_kinds SET description = 'One quest reward claimed; kind is daily, milestone or tutorial'
WHERE event = 'quest_completed';
UPDATE telemetry.game_event_kinds SET description = 'One session began at its first heartbeat after a gap of more than 30 minutes'
WHERE event = 'session_started';
UPDATE telemetry.game_event_kinds SET description = 'One session ended at its last heartbeat; qty is its length in seconds'
WHERE event = 'session_ended';

REVOKE ALL ON FUNCTION telemetry.record_session_event(uuid, text, timestamptz, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_session_gap() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.close_idle_sessions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_quest_activity_event() FROM PUBLIC;
