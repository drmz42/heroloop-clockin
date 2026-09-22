ALTER TABLE public.hero_ascension_events
  ADD COLUMN IF NOT EXISTS catalogue_usd_cents integer NOT NULL DEFAULT 0 CHECK (catalogue_usd_cents >= 0),
  ADD COLUMN IF NOT EXISTS hero_usd_quote_micros integer NOT NULL DEFAULT 1000 CHECK (hero_usd_quote_micros > 0);

COMMENT ON COLUMN public.hero_ascension_events.catalogue_usd_cents IS
  'Exact first-party USD catalogue value charged by this ascension, stored in cents.';
COMMENT ON COLUMN public.hero_ascension_events.hero_usd_quote_micros IS
  'Locked USD micros per HERO used for this ascension; Staging target quote is 1000.';

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
  IF p_target_uid IS NULL OR char_length(p_target_uid) < 1 OR char_length(p_target_uid) > 100 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  SELECT * INTO v_existing
  FROM public.hero_ascension_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id
      OR v_existing.target_uid <> p_target_uid
      OR v_existing.repeat_upgrades <> p_repeat THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  SELECT token_balance INTO v_balance
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  v_team := COALESCE(v_state->'team', '[]'::jsonb);
  v_training := COALESCE(v_state#>'{trainingCamp,heroUids}', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' OR jsonb_typeof(v_team) <> 'array' OR jsonb_typeof(v_training) <> 'array' THEN
    RAISE EXCEPTION 'invalid_save_state';
  END IF;

  LOOP
    SELECT hero INTO v_target
    FROM jsonb_array_elements(v_owned) AS hero
    WHERE hero->>'uid' = p_target_uid
    LIMIT 1;
    IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;

    v_target_hero_id := v_target->>'heroId';
    v_rarity := substring(v_target_hero_id FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$');
    v_base_usd_cents := CASE v_rarity
      WHEN 'common' THEN 1
      WHEN 'uncommon' THEN 2
      WHEN 'rare' THEN 3
      WHEN 'epic' THEN 5
      WHEN 'legendary' THEN 8
      WHEN 'mythic' THEN 12
      WHEN 'cosmic' THEN 20
      WHEN 'divine' THEN 30
      WHEN 'celestial' THEN 45
      ELSE NULL
    END;
    IF v_base_usd_cents IS NULL THEN RAISE EXCEPTION 'unsupported_rarity'; END IF;
    v_target_stars := LEAST(20, GREATEST(0, COALESCE((v_target->>'stars')::integer, 0)));
    IF v_target_stars >= 20 THEN
      IF v_stars_added = 0 THEN RAISE EXCEPTION 'maximum_stars'; END IF;
      EXIT;
    END IF;

    v_required := CASE
      WHEN v_target_stars < 5 THEN 1
      WHEN v_target_stars < 10 THEN 2
      WHEN v_target_stars < 15 THEN 3
      ELSE 4
    END;
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
      CASE
        WHEN hero->>'uid' = p_target_uid
          THEN jsonb_set(hero, '{stars}', to_jsonb(v_target_stars + 1), true)
        ELSE hero
      END
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

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id
  RETURNING revision INTO v_revision;

  UPDATE public.players
  SET token_balance = v_balance,
      boost_tokens_spent = boost_tokens_spent + v_total_cost,
      heroes_owned = jsonb_array_length(v_owned),
      updated_at = now()
  WHERE player_id = p_player_id;

  IF v_total_cost > 0 THEN
    INSERT INTO public.token_spend_events (idempotency_key, player_id, amount, action_kind)
    VALUES (p_idempotency_key, p_player_id, v_total_cost, 'hero-ascension');
  END IF;

  v_result := jsonb_build_object(
    'target_uid', p_target_uid,
    'stars_added', v_stars_added,
    'target_stars', v_target_stars,
    'consumed_uids', to_jsonb(v_consumed),
    'owned_heroes', v_owned,
    'spent', v_total_cost,
    'catalogue_usd_cents', v_total_usd_cents,
    'hero_usd_quote_micros', v_hero_usd_quote_micros,
    'token_balance', v_balance,
    'revision', v_revision
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
