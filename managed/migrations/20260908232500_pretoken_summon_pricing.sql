-- Pre-token Staging pricing. This path is reachable only through the
-- self-hosted API when TESTER_CONTROLS_ENABLED=true. It preserves the
-- server-authoritative quote/settlement boundary without pretending that a
-- live HERO market exists.
CREATE OR REPLACE FUNCTION public.quote_test_hero_summon(
  p_player_id uuid,
  p_expected_revision bigint,
  p_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state jsonb;
  v_revision bigint;
  v_cost numeric;
  v_dex_quote_id uuid;
  v_quote public.hero_summon_purchase_quotes%ROWTYPE;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 1 OR p_count NOT IN (1, 10, 100) THEN
    RAISE EXCEPTION 'invalid_hero_summon_quote';
  END IF;
  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  IF jsonb_typeof(v_state->'ownedHeroes') <> 'array' THEN RAISE EXCEPTION 'invalid_owned_heroes'; END IF;
  IF jsonb_array_length(v_state->'ownedHeroes') + p_count > COALESCE((v_state->>'heroCapacity')::integer, 500) THEN
    RAISE EXCEPTION 'hero_capacity_exceeded';
  END IF;

  v_cost := p_count * 20;
  -- The legacy settlement schema requires a quote reference. Its observation
  -- is deliberately future-dated so no DEX-backed product can select it.
  INSERT INTO public.hero_usd_dex_quotes(
    source, mint_address, usd_micros_per_hero, source_block, observed_at, expires_at
  ) VALUES (
    'pretoken_test', 'HeroTest11111111111111111111111111111111111', 1000, 1,
    clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day 1 minute'
  ) RETURNING quote_id INTO v_dex_quote_id;

  INSERT INTO public.hero_summon_purchase_quotes(
    player_id, expected_revision, summon_count, catalogue_usd_micros,
    token_cost, dex_quote_id, expires_at
  ) VALUES (
    p_player_id, v_revision, p_count, p_count * 20000,
    v_cost, v_dex_quote_id, clock_timestamp() + interval '60 seconds'
  ) RETURNING * INTO v_quote;

  RETURN jsonb_build_object(
    'quote_id', v_quote.quote_id,
    'summon_count', v_quote.summon_count,
    'pricing_mode', 'test_hero',
    'token_cost', v_quote.token_cost,
    'expires_at', v_quote.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.quote_test_hero_summon(uuid,bigint,integer)
  FROM PUBLIC, anon, authenticated, service_role;
