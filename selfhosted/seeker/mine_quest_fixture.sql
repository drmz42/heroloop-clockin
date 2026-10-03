-- Disposable accounts only. Mine rounds are synthetic receipts; no chain or wallet is used.
\set ON_ERROR_STOP 1
DO $$
DECLARE p uuid; other uuid; r jsonb; s public.player_saves; gold bigint; k uuid; balance numeric; day_start timestamptz;
BEGIN
 SELECT player_id INTO p FROM public.player_saves WHERE public.account_risk_level(player_id) NOT IN ('review','hold') ORDER BY player_id LIMIT 1;
 SELECT player_id INTO other FROM public.player_saves WHERE player_id<>p ORDER BY player_id LIMIT 1;
 SELECT token_balance INTO balance FROM public.players WHERE player_id=p;
 day_start:=(date_trunc('day',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow');
 -- Five rounds today and on each of the two previous Moscow days.
 r:=heroloop_api.seeker_mine_record(p,(SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'at',day_start-make_interval(days=>d)+interval '1 hour'))
   FROM generate_series(0,2) d CROSS JOIN generate_series(1,5)));
 IF (r->>'added')::integer<>15 THEN RAISE EXCEPTION 'mine record %',r; END IF;
 -- Replays and a foreign player's claim on the same round ids are inert.
 PERFORM heroloop_api.seeker_mine_record(other,(SELECT jsonb_agg(jsonb_build_object('id',round_id,'at',played_at))
   FROM public.seeker_mine_rounds WHERE player_id=p));
 IF (SELECT count(*) FROM public.seeker_mine_rounds WHERE player_id=other)<>0 THEN RAISE EXCEPTION 'round stolen'; END IF;
 BEGIN PERFORM heroloop_api.seeker_mine_record(p,jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',now()+interval '1 day')));
   RAISE EXCEPTION 'future round accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid_mine_rounds' THEN RAISE; END IF; END;
 r:=heroloop_api.seeker_quest_status(p)->'mine';
 IF r<>'{"rounds_today":5,"rounds_total":15,"streak_days":3}'::jsonb THEN RAISE EXCEPTION 'mine counters %',r; END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 gold:=COALESCE((s.state->>'gold')::bigint,0);
 k:=gen_random_uuid(); r:=heroloop_api.seeker_quest_claim(p,k,'mine-daily-5',s.revision);
 IF NOT (r->>'claimed')::boolean OR (r#>>'{reward,gold}')::bigint<>500 OR (r#>>'{state,gold}')::bigint<>gold+500 THEN RAISE EXCEPTION 'mine daily %',r; END IF;
 IF NOT (heroloop_api.seeker_quest_claim(p,k,'mine-daily-5',s.revision)->>'replayed')::boolean THEN RAISE EXCEPTION 'mine replay'; END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 BEGIN PERFORM heroloop_api.seeker_quest_claim(p,gen_random_uuid(),'mine-daily-5',s.revision); RAISE EXCEPTION 'double mine claim';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'quest_already_claimed' THEN RAISE; END IF; END;
 BEGIN PERFORM heroloop_api.seeker_quest_claim(p,gen_random_uuid(),'mine-daily-20',s.revision); RAISE EXCEPTION 'incomplete mine claim';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'quest_incomplete' THEN RAISE; END IF; END;
 r:=heroloop_api.seeker_quest_claim(p,gen_random_uuid(),'mine-streak-3',s.revision);
 IF (r#>>'{reward,gold}')::bigint<>1500 THEN RAISE EXCEPTION 'mine streak %',r; END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 BEGIN PERFORM heroloop_api.seeker_quest_claim(p,gen_random_uuid(),'mine-rank-bronze',s.revision); RAISE EXCEPTION 'early rank';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'quest_incomplete' THEN RAISE; END IF; END;
 -- A missed day today breaks the streak.
 DELETE FROM public.seeker_mine_rounds WHERE player_id=p AND played_at>=day_start;
 IF (heroloop_api.seeker_quest_status(p)#>>'{mine,streak_days}')::integer<>0 THEN RAISE EXCEPTION 'streak not reset'; END IF;
 IF (SELECT token_balance FROM public.players WHERE player_id=p)<>balance THEN RAISE EXCEPTION 'mine quest emitted tokens'; END IF;
 DELETE FROM public.seeker_mine_rounds WHERE player_id=p;
END $$;
