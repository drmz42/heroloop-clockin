ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS ascension_focus jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(ascension_focus) = 'object');

CREATE TABLE IF NOT EXISTS public.ascension_focus_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  rarity text NOT NULL,
  target_hero_id text,
  previous_target_hero_id text,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ascension_focus_events_player_created_idx
  ON public.ascension_focus_events (player_id, created_at DESC);

ALTER TABLE public.ascension_focus_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ascension_focus_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hero_ascension_required_duplicates(
  p_rarity text,
  p_current_stars integer
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT CASE p_rarity
    WHEN 'common' THEN (ARRAY[12, 24, 36, 48])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'uncommon' THEN (ARRAY[9, 18, 27, 36])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'rare' THEN (ARRAY[7, 14, 21, 28])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'epic' THEN (ARRAY[5, 10, 15, 20])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'legendary' THEN (ARRAY[4, 8, 12, 16])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'mythic' THEN (ARRAY[2, 4, 6, 8])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'cosmic' THEN (ARRAY[1, 2, 3, 4])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'divine' THEN 2
    WHEN 'celestial' THEN 1
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.hero_ascension_required_duplicates(text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.set_ascension_focus(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_rarity text,
  p_target_hero_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.ascension_focus_events%ROWTYPE;
  v_focus jsonb;
  v_state jsonb;
  v_previous text;
  v_result jsonb;
BEGIN
  IF p_rarity NOT IN ('common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial') THEN
    RAISE EXCEPTION 'invalid_focus_rarity';
  END IF;

  SELECT * INTO v_existing
  FROM public.ascension_focus_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id
      OR v_existing.rarity <> p_rarity
      OR v_existing.target_hero_id IS DISTINCT FROM p_target_hero_id THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  SELECT ascension_focus INTO v_focus
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  IF p_target_hero_id IS NOT NULL THEN
    IF p_target_hero_id !~ '^(shepherd|assassin|knight|druid|archer)-(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$'
      OR substring(p_target_hero_id FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$') <> p_rarity THEN
      RAISE EXCEPTION 'focus_target_rarity_mismatch';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) hero
      WHERE hero->>'heroId' = p_target_hero_id
    ) THEN
      RAISE EXCEPTION 'focus_target_not_owned';
    END IF;
  END IF;

  v_focus := COALESCE(v_focus, '{}'::jsonb);
  v_previous := v_focus->>p_rarity;
  v_focus := CASE
    WHEN p_target_hero_id IS NULL THEN v_focus - p_rarity
    ELSE jsonb_set(v_focus, ARRAY[p_rarity], to_jsonb(p_target_hero_id), true)
  END;

  UPDATE public.players
  SET ascension_focus = v_focus, updated_at = now()
  WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'rarity', p_rarity,
    'target_hero_id', p_target_hero_id,
    'ascension_focus', v_focus
  );

  INSERT INTO public.ascension_focus_events (
    idempotency_key, player_id, rarity, target_hero_id, previous_target_hero_id, result
  ) VALUES (
    p_idempotency_key, p_player_id, p_rarity, p_target_hero_id, v_previous, v_result
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_ascension_focus(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ascension_focus(uuid, uuid, text, text) TO service_role;

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
  v_initial_owned jsonb;
  v_results jsonb := '[]'::jsonb;
  v_balance numeric;
  v_cost numeric;
  v_legendary bigint;
  v_mythic bigint;
  v_cosmic bigint;
  v_divine bigint;
  v_focus jsonb;
  v_focus_locked jsonb;
  v_focus_target text;
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
  IF p_count NOT IN (1, 10, 100) THEN RAISE EXCEPTION 'invalid_summon_count'; END IF;

  SELECT * INTO v_existing FROM public.summon_events WHERE idempotency_key = p_idempotency_key;
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

  SELECT token_balance, pity_legendary, pity_mythic, pity_cosmic, pity_divine, ascension_focus
  INTO v_balance, v_legendary, v_mythic, v_cosmic, v_divine, v_focus
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  SELECT * INTO v_existing FROM public.summon_events WHERE idempotency_key = p_idempotency_key;
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
  v_initial_owned := v_owned;
  v_focus := COALESCE(v_focus, '{}'::jsonb);
  v_focus_locked := v_focus;

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
      v_rarity := CASE WHEN v_roll < 0.8 THEN 'cosmic' WHEN v_roll < 0.98 THEN 'divine' ELSE 'celestial' END;
    ELSIF v_min_rarity = 'mythic' THEN
      v_rarity := CASE WHEN v_roll < 0.8 THEN 'mythic' WHEN v_roll < 0.96 THEN 'cosmic' WHEN v_roll < 0.996 THEN 'divine' ELSE 'celestial' END;
    ELSIF v_min_rarity = 'legendary' THEN
      v_rarity := CASE WHEN v_roll < 0.75 THEN 'legendary' WHEN v_roll < 0.95 THEN 'mythic' WHEN v_roll < 0.99 THEN 'cosmic' WHEN v_roll < 0.999 THEN 'divine' ELSE 'celestial' END;
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

    v_focus_target := v_focus->>v_rarity;
    IF v_focus_target IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_initial_owned) hero WHERE hero->>'heroId' = v_focus_target
    ) THEN
      v_class := split_part(v_focus_target, '-', 1);
    ELSE
      IF v_focus_target IS NOT NULL THEN v_focus := v_focus - v_rarity; END IF;
      v_class := (ARRAY['shepherd', 'assassin', 'knight', 'druid', 'archer'])[1 + floor(random() * 5)::integer];
    END IF;

    v_uid := gen_random_uuid()::text;
    v_hero := jsonb_build_object(
      'uid', v_uid, 'heroId', v_class || '-' || v_rarity, 'level', 1, 'stars', 0,
      'equipped', '{}'::jsonb, 'xp', 0, 'isNew', true
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
      ascension_focus = v_focus,
      updated_at = now()
  WHERE player_id = p_player_id;

  INSERT INTO public.token_spend_events (idempotency_key, player_id, amount, action_kind)
  VALUES (p_idempotency_key, p_player_id, v_cost, 'hero-summon');

  v_result := jsonb_build_object(
    'player_id', p_player_id, 'heroes', v_results, 'spent', v_cost,
    'token_balance', v_balance, 'revision', v_revision,
    'pity_legendary', v_legendary, 'pity_mythic', v_mythic,
    'pity_cosmic', v_cosmic, 'pity_divine', v_divine,
    'focus_locked', v_focus_locked, 'ascension_focus', v_focus
  );

  INSERT INTO public.summon_events (idempotency_key, player_id, summon_count, token_cost, result)
  VALUES (p_idempotency_key, p_player_id, p_count, v_cost, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_hero_summon(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_hero_summon(uuid, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.settle_hero_ascension(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_target_uid text,
  p_repeat boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.hero_ascension_events%ROWTYPE;
  v_state jsonb;
  v_owned jsonb;
  v_team jsonb;
  v_training jsonb;
  v_target jsonb;
  v_target_hero_id text;
  v_target_stars integer;
  v_required integer;
  v_rarity text;
  v_base_usd_cents integer;
  v_cost numeric;
  v_total_cost numeric := 0;
  v_total_usd_cents integer := 0;
  v_hero_usd_quote_micros integer := 1000;
  v_balance numeric;
  v_consumed text[] := ARRAY[]::text[];
  v_candidates text[];
  v_stars_added integer := 0;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF p_target_uid IS NULL OR char_length(p_target_uid) < 1 OR char_length(p_target_uid) > 100 THEN RAISE EXCEPTION 'invalid_target'; END IF;

  SELECT * INTO v_existing FROM public.hero_ascension_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.target_uid <> p_target_uid OR v_existing.repeat_upgrades <> p_repeat THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  v_team := COALESCE(v_state->'team', '[]'::jsonb);
  v_training := COALESCE(v_state#>'{trainingCamp,heroUids}', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' OR jsonb_typeof(v_team) <> 'array' OR jsonb_typeof(v_training) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;

  LOOP
    SELECT hero INTO v_target FROM jsonb_array_elements(v_owned) AS hero WHERE hero->>'uid' = p_target_uid LIMIT 1;
    IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;

    v_target_hero_id := v_target->>'heroId';
    v_rarity := substring(v_target_hero_id FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$');
    v_base_usd_cents := CASE v_rarity
      WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3 WHEN 'epic' THEN 5
      WHEN 'legendary' THEN 8 WHEN 'mythic' THEN 12 WHEN 'cosmic' THEN 20
      WHEN 'divine' THEN 30 WHEN 'celestial' THEN 45 ELSE NULL
    END;
    IF v_base_usd_cents IS NULL THEN RAISE EXCEPTION 'unsupported_rarity'; END IF;
    v_target_stars := LEAST(20, GREATEST(0, COALESCE((v_target->>'stars')::integer, 0)));
    IF v_target_stars >= 20 THEN
      IF v_stars_added = 0 THEN RAISE EXCEPTION 'maximum_stars'; END IF;
      EXIT;
    END IF;

    v_required := public.hero_ascension_required_duplicates(v_rarity, v_target_stars);
    v_cost := CEIL((v_base_usd_cents * (v_target_stars + 1) * 10000)::numeric / v_hero_usd_quote_micros);

    SELECT array_agg(candidate.uid ORDER BY candidate.ordinality)
    INTO v_candidates
    FROM (
      SELECT hero->>'uid' AS uid, ordinality
      FROM jsonb_array_elements(v_owned) WITH ORDINALITY AS owned(hero, ordinality)
      WHERE hero->>'heroId' = v_target_hero_id
        AND hero->>'uid' <> p_target_uid
        AND COALESCE((hero->>'stars')::integer, 0) = 0
        AND COALESCE((hero->>'locked')::boolean, false) = false
        AND NOT (v_team ? (hero->>'uid'))
        AND NOT (v_training ? (hero->>'uid'))
      ORDER BY ordinality
      LIMIT v_required
    ) AS candidate;

    IF COALESCE(array_length(v_candidates, 1), 0) < v_required THEN
      IF v_stars_added = 0 THEN RAISE EXCEPTION 'insufficient_duplicates'; END IF;
      EXIT;
    END IF;
    IF v_balance < v_cost THEN
      IF v_stars_added = 0 THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
      EXIT;
    END IF;

    SELECT COALESCE(jsonb_agg(
      CASE WHEN hero->>'uid' = p_target_uid THEN jsonb_set(hero, '{stars}', to_jsonb(v_target_stars + 1), true) ELSE hero END
      ORDER BY ordinality
    ), '[]'::jsonb)
    INTO v_owned
    FROM jsonb_array_elements(v_owned) WITH ORDINALITY AS owned(hero, ordinality)
    WHERE NOT ((hero->>'uid') = ANY(v_candidates));

    v_consumed := v_consumed || v_candidates;
    v_balance := v_balance - v_cost;
    v_total_cost := v_total_cost + v_cost;
    v_total_usd_cents := v_total_usd_cents + (v_base_usd_cents * (v_target_stars + 1));
    v_stars_added := v_stars_added + 1;
    v_target_stars := v_target_stars + 1;
    EXIT WHEN NOT p_repeat;
  END LOOP;

  v_state := jsonb_set(v_state, '{ownedHeroes}', v_owned, true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;

  UPDATE public.players
  SET token_balance = v_balance, boost_tokens_spent = boost_tokens_spent + v_total_cost,
      heroes_owned = jsonb_array_length(v_owned), updated_at = now()
  WHERE player_id = p_player_id;

  IF v_total_cost > 0 THEN
    INSERT INTO public.token_spend_events (idempotency_key, player_id, amount, action_kind)
    VALUES (p_idempotency_key, p_player_id, v_total_cost, 'hero-ascension');
  END IF;

  v_result := jsonb_build_object(
    'target_uid', p_target_uid, 'stars_added', v_stars_added, 'target_stars', v_target_stars,
    'consumed_uids', to_jsonb(v_consumed), 'owned_heroes', v_owned, 'spent', v_total_cost,
    'catalogue_usd_cents', v_total_usd_cents, 'hero_usd_quote_micros', v_hero_usd_quote_micros,
    'token_balance', v_balance, 'revision', v_revision
  );

  INSERT INTO public.hero_ascension_events (
    idempotency_key, player_id, target_uid, repeat_upgrades, token_cost,
    catalogue_usd_cents, hero_usd_quote_micros, result
  ) VALUES (
    p_idempotency_key, p_player_id, p_target_uid, p_repeat, v_total_cost,
    v_total_usd_cents, v_hero_usd_quote_micros, v_result
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_hero_ascension(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_hero_ascension(uuid, uuid, text, boolean) TO service_role;
