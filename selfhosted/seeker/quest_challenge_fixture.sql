-- Disposable accounts only. Lifetime quest claims are synthetic receipt rows.
\set ON_ERROR_STOP 1
DO $$
DECLARE p uuid; c jsonb; r jsonb; s public.player_saves; gold bigint; k uuid; balance numeric; done bigint; step jsonb; locked jsonb;
BEGIN
 SELECT player_id INTO p FROM public.player_saves WHERE public.account_risk_level(player_id) NOT IN ('review','hold') ORDER BY player_id LIMIT 1;
 SELECT token_balance INTO balance FROM public.players WHERE player_id=p;
 c:=heroloop_api.seeker_challenge_status(p);
 IF (c->>'total')::integer<>28 OR jsonb_array_length(c->'steps')<>10 THEN RAISE EXCEPTION 'challenge catalogue %',c; END IF;
 IF (c#>>'{steps,9,threshold}')::integer<>28 OR (c#>>'{steps,0,threshold}')::integer<>3 THEN RAISE EXCEPTION 'challenge thresholds %',c; END IF;
 -- Daily, tutorial-like and unknown claims never count; only catalogue lifetime quests do.
 INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result)
  SELECT gen_random_uuid(),p,'daily:mine-daily-5:2000-01-01','mine-daily-5',1,'{"family":"daily","reward":{"gold":0}}'
  WHERE NOT EXISTS (SELECT 1 FROM public.quest_claim_events WHERE player_id=p AND instance_key='daily:mine-daily-5:2000-01-01');
 IF (heroloop_api.seeker_challenge_status(p)->>'completed')<>(c->>'completed') THEN RAISE EXCEPTION 'daily claim counted'; END IF;
 INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result)
  SELECT gen_random_uuid(),p,q.id,q.id,1,'{"family":"milestone","reward":{"gold":0}}'
  FROM public.seeker_challenge_quests() q
  WHERE NOT EXISTS (SELECT 1 FROM public.quest_claim_events e WHERE e.player_id=p AND e.instance_key=q.id)
  LIMIT GREATEST(0,3-(c->>'completed')::integer);
 c:=heroloop_api.seeker_challenge_status(p); done:=(c->>'completed')::bigint;
 IF done<3 THEN RAISE EXCEPTION 'challenge count %',c; END IF;
 SELECT value INTO step FROM jsonb_array_elements(c->'steps') WHERE NOT (value->>'claimed')::boolean AND (value->>'threshold')::bigint<=done ORDER BY (value->>'step')::integer LIMIT 1;
 SELECT value INTO locked FROM jsonb_array_elements(c->'steps') WHERE (value->>'threshold')::bigint>done ORDER BY (value->>'step')::integer LIMIT 1;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 gold:=COALESCE((s.state->>'gold')::bigint,0);
 IF step IS NOT NULL THEN
  k:=gen_random_uuid(); r:=heroloop_api.seeker_quest_claim(p,k,step->>'id',s.revision);
  IF NOT (r->>'claimed')::boolean OR (r#>>'{state,gold}')::bigint<>gold+(step#>>'{reward,gold}')::bigint THEN RAISE EXCEPTION 'challenge claim %',r; END IF;
  IF NOT (heroloop_api.seeker_quest_claim(p,k,step->>'id',s.revision)->>'replayed')::boolean THEN RAISE EXCEPTION 'challenge replay'; END IF;
  SELECT * INTO s FROM public.player_saves WHERE player_id=p;
  BEGIN PERFORM heroloop_api.seeker_quest_claim(p,gen_random_uuid(),step->>'id',s.revision); RAISE EXCEPTION 'double challenge claim';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'quest_already_claimed' THEN RAISE; END IF; END;
  IF NOT (heroloop_api.seeker_challenge_status(p)#>>ARRAY['steps',((step->>'step')::integer-1)::text,'claimed'])::boolean THEN RAISE EXCEPTION 'challenge claim not shown'; END IF;
 END IF;
 IF locked IS NOT NULL THEN
  BEGIN PERFORM heroloop_api.seeker_quest_claim(p,gen_random_uuid(),locked->>'id',s.revision); RAISE EXCEPTION 'early challenge claim';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'quest_incomplete' THEN RAISE; END IF; END;
 END IF;
 BEGIN PERFORM heroloop_api.seeker_quest_claim(p,gen_random_uuid(),'challenge-11',s.revision); RAISE EXCEPTION 'unknown challenge claim';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'quest_unknown' THEN RAISE; END IF; END;
 IF (SELECT token_balance FROM public.players WHERE player_id=p)<>balance THEN RAISE EXCEPTION 'challenge emitted tokens'; END IF;
END $$;
