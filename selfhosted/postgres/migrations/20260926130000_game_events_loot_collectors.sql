\set ON_ERROR_STOP on

-- Game event collectors for chests and summons.
--
-- Stage 2, second family, of docs/game/admin-game-analytics-proposal.md. Same
-- shape as the $HERO/Gold collectors: a trigger on the row the settlement
-- function inserts, so the event lands in the settlement's own transaction; a
-- rolled-back settlement leaves no event and an idempotent retry that inserts
-- no row records nothing. A collector error is swallowed with a warning so a
-- telemetry fault can never roll back a chest or a summon.
--
-- The settlement rows are written by the server: the chest count, every item
-- id and every hero id come from the server's own roll, never from a client.
-- An item id reads slot[-class]-rarity and a hero id class-rarity, so the
-- slot, class and rarity are split from them; anything that does not match the
-- event table's value rules is skipped rather than guessed.
--
-- One settlement writes one row per group rather than one per item: a chest
-- open of 17 chests is one chest_opened row with qty 17, and its drops are one
-- item_dropped row per slot and rarity with qty the count. Counting a family
-- therefore sums qty, which the catalogue descriptions below now say.
--
-- Collection has its own switch, installed off; Staging turns it on, and
-- Production needs its own Founder approval like the currency switch.

ALTER TABLE telemetry.game_event_settings ADD COLUMN IF NOT EXISTS loot_enabled boolean NOT NULL DEFAULT false;

UPDATE telemetry.game_event_kinds SET description = 'Chests opened in one settlement; qty is the count, kind is the chest source (bag or tutorial)'
WHERE event = 'chest_opened';
UPDATE telemetry.game_event_kinds SET description = 'Items dropped in one settlement; qty is the count, kind is the item slot, rarity the item rarity'
WHERE event = 'item_dropped';
UPDATE telemetry.game_event_kinds SET description = 'Heroes summoned in one settlement; qty is the count, hero_class and rarity the result, kind the payment method'
WHERE event = 'hero_summoned';

-- A value the event table accepts, or null.
CREATE OR REPLACE FUNCTION telemetry.game_event_token(p_value text, p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE WHEN p_value ~ '^[a-z0-9_-]+$' AND char_length(p_value) <= p_max THEN p_value END
$function$;

-- The last dash-separated part of an id (its rarity), and the first (its slot
-- or class).
CREATE OR REPLACE FUNCTION telemetry.game_event_id_rarity(p_id text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT telemetry.game_event_token(substring(p_id FROM '-([a-z0-9_]+)$'), 32)
$function$;

CREATE OR REPLACE FUNCTION telemetry.game_event_id_head(p_id text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT telemetry.game_event_token(substring(p_id FROM '^([a-z0-9_]+)-'), 32)
$function$;

CREATE OR REPLACE FUNCTION telemetry.loot_collection_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, telemetry
AS $function$
  SELECT coalesce((SELECT loot_enabled FROM telemetry.game_event_settings WHERE singleton), false)
$function$;

-- Chest open (bag or tutorial). TG_ARGV[0] is the chest source.
CREATE OR REPLACE FUNCTION telemetry.capture_chest_game_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_drop record;
BEGIN
  IF NOT telemetry.loot_collection_enabled() THEN RETURN NULL; END IF;
  BEGIN
    IF coalesce(NEW.chest_count, 0) > 0 THEN
      PERFORM telemetry.record_game_event(NEW.player_id, 'chest_opened', TG_ARGV[0], NULL, NULL, NULL, NULL, NULL, NEW.chest_count);
    END IF;
    IF jsonb_typeof(NEW.result->'items') = 'array' THEN
      FOR v_drop IN
        SELECT telemetry.game_event_id_head(item->>'itemId') AS slot,
               telemetry.game_event_id_rarity(item->>'itemId') AS rarity,
               count(*) AS dropped
        FROM jsonb_array_elements(NEW.result->'items') AS items(item)
        GROUP BY 1, 2
      LOOP
        CONTINUE WHEN v_drop.slot IS NULL OR v_drop.rarity IS NULL;
        PERFORM telemetry.record_game_event(NEW.player_id, 'item_dropped', v_drop.slot, v_drop.rarity, NULL, NULL, NULL, NULL, v_drop.dropped);
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'game_event_skipped event=chest_opened sqlstate=%', SQLSTATE;
  END;
  RETURN NULL;
END
$function$;

-- Summon: one row per class and rarity, the payment method as kind.
CREATE OR REPLACE FUNCTION telemetry.capture_summon_game_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_group record;
  v_kind text;
BEGIN
  IF NOT telemetry.loot_collection_enabled() THEN RETURN NULL; END IF;
  BEGIN
    v_kind := telemetry.game_event_token(coalesce(NEW.payment_method, 'paid'), 64);
    IF jsonb_typeof(NEW.result->'heroes') = 'array' THEN
      FOR v_group IN
        SELECT telemetry.game_event_id_head(hero->>'heroId') AS hero_class,
               telemetry.game_event_id_rarity(hero->>'heroId') AS rarity,
               count(*) AS summoned
        FROM jsonb_array_elements(NEW.result->'heroes') AS heroes(hero)
        GROUP BY 1, 2
      LOOP
        CONTINUE WHEN v_group.hero_class IS NULL OR v_group.rarity IS NULL;
        PERFORM telemetry.record_game_event(NEW.player_id, 'hero_summoned', v_kind, v_group.rarity, v_group.hero_class, NULL, NULL, NULL, v_group.summoned);
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'game_event_skipped event=hero_summoned sqlstate=%', SQLSTATE;
  END;
  RETURN NULL;
END
$function$;

-- Only tables that exist get a trigger, so this migration also applies to a
-- database where one of the settlements has not been built yet.
DO $triggers$
BEGIN
  IF to_regclass('public.chest_open_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_loot ON public.chest_open_events;
    CREATE TRIGGER game_event_loot AFTER INSERT ON public.chest_open_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_chest_game_event('bag');
  END IF;
  IF to_regclass('public.tutorial_chest_open_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_loot ON public.tutorial_chest_open_events;
    CREATE TRIGGER game_event_loot AFTER INSERT ON public.tutorial_chest_open_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_chest_game_event('tutorial');
  END IF;
  IF to_regclass('public.summon_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_loot ON public.summon_events;
    CREATE TRIGGER game_event_loot AFTER INSERT ON public.summon_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_summon_game_event();
  END IF;
END
$triggers$;

REVOKE ALL ON FUNCTION telemetry.game_event_token(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.game_event_id_rarity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.game_event_id_head(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.loot_collection_enabled() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_chest_game_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_summon_game_event() FROM PUBLIC;
