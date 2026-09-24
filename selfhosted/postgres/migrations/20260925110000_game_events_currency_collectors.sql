\set ON_ERROR_STOP on

-- Game event collectors for $HERO and Gold.
--
-- Stage 2 of docs/game/admin-game-analytics-proposal.md. Each collector is a
-- trigger on the row a settlement function writes, so the event is recorded in
-- the settlement's own transaction: a rolled-back settlement leaves no event,
-- and an idempotent retry that writes no new row records nothing.
--
-- Collection has its own switch, installed off. The economy-v1 collectors and
-- their gate are untouched. A collector error is swallowed with a warning so a
-- telemetry fault can never roll back a reward.
--
-- $HERO events mirror public.hero_economy_ledger one row to one event, with the
-- ledger's own source kind, so telemetry.reconcile_token_events can compare
-- them. Gold events use the source-sink registry ids; the quest settlement
-- books daily and milestone quests under one ledger kind, so both families are
-- daily_quest_gold here too. tester_gold (Staging-only) is not collected.

CREATE TABLE IF NOT EXISTS telemetry.game_event_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  currency_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO telemetry.game_event_settings(singleton) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE telemetry.game_event_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telemetry.game_event_settings FROM PUBLIC;

COMMENT ON TABLE telemetry.game_event_settings IS
  'Root-operated switch for game event collectors; installed off. Production collection needs its own Founder approval.';

-- A positive decimal from a settlement result, or null for anything else.
CREATE OR REPLACE FUNCTION telemetry.game_event_amount(p_value text)
RETURNS numeric LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE WHEN p_value ~ '^[0-9]{1,30}([.][0-9]{1,18})?$' THEN nullif(p_value::numeric, 0) END
$function$;

CREATE OR REPLACE FUNCTION telemetry.record_currency_event(
  p_player_id uuid,
  p_event text,
  p_kind text,
  p_qty numeric,
  p_location text DEFAULT NULL,
  p_balance_version text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN; END IF;
  IF NOT coalesce((SELECT currency_enabled FROM telemetry.game_event_settings WHERE singleton), false) THEN RETURN; END IF;
  BEGIN
    PERFORM telemetry.record_game_event(p_player_id, p_event, p_kind, NULL, NULL, p_location, NULL, NULL, p_qty,
      CASE WHEN p_balance_version ~ '^[A-Za-z0-9._-]{1,64}$' THEN p_balance_version END);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'game_event_skipped event=% sqlstate=%', p_event, SQLSTATE;
  END;
END
$function$;

-- $HERO: one ledger row, one event. ON CONFLICT DO NOTHING in the ledger
-- writers inserts no row, so a duplicate settlement records nothing.
CREATE OR REPLACE FUNCTION telemetry.capture_token_game_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  PERFORM telemetry.record_currency_event(NEW.player_id,
    CASE NEW.flow WHEN 'player_issuance' THEN 'token_issued' WHEN 'treasury_inflow' THEN 'token_spent' END,
    NEW.source_kind, NEW.amount);
  RETURN NULL;
END
$function$;

-- Gold on an inserted settlement row. TG_ARGV: event, registry kind, JSON path
-- of the amount inside result.
CREATE OR REPLACE FUNCTION telemetry.capture_gold_game_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  PERFORM telemetry.record_currency_event(NEW.player_id, TG_ARGV[0], TG_ARGV[1],
    telemetry.game_event_amount(NEW.result #>> TG_ARGV[2]::text[]));
  RETURN NULL;
END
$function$;

-- Normal combat settles by updating its row several times in one transaction:
-- completion sets completed_at with the wave reward, auto-pot then adds the
-- potion cost, and the compact receipt rewrites the result under another key.
-- Wave Gold is recorded on the completion transition and potion Gold the first
-- time a potion cost appears, so each is recorded once whatever the shape.
CREATE OR REPLACE FUNCTION telemetry.capture_combat_gold_game_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
DECLARE
  v_potion_new numeric := coalesce(telemetry.game_event_amount(NEW.result #>> '{auto_pot,gold_spent}'),
                                   telemetry.game_event_amount(NEW.result #>> '{flags,auto_pot_gold_spent}'));
  v_potion_old numeric := coalesce(telemetry.game_event_amount(OLD.result #>> '{auto_pot,gold_spent}'),
                                   telemetry.game_event_amount(OLD.result #>> '{flags,auto_pot_gold_spent}'));
BEGIN
  IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
    PERFORM telemetry.record_currency_event(NEW.player_id, 'gold_earned', 'combat_wave_gold',
      telemetry.game_event_amount(NEW.result #>> '{rewards,gold}'), NEW.location::text, NEW.balance_version);
  END IF;
  IF NEW.completed_at IS NOT NULL AND v_potion_new IS NOT NULL AND v_potion_old IS NULL THEN
    PERFORM telemetry.record_currency_event(NEW.player_id, 'gold_spent', 'potion_gold',
      v_potion_new, NEW.location::text, NEW.balance_version);
  END IF;
  RETURN NULL;
END
$function$;

-- The 500 starting Gold of a new, non-imported account.
CREATE OR REPLACE FUNCTION telemetry.capture_starter_gold_game_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  IF NOT coalesce(NEW.imported_legacy, false)
    AND NEW.state->>'gold' = '500' AND NEW.state->>'accountLevel' = '1' THEN
    PERFORM telemetry.record_currency_event(NEW.player_id, 'gold_earned', 'starter_gold', 500);
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS game_event_token ON public.hero_economy_ledger;
CREATE TRIGGER game_event_token AFTER INSERT ON public.hero_economy_ledger
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_token_game_event();

DROP TRIGGER IF EXISTS game_event_gold ON public.normal_combat_events;
CREATE TRIGGER game_event_gold AFTER UPDATE ON public.normal_combat_events
FOR EACH ROW WHEN (NEW.completed_at IS NOT NULL
  AND (OLD.completed_at IS NULL OR OLD.result IS DISTINCT FROM NEW.result))
EXECUTE FUNCTION telemetry.capture_combat_gold_game_event();

DROP TRIGGER IF EXISTS game_event_gold ON public.quest_claim_events;
CREATE TRIGGER game_event_gold AFTER INSERT ON public.quest_claim_events
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_gold_game_event('gold_earned', 'daily_quest_gold', '{reward,gold}');

DROP TRIGGER IF EXISTS game_event_gold ON public.tutorial_quest_claim_events;
CREATE TRIGGER game_event_gold AFTER INSERT ON public.tutorial_quest_claim_events
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_gold_game_event('gold_earned', 'tutorial_quest_gold', '{reward,gold}');

DROP TRIGGER IF EXISTS game_event_gold ON public.promo_code_redemptions;
CREATE TRIGGER game_event_gold AFTER INSERT ON public.promo_code_redemptions
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_gold_game_event('gold_earned', 'promo_gold', '{rewards,gold}');

DROP TRIGGER IF EXISTS game_event_gold ON public.boss_claim_events;
CREATE TRIGGER game_event_gold AFTER INSERT ON public.boss_claim_events
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_gold_game_event('gold_earned', 'boss_combat_gold', '{gold}');

DROP TRIGGER IF EXISTS game_event_gold ON public.item_mutation_events;
CREATE TRIGGER game_event_gold AFTER INSERT ON public.item_mutation_events
FOR EACH ROW WHEN (NEW.action_kind = 'sell')
EXECUTE FUNCTION telemetry.capture_gold_game_event('gold_earned', 'item_sale_gold', '{gold_refund}');

DROP TRIGGER IF EXISTS game_event_gold ON public.store_purchase_events;
CREATE TRIGGER game_event_gold AFTER INSERT ON public.store_purchase_events
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_gold_game_event('gold_spent', 'store_gold', '{price}');

DROP TRIGGER IF EXISTS game_event_gold ON public.item_upgrade_events;
CREATE TRIGGER game_event_gold AFTER INSERT ON public.item_upgrade_events
FOR EACH ROW WHEN (NEW.action_kind = 'enchant')
EXECUTE FUNCTION telemetry.capture_gold_game_event('gold_spent', 'enchant_gold', '{gold_cost}');

DROP TRIGGER IF EXISTS game_event_starter_gold ON public.player_saves;
CREATE TRIGGER game_event_starter_gold AFTER INSERT ON public.player_saves
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_starter_gold_game_event();

REVOKE ALL ON FUNCTION telemetry.game_event_amount(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.record_currency_event(uuid, text, text, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_token_game_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_gold_game_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_combat_gold_game_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION telemetry.capture_starter_gold_game_event() FROM PUBLIC;
