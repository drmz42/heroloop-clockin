CREATE TABLE public.hero_capacity_upgrade_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  previous_capacity integer NOT NULL CHECK (previous_capacity BETWEEN 500 AND 900 AND previous_capacity % 100 = 0),
  hero_capacity integer NOT NULL CHECK (hero_capacity BETWEEN 600 AND 1000 AND hero_capacity % 100 = 0),
  token_cost numeric NOT NULL CHECK (token_cost > 0),
  catalogue_usd_cents integer NOT NULL CHECK (catalogue_usd_cents BETWEEN 100 AND 500),
  hero_usd_quote_micros integer NOT NULL CHECK (hero_usd_quote_micros > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hero_capacity_upgrade_events_player_created
  ON public.hero_capacity_upgrade_events(player_id, created_at DESC);

ALTER TABLE public.hero_capacity_upgrade_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hero_capacity_upgrade_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_hero_capacity_upgrade(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.hero_capacity_upgrade_events%ROWTYPE;
  v_state jsonb;
  v_revision bigint;
  v_previous_capacity integer;
  v_capacity integer;
  v_tier integer;
  v_catalogue_usd_cents integer;
  v_hero_usd_quote_micros integer := 1000;
  v_cost numeric;
  v_balance numeric;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'invalid_hero_capacity_upgrade';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing
  FROM public.hero_capacity_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.expected_revision <> p_expected_revision THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  IF EXISTS (SELECT 1 FROM public.token_spend_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;

  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;

  SELECT token_balance INTO v_balance
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_previous_capacity := COALESCE((v_state->>'heroCapacity')::integer, 500);
  IF v_previous_capacity < 500 OR v_previous_capacity > 1000 OR v_previous_capacity % 100 <> 0 THEN
    RAISE EXCEPTION 'invalid_save_state';
  END IF;
  IF jsonb_typeof(COALESCE(v_state->'ownedHeroes', 'null'::jsonb)) <> 'array'
    OR jsonb_array_length(v_state->'ownedHeroes') > v_previous_capacity THEN
    RAISE EXCEPTION 'invalid_save_state';
  END IF;
  IF v_previous_capacity >= 1000 THEN RAISE EXCEPTION 'maximum_capacity'; END IF;

  v_tier := ((v_previous_capacity - 500) / 100) + 1;
  v_catalogue_usd_cents := v_tier * 100;
  v_cost := CEIL((v_catalogue_usd_cents * 10000)::numeric / v_hero_usd_quote_micros);
  IF v_balance < v_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  v_capacity := v_previous_capacity + 100;
  v_balance := v_balance - v_cost;
  v_state := jsonb_set(v_state, '{heroCapacity}', to_jsonb(v_capacity), true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id AND revision = p_expected_revision
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'state_conflict'; END IF;

  UPDATE public.players
  SET token_balance = v_balance,
      boost_tokens_spent = boost_tokens_spent + v_cost,
      updated_at = now()
  WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  INSERT INTO public.token_spend_events(idempotency_key, player_id, amount, action_kind)
  VALUES (p_idempotency_key, p_player_id, v_cost, 'hero-capacity-upgrade');

  v_result := jsonb_build_object(
    'previous_capacity', v_previous_capacity,
    'hero_capacity', v_capacity,
    'spent', v_cost,
    'catalogue_usd_cents', v_catalogue_usd_cents,
    'hero_usd_quote_micros', v_hero_usd_quote_micros,
    'token_balance', v_balance,
    'revision', v_revision
  );
  INSERT INTO public.hero_capacity_upgrade_events(
    idempotency_key, player_id, expected_revision, previous_capacity, hero_capacity,
    token_cost, catalogue_usd_cents, hero_usd_quote_micros, result
  ) VALUES (
    p_idempotency_key, p_player_id, p_expected_revision, v_previous_capacity, v_capacity,
    v_cost, v_catalogue_usd_cents, v_hero_usd_quote_micros, v_result
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_hero_capacity_upgrade(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_hero_capacity_upgrade(uuid, uuid, bigint) TO service_role;

COMMENT ON FUNCTION public.settle_hero_capacity_upgrade(uuid, uuid, bigint) IS
  'Idempotently buys the next server-priced permanent +100 Hero-capacity tier.';

DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef('public.settle_hero_summon(uuid,uuid,integer)'::regprocedure);
  v_updated := replace(
    v_definition,
    'jsonb_array_length(v_owned) + p_count > 500',
    'jsonb_array_length(v_owned) + p_count > COALESCE((v_state->>''heroCapacity'')::integer, 500)'
  );
  IF v_updated = v_definition THEN RAISE EXCEPTION 'hero_summon_capacity_patch_failed'; END IF;
  EXECUTE v_updated;
END;
$$;
