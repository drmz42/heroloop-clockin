-- Founder 2026-10-07: every day-keyed game function uses the UTC game day
-- (public.heroloop_game_date, see 20261007220000_game_day_helpers.sql).
BEGIN;
CREATE OR REPLACE FUNCTION public.boss_claim(p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.boss_claim_events%ROWTYPE; v_boss public.boss_encounters%ROWTYPE;
  v_encounter public.dungeon_encounters%ROWTYPE; v_save public.player_saves%ROWTYPE;
  v_request jsonb := jsonb_build_object('encounter_id', p_encounter_id, 'expected_revision', p_expected_revision);
  v_state jsonb; v_chests jsonb; v_chest jsonb; v_result jsonb; v_revision bigint; v_gold bigint;
  v_now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  v_day text := to_char(public.heroloop_game_date(now()), 'YYYY-MM-DD'); v_last_day text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.boss_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id = p_encounter_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'boss_encounter_not_found'; END IF;
  SELECT * INTO v_boss FROM public.boss_encounters
  WHERE player_id = p_player_id AND dungeon_encounter_id = v_encounter.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'boss_encounter_not_found'; END IF;
  IF v_boss.status <> 'active' OR v_encounter.status <> 'active' THEN RAISE EXCEPTION 'boss_encounter_not_active'; END IF;
  IF v_encounter.revision <> p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room <> 4 OR v_encounter.room_state->>'kind' <> 'shared_boss'
    OR v_encounter.room_state->>'status' <> 'reward_locked' THEN RAISE EXCEPTION 'boss_reward_not_ready'; END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_state := v_save.state; v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' OR jsonb_array_length(v_chests) >= 500 THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;
  v_last_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000)), 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms), true);
  END IF;
  IF COALESCE((v_state->>'chestsOpenedToday')::integer, 0) >= 1000 THEN RAISE EXCEPTION 'daily_chest_limit_reached'; END IF;
  v_chest := jsonb_build_object('stage', v_boss.location_id, 'boss', true);
  v_gold := public.boss_hunt_gold_reward_with_account(v_boss.location_id, v_encounter.roster_snapshot,
    (public.account_reward_bonus(p_player_id)->>'gold')::numeric);
  v_state := jsonb_set(v_state, '{chests}', v_chests || jsonb_build_array(v_chest), true);
  v_state := jsonb_set(v_state, '{chestsOpenedToday}', to_jsonb(COALESCE((v_state->>'chestsOpenedToday')::integer, 0) + 1), true);
  v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold), true);
  v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold), true);
  v_state := jsonb_set(v_state, '{session,goldToday}', to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint, 0) + v_gold), true);
  v_state := jsonb_set(v_state, '{totalBossKills}', to_jsonb(COALESCE((v_state->>'totalBossKills')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{session,bossKills}', to_jsonb(COALESCE((v_state#>>'{session,bossKills}')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{dailyQuests}', public.advance_boss_quests(v_state->'dailyQuests', false), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.advance_boss_quests(v_state->'milestoneQuests', true), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.normal_combat_advance_quests(v_state->'milestoneQuests', 'gold-earned-', v_gold), true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.players SET boss_kills = COALESCE(boss_kills, 0) + 1, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.boss_encounters SET status = 'claimed', completed_at = now() WHERE id = v_boss.id;
  UPDATE public.dungeon_encounters SET status = 'completed', revision = revision + 1, completed_at = now()
  WHERE id = v_encounter.id RETURNING * INTO v_encounter;
  v_result := jsonb_build_object('encounter_id', v_encounter.id, 'boss_encounter_id', v_boss.id,
    'status', 'completed', 'revision', v_encounter.revision, 'boss_chest', v_chest, 'gold', v_gold,
    'gold_source_key', 'boss-gold:' || v_boss.id::text,
    'state', v_state, 'save_revision', v_revision, 'reward_settled', true);
  INSERT INTO public.boss_claim_events(idempotency_key, player_id, boss_encounter_id, request, result)
  VALUES (p_idempotency_key, p_player_id, v_boss.id, v_request, v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.compact_removed_player_items(p_before timestamp with time zone, p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_deleted integer := 0;
  v_days integer := 0;
BEGIN
  IF p_before IS NULL OR p_before >= now() THEN RAISE EXCEPTION 'invalid_retention_boundary'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20000 THEN RAISE EXCEPTION 'invalid_batch_limit'; END IF;

  WITH candidate AS (
    SELECT item.id, item.player_id, item.rarity, item.source_kind, item.removed_at
    FROM public.player_items item
    WHERE item.removed_at IS NOT NULL
      AND item.removed_at < p_before
      -- An account under Watch, Review or Hold keeps its full item detail.
      AND public.account_risk_level(item.player_id) = 'normal'
      -- A listing still points at the row it sold.
      AND NOT EXISTS (SELECT 1 FROM public.market_item_listings listing WHERE listing.item_id = item.id)
    ORDER BY item.removed_at
    LIMIT p_limit
    FOR UPDATE OF item SKIP LOCKED
  ), removed AS (
    DELETE FROM public.player_items item
    USING candidate
    WHERE item.id = candidate.id
    RETURNING item.player_id, item.rarity, item.source_kind, item.removed_at
  ), summary AS (
    SELECT public.heroloop_game_date(removed.removed_at) AS day,
      removed.player_id, removed.rarity, COALESCE(removed.source_kind, 'unknown') AS source_kind,
      count(*)::integer AS removed_count
    FROM removed
    GROUP BY 1, 2, 3, 4
  ), merged AS (
    INSERT INTO public.player_item_history_daily(day, player_id, rarity, source_kind, removed_count)
    SELECT day, player_id, rarity, source_kind, removed_count FROM summary
    ON CONFLICT (day, player_id, rarity, source_kind) DO UPDATE SET
      removed_count = public.player_item_history_daily.removed_count + EXCLUDED.removed_count,
      updated_at = now()
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM merged), (SELECT COALESCE(sum(removed_count), 0) FROM summary)
  INTO v_days, v_deleted;

  RETURN jsonb_build_object('deleted_rows', COALESCE(v_deleted, 0), 'summary_rows', COALESCE(v_days, 0), 'before', p_before);
END
$function$;

CREATE OR REPLACE FUNCTION public.credit_periodic_resources(p_player_id uuid, p_seconds numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_seconds numeric;
  v_previous_tick timestamptz;
  v_tick timestamptz := clock_timestamp();
  v_progress numeric;
  v_gold_progress numeric;
  v_battles integer;
  v_chests integer;
  v_location integer;
  v_gold integer;
  v_now_ms bigint := FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000);
  v_day text := to_char(public.heroloop_game_date(clock_timestamp()), 'YYYY-MM-DD');
  v_last_day text;
  v_new_chests jsonb := '[]'::jsonb;
BEGIN
  SELECT resource_reward_at INTO v_previous_tick
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('gold', 0, 'chests', 0); END IF;
  v_seconds := LEAST(LEAST(60, GREATEST(0, p_seconds)), GREATEST(0, EXTRACT(EPOCH FROM (v_tick - v_previous_tick))));
  UPDATE public.players SET resource_reward_at = v_tick WHERE player_id = p_player_id;
  IF v_seconds <= 0 THEN RETURN jsonb_build_object('gold', 0, 'chests', 0); END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('gold', 0, 'chests', 0); END IF;
  v_state := v_save.state;

  v_last_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000)), 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms));
  END IF;

  v_progress := COALESCE((v_state#>>'{boost,chestProgressSeconds}')::numeric, 0) + v_seconds;
  v_chests := LEAST(
    FLOOR(v_progress / 86.4)::integer,
    GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->'chests', '[]'::jsonb))),
    GREATEST(0, 1000 - COALESCE((v_state->>'chestsOpenedToday')::integer, 0))
  );
  IF v_chests > 0 THEN
    SELECT jsonb_agg(jsonb_build_object('id', 'server-' || gen_random_uuid()::text, 'stage', GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1))))
    INTO v_new_chests FROM generate_series(1, v_chests);
    v_state := jsonb_set(v_state, '{chests}', COALESCE(v_state->'chests', '[]'::jsonb) || COALESCE(v_new_chests, '[]'::jsonb));
    v_state := jsonb_set(v_state, '{chestsOpenedToday}', to_jsonb(COALESCE((v_state->>'chestsOpenedToday')::integer, 0) + v_chests));
  END IF;
  v_state := jsonb_set(v_state, '{boost,chestProgressSeconds}', to_jsonb(v_progress - FLOOR(v_progress / 86.4) * 86.4));

  v_gold_progress := COALESCE((v_state#>>'{boost,goldProgressSeconds}')::numeric, 0) + v_seconds;
  v_battles := FLOOR(v_gold_progress / 12)::integer;
  v_location := GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1));
  v_gold := v_battles * (5 + v_location);
  IF v_gold > 0 THEN
    v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold));
    v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold));
  END IF;
  v_state := jsonb_set(v_state, '{boost,goldProgressSeconds}', to_jsonb(v_gold_progress - v_battles * 12));
  v_state := jsonb_set(v_state, '{lastSeen}', to_jsonb(v_now_ms));

  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE player_id = p_player_id;
  RETURN jsonb_build_object('gold', v_gold, 'chests', v_chests, 'revision', v_save.revision + 1);
END;
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_quest_claim(p_player uuid, p_key uuid, p_id text, p_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE q jsonb; s public.player_saves; e public.quest_claim_events; instance text; resources jsonb; result jsonb;
BEGIN
 IF p_id LIKE 'challenge-%' THEN RETURN public.seeker_challenge_claim(p_player,p_key,p_id,p_revision); END IF;
 IF p_id NOT LIKE 'skr-%' AND p_id NOT LIKE 'mine-%' THEN RETURN public.seeker_settle_quest_claim(p_player,p_key,p_id,p_revision); END IF;
 PERFORM public.assert_account_value_allowed(p_player);
 PERFORM pg_advisory_xact_lock(hashtextextended('quest-claim:'||p_player::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text,0));
 SELECT * INTO e FROM public.quest_claim_events WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF e.player_id<>p_player OR e.quest_id<>p_id OR e.expected_revision<>p_revision THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  SELECT * INTO s FROM public.player_saves WHERE player_id=p_player;
  RETURN e.result||jsonb_build_object('state',s.state,'revision',s.revision,'replayed',true);
 END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
 IF s.revision<>p_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
 SELECT value INTO q FROM jsonb_array_elements(heroloop_api.seeker_quest_status(p_player)->'quests') WHERE value->>'id'=p_id;
 IF q IS NULL THEN RAISE EXCEPTION 'quest_unknown'; END IF;
 IF (q->>'claimed')::boolean THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
 IF (q->>'progress')::numeric<(q->>'target')::bigint THEN RAISE EXCEPTION 'quest_incomplete'; END IF;
 instance:=CASE WHEN q->>'kind'='daily' THEN 'daily:'||p_id||':'||to_char(public.heroloop_game_date(now()),'YYYY-MM-DD') ELSE p_id END;
 IF (q#>>'{reward,summonScrolls}')::bigint>0 THEN
  resources:=public.apply_resource_entries(p_player,p_key,'quest_claim',encode(extensions.digest(instance::bytea,'sha256'),'hex'),
   jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',q#>>'{reward,summonScrolls}','source_key','summon_milestone_scroll')),s.revision+1);
  s.state:=jsonb_set(s.state,'{summonScrolls}',resources#>'{balances,summon_scroll}',true);
 END IF;
 s.state:=jsonb_set(s.state,'{gold}',to_jsonb(COALESCE((s.state->>'gold')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
 s.state:=jsonb_set(s.state,'{totalGoldEarned}',to_jsonb(COALESCE((s.state->>'totalGoldEarned')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
 UPDATE public.player_saves SET state=s.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING * INTO s;
 result:=jsonb_build_object('quest_id',p_id,'claimed',true,'reward',q->'reward','state',s.state,'revision',s.revision,'replayed',false);
 INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result) VALUES(p_key,p_player,instance,p_id,p_revision,(result-'state')||jsonb_build_object('rules_version','seeker-quest-compact-v1','state_hash',encode(extensions.digest(s.state::text,'sha256'),'hex')));
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_quest_status(p_player uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 WITH today AS (SELECT public.heroloop_game_date(now()) AS d),
 counters AS (
  SELECT COALESCE(sum(payment_minor),0)/1000000 AS lifetime,
   COALESCE(sum(payment_minor) FILTER(WHERE public.heroloop_game_date(paid_at)=(SELECT d FROM today)),0)/1000000 AS daily,
   count(*) FILTER(WHERE action IN ('market_buy_listing','store_buy_item') AND public.heroloop_game_date(paid_at)=(SELECT d FROM today)) AS bought,
   count(*) FILTER(WHERE action='market_list_item' AND public.heroloop_game_date(paid_at)=(SELECT d FROM today)) AS listed
  FROM public.seeker_commerce_requests WHERE player_id=p_player AND status='delivered' AND payment_minor IS NOT NULL
 ),
 mine_days AS (
  SELECT public.heroloop_game_date(played_at) AS d,count(*) AS n
  FROM public.seeker_mine_rounds WHERE player_id=p_player GROUP BY 1
 ),
 mine AS (
  SELECT COALESCE((SELECT sum(n) FROM mine_days),0) AS lifetime,
   COALESCE((SELECT n FROM mine_days WHERE d=(SELECT d FROM today)),0) AS daily,
   -- Consecutive game days ending today with at least 5 rounds; zero until today qualifies.
   (SELECT COALESCE(min(g),367) FROM today t,generate_series(0,366) g
     WHERE COALESCE((SELECT n FROM mine_days WHERE d=t.d-g),0)<5) AS streak
 )
 SELECT jsonb_build_object('quests',COALESCE(jsonb_agg(jsonb_build_object(
  'id',q.id,'kind',q.kind,'label',q.label,'target',q.target,
  'progress',floor(CASE WHEN q.id='skr-buy-1' THEN c.bought WHEN q.id='skr-list-1' THEN c.listed
    WHEN q.id LIKE 'mine-daily-%' THEN m.daily WHEN q.id LIKE 'mine-streak-%' THEN m.streak
    WHEN q.id LIKE 'mine-rank-%' THEN m.lifetime WHEN q.kind='daily' THEN c.daily ELSE c.lifetime END),
  'reward',jsonb_build_object('gold',q.gold,'hero',0,'summonScrolls',q.scrolls),
  'claimed',EXISTS(SELECT 1 FROM public.quest_claim_events e WHERE e.player_id=p_player AND e.instance_key=
   CASE WHEN q.kind='daily' THEN 'daily:'||q.id||':'||to_char(public.heroloop_game_date(now()),'YYYY-MM-DD') ELSE q.id END)
 ) ORDER BY q.id LIKE 'mine-%',q.target,q.id),'[]'::jsonb),'ore_available',false,
  'mine',(SELECT jsonb_build_object('rounds_today',daily,'rounds_total',lifetime,'streak_days',streak) FROM mine))
 FROM public.seeker_activity_quest_catalogue() q CROSS JOIN counters c CROSS JOIN mine m
$function$;

CREATE OR REPLACE FUNCTION public.market_snapshot(p_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_listings jsonb;
  v_history jsonb;
  v_pool public.market_fee_daily_pool%ROWTYPE;
  v_day date := public.heroloop_game_date(now());
BEGIN
  SELECT COALESCE(jsonb_agg(public.market_listing_json(listing) || jsonb_build_object('is_own', listing.seller_id = p_player_id) ORDER BY listing.created_at DESC), '[]'::jsonb)
    INTO v_listings FROM public.market_item_listings listing WHERE listing.status = 'active';
  SELECT COALESCE(jsonb_agg(entry ORDER BY occurred_at DESC), '[]'::jsonb) INTO v_history
  FROM (
    SELECT jsonb_build_object('id', listing.id, 'name', COALESCE(item.base_item_id, 'Item'), 'price', listing.price,
      'createdAt', floor(extract(epoch FROM listing.completed_at) * 1000),
      'action', CASE WHEN listing.seller_id = p_player_id THEN 'sold' ELSE 'bought' END) AS entry,
      listing.completed_at AS occurred_at
    FROM public.market_item_listings listing LEFT JOIN public.player_items item ON item.id = listing.item_id
    WHERE listing.status = 'sold' AND (listing.seller_id = p_player_id OR listing.buyer_id = p_player_id)
    ORDER BY listing.completed_at DESC LIMIT 30
  ) history;
  SELECT * INTO v_pool FROM public.market_fee_daily_pool WHERE day_key = v_day;
  RETURN jsonb_build_object('listings', v_listings, 'history', v_history, 'active_limit', 20, 'fee_percent', 5,
    'pool_day', v_day, 'pool_fee_total', COALESCE(v_pool.fee_total, 0), 'pool_trade_count', COALESCE(v_pool.trade_count, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_player_heartbeat(p_player_id uuid)
 RETURNS TABLE(login_days integer, online_seconds bigint, reward_active_until timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_day date := public.heroloop_game_date(v_now);
BEGIN
  RETURN QUERY
  UPDATE public.players AS p
  SET
    boost_online_seconds = p.boost_online_seconds + CASE
      WHEN p.last_heartbeat IS NOT NULL AND p.last_heartbeat >= v_now - interval '60 seconds'
        THEN LEAST(60, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - p.last_heartbeat)))::bigint))
      ELSE 0
    END,
    boost_login_days = p.boost_login_days + CASE WHEN p.boost_last_login_day IS DISTINCT FROM v_day THEN 1 ELSE 0 END,
    boost_last_login_day = v_day,
    online = true,
    last_heartbeat = v_now,
    resource_reward_at = CASE
      WHEN NOT p.boost_max_active AND p.reward_active_until < v_now THEN GREATEST(p.resource_reward_at, v_now)
      ELSE p.resource_reward_at
    END,
    reward_active_until = v_now + interval '8 hours',
    updated_at = v_now
  WHERE p.player_id = p_player_id
  RETURNING p.boost_login_days, p.boost_online_seconds, p.reward_active_until;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_season_activity(p_player_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  INSERT INTO public.season_activity_days(season_number, player_id, activity_day)
  SELECT season_number, p_player_id, public.heroloop_game_date(p_at)
  FROM public.game_seasons
  WHERE starts_at <= p_at AND p_at < ends_at
  ON CONFLICT DO NOTHING;
$function$;

CREATE OR REPLACE FUNCTION public.rollup_item_sales_daily(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_salvage_items integer := 0;
  v_salvage_gold bigint := 0;
  v_market_items integer := 0;
  v_market_hero numeric := 0;
BEGIN
  IF p_day IS NULL THEN RAISE EXCEPTION 'invalid_day'; END IF;

  SELECT COALESCE(sum(jsonb_array_length(event.result->'item_ids')), 0)::integer,
    COALESCE(sum((event.result->>'gold_refund')::bigint), 0)
  INTO v_salvage_items, v_salvage_gold
  FROM public.item_mutation_events event
  WHERE event.action_kind = 'sell'
    AND public.heroloop_game_date(event.created_at) = p_day
    AND jsonb_typeof(event.result->'item_ids') = 'array';

  SELECT count(*)::integer, COALESCE(sum(listing.price), 0)
  INTO v_market_items, v_market_hero
  FROM public.market_item_listings listing
  WHERE listing.status = 'sold'
    AND listing.completed_at IS NOT NULL
    AND public.heroloop_game_date(listing.completed_at) = p_day;

  INSERT INTO public.item_sales_daily(day, channel, items, gold_total, hero_total)
  VALUES (p_day, 'salvage_gold', v_salvage_items, v_salvage_gold, 0),
    (p_day, 'market_hero', v_market_items, 0, v_market_hero)
  ON CONFLICT (day, channel) DO UPDATE SET
    items = EXCLUDED.items,
    gold_total = EXCLUDED.gold_total,
    hero_total = EXCLUDED.hero_total,
    updated_at = now();

  RETURN jsonb_build_object(
    'day', p_day,
    'salvage_items', v_salvage_items, 'salvage_gold', v_salvage_gold,
    'market_items', v_market_items, 'market_hero', v_market_hero
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.seeker_quest_claim_before_compact_receipt(p_player_id uuid, p_idempotency_key uuid, p_quest_id text, p_expected_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.quest_claim_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb; v_quests jsonb; v_next_quests jsonb; v_quest jsonb; v_reward jsonb;
  v_family text; v_instance text; v_day text := to_char(public.heroloop_game_date(now()), 'YYYY-MM-DD');
  v_last_day text; v_gold bigint; v_hero numeric; v_scrolls bigint; v_balance numeric;
  v_entries jsonb; v_resource jsonb; v_revision bigint; v_result jsonb; v_next jsonb := 'null'::jsonb;
  v_tier integer; v_target bigint; v_next_target bigint; v_next_scrolls bigint; v_chain text; v_label text;
  v_token_earned numeric; v_token_spent numeric; v_player_summons bigint; v_player_chests bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('quest-claim:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.quest_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.quest_id <> p_quest_id OR v_existing.expected_revision <> p_expected_revision THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT token_balance,boost_tokens_earned,boost_tokens_spent,summons,chests_opened
  INTO v_balance,v_token_earned,v_token_spent,v_player_summons,v_player_chests
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_state := v_save.state;

  IF p_quest_id LIKE 'milestone-token-%' THEN RAISE EXCEPTION 'quest_unknown'; END IF; IF p_quest_id LIKE 'milestone-%' THEN
    v_family := 'milestone'; v_quests := COALESCE(v_state->'milestoneQuests', '[]'::jsonb);
    SELECT value INTO v_quest FROM jsonb_array_elements(v_quests) WHERE value->>'id' = p_quest_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'quest_unknown'; END IF;
    v_chain := v_quest->>'chain';
    v_tier := COALESCE((v_quest->>'tier')::integer, -1);
    v_target := CASE v_chain
      WHEN 'chest' THEN (ARRAY[1000,5000,25000]::bigint[])[v_tier+1]
      WHEN 'kill' THEN (ARRAY[50000,250000,1000000]::bigint[])[v_tier+1]
      WHEN 'boss' THEN (ARRAY[25,100,500]::bigint[])[v_tier+1]
      WHEN 'summon' THEN (ARRAY[10,100,1000,10000]::bigint[])[v_tier+1]
      WHEN 'token-earned' THEN (ARRAY[1000,10000,100000]::bigint[])[v_tier+1]
      WHEN 'token-spent' THEN (ARRAY[500,5000,50000]::bigint[])[v_tier+1]
      WHEN 'gold-earned' THEN (ARRAY[100000,1000000,10000000]::bigint[])[v_tier+1]
      WHEN 'hero-owned' THEN (ARRAY[25,100,200]::bigint[])[v_tier+1] ELSE NULL END;
    IF v_target IS NULL OR (v_quest->>'target')::bigint <> v_target OR p_quest_id <> 'milestone-'||v_chain||'-'||v_target::text THEN RAISE EXCEPTION 'quest_catalogue_mismatch'; END IF;
    v_quest := jsonb_set(v_quest,'{progress}',to_jsonb(CASE v_chain
      WHEN 'chest' THEN GREATEST(COALESCE((v_quest->>'progress')::bigint,0),COALESCE(v_player_chests,0))
      WHEN 'kill' THEN COALESCE((v_state->>'totalKills')::bigint,0)
      WHEN 'boss' THEN COALESCE((v_state->>'totalBossKills')::bigint,0)
      WHEN 'summon' THEN GREATEST(COALESCE((v_state->>'summons')::bigint,0),COALESCE(v_player_summons,0))
      WHEN 'token-earned' THEN floor(COALESCE(v_token_earned,0))::bigint
      WHEN 'token-spent' THEN floor(COALESCE(v_token_spent,0))::bigint
      WHEN 'gold-earned' THEN COALESCE((v_state->>'totalGoldEarned')::bigint,0)
      WHEN 'hero-owned' THEN jsonb_array_length(COALESCE(v_state->'ownedHeroes','[]'::jsonb)) ELSE 0 END),true);
    v_scrolls := CASE WHEN v_chain='summon' THEN (ARRAY[1,5,10,50]::bigint[])[v_tier+1] ELSE 0 END;
    v_reward := CASE WHEN v_chain='summon' THEN jsonb_build_object('gold',0,'hero',0,'summonScrolls',v_scrolls)
      ELSE jsonb_build_object('gold',GREATEST(2500,floor(v_target/10.0)::bigint),'hero',5*(v_tier+1)) END;
    v_instance := p_quest_id;
  ELSE
    v_family := 'daily'; v_quests := CASE WHEN jsonb_typeof(v_state->'dailyQuests')='array' AND jsonb_array_length(v_state->'dailyQuests')>0 THEN v_state->'dailyQuests' ELSE public.quest_daily_catalogue() END;
    v_last_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((v_state->>'lastQuestReset')::numeric, 0) / 1000)), 'YYYY-MM-DD');
    IF v_last_day IS DISTINCT FROM v_day THEN
      v_state := jsonb_set(jsonb_set(v_state,'{dailyQuests}',public.quest_daily_catalogue(),true),'{lastQuestReset}',to_jsonb(floor(extract(epoch FROM clock_timestamp())*1000)::bigint),true);
      UPDATE public.player_saves SET state=v_state,revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING revision INTO v_revision;
      RETURN jsonb_build_object('quest_id',p_quest_id,'family','daily','claimed',false,'code','quest_day_stale','state',v_state,'revision',v_revision,'replayed',false);
    END IF;
    SELECT value INTO v_quest FROM jsonb_array_elements(v_quests) WHERE value->>'id' = p_quest_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'quest_unknown'; END IF;
    SELECT value->'reward' INTO v_reward FROM jsonb_array_elements(public.quest_daily_catalogue()) WHERE value->>'id'=p_quest_id AND value->>'target'=v_quest->>'target';
    IF v_reward IS NULL THEN RAISE EXCEPTION 'quest_catalogue_mismatch'; END IF;
    v_gold := COALESCE((v_reward->>'gold')::bigint,0); v_hero := COALESCE((v_reward->>'hero')::numeric,0); v_scrolls := 0;
    v_instance := 'daily:' || p_quest_id || ':' || v_day;
  END IF;
  IF COALESCE((v_quest->>'claimed')::boolean,false) THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
  IF COALESCE((v_quest->>'progress')::bigint,0) < COALESCE((v_quest->>'target')::bigint,0) THEN RAISE EXCEPTION 'quest_incomplete'; END IF;
  IF v_family='milestone' THEN v_gold:=COALESCE((v_reward->>'gold')::bigint,0); v_hero:=COALESCE((v_reward->>'hero')::numeric,0); END IF;

  v_hero:=0; v_reward:=jsonb_set(v_reward,'{hero}','0'::jsonb,true); IF EXISTS (SELECT 1 FROM public.quest_claim_events WHERE player_id=p_player_id AND instance_key=v_instance) THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
  v_entries := CASE WHEN v_scrolls>0 THEN jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',v_scrolls::text,'source_key','summon_milestone_scroll')) ELSE '[]'::jsonb END;
  IF v_scrolls>0 THEN
    v_resource := public.apply_resource_entries(p_player_id,p_idempotency_key,'quest_claim',encode(extensions.digest((v_instance||':'||p_expected_revision)::bytea,'sha256'),'hex'),v_entries,v_save.revision+1);
  ELSE v_resource := public.resource_snapshot(p_player_id); END IF;
  v_balance := v_balance + v_hero;
  v_gold := GREATEST(0,COALESCE((v_state->>'gold')::bigint,0)) + v_gold;
  v_state := jsonb_set(v_state,'{gold}',to_jsonb(v_gold),true);
  v_state := jsonb_set(v_state,'{hero}',to_jsonb(v_balance),true);
  v_state := jsonb_set(v_state,'{totalGoldEarned}',to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint,0)+COALESCE((v_reward->>'gold')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{totalTokensEarned}',to_jsonb(COALESCE((v_state->>'totalTokensEarned')::numeric,0)+v_hero),true);
  v_state := jsonb_set(v_state,'{tokensEarnedToday}',to_jsonb(CASE WHEN v_state->>'tokenDayKey'=v_day THEN COALESCE((v_state->>'tokensEarnedToday')::numeric,0)+v_hero ELSE v_hero END),true);
  v_state := jsonb_set(v_state,'{tokenDayKey}',to_jsonb(v_day),true);
  v_state := jsonb_set(v_state,'{session,goldToday}',to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint,0)+COALESCE((v_reward->>'gold')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{session,heroToday}',to_jsonb(COALESCE((v_state#>>'{session,heroToday}')::numeric,0)+v_hero),true);
  v_state := jsonb_set(v_state,'{summonScrolls}',to_jsonb(COALESCE((v_resource#>>'{balances,summon_scroll}')::bigint,0)),true);

  IF v_family='daily' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN value->>'id'=p_quest_id THEN jsonb_set(value,'{claimed}','true'::jsonb,true) ELSE value END ORDER BY ord),'[]'::jsonb)
    INTO v_next_quests FROM jsonb_array_elements(v_quests) WITH ORDINALITY e(value,ord);
    v_state := jsonb_set(v_state,'{dailyQuests}',v_next_quests,true);
  ELSE
    v_next_target := CASE v_chain
      WHEN 'chest' THEN (ARRAY[5000,25000]::bigint[])[v_tier+1] WHEN 'kill' THEN (ARRAY[250000,1000000]::bigint[])[v_tier+1]
      WHEN 'boss' THEN (ARRAY[100,500]::bigint[])[v_tier+1] WHEN 'summon' THEN (ARRAY[100,1000,10000]::bigint[])[v_tier+1]
      WHEN 'token-earned' THEN (ARRAY[10000,100000]::bigint[])[v_tier+1] WHEN 'token-spent' THEN (ARRAY[5000,50000]::bigint[])[v_tier+1]
      WHEN 'gold-earned' THEN (ARRAY[1000000,10000000]::bigint[])[v_tier+1] WHEN 'hero-owned' THEN (ARRAY[100,200]::bigint[])[v_tier+1] ELSE NULL END;
    v_next_scrolls := CASE WHEN v_chain='summon' THEN (ARRAY[5,10,50]::bigint[])[v_tier+1] ELSE NULL END;
    v_label := CASE v_chain WHEN 'chest' THEN 'Open ' WHEN 'kill' THEN 'Defeat ' WHEN 'boss' THEN 'Defeat ' WHEN 'summon' THEN 'Summon '
      WHEN 'token-earned' THEN 'Earn ' WHEN 'token-spent' THEN 'Spend ' WHEN 'gold-earned' THEN 'Earn ' WHEN 'hero-owned' THEN 'Own ' END;
    v_label := v_label||to_char(v_next_target,'FM999,999,999')||CASE v_chain WHEN 'chest' THEN ' chests' WHEN 'kill' THEN ' enemies' WHEN 'boss' THEN ' bosses' WHEN 'summon' THEN ' heroes' WHEN 'token-earned' THEN ' $HERO' WHEN 'token-spent' THEN ' $HERO' WHEN 'gold-earned' THEN ' Gold' WHEN 'hero-owned' THEN ' heroes' END;
    IF v_next_target IS NOT NULL THEN v_next := jsonb_build_object('id','milestone-'||v_chain||'-'||v_next_target,'kind','milestone','chain',v_chain,'tier',v_tier+1,'label',v_label,'target',v_next_target,'progress',(v_quest->>'progress')::bigint,'reward',CASE WHEN v_chain='summon' THEN jsonb_build_object('gold',0,'hero',0,'summonScrolls',v_next_scrolls) ELSE jsonb_build_object('gold',GREATEST(2500,floor(v_next_target/10.0)::bigint),'hero',5*(v_tier+2)) END,'claimed',false); END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO v_next_quests FROM jsonb_array_elements(v_quests) WITH ORDINALITY e(value,ord) WHERE value->>'id'<>p_quest_id;
    IF v_next_target IS NOT NULL THEN v_next_quests:=v_next_quests||jsonb_build_array(v_next); END IF;
    v_state := jsonb_set(v_state,'{milestoneQuests}',v_next_quests,true);
  END IF;
  UPDATE public.players SET token_balance=v_balance, boost_tokens_earned=boost_tokens_earned+v_hero, updated_at=now() WHERE player_id=p_player_id;
  IF v_hero>0 THEN INSERT INTO public.hero_economy_ledger(flow,source_kind,source_key,player_id,amount,metadata)
    VALUES('player_issuance','quest-reward','quest:'||p_player_id::text||':'||v_instance,p_player_id,v_hero,jsonb_build_object('quest_id',p_quest_id,'family',v_family)); END IF;
  UPDATE public.player_saves SET state=v_state,revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING revision INTO v_revision;
  v_result:=jsonb_build_object('quest_id',p_quest_id,'family',v_family,'claimed',true,'reward',v_reward,'gold',v_gold,'token_balance',v_balance,'resources',v_resource,'next_milestone',v_next,'state',v_state,'revision',v_revision,'replayed',false);
  INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result) VALUES(p_idempotency_key,p_player_id,v_instance,p_quest_id,p_expected_revision,v_result);
  RETURN v_result;
END $function$;

CREATE OR REPLACE FUNCTION public.seeker_settle_market_buy(p_player_id uuid, p_idempotency_key uuid, p_listing_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('listing_id', p_listing_id);
  v_listing public.market_item_listings%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_buyer_state jsonb;
  v_seller_state jsonb;
  v_inventory jsonb;
  v_buyer_balance numeric;
  v_seller_balance numeric;
  v_seller_proceeds bigint;
  v_fee bigint;
  v_buyer_revision bigint;
  v_seller_revision bigint;
  v_day date := public.heroloop_game_date(now());
  v_pool_total bigint;
  v_pool_trades integer;
  v_mail_id uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'buy' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_listing FROM public.market_item_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id = p_player_id THEN RAISE EXCEPTION 'market_self_purchase'; END IF;

  PERFORM player_id FROM public.players
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  PERFORM player_id FROM public.player_saves
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  SELECT state INTO v_buyer_state FROM public.player_saves WHERE player_id = p_player_id;
  SELECT state INTO v_seller_state FROM public.player_saves WHERE player_id = v_listing.seller_id;
  IF v_buyer_state IS NULL OR v_seller_state IS NULL THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_buyer_state->'inventory', '[]'::jsonb);

  SELECT * INTO v_item FROM public.player_items
    WHERE id = v_listing.item_id AND player_id = v_listing.seller_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  UPDATE public.player_saves SET state = v_buyer_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_buyer_revision;
  UPDATE public.player_saves SET state = v_seller_state, revision = revision + 1, updated_at = now()
    WHERE player_id = v_listing.seller_id RETURNING revision INTO v_seller_revision;
  UPDATE public.player_items SET player_id = p_player_id WHERE id = v_listing.item_id;
  UPDATE public.market_item_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;
  v_mail_id := public.mail_deliver_item(p_player_id, v_listing.item_id, 'market_purchase', p_listing_id::text);

  v_result := jsonb_build_object(
    'listing_id', p_listing_id,
    'item', public.market_item_json(v_item),
    'inventory', v_inventory,
    'price', v_listing.price,
    'revision', v_buyer_revision,
    'seller_revision', v_seller_revision,
    'delivered_to', 'mail',
    'mail_id', v_mail_id
  );
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'buy', v_request, v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_market_buy(p_player_id uuid, p_idempotency_key uuid, p_listing_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('listing_id', p_listing_id);
  v_listing public.market_item_listings%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_buyer_state jsonb;
  v_seller_state jsonb;
  v_inventory jsonb;
  v_buyer_balance numeric;
  v_seller_balance numeric;
  v_seller_proceeds bigint;
  v_fee bigint;
  v_buyer_revision bigint;
  v_seller_revision bigint;
  v_day date := public.heroloop_game_date(now());
  v_pool_total bigint;
  v_pool_trades integer;
  v_mail_id uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'buy' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_listing FROM public.market_item_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id = p_player_id THEN RAISE EXCEPTION 'market_self_purchase'; END IF;

  PERFORM player_id FROM public.players
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  SELECT token_balance INTO v_buyer_balance FROM public.players WHERE player_id = p_player_id;
  SELECT token_balance INTO v_seller_balance FROM public.players WHERE player_id = v_listing.seller_id;
  IF v_buyer_balance < v_listing.price THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  PERFORM player_id FROM public.player_saves
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  SELECT state INTO v_buyer_state FROM public.player_saves WHERE player_id = p_player_id;
  SELECT state INTO v_seller_state FROM public.player_saves WHERE player_id = v_listing.seller_id;
  IF v_buyer_state IS NULL OR v_seller_state IS NULL THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_buyer_state->'inventory', '[]'::jsonb);

  SELECT * INTO v_item FROM public.player_items
    WHERE id = v_listing.item_id AND player_id = v_listing.seller_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  v_seller_proceeds := floor(v_listing.price * 95::numeric / 100)::bigint;
  v_fee := v_listing.price - v_seller_proceeds;
  UPDATE public.players SET token_balance = token_balance - v_listing.price,
      boost_tokens_spent = boost_tokens_spent + v_listing.price, updated_at = now()
    WHERE player_id = p_player_id RETURNING token_balance INTO v_buyer_balance;
  UPDATE public.players SET token_balance = token_balance + v_seller_proceeds, updated_at = now()
    WHERE player_id = v_listing.seller_id RETURNING token_balance INTO v_seller_balance;

  v_buyer_state := jsonb_set(v_buyer_state, '{hero}', to_jsonb(v_buyer_balance), true);
  v_seller_state := jsonb_set(v_seller_state, '{hero}', to_jsonb(v_seller_balance), true);
  UPDATE public.player_saves SET state = v_buyer_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_buyer_revision;
  UPDATE public.player_saves SET state = v_seller_state, revision = revision + 1, updated_at = now()
    WHERE player_id = v_listing.seller_id RETURNING revision INTO v_seller_revision;
  UPDATE public.player_items SET player_id = p_player_id WHERE id = v_listing.item_id;
  UPDATE public.market_item_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;
  v_mail_id := public.mail_deliver_item(p_player_id, v_listing.item_id, 'market_purchase', p_listing_id::text);

  INSERT INTO public.market_fee_daily_pool(day_key, fee_total, trade_count)
    VALUES (v_day, v_fee, 1)
    ON CONFLICT (day_key) DO UPDATE SET
      fee_total = public.market_fee_daily_pool.fee_total + EXCLUDED.fee_total,
      trade_count = public.market_fee_daily_pool.trade_count + 1,
      updated_at = now()
    RETURNING fee_total, trade_count INTO v_pool_total, v_pool_trades;

  v_result := jsonb_build_object(
    'listing_id', p_listing_id,
    'item', public.market_item_json(v_item),
    'inventory', v_inventory,
    'token_balance', v_buyer_balance,
    'price', v_listing.price,
    'seller_proceeds', v_seller_proceeds,
    'fee', v_fee,
    'pool_fee_total', v_pool_total,
    'pool_trade_count', v_pool_trades,
    'revision', v_buyer_revision,
    'seller_revision', v_seller_revision,
    'delivered_to', 'mail',
    'mail_id', v_mail_id
  );
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'buy', v_request, v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression_before_pending_normal_recovery(p_player_id uuid, p_tick timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'telemetry'
AS $function$
DECLARE
  v_before_state jsonb;
  v_before_tick timestamptz;
  v_reward_until timestamptz;
  v_boost_max boolean;
  v_online boolean;
  v_result jsonb;
  v_settled_through timestamptz;
  v_seconds numeric;
  v_progress numeric;
  v_expected integer;
  v_granted integer;
  v_capacity_available integer;
  v_daily_available integer;
  v_blocked integer;
  v_last_day text;
  v_settlement_day text;
  v_activity text;
  v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN public.settle_periodic_progression_before_economy_telemetry(p_player_id, p_tick);
  END IF;

  SELECT save.state, player.resource_reward_at, player.reward_active_until,
    player.boost_max_active, player.online
  INTO v_before_state, v_before_tick, v_reward_until, v_boost_max, v_online
  FROM public.players player
  LEFT JOIN public.player_saves save ON save.player_id = player.player_id
  WHERE player.player_id = p_player_id;

  v_result := public.settle_periodic_progression_before_economy_telemetry(p_player_id, p_tick);
  IF v_before_state IS NULL
    OR COALESCE(v_result->>'settled_through', '') = '' THEN RETURN v_result; END IF;

  BEGIN
    v_settled_through := (v_result->>'settled_through')::timestamptz;
    v_granted := GREATEST(0, COALESCE((v_result->>'chests')::integer, 0));
    v_seconds := GREATEST(0, extract(epoch FROM (
      CASE WHEN v_boost_max THEN v_settled_through ELSE LEAST(v_settled_through, v_reward_until) END
      - v_before_tick
    )));
    v_progress := GREATEST(0, COALESCE((v_before_state#>>'{boost,chestProgressSeconds}')::numeric, 0));
    v_expected := GREATEST(0, floor((v_progress + v_seconds) / 86.4)::integer);
    v_capacity_available := GREATEST(0, 500 - jsonb_array_length(COALESCE(v_before_state->'chests', '[]'::jsonb)));
    v_last_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((v_before_state->>'lastChestReset')::numeric, 0) / 1000)), 'YYYY-MM-DD');
    v_settlement_day := to_char(public.heroloop_game_date(v_settled_through), 'YYYY-MM-DD');
    v_daily_available := CASE WHEN v_last_day IS DISTINCT FROM v_settlement_day THEN 1000
      ELSE GREATEST(0, 1000 - COALESCE((v_before_state->>'chestsOpenedToday')::integer, 0)) END;
    v_blocked := GREATEST(0, LEAST(v_expected, v_daily_available) - v_capacity_available);
    v_activity := CASE WHEN v_boost_max THEN 'boost_max' WHEN v_online THEN 'hidden' ELSE 'offline' END;

    IF v_granted > 0 OR v_blocked > 0 THEN
      INSERT INTO public.periodic_chest_events(
        source_key, player_id, granted, blocked_capacity, activity_mode, settled_through
      ) VALUES (
        p_player_id::text || ':' || extract(epoch FROM v_settled_through)::numeric::text,
        p_player_id, v_granted, v_blocked, v_activity, v_settled_through
      ) ON CONFLICT (source_key) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Telemetry must never roll back a reward settlement.
    NULL;
  END;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression_legacy(p_player_id uuid, p_tick timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_previous_tick timestamptz;
  v_reward_active_until timestamptz;
  v_boost_max_active boolean;
  v_combat_power bigint;
  v_tick timestamptz := LEAST(COALESCE(p_tick, clock_timestamp()), clock_timestamp() + interval '5 seconds');
  v_reward_end timestamptz;
  v_seconds numeric;
  v_team jsonb;
  v_team_size integer;
  v_location integer;
  v_level_location_cap integer;
  v_can_clear boolean;
  v_combat_progress numeric;
  v_chest_progress numeric;
  v_battles integer;
  v_chests integer := 0;
  v_gold integer := 0;
  v_hero_xp integer := 0;
  v_account_xp integer := 0;
  v_kills integer := 0;
  v_total_account_xp bigint;
  v_account_level integer := 1;
  v_account_level_start bigint := 0;
  v_heroes jsonb;
  v_hero jsonb;
  v_hero_uid text;
  v_hero_level integer;
  v_hero_remaining bigint;
  v_index integer;
  v_now_ms bigint := FLOOR(EXTRACT(EPOCH FROM v_tick) * 1000);
  v_day text := to_char(public.heroloop_game_date(v_tick), 'YYYY-MM-DD');
  v_last_day text;
  v_new_chests jsonb := '[]'::jsonb;
BEGIN
  SELECT resource_reward_at, reward_active_until, boost_max_active, combat_power
  INTO v_previous_tick, v_reward_active_until, v_boost_max_active, v_combat_power
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;

  IF v_tick <= v_previous_tick THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0, 'replayed', true);
  END IF;

  v_reward_end := CASE WHEN v_boost_max_active THEN v_tick ELSE LEAST(v_tick, v_reward_active_until) END;
  v_seconds := GREATEST(0, EXTRACT(EPOCH FROM (v_reward_end - v_previous_tick)));
  UPDATE public.players SET resource_reward_at = v_tick WHERE player_id = p_player_id;
  IF v_seconds <= 0 THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;
  v_state := v_save.state;
  v_team := COALESCE(v_state->'team', '[]'::jsonb);
  v_team_size := LEAST(3, jsonb_array_length(v_team));
  IF v_team_size <= 0 THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;
  v_level_location_cap := LEAST(10, public.balance_v6_location_cap(COALESCE((v_state->>'accountLevel')::integer, 1)));
  v_location := LEAST(
    GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1)),
    GREATEST(1, COALESCE((v_state->>'highestLocation')::integer, 1)),
    v_level_location_cap
  );
  v_can_clear := v_combat_power > 0;

  v_last_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000)), 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms));
  END IF;

  v_chest_progress := COALESCE((v_state#>>'{boost,chestProgressSeconds}')::numeric, 0) + v_seconds;
  v_chests := LEAST(
    FLOOR(v_chest_progress / 86.4)::integer,
    GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->'chests', '[]'::jsonb))),
    GREATEST(0, 1000 - COALESCE((v_state->>'chestsOpenedToday')::integer, 0))
  );
  IF v_chests > 0 THEN
    SELECT jsonb_agg(jsonb_build_object('stage', GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1))))
    INTO v_new_chests FROM generate_series(1, v_chests);
    v_state := jsonb_set(v_state, '{chests}', COALESCE(v_state->'chests', '[]'::jsonb) || COALESCE(v_new_chests, '[]'::jsonb));
    v_state := jsonb_set(v_state, '{chestsOpenedToday}', to_jsonb(COALESCE((v_state->>'chestsOpenedToday')::integer, 0) + v_chests));
  END IF;
  v_state := jsonb_set(v_state, '{boost,chestProgressSeconds}', to_jsonb(v_chest_progress - FLOOR(v_chest_progress / 86.4) * 86.4));

  v_combat_progress := COALESCE((v_state#>>'{boost,combatProgressSeconds}')::numeric, 0) + v_seconds;
  v_battles := CASE WHEN v_can_clear THEN FLOOR(v_combat_progress / 12)::integer ELSE 0 END;
  v_state := jsonb_set(v_state, '{boost,combatProgressSeconds}', to_jsonb(CASE WHEN v_can_clear THEN v_combat_progress - v_battles * 12 ELSE 0 END));
  v_hero_xp := ROUND(GREATEST(1, ROUND((4 + v_location * 1.2) * 0.55)::integer)
    * (1 + (public.offline_reward_bonus(p_player_id)->>'xp')::numeric))::integer * v_battles;
  v_kills := v_battles * v_team_size;
  v_account_xp := v_hero_xp * v_team_size;
  v_gold := v_battles * ROUND((5 + v_location)
    * (1 + (public.offline_reward_bonus(p_player_id)->>'gold')::numeric))::integer * v_team_size;

  IF v_battles > 0 THEN
    v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold));
    v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold));
    v_state := jsonb_set(v_state, '{totalKills}', to_jsonb(COALESCE((v_state->>'totalKills')::bigint, 0) + v_kills));
    v_state := jsonb_set(v_state, '{session,kills}', to_jsonb(COALESCE((v_state#>>'{session,kills}')::bigint, 0) + v_kills));
    v_state := jsonb_set(v_state, '{session,goldToday}', to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint, 0) + v_gold));

    v_total_account_xp := COALESCE((v_state->>'accountXp')::bigint, 0) + v_account_xp;
    LOOP
      EXIT WHEN v_total_account_xp < v_account_level_start + public.account_xp_needed(v_account_level);
      v_account_level_start := v_account_level_start + public.account_xp_needed(v_account_level);
      v_account_level := v_account_level + 1;
    END LOOP;
    v_state := jsonb_set(v_state, '{accountXp}', to_jsonb(v_total_account_xp));
    v_state := jsonb_set(v_state, '{accountLevel}', to_jsonb(v_account_level));
    IF v_location = GREATEST(1, COALESCE((v_state->>'highestLocation')::integer, 1)) THEN
      v_state := jsonb_set(v_state, '{highestLocation}', to_jsonb(v_location + 1));
    END IF;

    v_heroes := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
    IF jsonb_array_length(v_heroes) > 0 THEN
      FOR v_index IN 0..jsonb_array_length(v_heroes) - 1 LOOP
        v_hero := v_heroes->v_index;
        v_hero_uid := v_hero->>'uid';
        IF v_team ? v_hero_uid THEN
          v_hero_level := GREATEST(1, COALESCE((v_hero->>'level')::integer, 1));
          v_hero_remaining := GREATEST(0, COALESCE((v_hero->>'xp')::bigint, 0)) + v_hero_xp;
          LOOP
            EXIT WHEN v_hero_remaining < public.hero_xp_needed(v_hero_level);
            v_hero_remaining := v_hero_remaining - public.hero_xp_needed(v_hero_level);
            v_hero_level := v_hero_level + 1;
          END LOOP;
          v_hero := jsonb_set(jsonb_set(v_hero, '{level}', to_jsonb(v_hero_level)), '{xp}', to_jsonb(v_hero_remaining));
          v_heroes := jsonb_set(v_heroes, ARRAY[v_index::text], v_hero);
        END IF;
      END LOOP;
    END IF;
    v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes);
  END IF;

  v_state := jsonb_set(v_state, '{lastSeen}', to_jsonb(v_now_ms));
  v_state := jsonb_set(v_state, '{combatXpAt}', to_jsonb(v_now_ms));
  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = v_tick
  WHERE player_id = p_player_id;

  RETURN jsonb_build_object(
    'gold', v_gold, 'account_xp', v_account_xp, 'hero_xp', v_hero_xp,
    'kills', v_kills, 'chests', v_chests, 'revision', v_save.revision + 1, 'settled_through', v_tick
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_quest_claim_before_compact_receipt(p_player_id uuid, p_idempotency_key uuid, p_quest_id text, p_expected_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.quest_claim_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb; v_quests jsonb; v_next_quests jsonb; v_quest jsonb; v_reward jsonb;
  v_family text; v_instance text; v_day text := to_char(public.heroloop_game_date(now()), 'YYYY-MM-DD');
  v_last_day text; v_gold bigint; v_hero numeric; v_scrolls bigint; v_balance numeric;
  v_entries jsonb; v_resource jsonb; v_revision bigint; v_result jsonb; v_next jsonb := 'null'::jsonb;
  v_tier integer; v_target bigint; v_next_target bigint; v_next_scrolls bigint; v_chain text; v_label text;
  v_token_earned numeric; v_token_spent numeric; v_player_summons bigint; v_player_chests bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('quest-claim:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.quest_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.quest_id <> p_quest_id OR v_existing.expected_revision <> p_expected_revision THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT token_balance,boost_tokens_earned,boost_tokens_spent,summons,chests_opened
  INTO v_balance,v_token_earned,v_token_spent,v_player_summons,v_player_chests
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_state := v_save.state;

  IF p_quest_id LIKE 'milestone-%' THEN
    v_family := 'milestone'; v_quests := COALESCE(v_state->'milestoneQuests', '[]'::jsonb);
    SELECT value INTO v_quest FROM jsonb_array_elements(v_quests) WHERE value->>'id' = p_quest_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'quest_unknown'; END IF;
    v_chain := v_quest->>'chain';
    v_tier := COALESCE((v_quest->>'tier')::integer, -1);
    v_target := CASE v_chain
      WHEN 'chest' THEN (ARRAY[1000,5000,25000]::bigint[])[v_tier+1]
      WHEN 'kill' THEN (ARRAY[50000,250000,1000000]::bigint[])[v_tier+1]
      WHEN 'boss' THEN (ARRAY[25,100,500]::bigint[])[v_tier+1]
      WHEN 'summon' THEN (ARRAY[10,100,1000,10000]::bigint[])[v_tier+1]
      WHEN 'token-earned' THEN (ARRAY[1000,10000,100000]::bigint[])[v_tier+1]
      WHEN 'token-spent' THEN (ARRAY[500,5000,50000]::bigint[])[v_tier+1]
      WHEN 'gold-earned' THEN (ARRAY[100000,1000000,10000000]::bigint[])[v_tier+1]
      WHEN 'hero-owned' THEN (ARRAY[25,100,200]::bigint[])[v_tier+1] ELSE NULL END;
    IF v_target IS NULL OR (v_quest->>'target')::bigint <> v_target OR p_quest_id <> 'milestone-'||v_chain||'-'||v_target::text THEN RAISE EXCEPTION 'quest_catalogue_mismatch'; END IF;
    v_quest := jsonb_set(v_quest,'{progress}',to_jsonb(CASE v_chain
      WHEN 'chest' THEN GREATEST(COALESCE((v_quest->>'progress')::bigint,0),COALESCE(v_player_chests,0))
      WHEN 'kill' THEN COALESCE((v_state->>'totalKills')::bigint,0)
      WHEN 'boss' THEN COALESCE((v_state->>'totalBossKills')::bigint,0)
      WHEN 'summon' THEN GREATEST(COALESCE((v_state->>'summons')::bigint,0),COALESCE(v_player_summons,0))
      WHEN 'token-earned' THEN floor(COALESCE(v_token_earned,0))::bigint
      WHEN 'token-spent' THEN floor(COALESCE(v_token_spent,0))::bigint
      WHEN 'gold-earned' THEN COALESCE((v_state->>'totalGoldEarned')::bigint,0)
      WHEN 'hero-owned' THEN jsonb_array_length(COALESCE(v_state->'ownedHeroes','[]'::jsonb)) ELSE 0 END),true);
    v_scrolls := CASE WHEN v_chain='summon' THEN (ARRAY[1,5,10,50]::bigint[])[v_tier+1] ELSE 0 END;
    v_reward := CASE WHEN v_chain='summon' THEN jsonb_build_object('gold',0,'hero',0,'summonScrolls',v_scrolls)
      ELSE jsonb_build_object('gold',GREATEST(2500,floor(v_target/10.0)::bigint),'hero',5*(v_tier+1)) END;
    v_instance := p_quest_id;
  ELSE
    v_family := 'daily'; v_quests := CASE WHEN jsonb_typeof(v_state->'dailyQuests')='array' AND jsonb_array_length(v_state->'dailyQuests')>0 THEN v_state->'dailyQuests' ELSE public.quest_daily_catalogue() END;
    v_last_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((v_state->>'lastQuestReset')::numeric, 0) / 1000)), 'YYYY-MM-DD');
    IF v_last_day IS DISTINCT FROM v_day THEN
      v_state := jsonb_set(jsonb_set(v_state,'{dailyQuests}',public.quest_daily_catalogue(),true),'{lastQuestReset}',to_jsonb(floor(extract(epoch FROM clock_timestamp())*1000)::bigint),true);
      UPDATE public.player_saves SET state=v_state,revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING revision INTO v_revision;
      RETURN jsonb_build_object('quest_id',p_quest_id,'family','daily','claimed',false,'code','quest_day_stale','state',v_state,'revision',v_revision,'replayed',false);
    END IF;
    SELECT value INTO v_quest FROM jsonb_array_elements(v_quests) WHERE value->>'id' = p_quest_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'quest_unknown'; END IF;
    SELECT value->'reward' INTO v_reward FROM jsonb_array_elements(public.quest_daily_catalogue()) WHERE value->>'id'=p_quest_id AND value->>'target'=v_quest->>'target';
    IF v_reward IS NULL THEN RAISE EXCEPTION 'quest_catalogue_mismatch'; END IF;
    v_gold := COALESCE((v_reward->>'gold')::bigint,0); v_hero := COALESCE((v_reward->>'hero')::numeric,0); v_scrolls := 0;
    v_instance := 'daily:' || p_quest_id || ':' || v_day;
  END IF;
  IF COALESCE((v_quest->>'claimed')::boolean,false) THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
  IF COALESCE((v_quest->>'progress')::bigint,0) < COALESCE((v_quest->>'target')::bigint,0) THEN RAISE EXCEPTION 'quest_incomplete'; END IF;
  IF v_family='milestone' THEN v_gold:=COALESCE((v_reward->>'gold')::bigint,0); v_hero:=COALESCE((v_reward->>'hero')::numeric,0); END IF;

  IF EXISTS (SELECT 1 FROM public.quest_claim_events WHERE player_id=p_player_id AND instance_key=v_instance) THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
  v_entries := CASE WHEN v_scrolls>0 THEN jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',v_scrolls::text,'source_key','summon_milestone_scroll')) ELSE '[]'::jsonb END;
  IF v_scrolls>0 THEN
    v_resource := public.apply_resource_entries(p_player_id,p_idempotency_key,'quest_claim',encode(extensions.digest((v_instance||':'||p_expected_revision)::bytea,'sha256'),'hex'),v_entries,v_save.revision+1);
  ELSE v_resource := public.resource_snapshot(p_player_id); END IF;
  v_balance := v_balance + v_hero;
  v_gold := GREATEST(0,COALESCE((v_state->>'gold')::bigint,0)) + v_gold;
  v_state := jsonb_set(v_state,'{gold}',to_jsonb(v_gold),true);
  v_state := jsonb_set(v_state,'{hero}',to_jsonb(v_balance),true);
  v_state := jsonb_set(v_state,'{totalGoldEarned}',to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint,0)+COALESCE((v_reward->>'gold')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{totalTokensEarned}',to_jsonb(COALESCE((v_state->>'totalTokensEarned')::numeric,0)+v_hero),true);
  v_state := jsonb_set(v_state,'{tokensEarnedToday}',to_jsonb(CASE WHEN v_state->>'tokenDayKey'=v_day THEN COALESCE((v_state->>'tokensEarnedToday')::numeric,0)+v_hero ELSE v_hero END),true);
  v_state := jsonb_set(v_state,'{tokenDayKey}',to_jsonb(v_day),true);
  v_state := jsonb_set(v_state,'{session,goldToday}',to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint,0)+COALESCE((v_reward->>'gold')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{session,heroToday}',to_jsonb(COALESCE((v_state#>>'{session,heroToday}')::numeric,0)+v_hero),true);
  v_state := jsonb_set(v_state,'{summonScrolls}',to_jsonb(COALESCE((v_resource#>>'{balances,summon_scroll}')::bigint,0)),true);

  IF v_family='daily' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN value->>'id'=p_quest_id THEN jsonb_set(value,'{claimed}','true'::jsonb,true) ELSE value END ORDER BY ord),'[]'::jsonb)
    INTO v_next_quests FROM jsonb_array_elements(v_quests) WITH ORDINALITY e(value,ord);
    v_state := jsonb_set(v_state,'{dailyQuests}',v_next_quests,true);
  ELSE
    v_next_target := CASE v_chain
      WHEN 'chest' THEN (ARRAY[5000,25000]::bigint[])[v_tier+1] WHEN 'kill' THEN (ARRAY[250000,1000000]::bigint[])[v_tier+1]
      WHEN 'boss' THEN (ARRAY[100,500]::bigint[])[v_tier+1] WHEN 'summon' THEN (ARRAY[100,1000,10000]::bigint[])[v_tier+1]
      WHEN 'token-earned' THEN (ARRAY[10000,100000]::bigint[])[v_tier+1] WHEN 'token-spent' THEN (ARRAY[5000,50000]::bigint[])[v_tier+1]
      WHEN 'gold-earned' THEN (ARRAY[1000000,10000000]::bigint[])[v_tier+1] WHEN 'hero-owned' THEN (ARRAY[100,200]::bigint[])[v_tier+1] ELSE NULL END;
    v_next_scrolls := CASE WHEN v_chain='summon' THEN (ARRAY[5,10,50]::bigint[])[v_tier+1] ELSE NULL END;
    v_label := CASE v_chain WHEN 'chest' THEN 'Open ' WHEN 'kill' THEN 'Defeat ' WHEN 'boss' THEN 'Defeat ' WHEN 'summon' THEN 'Summon '
      WHEN 'token-earned' THEN 'Earn ' WHEN 'token-spent' THEN 'Spend ' WHEN 'gold-earned' THEN 'Earn ' WHEN 'hero-owned' THEN 'Own ' END;
    v_label := v_label||to_char(v_next_target,'FM999,999,999')||CASE v_chain WHEN 'chest' THEN ' chests' WHEN 'kill' THEN ' enemies' WHEN 'boss' THEN ' bosses' WHEN 'summon' THEN ' heroes' WHEN 'token-earned' THEN ' $HERO' WHEN 'token-spent' THEN ' $HERO' WHEN 'gold-earned' THEN ' Gold' WHEN 'hero-owned' THEN ' heroes' END;
    IF v_next_target IS NOT NULL THEN v_next := jsonb_build_object('id','milestone-'||v_chain||'-'||v_next_target,'kind','milestone','chain',v_chain,'tier',v_tier+1,'label',v_label,'target',v_next_target,'progress',(v_quest->>'progress')::bigint,'reward',CASE WHEN v_chain='summon' THEN jsonb_build_object('gold',0,'hero',0,'summonScrolls',v_next_scrolls) ELSE jsonb_build_object('gold',GREATEST(2500,floor(v_next_target/10.0)::bigint),'hero',5*(v_tier+2)) END,'claimed',false); END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO v_next_quests FROM jsonb_array_elements(v_quests) WITH ORDINALITY e(value,ord) WHERE value->>'id'<>p_quest_id;
    IF v_next_target IS NOT NULL THEN v_next_quests:=v_next_quests||jsonb_build_array(v_next); END IF;
    v_state := jsonb_set(v_state,'{milestoneQuests}',v_next_quests,true);
  END IF;
  UPDATE public.players SET token_balance=v_balance, boost_tokens_earned=boost_tokens_earned+v_hero, updated_at=now() WHERE player_id=p_player_id;
  IF v_hero>0 THEN INSERT INTO public.hero_economy_ledger(flow,source_kind,source_key,player_id,amount,metadata)
    VALUES('player_issuance','quest-reward','quest:'||p_player_id::text||':'||v_instance,p_player_id,v_hero,jsonb_build_object('quest_id',p_quest_id,'family',v_family)); END IF;
  UPDATE public.player_saves SET state=v_state,revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING revision INTO v_revision;
  v_result:=jsonb_build_object('quest_id',p_quest_id,'family',v_family,'claimed',true,'reward',v_reward,'gold',v_gold,'token_balance',v_balance,'resources',v_resource,'next_milestone',v_next,'state',v_state,'revision',v_revision,'replayed',false);
  INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result) VALUES(p_idempotency_key,p_player_id,v_instance,p_quest_id,p_expected_revision,v_result);
  RETURN v_result;
END $function$;

CREATE OR REPLACE FUNCTION public.sync_quest_progress_before_save()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  v_day text := to_char(public.heroloop_game_date(now()), 'YYYY-MM-DD');
  v_old_day text;
  v_daily jsonb;
  v_milestones jsonb;
  v_delta bigint;
BEGIN
  v_old_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((OLD.state->>'lastQuestReset')::numeric, 0) / 1000)), 'YYYY-MM-DD');
  IF v_old_day IS DISTINCT FROM v_day THEN
    v_daily := public.quest_daily_catalogue();
    NEW.state := jsonb_set(NEW.state, '{lastQuestReset}', to_jsonb(v_now_ms), true);
  ELSE
    v_daily := COALESCE(NEW.state->'dailyQuests', public.quest_daily_catalogue());
  END IF;

  v_delta := GREATEST(0, COALESCE((NEW.state->>'totalKills')::bigint, 0) - COALESCE((OLD.state->>'totalKills')::bigint, 0));
  IF v_delta > 0 AND (v_old_day IS DISTINCT FROM v_day OR NEW.state->'dailyQuests' = OLD.state->'dailyQuests') THEN
    v_daily := public.quest_advance_prefix(v_daily, 'kill-', v_delta);
  END IF;
  v_delta := GREATEST(0, COALESCE((NEW.state->>'totalBossKills')::bigint, 0) - COALESCE((OLD.state->>'totalBossKills')::bigint, 0));
  IF v_delta > 0 AND (v_old_day IS DISTINCT FROM v_day OR NEW.state->'dailyQuests' = OLD.state->'dailyQuests') THEN
    v_daily := public.quest_advance_prefix(v_daily, 'boss-', v_delta);
  END IF;
  v_delta := GREATEST(0, COALESCE((NEW.state->>'summons')::bigint, 0) - COALESCE((OLD.state->>'summons')::bigint, 0));
  IF v_delta > 0 AND (v_old_day IS DISTINCT FROM v_day OR NEW.state->'dailyQuests' = OLD.state->'dailyQuests') THEN
    v_daily := public.quest_advance_prefix(v_daily, 'summon-', v_delta);
  END IF;
  IF v_old_day IS DISTINCT FROM v_day THEN
    v_delta := GREATEST(0, COALESCE((NEW.state->>'chestsOpenedToday')::bigint, 0));
    IF v_delta > 0 THEN v_daily := public.quest_advance_prefix(v_daily, 'chest-', v_delta); END IF;
  END IF;
  NEW.state := jsonb_set(NEW.state, '{dailyQuests}', v_daily, true);

  v_delta := GREATEST(0, COALESCE((NEW.state->>'summons')::bigint, 0) - COALESCE((OLD.state->>'summons')::bigint, 0));
  v_milestones := COALESCE(NEW.state->'milestoneQuests', '[]'::jsonb);
  IF v_delta > 0 AND NEW.state->'milestoneQuests' = OLD.state->'milestoneQuests' THEN
    v_milestones := public.quest_advance_prefix(v_milestones, 'milestone-summon-', v_delta);
    NEW.state := jsonb_set(NEW.state, '{milestoneQuests}', v_milestones, true);
  END IF;
  RETURN NEW;
END $function$;

COMMIT;
