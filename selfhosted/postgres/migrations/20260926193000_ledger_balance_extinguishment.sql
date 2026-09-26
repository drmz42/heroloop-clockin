\set ON_ERROR_STOP on

-- $HERO ledger: a surviving record of the balance an account deletion removes
-- (config/economy/hero-ledger-reconciliation.v1.json, currentCoverageBlockers
-- "account_delete"; docs/game/progression-and-economy.md).
--
-- Deleting a player removes token_balance and pending_tokens with the row, and
-- nothing in the ledger said so, so the global equation
--   verified baseline + player_issuance - treasury_inflow - balance_extinguishment
-- drifted by exactly that amount after every deletion. A BEFORE DELETE trigger
-- on public.players now writes one balance_extinguishment row whatever deleted
-- the account (the player's own deletion, the Control Center, a cascade from
-- auth.users, a QA cleanup), in the same transaction, so a rolled-back deletion
-- leaves no row.
--
-- The row carries no player_id: the account is gone, and a per-player reader
-- (the risk detector, the hourly settlement collector) must not count it as
-- that player's activity. The source key names the deleted account id, which
-- identifies nobody once the sign-in identity is deleted, and the deleting
-- transaction, so an id that is recreated and deleted again is booked again.
-- Extinguishment is not a burn, a treasury receipt or revenue: it only states
-- that balance left the player total.

DO $flow$
DECLARE
  v_constraint text;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.hero_economy_ledger'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%flow%'
  LOOP
    EXECUTE format('ALTER TABLE public.hero_economy_ledger DROP CONSTRAINT %I', v_constraint);
  END LOOP;
  ALTER TABLE public.hero_economy_ledger ADD CONSTRAINT hero_economy_ledger_flow_check
    CHECK (flow IN ('treasury_inflow', 'player_issuance', 'balance_extinguishment'));
END
$flow$;

CREATE OR REPLACE FUNCTION public.capture_hero_balance_extinguishment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_balance numeric := coalesce(OLD.token_balance, 0);
  v_pending numeric := coalesce(OLD.pending_tokens, 0);
BEGIN
  IF v_balance + v_pending > 0 THEN
    INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, metadata, occurred_at)
    VALUES ('balance_extinguishment', 'account_balance_extinguishment', 'account_delete:' || OLD.player_id || ':' || txid_current(), NULL,
      v_balance + v_pending, jsonb_build_object('token_balance', v_balance, 'pending_tokens', v_pending), now())
    ON CONFLICT (source_key) DO NOTHING;
  END IF;
  RETURN OLD;
END
$function$;

DROP TRIGGER IF EXISTS capture_hero_balance_extinguishment ON public.players;
CREATE TRIGGER capture_hero_balance_extinguishment BEFORE DELETE ON public.players
FOR EACH ROW EXECUTE FUNCTION public.capture_hero_balance_extinguishment();

REVOKE ALL ON FUNCTION public.capture_hero_balance_extinguishment() FROM PUBLIC;

-- The $HERO game event mirrors issuance and spending only. An extinguishment is
-- neither, and the account it came from no longer exists, so it records none.
CREATE OR REPLACE FUNCTION telemetry.capture_token_game_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry, public
AS $function$
BEGIN
  IF NEW.flow NOT IN ('player_issuance', 'treasury_inflow') THEN RETURN NULL; END IF;
  PERFORM telemetry.record_currency_event(NEW.player_id,
    CASE NEW.flow WHEN 'player_issuance' THEN 'token_issued' WHEN 'treasury_inflow' THEN 'token_spent' END,
    NEW.source_kind, NEW.amount);
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION telemetry.capture_token_game_event() FROM PUBLIC;

COMMENT ON FUNCTION public.capture_hero_balance_extinguishment() IS
  'Books the token_balance + pending_tokens a player deletion removes as one balance_extinguishment ledger row, without a player id, in the deleting transaction.';
