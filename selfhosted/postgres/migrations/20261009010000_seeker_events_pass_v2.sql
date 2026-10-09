-- Seeker Events Pass v2 (Founder 2026-10-09, HL-TASK-20261008204529-7A5447): a 30-day Pass of
-- 100 levels with three separately bought columns (Free, Premium $4.99, Collector $14.99 in SKR).
-- Pass XP comes only from Pass quests (daily and season), claimed once each. Re-applicable.
BEGIN;

-- Each paid column is its own purchase: one row per player, season and tier.
DO $$ BEGIN
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'seeker_event_passes_pkey'
      AND conrelid = 'public.seeker_event_passes'::regclass)) NOT LIKE '%tier%' THEN
    ALTER TABLE public.seeker_event_passes DROP CONSTRAINT seeker_event_passes_pkey;
    ALTER TABLE public.seeker_event_passes ADD PRIMARY KEY (player_id, season, tier);
  END IF;
END $$;
ALTER TABLE public.seeker_event_claims DROP CONSTRAINT IF EXISTS seeker_event_claims_kind_check;
ALTER TABLE public.seeker_event_claims ADD CONSTRAINT seeker_event_claims_kind_check
  CHECK (kind IN ('calendar','weekly','pass','pass_quest'));
ALTER TABLE public.seeker_event_claims DROP CONSTRAINT IF EXISTS seeker_event_claims_claim_key_check;
ALTER TABLE public.seeker_event_claims ADD CONSTRAINT seeker_event_claims_claim_key_check
  CHECK (claim_key ~ '^(calendar|weekly|pass|passq):[a-z0-9:-]{3,80}$');

-- Quest sources: every counter reads the player's own server receipts.
CREATE OR REPLACE FUNCTION public.seeker_event_metrics(p_player uuid, p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'battles', (SELECT count(*) FROM public.normal_combat_completion_events WHERE player_id = p_player
      AND created_at >= p_from AND created_at < p_to AND result->>'all_cleared' = 'true'),
    'kills', (SELECT COALESCE(sum(CASE WHEN result#>>'{rewards,kills}' ~ '^[0-9]{1,6}$' THEN (result#>>'{rewards,kills}')::bigint ELSE 0 END), 0)
      FROM public.normal_combat_completion_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'boss', (SELECT count(*) FROM public.boss_claim_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'boss_keys', (SELECT count(*) FROM public.boss_encounters WHERE player_id = p_player AND started_at >= p_from AND started_at < p_to),
    'dungeons', (SELECT count(*) FROM public.dungeon_encounters d WHERE d.player_id = p_player AND d.started_at >= p_from AND d.started_at < p_to
      AND NOT EXISTS (SELECT 1 FROM public.boss_encounters b WHERE b.player_id = p_player AND b.dungeon_encounter_id = d.id)),
    'chests', (SELECT COALESCE(sum(chest_count), 0) FROM public.chest_open_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'summons', (SELECT COALESCE(sum(summon_count), 0) FROM public.summon_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'upgrades', (SELECT count(*) FROM public.item_upgrade_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'stars', (SELECT COALESCE(sum(CASE WHEN result->>'stars_added' ~ '^[0-9]{1,4}$' THEN (result->>'stars_added')::integer ELSE 0 END), 0)
        FROM public.hero_promote_all_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to)
      + (SELECT count(*) FROM public.hero_ascension_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'mine', (SELECT count(*) FROM public.seeker_mine_rounds WHERE player_id = p_player AND played_at >= p_from AND played_at < p_to),
    'daily', (SELECT count(*) FROM public.quest_claim_events WHERE player_id = p_player AND instance_key LIKE 'daily:%' AND created_at >= p_from AND created_at < p_to),
    'logins', (SELECT count(*) FROM public.seeker_event_claims WHERE player_id = p_player AND kind = 'calendar' AND created_at >= p_from AND created_at < p_to))
$$;

-- Daily quests reset 00:00 UTC (1,000 XP a day); season quests run the whole Pass (12,000 XP).
CREATE OR REPLACE FUNCTION public.seeker_event_pass_quests()
RETURNS TABLE(id text, period text, label text, metric text, target bigint, xp integer)
LANGUAGE sql IMMUTABLE AS $$
  VALUES
    ('pd-checkin','daily','Check in on the calendar','logins',1::bigint,100),
    ('pd-daily-3','daily','Complete 3 daily quests','daily',3,150),
    ('pd-kills-500','daily','Kill 500 monsters','kills',500,150),
    ('pd-kills-2000','daily','Kill 2,000 monsters','kills',2000,150),
    ('pd-summon-1','daily','Summon a hero','summons',1,100),
    ('pd-upgrade-3','daily','Upgrade equipment 3 times','upgrades',3,100),
    ('pd-dungeon-1','daily','Enter a Dungeon','dungeons',1,100),
    ('pd-boss-1','daily','Use a Boss Key','boss_keys',1,150),
    ('ps-checkin-20','season','Check in on 20 days','logins',20,1500),
    ('ps-daily-60','season','Complete 60 daily quests','daily',60,1500),
    ('ps-kills-50000','season','Kill 50,000 monsters','kills',50000,1500),
    ('ps-summon-100','season','Summon 100 heroes','summons',100,1500),
    ('ps-upgrade-100','season','Upgrade equipment 100 times','upgrades',100,1500),
    ('ps-stars-10','season','Add 10 hero stars','stars',10,1500),
    ('ps-dungeon-15','season','Enter 15 Dungeons','dungeons',15,1500),
    ('ps-boss-10','season','Use 10 Boss Keys','boss_keys',10,1500)
$$;

-- 100 levels, 350 Pass XP each, three columns.
CREATE OR REPLACE FUNCTION public.seeker_event_pass_rewards()
RETURNS TABLE(rank integer, track text, gold bigint, scrolls integer, chests integer, boss_keys integer)
LANGUAGE sql IMMUTABLE AS $$
  SELECT l, 'free',
    CASE WHEN l % 5 = 0 THEN 0 WHEN l % 2 = 1 THEN 3000 + 200 * l ELSE 0 END::bigint,
    CASE WHEN l % 10 = 0 THEN 1 ELSE 0 END,
    CASE WHEN l % 10 = 0 THEN 2 WHEN l % 5 = 0 OR l % 2 = 0 THEN 1 ELSE 0 END,
    CASE WHEN l % 50 = 0 THEN 1 ELSE 0 END
  FROM generate_series(1, 100) l
  UNION ALL
  SELECT l, 'premium',
    CASE WHEN l % 5 = 0 THEN 0 WHEN l % 2 = 1 THEN 8000 + 500 * l ELSE 5000 + 300 * l END::bigint,
    CASE WHEN l % 10 = 0 THEN 3 WHEN l % 5 = 0 THEN 2 WHEN l % 2 = 1 AND l % 3 = 0 THEN 1 ELSE 0 END,
    CASE WHEN l % 10 = 0 THEN 3 WHEN l % 5 = 0 OR l % 2 = 0 THEN 2 ELSE 0 END,
    CASE WHEN l % 10 = 0 THEN 1 ELSE 0 END
  FROM generate_series(1, 100) l
  UNION ALL
  SELECT l, 'collector',
    CASE WHEN l % 5 = 0 THEN 0 WHEN l % 2 = 1 THEN 20000 + 1000 * l ELSE 0 END::bigint,
    CASE WHEN l % 10 = 0 THEN 6 WHEN l % 5 = 0 THEN 4 WHEN l % 2 = 0 THEN 1 ELSE 0 END,
    CASE WHEN l % 10 = 0 THEN 5 WHEN l % 5 = 0 OR l % 2 = 0 THEN 3 ELSE 0 END,
    CASE WHEN l % 10 = 0 THEN 2 WHEN l % 5 = 0 THEN 1 ELSE 0 END
  FROM generate_series(1, 100) l
$$;

CREATE OR REPLACE FUNCTION public.seeker_event_pass_xp(p_player uuid, p_from timestamptz, p_to timestamptz)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(sum((reward->>'xp')::bigint), 0)::bigint FROM public.seeker_event_claims
  WHERE player_id = p_player AND kind = 'pass_quest' AND created_at >= p_from AND created_at < p_to
$$;

CREATE OR REPLACE FUNCTION public.seeker_event_pass_level(p_xp bigint)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT LEAST(100, p_xp / 350)::integer $$;

CREATE OR REPLACE FUNCTION public.seeker_event_pass_quest_key(p_season integer, p_period text, p_id text, p_day date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'passq:' || p_season || ':' || CASE WHEN p_period = 'daily' THEN to_char(p_day, 'YYYY-MM-DD') ELSE 'season' END || ':' || p_id
$$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_event_status(p_player uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.seeker_event_calendar; v_today date := public.heroloop_game_date(now()); v_next_day integer;
  v_next_streak integer; v_claimed_today boolean; v_week timestamptz := public.seeker_event_week_start(now());
  v_theme integer; v_metrics jsonb; v_season record; v_tiers text[]; v_xp bigint; v_day_start timestamptz;
  v_daily jsonb; v_season_metrics jsonb;
BEGIN
  SELECT * INTO c FROM public.seeker_event_calendar WHERE player_id = p_player;
  IF NOT FOUND THEN c.cycle := 1; c.day := 0; c.streak := 0; END IF;
  v_claimed_today := c.last_claim_date = v_today;
  v_next_day := CASE WHEN v_claimed_today THEN NULL WHEN c.day >= 28 THEN 1 ELSE c.day + 1 END;
  v_next_streak := CASE WHEN v_claimed_today THEN c.streak WHEN c.last_claim_date = v_today - 1 THEN c.streak + 1 ELSE 1 END;
  SELECT * INTO v_season FROM public.seeker_event_season(now());
  SELECT COALESCE(array_agg(tier ORDER BY tier DESC), '{}') INTO v_tiers FROM public.seeker_event_passes WHERE player_id = p_player AND season = v_season.season;
  v_theme := public.seeker_event_theme(v_week);
  v_metrics := public.seeker_event_metrics(p_player, v_week, v_week + interval '7 days');
  v_day_start := v_today::timestamp AT TIME ZONE 'UTC';
  v_daily := public.seeker_event_metrics(p_player, v_day_start, v_day_start + interval '1 day');
  v_season_metrics := public.seeker_event_metrics(p_player, v_season.starts_at, v_season.ends_at);
  v_xp := public.seeker_event_pass_xp(p_player, v_season.starts_at, v_season.ends_at);
  RETURN jsonb_build_object(
    'server_time', now(),
    'calendar', jsonb_build_object(
      'cycle', c.cycle, 'claimed_days', CASE WHEN c.day >= 28 AND NOT COALESCE(v_claimed_today, false) THEN 0 ELSE c.day END,
      'claimed_today', COALESCE(v_claimed_today, false), 'next_day', v_next_day,
      'streak', CASE WHEN v_claimed_today OR c.last_claim_date = v_today - 1 THEN c.streak ELSE 0 END,
      'streak_lost', c.last_claim_date IS NOT NULL AND c.last_claim_date < v_today - 1,
      'multiplier', public.seeker_event_multiplier(v_next_streak),
      'resets_at', (v_today + 1)::timestamp AT TIME ZONE 'UTC',
      'days', (SELECT jsonb_agg(jsonb_build_object('day', r.day, 'marked', r.marked,
        'reward', jsonb_build_object('gold', r.gold, 'scrolls', r.scrolls, 'chests', r.chests, 'boss_keys', r.boss_keys)) ORDER BY r.day)
        FROM public.seeker_event_calendar_rewards() r)),
    'weekly', jsonb_build_object('theme', v_theme,
      'title', (ARRAY['Hunt of the Fallen','Treasure Tide','Summoner''s Call'])[v_theme + 1],
      'starts_at', v_week, 'ends_at', v_week + interval '7 days',
      'quests', (SELECT jsonb_agg(jsonb_build_object('id', q.id, 'label', q.label, 'target', q.target,
          'progress', LEAST(q.target, (v_metrics->>q.metric)::bigint),
          'reward', jsonb_build_object('gold', q.gold, 'scrolls', q.scrolls, 'chests', q.chests, 'boss_keys', 0),
          'claimed', EXISTS(SELECT 1 FROM public.seeker_event_claims e WHERE e.player_id = p_player
            AND e.claim_key = 'weekly:' || to_char(v_week AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ':' || q.id)) ORDER BY q.target > (v_metrics->>q.metric)::bigint, q.id)
        FROM public.seeker_event_weekly_catalogue(v_theme) q)),
    'pass', jsonb_build_object('season', v_season.season, 'starts_at', v_season.starts_at, 'ends_at', v_season.ends_at,
      'tiers', to_jsonb(v_tiers), 'xp', v_xp, 'level', public.seeker_event_pass_level(v_xp), 'xp_per_level', 350, 'max_level', 100,
      'prices', jsonb_build_object('premium', 499, 'collector', 1499),
      'daily_resets_at', (v_today + 1)::timestamp AT TIME ZONE 'UTC',
      'rewards', (SELECT jsonb_agg(jsonb_build_object('level', p.rank, 'track', p.track,
          'reward', jsonb_build_object('gold', p.gold, 'scrolls', p.scrolls, 'chests', p.chests, 'boss_keys', p.boss_keys),
          'claimed', EXISTS(SELECT 1 FROM public.seeker_event_claims e WHERE e.player_id = p_player
            AND e.claim_key = 'pass:' || v_season.season || ':' || p.track || ':' || p.rank)) ORDER BY p.rank, p.track)
        FROM public.seeker_event_pass_rewards() p),
      'quests', (SELECT jsonb_agg(jsonb_build_object('id', q.id, 'period', q.period, 'label', q.label, 'target', q.target, 'xp', q.xp,
          'progress', LEAST(q.target, ((CASE WHEN q.period = 'daily' THEN v_daily ELSE v_season_metrics END)->>q.metric)::bigint),
          'claimed', EXISTS(SELECT 1 FROM public.seeker_event_claims e WHERE e.player_id = p_player
            AND e.claim_key = public.seeker_event_pass_quest_key(v_season.season, q.period, q.id, v_today))) ORDER BY q.period, q.target)
        FROM public.seeker_event_pass_quests() q)));
END $$;

-- p_kind: calendar (''), weekly (quest id), pass ('' = every reached, unclaimed level of every owned column)
-- or pass_quest (Pass quest id; grants Pass XP only).
CREATE OR REPLACE FUNCTION heroloop_api.seeker_event_claim(p_player uuid, p_key uuid, p_kind text, p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_request jsonb := jsonb_build_object('kind', p_kind, 'id', p_id); e public.seeker_event_requests;
  c public.seeker_event_calendar; v_today date := public.heroloop_game_date(now()); v_day integer; v_cycle integer;
  v_streak integer; v_base record; v_reward jsonb; v_factor numeric; v_tiers text[]; v_season record; v_week timestamptz;
  q record; v_metrics jsonb; v_level integer; v_keys text[]; v_granted jsonb; v_result jsonb; v_start timestamptz;
BEGIN
  IF p_kind NOT IN ('calendar','weekly','pass','pass_quest') OR p_id IS NULL OR length(p_id) > 40 THEN RAISE EXCEPTION 'invalid_event_claim'; END IF;
  PERFORM public.assert_account_value_allowed(p_player);
  PERFORM pg_advisory_xact_lock(hashtextextended('seeker-event:' || p_player::text, 0));
  SELECT * INTO e FROM public.seeker_event_requests WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF e.player_id <> p_player OR e.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN e.result || (SELECT jsonb_build_object('state', s.state, 'revision', s.revision, 'replayed', true)
      FROM public.player_saves s WHERE s.player_id = p_player);
  END IF;
  SELECT * INTO v_season FROM public.seeker_event_season(now());
  SELECT COALESCE(array_agg(tier), '{}') INTO v_tiers FROM public.seeker_event_passes WHERE player_id = p_player AND season = v_season.season;

  IF p_kind = 'calendar' THEN
    INSERT INTO public.seeker_event_calendar(player_id) VALUES (p_player) ON CONFLICT DO NOTHING;
    SELECT * INTO c FROM public.seeker_event_calendar WHERE player_id = p_player FOR UPDATE;
    IF c.last_claim_date = v_today THEN RAISE EXCEPTION 'event_already_claimed'; END IF;
    v_streak := CASE WHEN c.last_claim_date = v_today - 1 THEN c.streak + 1 ELSE 1 END;
    v_cycle := CASE WHEN c.day >= 28 THEN c.cycle + 1 ELSE c.cycle END;
    v_day := CASE WHEN c.day >= 28 THEN 1 ELSE c.day + 1 END;
    SELECT * INTO v_base FROM public.seeker_event_calendar_rewards() r WHERE r.day = v_day;
    v_factor := public.seeker_event_multiplier(v_streak) * CASE WHEN v_base.marked AND cardinality(v_tiers) > 0 THEN 2 ELSE 1 END;
    v_reward := public.seeker_event_scale(jsonb_build_object('gold', v_base.gold, 'scrolls', v_base.scrolls,
      'chests', v_base.chests, 'boss_keys', v_base.boss_keys), v_factor);
    -- Multipliers scale Gold, Scrolls and chests; the day-28 Boss Key stays one key.
    v_reward := jsonb_set(v_reward, '{boss_keys}', to_jsonb(v_base.boss_keys));
    v_keys := ARRAY['calendar:' || v_cycle || ':' || v_day];
    UPDATE public.seeker_event_calendar SET cycle = v_cycle, day = v_day, streak = v_streak, last_claim_date = v_today, updated_at = now()
      WHERE player_id = p_player;
    v_result := jsonb_build_object('kind', 'calendar', 'day', v_day, 'cycle', v_cycle, 'streak', v_streak,
      'multiplier', public.seeker_event_multiplier(v_streak), 'pass_doubled', v_base.marked AND cardinality(v_tiers) > 0);

  ELSIF p_kind = 'weekly' THEN
    v_week := public.seeker_event_week_start(now());
    SELECT * INTO q FROM public.seeker_event_weekly_catalogue(public.seeker_event_theme(v_week)) w WHERE w.id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'event_quest_unknown'; END IF;
    v_metrics := public.seeker_event_metrics(p_player, v_week, v_week + interval '7 days');
    IF (v_metrics->>q.metric)::bigint < q.target THEN RAISE EXCEPTION 'event_quest_incomplete'; END IF;
    v_keys := ARRAY['weekly:' || to_char(v_week AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ':' || q.id];
    v_reward := jsonb_build_object('gold', q.gold, 'scrolls', q.scrolls, 'chests', q.chests, 'boss_keys', 0);
    v_result := jsonb_build_object('kind', 'weekly', 'quest_id', q.id);

  ELSIF p_kind = 'pass_quest' THEN
    SELECT * INTO q FROM public.seeker_event_pass_quests() w WHERE w.id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'event_quest_unknown'; END IF;
    v_start := CASE WHEN q.period = 'daily' THEN v_today::timestamp AT TIME ZONE 'UTC' ELSE v_season.starts_at END;
    v_metrics := public.seeker_event_metrics(p_player, v_start, CASE WHEN q.period = 'daily' THEN v_start + interval '1 day' ELSE v_season.ends_at END);
    IF (v_metrics->>q.metric)::bigint < q.target THEN RAISE EXCEPTION 'event_quest_incomplete'; END IF;
    v_keys := ARRAY[public.seeker_event_pass_quest_key(v_season.season, q.period, q.id, v_today)];
    v_reward := jsonb_build_object('xp', q.xp);
    v_result := jsonb_build_object('kind', 'pass_quest', 'quest_id', q.id, 'xp', q.xp);

  ELSE
    IF p_id <> '' THEN RAISE EXCEPTION 'invalid_event_claim'; END IF;
    v_level := public.seeker_event_pass_level(public.seeker_event_pass_xp(p_player, v_season.starts_at, v_season.ends_at));
    SELECT array_agg('pass:' || v_season.season || ':' || p.track || ':' || p.rank ORDER BY p.rank, p.track),
      jsonb_build_object('gold', COALESCE(sum(p.gold), 0), 'scrolls', COALESCE(sum(p.scrolls), 0),
        'chests', COALESCE(sum(p.chests), 0), 'boss_keys', COALESCE(sum(p.boss_keys), 0))
      INTO v_keys, v_reward
      FROM public.seeker_event_pass_rewards() p
      WHERE p.rank <= v_level AND (p.track = 'free' OR p.track = ANY(v_tiers))
        AND NOT EXISTS (SELECT 1 FROM public.seeker_event_claims x WHERE x.player_id = p_player
          AND x.claim_key = 'pass:' || v_season.season || ':' || p.track || ':' || p.rank);
    IF v_keys IS NULL THEN RAISE EXCEPTION 'event_nothing_to_claim'; END IF;
    v_result := jsonb_build_object('kind', 'pass', 'level', v_level, 'claimed_levels', to_jsonb(v_keys));
  END IF;

  IF EXISTS (SELECT 1 FROM public.seeker_event_claims WHERE player_id = p_player AND claim_key = ANY(v_keys)) THEN
    RAISE EXCEPTION 'event_already_claimed';
  END IF;
  INSERT INTO public.seeker_event_claims(player_id, claim_key, kind, idempotency_key, reward)
    SELECT p_player, k, p_kind, p_key, v_reward FROM unnest(v_keys) k;
  IF p_kind = 'pass_quest' THEN
    v_granted := (SELECT jsonb_build_object('state', s.state, 'revision', s.revision) FROM public.player_saves s WHERE s.player_id = p_player);
  ELSE
    v_granted := public.seeker_event_grant(p_player, p_key, 'seeker_event_' || p_kind, v_reward);
  END IF;
  v_result := v_result || jsonb_build_object('reward', v_reward, 'claimed', true);
  INSERT INTO public.seeker_event_requests(idempotency_key, player_id, request, result) VALUES (p_key, p_player, v_request, v_result);
  RETURN v_result || v_granted || jsonb_build_object('replayed', false);
END $$;

-- Each column is bought once per season; buying one never unlocks the other.
CREATE OR REPLACE FUNCTION public.seeker_event_pass_deliver(p_player uuid, p_key uuid, p_tier text, p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_season integer := (p_context->>'season')::integer;
BEGIN
  IF v_season IS DISTINCT FROM (SELECT season FROM public.seeker_event_season(now())) THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
  IF p_tier NOT IN ('premium','collector') THEN RAISE EXCEPTION 'invalid_skr_product'; END IF;
  INSERT INTO public.seeker_event_passes(player_id, season, tier, purchase_key) VALUES (p_player, v_season, p_tier, p_key)
    ON CONFLICT (player_id, season, tier) DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'event_pass_owned'; END IF;
  RETURN jsonb_build_object('pass', jsonb_build_object('season', v_season, 'tier', p_tier));
END $$;

-- SKR quote: Premium $4.99 and Collector $14.99, each once per season.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position('event_pass_v2' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'  v_context:=v_context||jsonb_build_object(''season'',v_previous,''previous_tier'',(SELECT tier FROM public.seeker_event_passes WHERE player_id=p_player AND season=v_previous));\n'
      || E'  IF v_context->>''previous_tier''=''collector'' OR v_context->>''previous_tier''=p_params->>''tier'' THEN RAISE EXCEPTION ''event_pass_owned''; END IF;\n'
      || E'  v_cents:=CASE p_params->>''tier'' WHEN ''premium'' THEN 499 WHEN ''collector'' THEN CASE WHEN v_context->>''previous_tier''=''premium'' THEN 1000 ELSE 1499 END END;\n',
      E'  -- event_pass_v2: independent columns\n'
      || E'  v_context:=v_context||jsonb_build_object(''season'',v_previous,''tier'',p_params->>''tier'');\n'
      || E'  IF EXISTS (SELECT 1 FROM public.seeker_event_passes WHERE player_id=p_player AND season=v_previous AND tier=p_params->>''tier'') THEN RAISE EXCEPTION ''event_pass_owned''; END IF;\n'
      || E'  v_cents:=CASE p_params->>''tier'' WHEN ''premium'' THEN 499 WHEN ''collector'' THEN 1499 END;\n');
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_event_pass_v2_prepare_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.seeker_event_pass_quests(), public.seeker_event_pass_level(bigint),
  public.seeker_event_pass_quest_key(integer,text,text,date) FROM PUBLIC, anon, authenticated;
COMMIT;
