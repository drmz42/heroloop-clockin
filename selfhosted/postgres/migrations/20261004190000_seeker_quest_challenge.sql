-- Seeker lifetime Quest Challenge: every finite lifetime quest the player has claimed
-- counts toward one bar; each 10% step pays one server-owned prize (Gold and Summon
-- Scrolls only, zero $HERO). Progress is the player's own quest_claim_events, never a
-- client value. Idempotent re-application.
BEGIN;
-- Finite lifetime quests that count. Token milestone chains are hidden in Seeker.
CREATE OR REPLACE FUNCTION public.seeker_challenge_quests()
RETURNS TABLE(id text) LANGUAGE sql IMMUTABLE AS $$
 SELECT 'milestone-'||chain||'-'||target FROM (VALUES
  ('chest',1000),('chest',5000),('chest',25000),
  ('kill',50000),('kill',250000),('kill',1000000),
  ('boss',25),('boss',100),('boss',500),
  ('summon',10),('summon',100),('summon',1000),('summon',10000),
  ('gold-earned',100000),('gold-earned',1000000),('gold-earned',10000000),
  ('hero-owned',25),('hero-owned',100),('hero-owned',200)) m(chain,target)
 UNION ALL
 SELECT q.id FROM public.seeker_activity_quest_catalogue() q WHERE q.kind='milestone'
$$;

-- Founder 2026-10-04: a prize at every 10%; the 100% prize is the largest.
CREATE OR REPLACE FUNCTION public.seeker_challenge_rewards()
RETURNS TABLE(step integer,gold bigint,scrolls bigint) LANGUAGE sql IMMUTABLE AS $$
 VALUES (1,2000,0),(2,0,1),(3,5000,0),(4,0,2),(5,10000,2),(6,15000,0),(7,0,3),(8,25000,0),(9,0,5),(10,50000,10)
$$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_challenge_status(p_player uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH total AS (SELECT count(*) AS n FROM public.seeker_challenge_quests()),
 done AS (
  SELECT count(*) AS n FROM public.quest_claim_events e
  WHERE e.player_id=p_player AND e.instance_key IN (SELECT id FROM public.seeker_challenge_quests())
 )
 SELECT jsonb_build_object('completed',d.n,'total',t.n,'steps',jsonb_agg(jsonb_build_object(
  'id','challenge-'||r.step,'step',r.step,'percent',r.step*10,
  'threshold',ceil(t.n*r.step/10.0)::bigint,
  'reward',jsonb_build_object('gold',r.gold,'hero',0,'summonScrolls',r.scrolls),
  'claimed',EXISTS(SELECT 1 FROM public.quest_claim_events e WHERE e.player_id=p_player AND e.instance_key='challenge-'||r.step)
 ) ORDER BY r.step))
 FROM public.seeker_challenge_rewards() r CROSS JOIN total t CROSS JOIN done d
 GROUP BY d.n,t.n
$$;

CREATE OR REPLACE FUNCTION public.seeker_challenge_claim(p_player uuid,p_key uuid,p_id text,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c jsonb; q jsonb; s public.player_saves; e public.quest_claim_events; resources jsonb; result jsonb;
BEGIN
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
 c:=heroloop_api.seeker_challenge_status(p_player);
 SELECT value INTO q FROM jsonb_array_elements(c->'steps') WHERE value->>'id'=p_id;
 IF q IS NULL THEN RAISE EXCEPTION 'quest_unknown'; END IF;
 IF (q->>'claimed')::boolean THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
 IF (c->>'completed')::bigint<(q->>'threshold')::bigint THEN RAISE EXCEPTION 'quest_incomplete'; END IF;
 IF (q#>>'{reward,summonScrolls}')::bigint>0 THEN
  resources:=public.apply_resource_entries(p_player,p_key,'quest_claim',encode(extensions.digest(p_id::bytea,'sha256'),'hex'),
   jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',q#>>'{reward,summonScrolls}','source_key','summon_milestone_scroll')),s.revision+1);
  s.state:=jsonb_set(s.state,'{summonScrolls}',resources#>'{balances,summon_scroll}',true);
 END IF;
 s.state:=jsonb_set(s.state,'{gold}',to_jsonb(COALESCE((s.state->>'gold')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
 s.state:=jsonb_set(s.state,'{totalGoldEarned}',to_jsonb(COALESCE((s.state->>'totalGoldEarned')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
 UPDATE public.player_saves SET state=s.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING * INTO s;
 result:=jsonb_build_object('quest_id',p_id,'family','milestone','claimed',true,'reward',q->'reward','state',s.state,'revision',s.revision,'replayed',false);
 INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result) VALUES(p_key,p_player,p_id,p_id,p_revision,(result-'state')||jsonb_build_object('rules_version','seeker-challenge-v1','state_hash',encode(extensions.digest(s.state::text,'sha256'),'hex')));
 RETURN result;
END $$;

-- Route challenge-* claims ahead of the activity and standard quest settlements.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('heroloop_api.seeker_quest_claim(uuid,uuid,text,bigint)'::regprocedure);
 IF position('public.seeker_challenge_claim(' IN d)=0 THEN
  d:=replace(d,$s$IF p_id NOT LIKE 'skr-%' AND p_id NOT LIKE 'mine-%' THEN$s$,
   $s$IF p_id LIKE 'challenge-%' THEN RETURN public.seeker_challenge_claim(p_player,p_key,p_id,p_revision); END IF;
 IF p_id NOT LIKE 'skr-%' AND p_id NOT LIKE 'mine-%' THEN$s$);
  IF position('public.seeker_challenge_claim(' IN d)=0 THEN RAISE EXCEPTION 'seeker_challenge_patch_failed'; END IF;
  EXECUTE d;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.seeker_challenge_quests(),public.seeker_challenge_rewards(),
  heroloop_api.seeker_challenge_status(uuid),public.seeker_challenge_claim(uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_challenge_status(uuid) TO heroloop_api;
COMMIT;
