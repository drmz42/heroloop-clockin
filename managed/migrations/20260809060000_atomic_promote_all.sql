CREATE TABLE IF NOT EXISTS public.hero_promote_all_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  target_uids text[] NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.hero_promote_all_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hero_promote_all_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_all_hero_ascensions(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_target_uids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.hero_promote_all_events%ROWTYPE;
  v_target_uid text;
  v_step_key uuid;
  v_step jsonb;
  v_error text;
  v_index integer := 0;
  v_spent numeric := 0;
  v_stars_added integer := 0;
  v_promotions jsonb := '[]'::jsonb;
  v_owned jsonb;
  v_balance numeric;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF p_target_uids IS NULL
    OR cardinality(p_target_uids) NOT BETWEEN 1 AND 45
    OR EXISTS (SELECT 1 FROM unnest(p_target_uids) uid WHERE uid IS NULL OR char_length(uid) NOT BETWEEN 1 AND 100)
    OR (SELECT count(*) FROM unnest(p_target_uids) uid) <> (SELECT count(DISTINCT uid) FROM unnest(p_target_uids) uid) THEN
    RAISE EXCEPTION 'invalid_targets';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing
  FROM public.hero_promote_all_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.target_uids <> p_target_uids THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  FOREACH v_target_uid IN ARRAY p_target_uids LOOP
    v_index := v_index + 1;
    v_step_key := md5(p_idempotency_key::text || ':' || v_index::text)::uuid;
    BEGIN
      v_step := public.settle_hero_ascension(p_player_id, v_step_key, v_target_uid, true);
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      IF v_error = 'insufficient_tokens' THEN
        EXIT;
      ELSIF v_error IN ('insufficient_duplicates', 'maximum_stars', 'target_not_found') THEN
        CONTINUE;
      END IF;
      RAISE;
    END;

    v_spent := v_spent + COALESCE((v_step->>'spent')::numeric, 0);
    v_stars_added := v_stars_added + COALESCE((v_step->>'stars_added')::integer, 0);
    v_promotions := v_promotions || jsonb_build_array(jsonb_build_object(
      'target_uid', v_target_uid,
      'stars_added', COALESCE((v_step->>'stars_added')::integer, 0)
    ));
  END LOOP;

  SELECT state->'ownedHeroes', revision INTO v_owned, v_revision
  FROM public.player_saves WHERE player_id = p_player_id;
  SELECT token_balance INTO v_balance
  FROM public.players WHERE player_id = p_player_id;
  IF v_owned IS NULL OR v_balance IS NULL OR v_revision IS NULL THEN
    RAISE EXCEPTION 'account_required';
  END IF;

  v_result := jsonb_build_object(
    'owned_heroes', v_owned,
    'token_balance', v_balance,
    'revision', v_revision,
    'spent', v_spent,
    'stars_added', v_stars_added,
    'promotions', v_promotions
  );

  INSERT INTO public.hero_promote_all_events (idempotency_key, player_id, target_uids, result)
  VALUES (p_idempotency_key, p_player_id, p_target_uids, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_all_hero_ascensions(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_all_hero_ascensions(uuid, uuid, text[]) TO service_role;
