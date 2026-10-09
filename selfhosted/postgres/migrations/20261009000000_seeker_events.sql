-- Seeker Events (HL-TASK-20261008204529-7A5447): 28-day login calendar, weekly Friday event
-- and a 30-day Premium Pass with two paid lines (Premium $4.99, Collector $14.99 in SKR).
-- Every reward is server-owned, in-game only and granted once per idempotent claim.
-- Progress is read from server receipts, never from client values. Re-applicable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.seeker_event_calendar (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle >= 1),
  day integer NOT NULL DEFAULT 0 CHECK (day BETWEEN 0 AND 28),
  streak integer NOT NULL DEFAULT 0 CHECK (streak >= 0),
  last_claim_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.seeker_event_passes (
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  season integer NOT NULL CHECK (season >= 1),
  tier text NOT NULL CHECK (tier IN ('premium','collector')),
  purchase_key uuid NOT NULL,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);

-- One row per granted reward: calendar:<cycle>:<day>, weekly:<week>:<quest>, pass:<season>:<track>:<rank>.
CREATE TABLE IF NOT EXISTS public.seeker_event_claims (
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  claim_key text NOT NULL CHECK (claim_key ~ '^(calendar|weekly|pass):[a-z0-9:-]{3,80}$'),
  kind text NOT NULL CHECK (kind IN ('calendar','weekly','pass')),
  idempotency_key uuid NOT NULL,
  reward jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, claim_key)
);
CREATE INDEX IF NOT EXISTS seeker_event_claims_player_kind_idx ON public.seeker_event_claims(player_id, kind, created_at);

CREATE TABLE IF NOT EXISTS public.seeker_event_requests (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Weekly quests and Pass XP count won waves per player inside a window.
CREATE INDEX IF NOT EXISTS normal_combat_completion_events_player_created_idx
  ON public.normal_combat_completion_events(player_id, created_at DESC);

ALTER TABLE public.seeker_event_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seeker_event_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seeker_event_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seeker_event_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seeker_event_calendar, public.seeker_event_passes, public.seeker_event_claims,
  public.seeker_event_requests FROM PUBLIC, anon, authenticated;

-- Resource ledger source key for event Scrolls and Boss Keys.
DO $patch$
DECLARE d text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)',
    'public.resource_ledger_reconciliation()'] LOOP
    d := pg_get_functiondef(signature::regprocedure);
    IF position('seeker_event_reward' IN d) = 0 THEN
      IF position('''potion_use''' IN d) = 0 THEN RAISE EXCEPTION 'seeker_event_resource_definition_mismatch'; END IF;
      d := replace(d, '''potion_use''', '''potion_use'',''seeker_event_reward''');
      EXECUTE d;
    END IF;
  END LOOP;
END $patch$;

-- Season 1 starts 2026-10-08 00:00 UTC; every season lasts 30 days.
CREATE OR REPLACE FUNCTION public.seeker_event_season(p_at timestamptz)
RETURNS TABLE(season integer, starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT s, timestamptz '2026-10-08 00:00:00+00' + (s - 1) * interval '30 days',
    timestamptz '2026-10-08 00:00:00+00' + s * interval '30 days'
  FROM (SELECT GREATEST(1, floor(extract(epoch FROM p_at - timestamptz '2026-10-08 00:00:00+00') / 2592000)::integer + 1) AS s) x
$$;

-- The weekly event refreshes every Friday at 01:00 UTC (04:00 Moscow).
CREATE OR REPLACE FUNCTION public.seeker_event_week_start(p_at timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT (date_trunc('day', t) - ((extract(isodow FROM t)::integer + 2) % 7) * interval '1 day' + interval '1 hour') AT TIME ZONE 'UTC'
  FROM (SELECT (p_at AT TIME ZONE 'UTC') - interval '1 hour' AS t) x
$$;

-- Base calendar table. Marked days are doubled for Premium Pass owners.
CREATE OR REPLACE FUNCTION public.seeker_event_calendar_rewards()
RETURNS TABLE(day integer, gold bigint, scrolls integer, chests integer, boss_keys integer, marked boolean)
LANGUAGE sql IMMUTABLE AS $$
  SELECT d,
    CASE (d - 1) % 7 + 1 WHEN 1 THEN 5000 WHEN 2 THEN 7500 WHEN 3 THEN 10000 WHEN 4 THEN 12500 WHEN 5 THEN 15000 WHEN 6 THEN 20000
      ELSE (ARRAY[15000,20000,25000,40000])[(d + 6) / 7] END::bigint,
    CASE WHEN d % 7 = 0 THEN (ARRAY[1,1,2,3])[d / 7] ELSE 0 END,
    CASE WHEN d % 7 = 0 THEN (ARRAY[2,3,3,5])[d / 7] ELSE 0 END,
    CASE WHEN d = 28 THEN 1 ELSE 0 END,
    (d - 1) % 7 + 1 IN (4, 7)
  FROM generate_series(1, 28) d
$$;

-- Consecutive UTC check-ins: days 1-7 x1, 8-14 x1.5, 15-21 x2, 22+ x3. A missed day restarts at x1.
CREATE OR REPLACE FUNCTION public.seeker_event_multiplier(p_streak integer)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_streak >= 22 THEN 3 WHEN p_streak >= 15 THEN 2 WHEN p_streak >= 8 THEN 1.5 ELSE 1 END::numeric
$$;

CREATE OR REPLACE FUNCTION public.seeker_event_weekly_catalogue(p_theme integer)
RETURNS TABLE(id text, label text, metric text, target bigint, gold bigint, scrolls integer, chests integer)
LANGUAGE sql IMMUTABLE AS $$
  SELECT q.id, q.label, q.metric, q.target, q.gold, q.scrolls, q.chests FROM (VALUES
    (0,'w-battles-500','Win 500 battles','battles',500::bigint,10000::bigint,0,2),
    (0,'w-battles-2500','Win 2,500 battles','battles',2500,25000,1,3),
    (0,'w-boss-2','Defeat 2 Bosses','boss',2,0,2,2),
    (0,'w-daily-10','Claim 10 daily quests','daily',10,15000,1,0),
    (0,'w-login-5','Check in on 5 days','logins',5,0,1,3),
    (0,'w-chests-100','Open 100 chests','chests',100,15000,0,2),
    (1,'w-chests-100','Open 100 chests','chests',100,15000,0,2),
    (1,'w-chests-500','Open 500 chests','chests',500,30000,1,3),
    (1,'w-upgrade-10','Upgrade equipment 10 times','upgrades',10,15000,1,0),
    (1,'w-battles-500','Win 500 battles','battles',500,10000,0,2),
    (1,'w-login-5','Check in on 5 days','logins',5,0,1,3),
    (1,'w-summon-10','Summon 10 heroes','summons',10,0,2,0),
    (2,'w-summon-10','Summon 10 heroes','summons',10,0,2,0),
    (2,'w-summon-50','Summon 50 heroes','summons',50,0,3,2),
    (2,'w-mine-20','Play 20 Mine rounds','mine',20,10000,1,0),
    (2,'w-boss-1','Defeat 1 Boss','boss',1,0,1,2),
    (2,'w-login-5','Check in on 5 days','logins',5,0,1,3),
    (2,'w-battles-1000','Win 1,000 battles','battles',1000,20000,1,2)
  ) q(theme,id,label,metric,target,gold,scrolls,chests) WHERE q.theme = p_theme
$$;

CREATE OR REPLACE FUNCTION public.seeker_event_theme(p_week_start timestamptz)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT (((floor(extract(epoch FROM p_week_start - timestamptz '2026-10-09 01:00:00+00') / 604800)::integer + 1) % 3) + 3) % 3
$$;

CREATE OR REPLACE FUNCTION public.seeker_event_metrics(p_player uuid, p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'battles', (SELECT count(*) FROM public.normal_combat_completion_events WHERE player_id = p_player
      AND created_at >= p_from AND created_at < p_to AND result->>'all_cleared' = 'true'),
    'boss', (SELECT count(*) FROM public.boss_claim_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'chests', (SELECT COALESCE(sum(chest_count), 0) FROM public.chest_open_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'summons', (SELECT COALESCE(sum(summon_count), 0) FROM public.summon_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'upgrades', (SELECT count(*) FROM public.item_upgrade_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to),
    'mine', (SELECT count(*) FROM public.seeker_mine_rounds WHERE player_id = p_player AND played_at >= p_from AND played_at < p_to),
    'daily', (SELECT count(*) FROM public.quest_claim_events WHERE player_id = p_player AND instance_key LIKE 'daily:%' AND created_at >= p_from AND created_at < p_to),
    'logins', (SELECT count(*) FROM public.seeker_event_claims WHERE player_id = p_player AND kind = 'calendar' AND created_at >= p_from AND created_at < p_to))
$$;

-- 40 ranks, 300 Pass XP each. Free and Premium tracks; Collector also gets +10 ranks at purchase.
CREATE OR REPLACE FUNCTION public.seeker_event_pass_rewards()
RETURNS TABLE(rank integer, track text, gold bigint, scrolls integer, chests integer, boss_keys integer)
LANGUAGE sql IMMUTABLE AS $$
  SELECT r, 'free',
    CASE WHEN r % 2 = 1 THEN 4000 + 500 * r ELSE 0 END::bigint,
    CASE WHEN r % 10 = 0 THEN 2 WHEN r % 5 = 0 THEN 1 ELSE 0 END,
    CASE WHEN r % 10 = 0 THEN 2 WHEN r % 2 = 0 OR r % 5 = 0 THEN 1 ELSE 0 END,
    0
  FROM generate_series(1, 40) r
  UNION ALL
  SELECT r, 'premium',
    CASE WHEN r % 2 = 1 THEN 12000 + 1500 * r ELSE 0 END::bigint,
    CASE WHEN r % 10 = 0 THEN 4 WHEN r % 5 = 0 THEN 2 ELSE 0 END,
    CASE WHEN r % 10 = 0 THEN 4 WHEN r % 5 = 0 THEN 3 WHEN r % 2 = 0 THEN 2 ELSE 0 END,
    CASE WHEN r % 10 = 0 THEN 1 ELSE 0 END
  FROM generate_series(1, 40) r
$$;

-- Pass XP: won waves 1 each (at most 150 per UTC day), daily quests 20, Boss victories 40,
-- calendar check-ins 50 and weekly event quests 100. Collector adds 3,000 (10 ranks).
CREATE OR REPLACE FUNCTION public.seeker_event_pass_xp(p_player uuid, p_from timestamptz, p_to timestamptz)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT sum(LEAST(n, 150)) FROM (
      SELECT public.heroloop_game_date(created_at), count(*) AS n FROM public.normal_combat_completion_events
      WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to AND result->>'all_cleared' = 'true'
      GROUP BY 1) waves), 0)::bigint
    + 20 * (SELECT count(*) FROM public.quest_claim_events WHERE player_id = p_player AND instance_key LIKE 'daily:%' AND created_at >= p_from AND created_at < p_to)
    + 40 * (SELECT count(*) FROM public.boss_claim_events WHERE player_id = p_player AND created_at >= p_from AND created_at < p_to)
    + 50 * (SELECT count(*) FROM public.seeker_event_claims WHERE player_id = p_player AND kind = 'calendar' AND created_at >= p_from AND created_at < p_to)
    + 100 * (SELECT count(*) FROM public.seeker_event_claims WHERE player_id = p_player AND kind = 'weekly' AND created_at >= p_from AND created_at < p_to)
$$;

-- Grants Gold, Summon Scrolls, Boss Keys and chests to the locked save in one transaction.
CREATE OR REPLACE FUNCTION public.seeker_event_grant(p_player uuid, p_key uuid, p_action text, p_reward jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.player_saves; v_gold bigint := COALESCE((p_reward->>'gold')::bigint, 0);
  v_scrolls bigint := COALESCE((p_reward->>'scrolls')::bigint, 0); v_keys bigint := COALESCE((p_reward->>'boss_keys')::bigint, 0);
  v_chests integer := COALESCE((p_reward->>'chests')::integer, 0); v_entries jsonb := '[]'::jsonb; v_resource jsonb; v_new jsonb;
BEGIN
  IF v_gold < 0 OR v_scrolls < 0 OR v_keys < 0 OR v_chests < 0 THEN RAISE EXCEPTION 'invalid_event_reward'; END IF;
  SELECT * INTO s FROM public.player_saves WHERE player_id = p_player FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_scrolls > 0 THEN v_entries := v_entries || jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',v_scrolls::text,'source_key','seeker_event_reward')); END IF;
  IF v_keys > 0 THEN v_entries := v_entries || jsonb_build_array(jsonb_build_object('resource_id','boss_key','delta',v_keys::text,'source_key','seeker_event_reward')); END IF;
  IF jsonb_array_length(v_entries) > 0 THEN
    v_resource := public.apply_resource_entries(p_player, p_key, p_action,
      encode(extensions.digest((p_action || ':' || p_key::text || ':' || p_reward::text)::bytea, 'sha256'), 'hex'), v_entries, s.revision + 1);
    s.state := jsonb_set(s.state, '{summonScrolls}', v_resource#>'{balances,summon_scroll}', true);
    s.state := jsonb_set(s.state, '{bossKeys}', v_resource#>'{balances,boss_key}', true);
    UPDATE public.players SET boss_keys = (v_resource#>>'{balances,boss_key}')::integer WHERE player_id = p_player;
  END IF;
  IF v_chests > 0 THEN
    IF jsonb_array_length(COALESCE(s.state->'chests', '[]'::jsonb)) + v_chests > 500 THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;
    SELECT jsonb_agg(jsonb_build_object('id', 'server-' || gen_random_uuid()::text, 'stage', GREATEST(1, COALESCE((s.state->>'currentLocation')::integer, 1))))
      INTO v_new FROM generate_series(1, v_chests);
    s.state := jsonb_set(s.state, '{chests}', COALESCE(s.state->'chests', '[]'::jsonb) || v_new, true);
  END IF;
  s.state := jsonb_set(s.state, '{gold}', to_jsonb(COALESCE((s.state->>'gold')::bigint, 0) + v_gold), true);
  s.state := jsonb_set(s.state, '{totalGoldEarned}', to_jsonb(COALESCE((s.state->>'totalGoldEarned')::bigint, 0) + v_gold), true);
  UPDATE public.player_saves SET state = s.state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player RETURNING * INTO s;
  RETURN jsonb_build_object('state', s.state, 'revision', s.revision);
END $$;

CREATE OR REPLACE FUNCTION public.seeker_event_scale(p_reward jsonb, p_factor numeric)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('gold', floor((p_reward->>'gold')::numeric * p_factor)::bigint,
    'scrolls', floor((p_reward->>'scrolls')::numeric * p_factor)::integer,
    'chests', floor((p_reward->>'chests')::numeric * p_factor)::integer,
    'boss_keys', floor((p_reward->>'boss_keys')::numeric * p_factor)::integer)
$$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_event_status(p_player uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.seeker_event_calendar; v_today date := public.heroloop_game_date(now()); v_next_day integer;
  v_next_streak integer; v_claimed_today boolean; v_week timestamptz := public.seeker_event_week_start(now());
  v_theme integer; v_metrics jsonb; v_season record; v_tier text; v_xp bigint; v_rank integer;
BEGIN
  SELECT * INTO c FROM public.seeker_event_calendar WHERE player_id = p_player;
  IF NOT FOUND THEN c.cycle := 1; c.day := 0; c.streak := 0; END IF;
  v_claimed_today := c.last_claim_date = v_today;
  v_next_day := CASE WHEN v_claimed_today THEN NULL WHEN c.day >= 28 THEN 1 ELSE c.day + 1 END;
  v_next_streak := CASE WHEN v_claimed_today THEN c.streak WHEN c.last_claim_date = v_today - 1 THEN c.streak + 1 ELSE 1 END;
  SELECT * INTO v_season FROM public.seeker_event_season(now());
  SELECT tier INTO v_tier FROM public.seeker_event_passes WHERE player_id = p_player AND season = v_season.season;
  v_theme := public.seeker_event_theme(v_week);
  v_metrics := public.seeker_event_metrics(p_player, v_week, v_week + interval '7 days');
  v_xp := public.seeker_event_pass_xp(p_player, v_season.starts_at, v_season.ends_at) + CASE WHEN v_tier = 'collector' THEN 3000 ELSE 0 END;
  v_rank := LEAST(40, v_xp / 300)::integer;
  RETURN jsonb_build_object(
    'server_time', now(),
    'calendar', jsonb_build_object(
      'cycle', c.cycle, 'claimed_days', CASE WHEN c.day >= 28 AND NOT v_claimed_today THEN 0 ELSE c.day END,
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
      'tier', v_tier, 'xp', v_xp, 'rank', v_rank, 'xp_per_rank', 300, 'max_rank', 40,
      'prices', jsonb_build_object('premium', 499, 'collector', CASE WHEN v_tier = 'premium' THEN 1000 ELSE 1499 END),
      'rewards', (SELECT jsonb_agg(jsonb_build_object('rank', p.rank, 'track', p.track,
          'reward', jsonb_build_object('gold', p.gold, 'scrolls', p.scrolls, 'chests', p.chests, 'boss_keys', p.boss_keys),
          'claimed', EXISTS(SELECT 1 FROM public.seeker_event_claims e WHERE e.player_id = p_player
            AND e.claim_key = 'pass:' || v_season.season || ':' || p.track || ':' || p.rank)) ORDER BY p.rank, p.track)
        FROM public.seeker_event_pass_rewards() p)));
END $$;

-- p_kind: calendar (p_id ''), weekly (quest id) or pass ('' = every reached, unclaimed rank).
CREATE OR REPLACE FUNCTION heroloop_api.seeker_event_claim(p_player uuid, p_key uuid, p_kind text, p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_request jsonb := jsonb_build_object('kind', p_kind, 'id', p_id); e public.seeker_event_requests;
  c public.seeker_event_calendar; v_today date := public.heroloop_game_date(now()); v_day integer; v_cycle integer;
  v_streak integer; v_base record; v_reward jsonb; v_factor numeric; v_tier text; v_season record; v_week timestamptz;
  q record; v_metrics jsonb; v_claim_key text; v_rank integer; v_keys text[]; v_granted jsonb; v_result jsonb; v_xp bigint;
BEGIN
  IF p_kind NOT IN ('calendar','weekly','pass') OR p_id IS NULL OR length(p_id) > 40 THEN RAISE EXCEPTION 'invalid_event_claim'; END IF;
  PERFORM public.assert_account_value_allowed(p_player);
  PERFORM pg_advisory_xact_lock(hashtextextended('seeker-event:' || p_player::text, 0));
  SELECT * INTO e FROM public.seeker_event_requests WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF e.player_id <> p_player OR e.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN e.result || (SELECT jsonb_build_object('state', s.state, 'revision', s.revision, 'replayed', true)
      FROM public.player_saves s WHERE s.player_id = p_player);
  END IF;
  SELECT * INTO v_season FROM public.seeker_event_season(now());
  SELECT tier INTO v_tier FROM public.seeker_event_passes WHERE player_id = p_player AND season = v_season.season;

  IF p_kind = 'calendar' THEN
    INSERT INTO public.seeker_event_calendar(player_id) VALUES (p_player) ON CONFLICT DO NOTHING;
    SELECT * INTO c FROM public.seeker_event_calendar WHERE player_id = p_player FOR UPDATE;
    IF c.last_claim_date = v_today THEN RAISE EXCEPTION 'event_already_claimed'; END IF;
    v_streak := CASE WHEN c.last_claim_date = v_today - 1 THEN c.streak + 1 ELSE 1 END;
    v_cycle := CASE WHEN c.day >= 28 THEN c.cycle + 1 ELSE c.cycle END;
    v_day := CASE WHEN c.day >= 28 THEN 1 ELSE c.day + 1 END;
    SELECT * INTO v_base FROM public.seeker_event_calendar_rewards() r WHERE r.day = v_day;
    v_factor := public.seeker_event_multiplier(v_streak) * CASE WHEN v_base.marked AND v_tier IS NOT NULL THEN 2 ELSE 1 END;
    v_reward := public.seeker_event_scale(jsonb_build_object('gold', v_base.gold, 'scrolls', v_base.scrolls,
      'chests', v_base.chests, 'boss_keys', v_base.boss_keys), v_factor);
    -- Multipliers scale Gold, Scrolls and chests; the day-28 Boss Key stays one key.
    v_reward := jsonb_set(v_reward, '{boss_keys}', to_jsonb(v_base.boss_keys));
    v_keys := ARRAY['calendar:' || v_cycle || ':' || v_day];
    UPDATE public.seeker_event_calendar SET cycle = v_cycle, day = v_day, streak = v_streak, last_claim_date = v_today, updated_at = now()
      WHERE player_id = p_player;
    v_result := jsonb_build_object('kind', 'calendar', 'day', v_day, 'cycle', v_cycle, 'streak', v_streak,
      'multiplier', public.seeker_event_multiplier(v_streak), 'pass_doubled', v_base.marked AND v_tier IS NOT NULL);

  ELSIF p_kind = 'weekly' THEN
    v_week := public.seeker_event_week_start(now());
    SELECT * INTO q FROM public.seeker_event_weekly_catalogue(public.seeker_event_theme(v_week)) w WHERE w.id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'event_quest_unknown'; END IF;
    v_metrics := public.seeker_event_metrics(p_player, v_week, v_week + interval '7 days');
    IF (v_metrics->>q.metric)::bigint < q.target THEN RAISE EXCEPTION 'event_quest_incomplete'; END IF;
    v_keys := ARRAY['weekly:' || to_char(v_week AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ':' || q.id];
    v_reward := jsonb_build_object('gold', q.gold, 'scrolls', q.scrolls, 'chests', q.chests, 'boss_keys', 0);
    v_result := jsonb_build_object('kind', 'weekly', 'quest_id', q.id);

  ELSE
    IF p_id <> '' THEN RAISE EXCEPTION 'invalid_event_claim'; END IF;
    v_xp := public.seeker_event_pass_xp(p_player, v_season.starts_at, v_season.ends_at) + CASE WHEN v_tier = 'collector' THEN 3000 ELSE 0 END;
    v_rank := LEAST(40, v_xp / 300)::integer;
    SELECT array_agg('pass:' || v_season.season || ':' || p.track || ':' || p.rank ORDER BY p.rank, p.track),
      jsonb_build_object('gold', COALESCE(sum(p.gold), 0), 'scrolls', COALESCE(sum(p.scrolls), 0),
        'chests', COALESCE(sum(p.chests), 0), 'boss_keys', COALESCE(sum(p.boss_keys), 0))
      INTO v_keys, v_reward
      FROM public.seeker_event_pass_rewards() p
      WHERE p.rank <= v_rank AND (p.track = 'free' OR v_tier IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM public.seeker_event_claims x WHERE x.player_id = p_player
          AND x.claim_key = 'pass:' || v_season.season || ':' || p.track || ':' || p.rank);
    IF v_keys IS NULL THEN RAISE EXCEPTION 'event_nothing_to_claim'; END IF;
    v_result := jsonb_build_object('kind', 'pass', 'rank', v_rank, 'claimed_ranks', to_jsonb(v_keys));
  END IF;

  IF EXISTS (SELECT 1 FROM public.seeker_event_claims WHERE player_id = p_player AND claim_key = ANY(v_keys)) THEN
    RAISE EXCEPTION 'event_already_claimed';
  END IF;
  INSERT INTO public.seeker_event_claims(player_id, claim_key, kind, idempotency_key, reward)
    SELECT p_player, k, p_kind, p_key, v_reward FROM unnest(v_keys) k;
  v_granted := public.seeker_event_grant(p_player, p_key, 'seeker_event_' || p_kind, v_reward);
  v_result := v_result || jsonb_build_object('reward', v_reward, 'claimed', true);
  INSERT INTO public.seeker_event_requests(idempotency_key, player_id, request, result) VALUES (p_key, p_player, v_request, v_result);
  RETURN v_result || v_granted || jsonb_build_object('replayed', false);
END $$;

-- Collector delivers 15 Summon Scrolls and 2 Boss Keys once per season at purchase.
CREATE OR REPLACE FUNCTION public.seeker_event_pass_deliver(p_player uuid, p_key uuid, p_tier text, p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_season integer := (p_context->>'season')::integer; v_current text; v_granted jsonb;
BEGIN
  IF v_season IS DISTINCT FROM (SELECT season FROM public.seeker_event_season(now())) THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
  SELECT tier INTO v_current FROM public.seeker_event_passes WHERE player_id = p_player AND season = v_season FOR UPDATE;
  IF v_current IS DISTINCT FROM (p_context->>'previous_tier') THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
  IF p_tier NOT IN ('premium','collector') OR v_current = 'collector' OR v_current = p_tier THEN RAISE EXCEPTION 'event_pass_owned'; END IF;
  INSERT INTO public.seeker_event_passes(player_id, season, tier, purchase_key) VALUES (p_player, v_season, p_tier, p_key)
    ON CONFLICT (player_id, season) DO UPDATE SET tier = EXCLUDED.tier, purchase_key = EXCLUDED.purchase_key, purchased_at = now();
  IF p_tier = 'collector' THEN
    v_granted := public.seeker_event_grant(p_player, p_key, 'seeker_event_collector',
      '{"gold":0,"scrolls":15,"chests":0,"boss_keys":2}'::jsonb);
  END IF;
  RETURN jsonb_build_object('pass', jsonb_build_object('season', v_season, 'tier', p_tier)) || COALESCE(v_granted, '{}'::jsonb);
END $$;

-- SKR quote: Premium $4.99, Collector $14.99 or $10.00 as an upgrade from Premium.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position('event_pass_buy' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E' ELSE RAISE EXCEPTION ''invalid_skr_product'';\n END IF;\n INSERT INTO public.seeker_commerce_requests',
      E' ELSIF p_action=''event_pass_buy'' THEN\n'
      || E'  v_previous:=(SELECT season FROM public.seeker_event_season(now()));\n'
      || E'  v_context:=v_context||jsonb_build_object(''season'',v_previous,''previous_tier'',(SELECT tier FROM public.seeker_event_passes WHERE player_id=p_player AND season=v_previous));\n'
      || E'  IF v_context->>''previous_tier''=''collector'' OR v_context->>''previous_tier''=p_params->>''tier'' THEN RAISE EXCEPTION ''event_pass_owned''; END IF;\n'
      || E'  v_cents:=CASE p_params->>''tier'' WHEN ''premium'' THEN 499 WHEN ''collector'' THEN CASE WHEN v_context->>''previous_tier''=''premium'' THEN 1000 ELSE 1499 END END;\n'
      || E'  IF v_cents IS NULL THEN RAISE EXCEPTION ''invalid_skr_product''; END IF;\n'
      || E' ELSE RAISE EXCEPTION ''invalid_skr_product'';\n END IF;\n INSERT INTO public.seeker_commerce_requests');
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_event_prepare_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Delivery: an owned or changed pass is a definitive refusal, so the SKR charge is refunded.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_deliver(uuid,uuid)'::regprocedure);
  IF position('seeker_event_pass_deliver' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'  END IF;\n EXCEPTION WHEN raise_exception THEN',
      E'  ELSIF r.action=''event_pass_buy'' THEN\n'
      || E'   v_result:=public.seeker_event_pass_deliver(p_player,p_key,r.params->>''tier'',r.context);\n'
      || E'  END IF;\n EXCEPTION WHEN raise_exception THEN');
    v_new := replace(v_new, 'IF v_code NOT IN (', 'IF v_code NOT IN (''event_pass_owned'',''chest_capacity_exceeded'',');
    IF v_new = v_def OR position('seeker_event_pass_deliver' IN v_new) = 0 OR position('''event_pass_owned''' IN v_new) = 0 THEN
      RAISE EXCEPTION 'seeker_event_deliver_patch_failed';
    END IF;
    EXECUTE v_new;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.seeker_event_season(timestamptz), public.seeker_event_week_start(timestamptz),
  public.seeker_event_calendar_rewards(), public.seeker_event_multiplier(integer), public.seeker_event_weekly_catalogue(integer),
  public.seeker_event_theme(timestamptz), public.seeker_event_metrics(uuid,timestamptz,timestamptz), public.seeker_event_pass_rewards(),
  public.seeker_event_pass_xp(uuid,timestamptz,timestamptz), public.seeker_event_grant(uuid,uuid,text,jsonb),
  public.seeker_event_scale(jsonb,numeric), public.seeker_event_pass_deliver(uuid,uuid,text,jsonb),
  heroloop_api.seeker_event_status(uuid), heroloop_api.seeker_event_claim(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_event_status(uuid), heroloop_api.seeker_event_claim(uuid,uuid,text,text) TO heroloop_api;
COMMIT;
