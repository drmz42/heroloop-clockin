CREATE TABLE public.hero_release_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  hero_uid text NOT NULL CHECK (char_length(hero_uid) BETWEEN 1 AND 100),
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hero_release_events_player_created
  ON public.hero_release_events(player_id, created_at DESC);

ALTER TABLE public.hero_release_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hero_release_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_hero_release(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_hero_uid text,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.hero_release_events%ROWTYPE;
  v_state jsonb;
  v_owned jsonb;
  v_target jsonb;
  v_remaining jsonb;
  v_revision bigint;
  v_avatar_hero_id text;
  v_target_hero_id text;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL
    OR p_hero_uid IS NULL OR char_length(p_hero_uid) NOT BETWEEN 1 AND 100
    OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'invalid_hero_release';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing
  FROM public.hero_release_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id
      OR v_existing.hero_uid <> p_hero_uid
      OR v_existing.expected_revision <> p_expected_revision THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;

  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' OR jsonb_array_length(v_owned) < 1 THEN
    RAISE EXCEPTION 'invalid_save_state';
  END IF;
  SELECT hero INTO v_target
  FROM jsonb_array_elements(v_owned) AS owned(hero)
  WHERE hero->>'uid' = p_hero_uid
  LIMIT 1;
  IF v_target IS NULL THEN RAISE EXCEPTION 'hero_not_found'; END IF;
  IF jsonb_array_length(v_owned) = 1 THEN RAISE EXCEPTION 'last_hero'; END IF;
  IF COALESCE((v_target->>'locked')::boolean, false) THEN RAISE EXCEPTION 'hero_locked'; END IF;
  IF COALESCE(v_state->'team', '[]'::jsonb) ? p_hero_uid THEN RAISE EXCEPTION 'hero_in_team'; END IF;
  IF COALESCE(v_state#>'{trainingCamp,heroUids}', '[]'::jsonb) ? p_hero_uid THEN
    RAISE EXCEPTION 'hero_in_training';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(COALESCE(v_target->'equipped', '{}'::jsonb)) equipped
    WHERE jsonb_typeof(equipped.value) = 'string' AND trim(BOTH '"' FROM equipped.value::text) <> ''
  ) THEN RAISE EXCEPTION 'hero_has_equipment'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'marketListings', '[]'::jsonb)) listing
    WHERE listing#>>'{hero,uid}' = p_hero_uid
  ) THEN RAISE EXCEPTION 'hero_in_market'; END IF;
  IF EXISTS (SELECT 1 FROM public.dungeon_encounters WHERE player_id = p_player_id AND status = 'active')
    OR EXISTS (SELECT 1 FROM public.boss_encounters WHERE player_id = p_player_id AND status = 'active')
    OR EXISTS (SELECT 1 FROM public.normal_combat_events WHERE player_id = p_player_id AND completed_at IS NULL) THEN
    RAISE EXCEPTION 'hero_in_active_encounter';
  END IF;

  SELECT COALESCE(jsonb_agg(hero ORDER BY ordinality), '[]'::jsonb)
  INTO v_remaining
  FROM jsonb_array_elements(v_owned) WITH ORDINALITY AS owned(hero, ordinality)
  WHERE hero->>'uid' <> p_hero_uid;
  IF jsonb_array_length(v_remaining) <> jsonb_array_length(v_owned) - 1 THEN
    RAISE EXCEPTION 'invalid_save_state';
  END IF;

  v_target_hero_id := v_target->>'heroId';
  v_avatar_hero_id := COALESCE(v_state->>'avatarHeroId', '');
  IF v_avatar_hero_id = v_target_hero_id
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_remaining) hero WHERE hero->>'heroId' = v_avatar_hero_id) THEN
    v_avatar_hero_id := COALESCE(v_remaining->0->>'heroId', '');
    v_state := jsonb_set(v_state, '{avatarHeroId}', to_jsonb(v_avatar_hero_id), true);
  END IF;
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_remaining, true);

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id AND revision = p_expected_revision
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'state_conflict'; END IF;

  UPDATE public.players
  SET heroes_owned = jsonb_array_length(v_remaining),
      avatar_hero_id = v_avatar_hero_id,
      updated_at = now()
  WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_result := jsonb_build_object(
    'released_uid', p_hero_uid,
    'owned_heroes', v_remaining,
    'remaining_heroes', jsonb_array_length(v_remaining),
    'avatar_hero_id', v_avatar_hero_id,
    'revision', v_revision,
    'reward', jsonb_build_object('gold', 0, 'hero', 0, 'items', 0, 'xp', 0)
  );
  INSERT INTO public.hero_release_events(idempotency_key, player_id, hero_uid, expected_revision, result)
  VALUES (p_idempotency_key, p_player_id, p_hero_uid, p_expected_revision, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_hero_release(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_hero_release(uuid, uuid, text, bigint) TO service_role;

COMMENT ON FUNCTION public.settle_hero_release(uuid, uuid, text, bigint) IS
  'Idempotently releases one inactive, unlocked, unequipped owned Hero without any reward.';
