-- Account-wide Gold/XP bonus foundation (Balance v4 external sources).
--
-- Avatar/profile, seasonal frames, badges, achievements, cosmetics, timed
-- boosts and other account sources add once per account, never per hero, on
-- top of the Gold/XP lines carried by equipped items. The catalogue starts
-- empty, so every player's account bonus is exactly zero and normal-wave
-- rewards stay byte-identical until a source is granted.
--
-- Seasons last 28-93 days. When a season has ended, every player with at
-- least `min_active_days` distinct Moscow days of online normal combat in it
-- receives that season's frame permanently (+5% Gold, +5% XP). The grant is
-- idempotent and runs from the worker tick.

CREATE TABLE IF NOT EXISTS public.account_bonus_categories (
  category text PRIMARY KEY CHECK (category IN
    ('avatar', 'season_frame', 'badge', 'achievement', 'cosmetic', 'timed_boost', 'other')),
  gold_cap numeric CHECK (gold_cap IS NULL OR gold_cap BETWEEN 0 AND 10),
  xp_cap numeric CHECK (xp_cap IS NULL OR xp_cap BETWEEN 0 AND 10)
);
ALTER TABLE public.account_bonus_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_bonus_categories FROM PUBLIC;

-- Category ceilings from the Balance v4 roadmap (docs/game/balance-v4-gold-economy.md).
-- Seasonal frames are cumulative with no lifetime cap (NULL).
INSERT INTO public.account_bonus_categories(category, gold_cap, xp_cap) VALUES
  ('avatar', 0.50, 0.40),
  ('season_frame', NULL, NULL),
  ('badge', 0.45, 0.40),
  ('achievement', 0.60, 0.50),
  ('cosmetic', 0.60, 0.70),
  ('timed_boost', 1.00, 1.00),
  ('other', 0.25, 0.40)
ON CONFLICT (category) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.account_bonus_sources (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  category text NOT NULL REFERENCES public.account_bonus_categories(category),
  gold_bonus numeric NOT NULL DEFAULT 0 CHECK (gold_bonus BETWEEN 0 AND 1),
  xp_bonus numeric NOT NULL DEFAULT 0 CHECK (xp_bonus BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
ALTER TABLE public.account_bonus_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_bonus_sources FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.player_account_bonuses (
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  source_key text NOT NULL REFERENCES public.account_bonus_sources(source_key),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  grant_reason text NOT NULL CHECK (grant_reason ~ '^[a-z][a-z0-9_:.-]{2,95}$'),
  PRIMARY KEY (player_id, source_key),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);
ALTER TABLE public.player_account_bonuses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_account_bonuses FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.game_seasons (
  season_number integer PRIMARY KEY CHECK (season_number >= 1),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  min_active_days integer NOT NULL DEFAULT 7 CHECK (min_active_days BETWEEN 1 AND 93),
  frame_source_key text NOT NULL UNIQUE REFERENCES public.account_bonus_sources(source_key),
  frames_granted_at timestamptz,
  frames_granted_count integer CHECK (frames_granted_count IS NULL OR frames_granted_count >= 0),
  CHECK (ends_at - starts_at BETWEEN interval '28 days' AND interval '93 days')
);
ALTER TABLE public.game_seasons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_seasons FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.season_activity_days (
  season_number integer NOT NULL REFERENCES public.game_seasons(season_number),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  activity_day date NOT NULL,
  PRIMARY KEY (season_number, player_id, activity_day)
);
ALTER TABLE public.season_activity_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.season_activity_days FROM PUBLIC;

-- Sum of active grants, capped per category. Returns {gold, xp, categories, version}.
CREATE OR REPLACE FUNCTION public.account_reward_bonus(p_player_id uuid, p_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH per_category AS (
    SELECT c.category,
      LEAST(coalesce(sum(s.gold_bonus), 0), coalesce(c.gold_cap, 'Infinity'::numeric)) AS gold,
      LEAST(coalesce(sum(s.xp_bonus), 0), coalesce(c.xp_cap, 'Infinity'::numeric)) AS xp
    FROM public.player_account_bonuses g
    JOIN public.account_bonus_sources s ON s.source_key = g.source_key
    JOIN public.account_bonus_categories c ON c.category = s.category
    WHERE g.player_id = p_player_id
      AND g.revoked_at IS NULL
      AND g.granted_at <= p_at
      AND (g.expires_at IS NULL OR g.expires_at > p_at)
      AND (s.retired_at IS NULL OR s.retired_at > p_at)
    GROUP BY c.category, c.gold_cap, c.xp_cap
  )
  SELECT jsonb_build_object(
    'version', 'account-bonus-v1',
    'gold', coalesce(sum(gold), 0),
    'xp', coalesce(sum(xp), 0),
    'categories', coalesce(jsonb_object_agg(category, jsonb_build_object('gold', gold, 'xp', xp))
      FILTER (WHERE gold > 0 OR xp > 0), '{}'::jsonb)
  )
  FROM per_category;
$$;
REVOKE ALL ON FUNCTION public.account_reward_bonus(uuid, timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.record_season_activity(p_player_id uuid, p_at timestamptz DEFAULT now())
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.season_activity_days(season_number, player_id, activity_day)
  SELECT season_number, p_player_id, (p_at AT TIME ZONE 'Europe/Moscow')::date
  FROM public.game_seasons
  WHERE starts_at <= p_at AND p_at < ends_at
  ON CONFLICT DO NOTHING;
$$;
REVOKE ALL ON FUNCTION public.record_season_activity(uuid, timestamptz) FROM PUBLIC;

-- Operator entry point until the Control Center owns seasons. Each season gets
-- its own permanent frame source; seasons may not overlap.
CREATE OR REPLACE FUNCTION public.create_game_season(
  p_season_number integer, p_starts_at timestamptz, p_ends_at timestamptz, p_min_active_days integer DEFAULT 7
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_frame text := 'season_frame_' || p_season_number;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('game-seasons', 0));
  IF EXISTS (SELECT 1 FROM public.game_seasons
             WHERE tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)) THEN
    RAISE EXCEPTION 'season_overlap' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.account_bonus_sources(source_key, category, gold_bonus, xp_bonus)
  VALUES (v_frame, 'season_frame', 0.05, 0.05);
  INSERT INTO public.game_seasons(season_number, starts_at, ends_at, min_active_days, frame_source_key)
  VALUES (p_season_number, p_starts_at, p_ends_at, p_min_active_days, v_frame);
  RETURN jsonb_build_object('season_number', p_season_number, 'frame_source_key', v_frame);
END;
$$;
REVOKE ALL ON FUNCTION public.create_game_season(integer, timestamptz, timestamptz, integer) FROM PUBLIC;

-- Grants frames for every ended season exactly once. Returns the seasons settled now.
CREATE OR REPLACE FUNCTION public.grant_due_season_frames(p_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_season public.game_seasons%ROWTYPE;
  v_count integer;
  v_settled jsonb := '[]'::jsonb;
BEGIN
  FOR v_season IN
    SELECT * FROM public.game_seasons
    WHERE frames_granted_at IS NULL AND ends_at <= p_at
    ORDER BY season_number
    FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.player_account_bonuses(player_id, source_key, granted_at, grant_reason)
    SELECT a.player_id, v_season.frame_source_key, v_season.ends_at, 'season:' || v_season.season_number
    FROM public.season_activity_days a
    WHERE a.season_number = v_season.season_number
    GROUP BY a.player_id
    HAVING count(*) >= v_season.min_active_days
    ON CONFLICT (player_id, source_key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE public.game_seasons
    SET frames_granted_at = p_at, frames_granted_count = v_count
    WHERE season_number = v_season.season_number;
    v_settled := v_settled || jsonb_build_object('season_number', v_season.season_number, 'granted', v_count);
  END LOOP;
  RETURN jsonb_build_object('settled', v_settled);
END;
$$;
REVOKE ALL ON FUNCTION public.grant_due_season_frames(timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heroloop_worker.grant_due_season_frames(p_requested_tick timestamptz)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.grant_due_season_frames(LEAST(p_requested_tick, now()))
$$;
REVOKE ALL ON FUNCTION heroloop_worker.grant_due_season_frames(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_worker.grant_due_season_frames(timestamptz) TO heroloop_worker;

-- Adds the account bonus once to the summed item bonuses of a normal wave.
-- A zero account bonus returns the item payload unchanged.
CREATE OR REPLACE FUNCTION public.merge_account_reward_bonus(p_reward_bonuses jsonb, p_account jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_reward_bonuses) IS DISTINCT FROM 'object'
      OR (coalesce((p_account->>'gold')::numeric, 0) <= 0 AND coalesce((p_account->>'xp')::numeric, 0) <= 0)
      THEN p_reward_bonuses
    ELSE jsonb_build_object(
      'gold', coalesce((p_reward_bonuses->>'gold')::numeric, 0) + greatest(0, coalesce((p_account->>'gold')::numeric, 0)),
      'xp', coalesce((p_reward_bonuses->>'xp')::numeric, 0) + greatest(0, coalesce((p_account->>'xp')::numeric, 0)),
      'item', jsonb_build_object('gold', p_reward_bonuses->'gold', 'xp', p_reward_bonuses->'xp'),
      'account', p_account)
  END
$$;
REVOKE ALL ON FUNCTION public.merge_account_reward_bonus(jsonb, jsonb) FROM PUBLIC;

-- Online normal waves record season activity and carry the account bonus.
CREATE OR REPLACE FUNCTION heroloop_api.normal_combat_store_outcome(
  p_player_id uuid, p_start_key uuid, p_initial_units jsonb, p_reward_bonuses jsonb, p_outcome jsonb
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.record_season_activity(p_player_id, now());
  RETURN public.normal_combat_store_outcome(
    p_player_id, p_start_key, p_initial_units,
    public.merge_account_reward_bonus(p_reward_bonuses, public.account_reward_bonus(p_player_id, now())),
    p_outcome
  );
END;
$function$;
REVOKE ALL ON FUNCTION heroloop_api.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) TO heroloop_api;
