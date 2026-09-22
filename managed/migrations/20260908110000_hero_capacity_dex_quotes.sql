CREATE TABLE public.hero_usd_dex_quotes (
  quote_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source ~ '^[a-z0-9_-]{1,64}$'),
  mint_address text NOT NULL CHECK (char_length(mint_address) BETWEEN 32 AND 64),
  usd_micros_per_hero numeric NOT NULL CHECK (usd_micros_per_hero > 0),
  source_block bigint NOT NULL CHECK (source_block > 0),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > observed_at),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hero_usd_dex_quotes_fresh_idx
  ON public.hero_usd_dex_quotes(expires_at DESC, observed_at DESC);

CREATE TABLE public.hero_capacity_purchase_quotes (
  quote_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  previous_capacity integer NOT NULL CHECK (previous_capacity BETWEEN 500 AND 900 AND previous_capacity % 100 = 0),
  hero_capacity integer NOT NULL CHECK (hero_capacity BETWEEN 600 AND 1000 AND hero_capacity % 100 = 0),
  catalogue_usd_cents integer NOT NULL CHECK (catalogue_usd_cents BETWEEN 100 AND 500),
  token_cost numeric NOT NULL CHECK (token_cost > 0),
  dex_quote_id uuid NOT NULL REFERENCES public.hero_usd_dex_quotes(quote_id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hero_capacity_purchase_quotes_player_created_idx
  ON public.hero_capacity_purchase_quotes(player_id, created_at DESC);

ALTER TABLE public.hero_usd_dex_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hero_capacity_purchase_quotes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hero_usd_dex_quotes, public.hero_capacity_purchase_quotes
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.hero_capacity_upgrade_events
  ADD COLUMN purchase_quote_id uuid REFERENCES public.hero_capacity_purchase_quotes(quote_id) ON DELETE RESTRICT,
  ADD COLUMN dex_quote_id uuid REFERENCES public.hero_usd_dex_quotes(quote_id) ON DELETE RESTRICT,
  ADD COLUMN dex_source text,
  ADD COLUMN dex_mint_address text,
  ADD COLUMN dex_source_block bigint,
  ADD COLUMN dex_observed_at timestamptz,
  ADD COLUMN quote_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.quote_hero_capacity_upgrade(
  p_player_id uuid,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state jsonb;
  v_revision bigint;
  v_previous_capacity integer;
  v_capacity integer;
  v_tier integer;
  v_catalogue_usd_cents integer;
  v_cost numeric;
  v_dex public.hero_usd_dex_quotes%ROWTYPE;
  v_quote public.hero_capacity_purchase_quotes%ROWTYPE;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'invalid_hero_capacity_quote';
  END IF;
  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_previous_capacity := COALESCE((v_state->>'heroCapacity')::integer, 500);
  IF v_previous_capacity < 500 OR v_previous_capacity > 1000 OR v_previous_capacity % 100 <> 0 THEN
    RAISE EXCEPTION 'invalid_save_state';
  END IF;
  IF v_previous_capacity >= 1000 THEN RAISE EXCEPTION 'maximum_capacity'; END IF;

  SELECT * INTO v_dex
  FROM public.hero_usd_dex_quotes
  WHERE observed_at <= clock_timestamp()
    AND observed_at >= clock_timestamp() - interval '5 minutes'
    AND expires_at > clock_timestamp()
  ORDER BY observed_at DESC, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'dex_quote_unavailable'; END IF;

  v_tier := ((v_previous_capacity - 500) / 100) + 1;
  v_capacity := v_previous_capacity + 100;
  v_catalogue_usd_cents := v_tier * 100;
  v_cost := CEIL((v_catalogue_usd_cents * 10000)::numeric / v_dex.usd_micros_per_hero);
  INSERT INTO public.hero_capacity_purchase_quotes(
    player_id, expected_revision, previous_capacity, hero_capacity,
    catalogue_usd_cents, token_cost, dex_quote_id, expires_at
  ) VALUES (
    p_player_id, v_revision, v_previous_capacity, v_capacity,
    v_catalogue_usd_cents, v_cost, v_dex.quote_id,
    LEAST(v_dex.expires_at, clock_timestamp() + interval '60 seconds')
  ) RETURNING * INTO v_quote;

  RETURN jsonb_build_object(
    'quote_id', v_quote.quote_id,
    'previous_capacity', v_quote.previous_capacity,
    'hero_capacity', v_quote.hero_capacity,
    'catalogue_usd_cents', v_quote.catalogue_usd_cents,
    'token_cost', v_quote.token_cost,
    'hero_usd_quote_micros', v_dex.usd_micros_per_hero,
    'dex_source', v_dex.source,
    'dex_mint_address', v_dex.mint_address,
    'dex_source_block', v_dex.source_block,
    'dex_observed_at', v_dex.observed_at,
    'expires_at', v_quote.expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_hero_capacity_upgrade(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_expected_revision bigint,
  p_quote_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.hero_capacity_upgrade_events%ROWTYPE;
  v_quote public.hero_capacity_purchase_quotes%ROWTYPE;
  v_dex public.hero_usd_dex_quotes%ROWTYPE;
  v_state jsonb;
  v_revision bigint;
  v_balance numeric;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_quote_id IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'invalid_hero_capacity_upgrade';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.hero_capacity_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.expected_revision <> p_expected_revision
      OR v_existing.purchase_quote_id IS DISTINCT FROM p_quote_id THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  IF EXISTS (SELECT 1 FROM public.token_spend_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;
  SELECT * INTO v_quote FROM public.hero_capacity_purchase_quotes
  WHERE quote_id = p_quote_id AND player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'hero_capacity_quote_not_found'; END IF;
  IF v_quote.expected_revision <> p_expected_revision THEN RAISE EXCEPTION 'quote_revision_mismatch'; END IF;
  IF v_quote.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'hero_capacity_quote_expired'; END IF;
  SELECT * INTO v_dex FROM public.hero_usd_dex_quotes WHERE quote_id = v_quote.dex_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dex_quote_unavailable'; END IF;

  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  IF COALESCE((v_state->>'heroCapacity')::integer, 500) <> v_quote.previous_capacity THEN
    RAISE EXCEPTION 'hero_capacity_quote_stale';
  END IF;
  SELECT token_balance INTO v_balance FROM public.players
  WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF v_balance < v_quote.token_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  v_balance := v_balance - v_quote.token_cost;
  v_state := jsonb_set(v_state, '{heroCapacity}', to_jsonb(v_quote.hero_capacity), true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);
  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE player_id = p_player_id AND revision = p_expected_revision
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'state_conflict'; END IF;
  UPDATE public.players
  SET token_balance = v_balance,
      boost_tokens_spent = boost_tokens_spent + v_quote.token_cost,
      updated_at = clock_timestamp()
  WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  INSERT INTO public.token_spend_events(idempotency_key,player_id,amount,action_kind)
  VALUES (p_idempotency_key,p_player_id,v_quote.token_cost,'hero-capacity-upgrade');

  v_result := jsonb_build_object(
    'quote_id', v_quote.quote_id,
    'previous_capacity', v_quote.previous_capacity,
    'hero_capacity', v_quote.hero_capacity,
    'spent', v_quote.token_cost,
    'catalogue_usd_cents', v_quote.catalogue_usd_cents,
    'hero_usd_quote_micros', v_dex.usd_micros_per_hero,
    'token_balance', v_balance,
    'revision', v_revision,
    'dex_source', v_dex.source,
    'dex_mint_address', v_dex.mint_address,
    'dex_source_block', v_dex.source_block,
    'dex_observed_at', v_dex.observed_at,
    'quote_expires_at', v_quote.expires_at
  );
  INSERT INTO public.hero_capacity_upgrade_events(
    idempotency_key,player_id,expected_revision,previous_capacity,hero_capacity,
    token_cost,catalogue_usd_cents,hero_usd_quote_micros,result,purchase_quote_id,dex_quote_id,
    dex_source,dex_mint_address,dex_source_block,dex_observed_at,quote_expires_at
  ) VALUES (
    p_idempotency_key,p_player_id,p_expected_revision,v_quote.previous_capacity,v_quote.hero_capacity,
    v_quote.token_cost,v_quote.catalogue_usd_cents,v_dex.usd_micros_per_hero,v_result,v_quote.quote_id,v_dex.quote_id,
    v_dex.source,v_dex.mint_address,v_dex.source_block,v_dex.observed_at,v_quote.expires_at
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_hero_capacity_upgrade(uuid,uuid,bigint) FROM service_role;
REVOKE ALL ON FUNCTION public.quote_hero_capacity_upgrade(uuid,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_hero_capacity_upgrade(uuid,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.quote_hero_capacity_upgrade(uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_hero_capacity_upgrade(uuid,uuid,bigint,uuid) TO service_role;

COMMENT ON TABLE public.hero_usd_dex_quotes IS
  'Trusted short-lived post-TGE HERO/USD DEX observations. No browser or API role can insert a quote.';
COMMENT ON FUNCTION public.quote_hero_capacity_upgrade(uuid,bigint) IS
  'Locks the next USD catalogue tier to one fresh server-owned DEX observation for at most 60 seconds.';
