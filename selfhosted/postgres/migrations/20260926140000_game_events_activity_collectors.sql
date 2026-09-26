\set ON_ERROR_STOP on

-- Game event collectors for combat, dungeons, items and heroes.
--
-- Stage 2, third family, of docs/game/admin-game-analytics-proposal.md. Same
-- guarantees as the currency and loot collectors: a trigger on the row the
-- settlement function writes, in its own transaction, so a rolled-back
-- settlement leaves no event and a retry that writes no new row or makes no
-- state transition records nothing; a collector error is swallowed with a
-- warning and never rolls back the settlement. Every value comes from the
-- server's settlement row, never from a client.
--
--   normal_combat_events   completion  monster_killed (qty kills, location), wave_lost
--   boss_encounters        insert      boss_summoned (location, kind field|dungeon)
--                          won         boss_killed
--   dungeon_encounters     insert      dungeon_started (level depth)
--                          completed   dungeon_cleared
--                          failed      dungeon_failed (outcome failed|abandoned)
--   item_upgrade_events    enchant     item_enchanted (level target, outcome, rarity)
--   item_mutation_events   sell        item_sold (qty items)
--   hero_ascension_events  insert      hero_ascended (qty stars, kind single)
--   hero_promote_all_events insert     hero_ascended (qty stars, kind promote_all)
--   hero_release_events    insert      hero_released
--   training_assignment_events insert  hero_trained (only when a hero is placed)
--
-- Collection has its own switch, installed off; Staging turns it on, and
-- Production needs its own Founder approval.

ALTER TABLE telemetry.game_event_settings ADD COLUMN IF NOT EXISTS activity_enabled boolean NOT NULL DEFAULT false;

UPDATE telemetry.game_event_kinds SET description = 'Stars added by one ascension or promote-all; qty is the stars, kind single or promote_all'
WHERE event = 'hero_ascended';
UPDATE telemetry.game_event_kinds SET description = 'One boss fight started; kind is field or dungeon, location the map location'
WHERE event = 'boss_summoned';
UPDATE telemetry.game_event_kinds SET description = 'One boss defeated; kind is field or dungeon, location the map location'
WHERE event = 'boss_killed';
UPDATE telemetry.game_event_kinds SET description = 'Items sold for Gold in one settlement; qty is the count'
WHERE event = 'item_sold';

CREATE OR REPLACE FUNCTION telemetry.activity_collection_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, telemetry
AS $function$
  SELECT coalesce((SELECT activity_enabled FROM telemetry.game_event_settings WHERE singleton), false)
$function$;

-- One event, skipped with a warning on any fault. Every collector below goes
-- through here so none of them can roll back its settlement.
CREATE OR REPLACE FUNCTION telemetry.record_activity_event(
  p_player_id uuid, p_event text, p_kind text DEFAULT NULL, p_rarity text DEFAULT NULL, p_location text DEFAULT NULL,
  p_level integer DEFAULT NULL, p_outcome text DEFAULT NULL, p_qty numeric DEFAULT 1, p_balance_version text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN; END IF;
  IF NOT telemetry.activity_collection_enabled() THEN RETURN; END IF;
  BEGIN
    PERFORM telemetry.record_game_event(p_player_id, p_event, p_kind, p_rarity, NULL, p_location, p_level, p_outcome, p_qty,
      CASE WHEN p_balance_version ~ '^[A-Za-z0-9._-]{1,64}$' THEN p_balance_version END);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'game_event_skipped event=% sqlstate=%', p_event, SQLSTATE;
  END;
END
$function$;

-- Normal combat completes once: completed_at goes from null to set. Kills come
-- from the settled reward, the result from the precomputed outcome.
CREATE OR REPLACE FUNCTION telemetry.capture_combat_activity_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  PERFORM telemetry.record_activity_event(NEW.player_id, 'monster_killed', NULL, NULL, NEW.location::text, NULL, NULL,
    telemetry.game_event_amount(NEW.result #>> '{rewards,kills}'), NEW.balance_version);
  IF NEW.outcome->>'status' = 'failed' THEN
    PERFORM telemetry.record_activity_event(NEW.player_id, 'wave_lost', NULL, NULL, NEW.location::text, NULL, NULL, 1, NEW.balance_version);
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION telemetry.capture_boss_activity_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_kind text := CASE WHEN NEW.dungeon_encounter_id IS NULL THEN 'field' ELSE 'dungeon' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM telemetry.record_activity_event(NEW.player_id, 'boss_summoned', v_kind, NULL, NEW.location_id::text, NULL, NULL, 1, NEW.balance_version);
  -- A win is the step out of active into won, or straight into claimed; the
  -- later won-to-claimed step is the reward claim, not a second kill.
  ELSIF OLD.status = 'active' AND NEW.status IN ('won', 'claimed') THEN
    PERFORM telemetry.record_activity_event(NEW.player_id, 'boss_killed', v_kind, NULL, NEW.location_id::text, NULL, NULL, 1, NEW.balance_version);
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION telemetry.capture_dungeon_activity_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM telemetry.record_activity_event(NEW.player_id, 'dungeon_started', NULL, NULL, NULL, NEW.depth, NULL, 1, NEW.balance_version);
  ELSIF NEW.status = 'completed' AND OLD.status = 'active' THEN
    PERFORM telemetry.record_activity_event(NEW.player_id, 'dungeon_cleared', NULL, NULL, NULL, NEW.depth, NULL, 1, NEW.balance_version);
  ELSIF NEW.status IN ('failed', 'abandoned') AND OLD.status = 'active' THEN
    PERFORM telemetry.record_activity_event(NEW.player_id, 'dungeon_failed', NULL, NULL, NULL, NEW.depth, NEW.status, 1, NEW.balance_version);
  END IF;
  RETURN NULL;
END
$function$;

-- Enchant: the target level is the level reached on success and one above the
-- level kept on a failure or a destruction.
CREATE OR REPLACE FUNCTION telemetry.capture_enchant_activity_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_success boolean := (NEW.result->>'success') = 'true';
  v_destroyed boolean := (NEW.result->>'destroyed') = 'true';
  v_level integer;
BEGIN
  IF (NEW.result #>> '{item,enchantLevel}') ~ '^[0-9]{1,3}$' THEN
    v_level := (NEW.result #>> '{item,enchantLevel}')::integer + CASE WHEN v_success THEN 0 ELSE 1 END;
  END IF;
  PERFORM telemetry.record_activity_event(NEW.player_id, 'item_enchanted', NULL,
    telemetry.game_event_id_rarity(NEW.result #>> '{item,itemId}'), NULL, v_level,
    CASE WHEN v_destroyed THEN 'destroyed' WHEN v_success THEN 'success' ELSE 'fail' END, 1, NEW.result->>'balance_version');
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION telemetry.capture_sale_activity_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  PERFORM telemetry.record_activity_event(NEW.player_id, 'item_sold', NULL, NULL, NULL, NULL, NULL,
    coalesce(cardinality(NEW.item_ids), 0));
  RETURN NULL;
END
$function$;

-- Heroes. TG_ARGV[0] names the event, TG_ARGV[1] the kind; the ascension
-- tables carry the stars added in their result.
CREATE OR REPLACE FUNCTION telemetry.capture_hero_activity_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_qty numeric := 1;
BEGIN
  IF TG_ARGV[0] = 'hero_ascended' THEN
    v_qty := telemetry.game_event_amount(NEW.result->>'stars_added');
  END IF;
  PERFORM telemetry.record_activity_event(NEW.player_id, TG_ARGV[0], nullif(TG_ARGV[1], ''), NULL, NULL, NULL, NULL, v_qty);
  RETURN NULL;
END
$function$;

-- Only tables that exist get a trigger.
DO $triggers$
BEGIN
  IF to_regclass('public.normal_combat_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.normal_combat_events;
    CREATE TRIGGER game_event_activity AFTER UPDATE ON public.normal_combat_events
    FOR EACH ROW WHEN (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL)
    EXECUTE FUNCTION telemetry.capture_combat_activity_event();
  END IF;
  IF to_regclass('public.boss_encounters') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.boss_encounters;
    CREATE TRIGGER game_event_activity AFTER INSERT OR UPDATE OF status ON public.boss_encounters
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_boss_activity_event();
  END IF;
  IF to_regclass('public.dungeon_encounters') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.dungeon_encounters;
    CREATE TRIGGER game_event_activity AFTER INSERT OR UPDATE OF status ON public.dungeon_encounters
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_dungeon_activity_event();
  END IF;
  IF to_regclass('public.item_upgrade_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.item_upgrade_events;
    CREATE TRIGGER game_event_activity AFTER INSERT ON public.item_upgrade_events
    FOR EACH ROW WHEN (NEW.action_kind = 'enchant')
    EXECUTE FUNCTION telemetry.capture_enchant_activity_event();
  END IF;
  IF to_regclass('public.item_mutation_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.item_mutation_events;
    CREATE TRIGGER game_event_activity AFTER INSERT ON public.item_mutation_events
    FOR EACH ROW WHEN (NEW.action_kind = 'sell')
    EXECUTE FUNCTION telemetry.capture_sale_activity_event();
  END IF;
  IF to_regclass('public.hero_ascension_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.hero_ascension_events;
    CREATE TRIGGER game_event_activity AFTER INSERT ON public.hero_ascension_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_hero_activity_event('hero_ascended', 'single');
  END IF;
  IF to_regclass('public.hero_promote_all_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.hero_promote_all_events;
    CREATE TRIGGER game_event_activity AFTER INSERT ON public.hero_promote_all_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_hero_activity_event('hero_ascended', 'promote_all');
  END IF;
  IF to_regclass('public.hero_release_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.hero_release_events;
    CREATE TRIGGER game_event_activity AFTER INSERT ON public.hero_release_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.capture_hero_activity_event('hero_released', '');
  END IF;
  IF to_regclass('public.training_assignment_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS game_event_activity ON public.training_assignment_events;
    CREATE TRIGGER game_event_activity AFTER INSERT ON public.training_assignment_events
    FOR EACH ROW WHEN (NEW.hero_uid IS NOT NULL)
    EXECUTE FUNCTION telemetry.capture_hero_activity_event('hero_trained', '');
  END IF;
END
$triggers$;

REVOKE ALL ON FUNCTION telemetry.activity_collection_enabled() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.record_activity_event(uuid, text, text, text, text, integer, text, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_combat_activity_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_boss_activity_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_dungeon_activity_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_enchant_activity_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_sale_activity_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_hero_activity_event() FROM PUBLIC;
