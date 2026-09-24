\set ON_ERROR_STOP on

-- Game event foundation: one append-only, server-written record of what players
-- did, so the Founder Control Center and marketing can count it.
--
-- Stage 1 of docs/game/admin-game-analytics-proposal.md. This installs the
-- storage, the allowlist, the daily roll-up, retention and the ledger
-- reconciliation only. Nothing calls telemetry.record_game_event yet, so the
-- tables stay empty until a later stage wires a settlement function to it, and
-- nothing is backfilled: a series begins on the day collection started.
--
-- Events are typed columns, never free text or JSON, so a row cannot carry a
-- wallet, an e-mail, a request body or a player save. player_id is kept only to
-- count distinct players; ON DELETE SET NULL anonymises a deleted account and
-- no admin function returns it.

CREATE SCHEMA IF NOT EXISTS telemetry;

-- The catalogue. An event that is not listed here cannot be recorded, so a typo
-- or an unreviewed event fails loudly instead of creating a silent new series.
CREATE TABLE IF NOT EXISTS telemetry.game_event_kinds (
  event text PRIMARY KEY CHECK (event ~ '^[a-z0-9_]{1,48}$'),
  family text NOT NULL CHECK (family ~ '^[a-z0-9_]{1,24}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200)
);

INSERT INTO telemetry.game_event_kinds(event, family, description) VALUES
  ('chest_opened',    'chest',   'One chest opened; kind is the chest source, outcome empty or bag_full'),
  ('item_dropped',    'chest',   'One item dropped by a chest or reward; rarity and kind are the item slot and source'),
  ('hero_summoned',   'summon',  'One hero summoned; hero_class and rarity are the result, kind is the payment method'),
  ('monster_killed',  'combat',  'Monsters defeated in one settlement; qty is the count, kind is the monster rank'),
  ('boss_killed',     'combat',  'One boss defeated; kind is the boss type'),
  ('boss_summoned',   'combat',  'One boss fight started'),
  ('wave_lost',       'combat',  'One normal wave lost'),
  ('dungeon_started', 'dungeon', 'One dungeon attempt started'),
  ('dungeon_cleared', 'dungeon', 'One dungeon cleared'),
  ('dungeon_failed',  'dungeon', 'One dungeon attempt failed'),
  ('item_enchanted',  'item',    'One enchant attempt; level is the target, outcome is success, fail or destroyed'),
  ('item_sold',       'item',    'One item sold for Gold'),
  ('item_bought',     'item',    'One item bought'),
  ('item_destroyed',  'item',    'One item destroyed outside an enchant attempt'),
  ('hero_ascended',   'hero',    'One hero ascended'),
  ('hero_trained',    'hero',    'One hero trained'),
  ('hero_released',   'hero',    'One hero released'),
  ('hero_rerolled',   'hero',    'One hero rerolled'),
  ('gold_earned',     'gold',    'Gold issued; kind is the source-sink registry kind, qty the amount'),
  ('gold_spent',      'gold',    'Gold spent; kind is the source-sink registry kind, qty the amount'),
  ('token_issued',    'token',   '$HERO issued to a player; kind is the ledger source kind, qty the amount'),
  ('token_spent',     'token',   '$HERO spent by a player; kind is the ledger source kind, qty the amount'),
  ('session_started', 'session', 'One session began'),
  ('session_ended',   'session', 'One session ended; qty is its length in seconds'),
  ('tutorial_step',   'session', 'One tutorial step completed; level is the step number'),
  ('quest_completed', 'quest',   'One quest completed; kind is daily or tutorial')
ON CONFLICT (event) DO NOTHING;

-- Raw rows: recent detail, bounded by the passport's retention.
CREATE TABLE IF NOT EXISTS telemetry.game_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  player_id uuid REFERENCES public.players(player_id) ON DELETE SET NULL,
  event text NOT NULL REFERENCES telemetry.game_event_kinds(event),
  kind text CHECK (kind ~ '^[a-z0-9_-]{1,64}$'),
  rarity text CHECK (rarity ~ '^[a-z0-9_-]{1,32}$'),
  hero_class text CHECK (hero_class ~ '^[a-z0-9_-]{1,32}$'),
  location text CHECK (location ~ '^[a-z0-9_-]{1,64}$'),
  level integer CHECK (level BETWEEN 0 AND 1000),
  outcome text CHECK (outcome ~ '^[a-z0-9_-]{1,32}$'),
  qty numeric NOT NULL DEFAULT 1 CHECK (qty >= 0),
  balance_version text CHECK (balance_version ~ '^[A-Za-z0-9._-]{1,64}$')
);

CREATE INDEX IF NOT EXISTS game_events_event_time_idx ON telemetry.game_events(event, occurred_at DESC);
CREATE INDEX IF NOT EXISTS game_events_time_idx ON telemetry.game_events(occurred_at);

-- Daily roll-up: permanent and small, so history survives the raw retention.
-- Empty string stands for "not applicable" because a primary key cannot hold a
-- null.
CREATE TABLE IF NOT EXISTS telemetry.game_event_daily (
  day date NOT NULL,
  event text NOT NULL REFERENCES telemetry.game_event_kinds(event),
  kind text NOT NULL DEFAULT '',
  rarity text NOT NULL DEFAULT '',
  hero_class text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  level integer NOT NULL DEFAULT -1,
  outcome text NOT NULL DEFAULT '',
  events bigint NOT NULL CHECK (events >= 0),
  qty numeric NOT NULL CHECK (qty >= 0),
  accounts integer NOT NULL CHECK (accounts >= 0),
  PRIMARY KEY (day, event, kind, rarity, hero_class, location, level, outcome)
);

-- Single row: the last UTC day that is rolled up. Raw rows are never purged
-- past it, so a slow roll-up cannot lose a day.
CREATE TABLE IF NOT EXISTS telemetry.game_event_rollup_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  rolled_through date
);
INSERT INTO telemetry.game_event_rollup_state(singleton) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE telemetry.game_event_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.game_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.game_event_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.game_event_rollup_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telemetry.game_event_kinds, telemetry.game_events, telemetry.game_event_daily,
  telemetry.game_event_rollup_state FROM PUBLIC;

COMMENT ON TABLE telemetry.game_events IS
  'Server-written game events (chests, summons, combat, items, Gold, $HERO). Typed columns only; written inside the settlement it describes; retention in storage-passports.';
COMMENT ON TABLE telemetry.game_event_daily IS
  'Permanent per-day roll-up of telemetry.game_events. Aggregate only, no player identifier.';

-- The only way to write an event. Called by settlement functions in the same
-- transaction as the reward, so a rolled-back settlement leaves no event. An
-- unknown event is a foreign-key error, which rolls that settlement back: a
-- wiring mistake must be found in QA, never lost silently in Production.
CREATE OR REPLACE FUNCTION telemetry.record_game_event(
  p_player_id uuid,
  p_event text,
  p_kind text DEFAULT NULL,
  p_rarity text DEFAULT NULL,
  p_hero_class text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_level integer DEFAULT NULL,
  p_outcome text DEFAULT NULL,
  p_qty numeric DEFAULT 1,
  p_balance_version text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  INSERT INTO telemetry.game_events(player_id, event, kind, rarity, hero_class, location, level, outcome, qty, balance_version)
  VALUES (p_player_id, p_event, p_kind, p_rarity, p_hero_class, p_location, p_level, p_outcome, coalesce(p_qty, 1), p_balance_version);
END
$function$;

-- Rolls whole completed UTC days into game_event_daily. Recomputes each day it
-- touches, so running it twice, or late, gives the same rows. Today is never
-- rolled: a partial day would read as a complete one.
CREATE OR REPLACE FUNCTION telemetry.rollup_game_events(p_through date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_through date := least(coalesce(p_through, v_today - 1), v_today - 1);
  v_from date;
  v_day date;
  v_days integer := 0;
BEGIN
  SELECT coalesce(rolled_through + 1, (SELECT (min(occurred_at) AT TIME ZONE 'UTC')::date FROM telemetry.game_events))
    INTO v_from FROM telemetry.game_event_rollup_state;
  IF v_from IS NULL OR v_from > v_through THEN
    RETURN jsonb_build_object('rolled_days', 0, 'rolled_through', (SELECT rolled_through FROM telemetry.game_event_rollup_state));
  END IF;

  FOR v_day IN SELECT generate_series(v_from, v_through, interval '1 day')::date LOOP
    DELETE FROM telemetry.game_event_daily WHERE day = v_day;
    INSERT INTO telemetry.game_event_daily(day, event, kind, rarity, hero_class, location, level, outcome, events, qty, accounts)
    SELECT v_day, event, coalesce(kind, ''), coalesce(rarity, ''), coalesce(hero_class, ''), coalesce(location, ''),
           coalesce(level, -1), coalesce(outcome, ''), count(*), sum(qty), count(DISTINCT player_id)
    FROM telemetry.game_events
    WHERE occurred_at >= v_day::timestamp AT TIME ZONE 'UTC'
      AND occurred_at <  (v_day + 1)::timestamp AT TIME ZONE 'UTC'
    GROUP BY event, coalesce(kind, ''), coalesce(rarity, ''), coalesce(hero_class, ''), coalesce(location, ''),
             coalesce(level, -1), coalesce(outcome, '');
    v_days := v_days + 1;
  END LOOP;

  UPDATE telemetry.game_event_rollup_state SET rolled_through = v_through;
  RETURN jsonb_build_object('rolled_days', v_days, 'rolled_through', v_through);
END
$function$;

-- Deletes raw rows older than the retention window, and only days already
-- rolled up. Class B daily rows are never touched here.
CREATE OR REPLACE FUNCTION telemetry.purge_game_events(p_keep_hours integer DEFAULT 2160)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_cutoff timestamptz := now() - make_interval(hours => greatest(coalesce(p_keep_hours, 2160), 24));
  v_rolled date;
  v_deleted bigint;
BEGIN
  SELECT rolled_through INTO v_rolled FROM telemetry.game_event_rollup_state;
  IF v_rolled IS NULL THEN RETURN 0; END IF;
  v_cutoff := least(v_cutoff, (v_rolled + 1)::timestamp AT TIME ZONE 'UTC');
  DELETE FROM telemetry.game_events WHERE occurred_at < v_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$function$;

-- Report-only. Compares the $HERO ledger with the recorded token events per
-- source kind over one window. It cannot repair either side. A window with no
-- token events at all reports not_collected rather than a false drift.
CREATE OR REPLACE FUNCTION telemetry.reconcile_token_events(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_events bigint;
  v_rows jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '31 days' THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_events FROM telemetry.game_events
  WHERE event IN ('token_issued', 'token_spent') AND occurred_at >= p_from AND occurred_at < p_to;
  IF v_events = 0 THEN
    RETURN jsonb_build_object('status', 'not_collected', 'from', p_from, 'to', p_to);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'source_kind', source_kind, 'ledger', ledger_amount, 'events', event_amount, 'drift', ledger_amount - event_amount
         ) ORDER BY source_kind), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT coalesce(l.source_kind, e.kind) AS source_kind, coalesce(l.amount, 0) AS ledger_amount, coalesce(e.amount, 0) AS event_amount
    FROM (SELECT source_kind, sum(amount) AS amount FROM public.hero_economy_ledger
          WHERE flow = 'player_issuance' AND occurred_at >= p_from AND occurred_at < p_to GROUP BY source_kind) l
    FULL JOIN (SELECT kind, sum(qty) AS amount FROM telemetry.game_events
               WHERE event = 'token_issued' AND occurred_at >= p_from AND occurred_at < p_to GROUP BY kind) e
      ON e.kind = l.source_kind
  ) pairs;

  RETURN jsonb_build_object('status', 'compared', 'from', p_from, 'to', p_to, 'per_source', v_rows,
    'drifting_sources', (SELECT count(*) FROM jsonb_array_elements(v_rows) r WHERE (r->>'drift')::numeric <> 0));
END
$function$;

REVOKE ALL ON FUNCTION telemetry.record_game_event(uuid, text, text, text, text, text, integer, text, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.rollup_game_events(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.purge_game_events(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.reconcile_token_events(timestamptz, timestamptz) FROM PUBLIC;
