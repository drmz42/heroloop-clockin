-- Founder 2026-10-04: Summon Scrolls are revenue, so Mine quests grant fewer of them
-- (7-day streak: 3,000 Gold + 1 Scroll). Gold amounts are unchanged.
BEGIN;
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
 ('mine-daily-20','daily','Play 20 Mine rounds',20,1000,0),
 ('mine-daily-50','daily','Play 50 Mine rounds',50,3000,1),
 ('mine-streak-3','daily','Mining streak: 5+ rounds for 3 days in a row',3,1500,0),
 ('mine-streak-7','daily','Mining streak: 5+ rounds for 7 days in a row',7,3000,1),
 ('mine-rank-bronze','milestone','Bronze Miner: 50 Mine rounds',50,2000,0),
 ('mine-rank-silver','milestone','Silver Miner: 250 Mine rounds',250,5000,1),
 ('mine-rank-gold','milestone','Gold Miner: 1,000 Mine rounds',1000,10000,2),
 ('mine-rank-diamond','milestone','Diamond Miner: 5,000 Mine rounds',5000,50000,5)
$$;
REVOKE ALL ON FUNCTION public.seeker_activity_quest_catalogue() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
