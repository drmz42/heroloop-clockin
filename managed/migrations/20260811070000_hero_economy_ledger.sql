-- Numeric internal accounting only. This ledger performs no blockchain transaction
-- and never changes a player balance.
CREATE TABLE IF NOT EXISTS public.hero_economy_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow text NOT NULL CHECK (flow IN ('treasury_inflow', 'player_issuance')),
  source_kind text NOT NULL CHECK (source_kind ~ '^[a-z0-9_-]{1,64}$'),
  source_key text NOT NULL UNIQUE CHECK (char_length(source_key) BETWEEN 1 AND 160),
  player_id uuid REFERENCES public.players(player_id) ON DELETE SET NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hero_economy_ledger_flow_time
  ON public.hero_economy_ledger(flow, occurred_at DESC);
CREATE INDEX IF NOT EXISTS hero_economy_ledger_source_time
  ON public.hero_economy_ledger(source_kind, occurred_at DESC);
ALTER TABLE public.hero_economy_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hero_economy_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.hero_economy_ledger TO service_role;

CREATE OR REPLACE FUNCTION public.capture_hero_token_spend()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, occurred_at)
  VALUES ('treasury_inflow', NEW.action_kind, 'token_spend:' || NEW.idempotency_key, NEW.player_id, NEW.amount, NEW.created_at)
  ON CONFLICT (source_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_hero_market_fee()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fee numeric;
BEGIN
  IF NEW.action <> 'buy' OR COALESCE(NEW.result->>'fee', '') !~ '^[0-9]+([.][0-9]+)?$' THEN RETURN NEW; END IF;
  v_fee := (NEW.result->>'fee')::numeric;
  IF v_fee > 0 THEN
    INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, metadata, occurred_at)
    VALUES ('treasury_inflow', 'market_fee', 'market_fee:' || NEW.idempotency_key, NEW.player_id, v_fee,
      jsonb_build_object('trade_price', NEW.result->'price', 'listing_id', NEW.result->'listing_id'), NEW.created_at)
    ON CONFLICT (source_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_hero_distribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.amount_distributed > 0 THEN
    INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, amount, metadata, occurred_at)
    VALUES ('player_issuance', 'mining_pool', 'distribution:' || NEW.id, NEW.amount_distributed,
      jsonb_build_object('player_count', NEW.player_count, 'forfeited', NEW.forfeited), NEW.tick_at)
    ON CONFLICT (source_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_hero_promo_issuance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_amount numeric;
BEGIN
  IF COALESCE(NEW.result#>>'{rewards,hero}', '') !~ '^[0-9]+([.][0-9]+)?$' THEN RETURN NEW; END IF;
  v_amount := (NEW.result#>>'{rewards,hero}')::numeric;
  IF v_amount > 0 THEN
    INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, metadata, occurred_at)
    VALUES ('player_issuance', 'promo_code', 'promo:' || NEW.idempotency_key, NEW.player_id, v_amount,
      jsonb_build_object('promo_code_id', NEW.promo_code_id), NEW.redeemed_at)
    ON CONFLICT (source_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_hero_token_spend ON public.token_spend_events;
CREATE TRIGGER capture_hero_token_spend AFTER INSERT ON public.token_spend_events
FOR EACH ROW EXECUTE FUNCTION public.capture_hero_token_spend();
DROP TRIGGER IF EXISTS capture_hero_market_fee ON public.market_item_events;
CREATE TRIGGER capture_hero_market_fee AFTER INSERT ON public.market_item_events
FOR EACH ROW EXECUTE FUNCTION public.capture_hero_market_fee();
DROP TRIGGER IF EXISTS capture_hero_distribution ON public.distribution_log;
CREATE TRIGGER capture_hero_distribution AFTER INSERT ON public.distribution_log
FOR EACH ROW EXECUTE FUNCTION public.capture_hero_distribution();
DROP TRIGGER IF EXISTS capture_hero_promo_issuance ON public.promo_code_redemptions;
CREATE TRIGGER capture_hero_promo_issuance AFTER INSERT ON public.promo_code_redemptions
FOR EACH ROW EXECUTE FUNCTION public.capture_hero_promo_issuance();

REVOKE ALL ON FUNCTION public.capture_hero_token_spend() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capture_hero_market_fee() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capture_hero_distribution() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capture_hero_promo_issuance() FROM PUBLIC, anon, authenticated;

INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, occurred_at)
SELECT 'treasury_inflow', action_kind, 'token_spend:' || idempotency_key, player_id, amount, created_at
FROM public.token_spend_events WHERE amount > 0 ON CONFLICT (source_key) DO NOTHING;

INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, metadata, occurred_at)
SELECT 'treasury_inflow', 'market_fee', 'market_fee:' || idempotency_key, player_id, (result->>'fee')::numeric,
  jsonb_build_object('trade_price', result->'price', 'listing_id', result->'listing_id'), created_at
FROM public.market_item_events
WHERE action = 'buy' AND COALESCE(result->>'fee', '') ~ '^[0-9]+([.][0-9]+)?$' AND (result->>'fee')::numeric > 0
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, amount, metadata, occurred_at)
SELECT 'player_issuance', 'mining_pool', 'distribution:' || id, amount_distributed,
  jsonb_build_object('player_count', player_count, 'forfeited', forfeited), tick_at
FROM public.distribution_log WHERE amount_distributed > 0 ON CONFLICT (source_key) DO NOTHING;
