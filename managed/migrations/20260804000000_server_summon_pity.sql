ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS pity_legendary bigint NOT NULL DEFAULT 0 CHECK (pity_legendary >= 0),
  ADD COLUMN IF NOT EXISTS pity_mythic bigint NOT NULL DEFAULT 0 CHECK (pity_mythic >= 0),
  ADD COLUMN IF NOT EXISTS pity_cosmic bigint NOT NULL DEFAULT 0 CHECK (pity_cosmic >= 0),
  ADD COLUMN IF NOT EXISTS pity_divine bigint NOT NULL DEFAULT 0 CHECK (pity_divine >= 0);

CREATE TABLE IF NOT EXISTS public.summon_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  summon_count integer NOT NULL CHECK (summon_count IN (1, 10, 100)),
  token_cost numeric NOT NULL CHECK (token_cost > 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS summon_events_player_created_idx
  ON public.summon_events (player_id, created_at DESC);

ALTER TABLE public.summon_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.summon_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_hero_summon(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.summon_events%ROWTYPE;
  v_state jsonb;
  v_owned jsonb;
  v_results jsonb := '[]'::jsonb;
  v_balance numeric;
  v_cost numeric;
  v_legendary bigint;
  v_mythic bigint;
  v_cosmic bigint;
  v_divine bigint;
  v_min_rarity text;
  v_rarity text;
  v_class text;
  v_roll double precision;
  v_extra_pct double precision;
  v_uid text;
  v_hero jsonb;
  v_result jsonb;
  v_summons bigint;
  v_revision bigint;
  i integer;
BEGIN
  IF p_count NOT IN (1, 10, 100) THEN
    RAISE EXCEPTION 'invalid_summon_count';
  END IF;

  SELECT * INTO v_existing
  FROM public.summon_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.summon_count <> p_count THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  SELECT token_balance, pity_legendary, pity_mythic, pity_cosmic, pity_divine
  INTO v_balance, v_legendary, v_mythic, v_cosmic, v_divine
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  SELECT * INTO v_existing
  FROM public.summon_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.summon_count <> p_count THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  v_cost := p_count * 30;
  IF v_balance < v_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' THEN RAISE EXCEPTION 'invalid_owned_heroes'; END IF;
  IF jsonb_array_length(v_owned) + p_count > 500 THEN RAISE EXCEPTION 'hero_capacity_exceeded'; END IF;

  FOR i IN 1..p_count LOOP
    v_min_rarity := CASE
      WHEN v_divine >= 9999 THEN 'divine'
      WHEN v_cosmic >= 2499 THEN 'cosmic'
      WHEN v_mythic >= 499 THEN 'mythic'
      WHEN v_legendary >= 99 THEN 'legendary'
      ELSE NULL
    END;
    v_roll := random();

    IF v_min_rarity = 'divine' THEN
      v_rarity := CASE WHEN v_roll < 0.9 THEN 'divine' ELSE 'celestial' END;
    ELSIF v_min_rarity = 'cosmic' THEN
      v_rarity := CASE
        WHEN v_roll < 0.8 THEN 'cosmic'
        WHEN v_roll < 0.98 THEN 'divine'
        ELSE 'celestial'
      END;
    ELSIF v_min_rarity = 'mythic' THEN
      v_rarity := CASE
        WHEN v_roll < 0.8 THEN 'mythic'
        WHEN v_roll < 0.96 THEN 'cosmic'
        WHEN v_roll < 0.996 THEN 'divine'
        ELSE 'celestial'
      END;
    ELSIF v_min_rarity = 'legendary' THEN
      v_rarity := CASE
        WHEN v_roll < 0.75 THEN 'legendary'
        WHEN v_roll < 0.95 THEN 'mythic'
        WHEN v_roll < 0.99 THEN 'cosmic'
        WHEN v_roll < 0.999 THEN 'divine'
        ELSE 'celestial'
      END;
    ELSE
      v_extra_pct := CASE WHEN v_mythic >= 200 THEN LEAST(2.99, (v_mythic - 199) * 0.01) ELSE 0 END;
      v_roll := v_roll * 100;
      v_rarity := CASE
        WHEN v_roll < 55 - v_extra_pct THEN 'common'
        WHEN v_roll < 82 - v_extra_pct THEN 'uncommon'
        WHEN v_roll < 94 - v_extra_pct THEN 'rare'
        WHEN v_roll < 98 - v_extra_pct THEN 'epic'
        WHEN v_roll < 99.5 - v_extra_pct THEN 'legendary'
        WHEN v_roll < 99.9 THEN 'mythic'
        WHEN v_roll < 99.98 THEN 'cosmic'
        WHEN v_roll < 99.998 THEN 'divine'
        ELSE 'celestial'
      END;
    END IF;

    v_class := (ARRAY['shepherd', 'assassin', 'knight', 'druid', 'archer'])[1 + floor(random() * 5)::integer];
    v_uid := gen_random_uuid()::text;
    v_hero := jsonb_build_object(
      'uid', v_uid,
      'heroId', v_class || '-' || v_rarity,
      'level', 1,
      'stars', 0,
      'equipped', '{}'::jsonb,
      'xp', 0,
      'isNew', true
    );
    v_results := v_results || jsonb_build_array(v_hero);
    v_owned := v_owned || jsonb_build_array(v_hero);

    IF v_rarity IN ('legendary', 'mythic', 'cosmic', 'divine', 'celestial') THEN v_legendary := 0; ELSE v_legendary := v_legendary + 1; END IF;
    IF v_rarity IN ('mythic', 'cosmic', 'divine', 'celestial') THEN v_mythic := 0; ELSE v_mythic := v_mythic + 1; END IF;
    IF v_rarity IN ('cosmic', 'divine', 'celestial') THEN v_cosmic := 0; ELSE v_cosmic := v_cosmic + 1; END IF;
    IF v_rarity IN ('divine', 'celestial') THEN v_divine := 0; ELSE v_divine := v_divine + 1; END IF;
  END LOOP;

  v_balance := v_balance - v_cost;
  v_summons := GREATEST(0, COALESCE((v_state->>'summons')::bigint, 0)) + p_count;
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_owned, true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);
  v_state := jsonb_set(v_state, '{summons}', to_jsonb(v_summons), true);

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id
  RETURNING revision INTO v_revision;

  UPDATE public.players
  SET token_balance = v_balance,
      boost_tokens_spent = boost_tokens_spent + v_cost,
      summons = summons + p_count,
      pity_legendary = v_legendary,
      pity_mythic = v_mythic,
      pity_cosmic = v_cosmic,
      pity_divine = v_divine,
      updated_at = now()
  WHERE player_id = p_player_id;

  INSERT INTO public.token_spend_events (idempotency_key, player_id, amount, action_kind)
  VALUES (p_idempotency_key, p_player_id, v_cost, 'hero-summon');

  v_result := jsonb_build_object(
    'player_id', p_player_id,
    'heroes', v_results,
    'spent', v_cost,
    'token_balance', v_balance,
    'revision', v_revision,
    'pity_legendary', v_legendary,
    'pity_mythic', v_mythic,
    'pity_cosmic', v_cosmic,
    'pity_divine', v_divine
  );

  INSERT INTO public.summon_events (idempotency_key, player_id, summon_count, token_cost, result)
  VALUES (p_idempotency_key, p_player_id, p_count, v_cost, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_hero_summon(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_hero_summon(uuid, uuid, integer) TO service_role;
