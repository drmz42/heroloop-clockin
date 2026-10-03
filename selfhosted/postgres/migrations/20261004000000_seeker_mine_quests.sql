-- Seeker ORE Mine quests: daily rounds, streaks and miner ranks pay Gold and Summon
-- Scrolls only. Progress comes from verified Mine rounds that the API copies from the
-- private wallet service; a client never reports rounds. Idempotent re-application.
BEGIN;
CREATE TABLE IF NOT EXISTS public.seeker_mine_rounds (
  round_id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  played_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS seeker_mine_rounds_player_time ON public.seeker_mine_rounds(player_id,played_at);
REVOKE ALL ON public.seeker_mine_rounds FROM PUBLIC,anon,authenticated,service_role;

-- Only the API calls this, with rounds the wallet service settled at a non-zero
-- verified cost for this player. Unknown fields, future times and replays are inert.
CREATE OR REPLACE FUNCTION heroloop_api.seeker_mine_record(p_player uuid,p_rounds jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb; v_added integer:=0; v_at timestamptz; v_id uuid;
BEGIN
  IF jsonb_typeof(p_rounds)<>'array' OR jsonb_array_length(p_rounds)>500 THEN RAISE EXCEPTION 'invalid_mine_rounds'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rounds) LOOP
    BEGIN
      v_id:=(r->>'id')::uuid; v_at:=(r->>'at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_mine_rounds';
    END;
    IF v_id IS NULL OR v_at IS NULL OR v_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'invalid_mine_rounds'; END IF;
    INSERT INTO public.seeker_mine_rounds(round_id,player_id,played_at) VALUES(v_id,p_player,v_at) ON CONFLICT (round_id) DO NOTHING;
    IF FOUND THEN v_added:=v_added+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('added',v_added);
END $$;

CREATE OR REPLACE FUNCTION public.seeker_activity_quest_catalogue()
RETURNS TABLE(id text,kind text,label text,target bigint,gold bigint,scrolls bigint)
LANGUAGE sql IMMUTABLE AS $$
 VALUES
 ('skr-daily-100','daily','Spend 100 SKR',100,500,0),
 ('skr-daily-1000','daily','Spend 1,000 SKR',1000,1500,1),
 ('skr-daily-10000','daily','Spend 10,000 SKR',10000,5000,2),
 ('skr-buy-1','daily','Buy 1 equipment item',1,500,0),
 ('skr-list-1','daily','List 1 equipment item on Market',1,500,0),
 ('skr-lifetime-1000','milestone','Spend 1,000 SKR total',1000,2500,1),
 ('skr-lifetime-10000','milestone','Spend 10,000 SKR total',10000,5000,3),
 ('skr-lifetime-100000','milestone','Spend 100,000 SKR total',100000,10000,5),
 ('skr-lifetime-1000000','milestone','Spend 1,000,000 SKR total',1000000,25000,10),
 ('skr-lifetime-10000000','milestone','Spend 10,000,000 SKR total',10000000,100000,50),
 ('mine-daily-5','daily','Play 5 Mine rounds',5,500,0),
 ('mine-daily-20','daily','Play 20 Mine rounds',20,1000,1),
 ('mine-daily-50','daily','Play 50 Mine rounds',50,3000,2),
 ('mine-streak-3','daily','Mining streak: 5+ rounds for 3 days in a row',3,1500,0),
 ('mine-streak-7','daily','Mining streak: 5+ rounds for 7 days in a row',7,3000,3),
 ('mine-rank-bronze','milestone','Bronze Miner: 50 Mine rounds',50,2000,1),
 ('mine-rank-silver','milestone','Silver Miner: 250 Mine rounds',250,5000,3),
 ('mine-rank-gold','milestone','Gold Miner: 1,000 Mine rounds',1000,10000,5),
 ('mine-rank-diamond','milestone','Diamond Miner: 5,000 Mine rounds',5000,50000,20)
$$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_quest_status(p_player uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Europe/Moscow')::date AS d),
 counters AS (
  SELECT COALESCE(sum(payment_minor),0)/1000000 AS lifetime,
   COALESCE(sum(payment_minor) FILTER(WHERE (paid_at AT TIME ZONE 'Europe/Moscow')::date=(SELECT d FROM today)),0)/1000000 AS daily,
   count(*) FILTER(WHERE action IN ('market_buy_listing','store_buy_item') AND (paid_at AT TIME ZONE 'Europe/Moscow')::date=(SELECT d FROM today)) AS bought,
   count(*) FILTER(WHERE action='market_list_item' AND (paid_at AT TIME ZONE 'Europe/Moscow')::date=(SELECT d FROM today)) AS listed
  FROM public.seeker_commerce_requests WHERE player_id=p_player AND status='delivered' AND payment_minor IS NOT NULL
 ),
 mine_days AS (
  SELECT (played_at AT TIME ZONE 'Europe/Moscow')::date AS d,count(*) AS n
  FROM public.seeker_mine_rounds WHERE player_id=p_player GROUP BY 1
 ),
 mine AS (
  SELECT COALESCE((SELECT sum(n) FROM mine_days),0) AS lifetime,
   COALESCE((SELECT n FROM mine_days WHERE d=(SELECT d FROM today)),0) AS daily,
   -- Consecutive Moscow days ending today with at least 5 rounds; zero until today qualifies.
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
   CASE WHEN q.kind='daily' THEN 'daily:'||q.id||':'||to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') ELSE q.id END)
 ) ORDER BY q.id LIKE 'mine-%',q.target,q.id),'[]'::jsonb),'ore_available',false,
  'mine',(SELECT jsonb_build_object('rounds_today',daily,'rounds_total',lifetime,'streak_days',streak) FROM mine))
 FROM public.seeker_activity_quest_catalogue() q CROSS JOIN counters c CROSS JOIN mine m
$$;

-- Route mine-* quest claims through the existing activity-quest settlement.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('heroloop_api.seeker_quest_claim(uuid,uuid,text,bigint)'::regprocedure);
 IF position($s$p_id NOT LIKE 'mine-%'$s$ IN d)=0 THEN
  d:=replace(d,$s$IF p_id NOT LIKE 'skr-%' THEN$s$,$s$IF p_id NOT LIKE 'skr-%' AND p_id NOT LIKE 'mine-%' THEN$s$);
  IF position($s$p_id NOT LIKE 'mine-%'$s$ IN d)=0 THEN RAISE EXCEPTION 'seeker_mine_quest_patch_failed'; END IF;
  EXECUTE d;
 END IF;
END $$;
REVOKE ALL ON FUNCTION heroloop_api.seeker_mine_record(uuid,jsonb),public.seeker_activity_quest_catalogue(),
  heroloop_api.seeker_quest_status(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_mine_record(uuid,jsonb),heroloop_api.seeker_quest_status(uuid) TO heroloop_api;
COMMIT;
