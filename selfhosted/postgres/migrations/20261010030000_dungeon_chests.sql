-- Dungeon Chests: one chest per reward-eligible final Dungeon Boss victory, stacked per Depth
-- in the resource ledger. Opening one rolls exactly one Hero from that Depth's table.
-- Divine and Celestial obey the shared rarity supply; an exhausted tier falls back to Epic.
BEGIN;

INSERT INTO public.resource_catalog(resource_id,family,display_order,maximum_balance)
VALUES ('dungeon_chest_d1','chest',16,1000000),
       ('dungeon_chest_d2','chest',17,1000000),
       ('dungeon_chest_d3','chest',18,1000000)
ON CONFLICT (resource_id) DO NOTHING;
INSERT INTO public.player_resource_balances(player_id,resource_id)
SELECT player_id,resource_id FROM public.player_resource_state
CROSS JOIN public.resource_catalog WHERE resource_id IN ('dungeon_chest_d1','dungeon_chest_d2','dungeon_chest_d3')
ON CONFLICT DO NOTHING;

DO $patch$
DECLARE d text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)',
    'public.resource_ledger_reconciliation()'] LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    IF position('dungeon_chest_open' in d)=0 THEN
      IF length(d)-length(replace(d,'''boss_summon_scroll''',''))<>length('''boss_summon_scroll''') THEN
        RAISE EXCEPTION 'dungeon_chest_resource_definition_mismatch';
      END IF;
      d:=replace(d,'''boss_summon_scroll''','''boss_summon_scroll'',''dungeon_chest_reward'',''dungeon_chest_open''');
      EXECUTE d;
    END IF;
  END LOOP;
END $patch$;

CREATE TABLE IF NOT EXISTS public.dungeon_chest_open_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  depth smallint NOT NULL CHECK (depth BETWEEN 1 AND 3),
  expected_revision bigint NOT NULL,
  rarity text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dungeon_chest_open_events_player_idx ON public.dungeon_chest_open_events(player_id,created_at);
ALTER TABLE public.dungeon_chest_open_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dungeon_chest_open_events FROM PUBLIC,anon,authenticated,service_role,heroloop_api_runtime;

-- Percent weights in rarity order epic, legendary, mythic, cosmic, divine, celestial.
CREATE OR REPLACE FUNCTION public.dungeon_chest_weights(p_depth integer)
RETURNS numeric[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT CASE p_depth
    WHEN 1 THEN ARRAY[80,15,4,1,0,0]::numeric[]
    WHEN 2 THEN ARRAY[70,20,7,2.5,0.5,0]::numeric[]
    WHEN 3 THEN ARRAY[60,25,10,4,0.8,0.2]::numeric[]
  END
$fn$;

CREATE OR REPLACE FUNCTION public.dungeon_chest_balances(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT jsonb_build_object(
    '1',COALESCE((SELECT quantity_bigint FROM public.player_resource_balances WHERE player_id=p_player_id AND resource_id='dungeon_chest_d1'),0),
    '2',COALESCE((SELECT quantity_bigint FROM public.player_resource_balances WHERE player_id=p_player_id AND resource_id='dungeon_chest_d2'),0),
    '3',COALESCE((SELECT quantity_bigint FROM public.player_resource_balances WHERE player_id=p_player_id AND resource_id='dungeon_chest_d3'),0))
$fn$;

CREATE OR REPLACE FUNCTION public.dungeon_chest_odds()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $fn$
  SELECT jsonb_object_agg(depth::text,(
    SELECT jsonb_object_agg(rarity,weight) FROM unnest(ARRAY['epic','legendary','mythic','cosmic','divine','celestial'],
      public.dungeon_chest_weights(depth)) AS t(rarity,weight) WHERE weight>0))
  FROM generate_series(1,3) depth
$fn$;

CREATE OR REPLACE FUNCTION public.settle_dungeon_chest_open(
  p_player_id uuid, p_idempotency_key uuid, p_depth integer, p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $fn$
DECLARE
  v_existing public.dungeon_chest_open_events%ROWTYPE;
  v_state jsonb; v_revision bigint; v_owned jsonb; v_hero jsonb; v_result jsonb;
  v_rarities text[] := ARRAY['epic','legendary','mythic','cosmic','divine','celestial'];
  v_weights numeric[]; v_total numeric := 0; v_roll numeric; v_cursor numeric := 0;
  v_index integer := 1; v_rarity text; v_class text; j integer;
  v_divine_remaining integer; v_celestial_remaining integer;
BEGIN
  IF p_idempotency_key IS NULL OR p_depth IS NULL OR p_depth NOT BETWEEN 1 AND 3
    OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'invalid_dungeon_chest_open';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  SELECT * INTO v_existing FROM public.dungeon_chest_open_events WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id<>p_player_id OR v_existing.depth<>p_depth OR v_existing.expected_revision<>p_expected_revision THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result || jsonb_build_object('replayed',true);
  END IF;
  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  SELECT state,revision INTO v_state,v_revision FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_owned := COALESCE(v_state->'ownedHeroes','[]'::jsonb);
  IF jsonb_typeof(v_owned)<>'array' THEN RAISE EXCEPTION 'invalid_owned_heroes'; END IF;
  IF jsonb_array_length(v_owned)+1 > COALESCE((v_state->>'heroCapacity')::integer,500) THEN
    RAISE EXCEPTION 'hero_capacity_exceeded';
  END IF;

  PERFORM public.apply_resource_entries(p_player_id,p_idempotency_key,'dungeon_chest_open',
    encode(extensions.digest(jsonb_build_object('depth',p_depth,'expected_revision',p_expected_revision)::text,'sha256'),'hex'),
    jsonb_build_array(jsonb_build_object('resource_id','dungeon_chest_d'||p_depth,'delta','-1','source_key','dungeon_chest_open')),
    p_expected_revision+1);

  PERFORM rarity FROM public.rarity_supply WHERE rarity IN ('celestial','divine') ORDER BY rarity FOR UPDATE;
  SELECT max_existing-existing_count INTO v_celestial_remaining FROM public.rarity_supply WHERE rarity='celestial';
  SELECT max_existing-existing_count INTO v_divine_remaining FROM public.rarity_supply WHERE rarity='divine';
  IF v_celestial_remaining IS NULL OR v_divine_remaining IS NULL THEN RAISE EXCEPTION 'rarity_supply_unavailable'; END IF;
  v_weights := public.dungeon_chest_weights(p_depth);
  IF v_divine_remaining<=0 THEN v_weights[1]:=v_weights[1]+v_weights[5]; v_weights[5]:=0; END IF;
  IF v_celestial_remaining<=0 THEN v_weights[1]:=v_weights[1]+v_weights[6]; v_weights[6]:=0; END IF;
  FOR j IN 1..6 LOOP v_total := v_total+v_weights[j]; END LOOP;
  v_roll := random()::numeric*v_total;
  FOR j IN 1..6 LOOP
    v_cursor := v_cursor+v_weights[j];
    IF v_weights[j]>0 AND v_roll<v_cursor THEN v_index:=j; EXIT; END IF;
  END LOOP;
  v_rarity := v_rarities[v_index];
  v_class := (ARRAY['shepherd','assassin','knight','druid','archer'])[1+floor(random()*5)::integer];
  v_hero := jsonb_build_object('uid',gen_random_uuid()::text,'heroId',v_class||'-'||v_rarity,'level',1,'stars',0,
    'equipped','{}'::jsonb,'xp',0,'isNew',true);
  v_owned := v_owned || jsonb_build_array(v_hero);

  UPDATE public.player_saves SET state=jsonb_set(v_state,'{ownedHeroes}',v_owned,true),
    revision=revision+1,updated_at=clock_timestamp()
  WHERE player_id=p_player_id AND revision=p_expected_revision RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'state_conflict'; END IF;

  v_result := jsonb_build_object('depth',p_depth,'rarity',v_rarity,'hero',v_hero,'revision',v_revision,
    'balances',public.dungeon_chest_balances(p_player_id),'replayed',false);
  INSERT INTO public.dungeon_chest_open_events(idempotency_key,player_id,depth,expected_revision,rarity,result)
  VALUES (p_idempotency_key,p_player_id,p_depth,p_expected_revision,v_rarity,v_result);
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_chest_status(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT jsonb_build_object('balances',public.dungeon_chest_balances(p_player_id),'odds',public.dungeon_chest_odds())
$fn$;

CREATE OR REPLACE FUNCTION heroloop_api.dungeon_chest_open(p_player_id uuid, p_key uuid, p_depth integer, p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  PERFORM public.assert_account_value_allowed(p_player_id);
  RETURN public.settle_dungeon_chest_open(p_player_id,p_key,p_depth,p_revision);
END
$fn$;

REVOKE ALL ON FUNCTION public.dungeon_chest_weights(integer),public.dungeon_chest_balances(uuid),public.dungeon_chest_odds(),
  public.settle_dungeon_chest_open(uuid,uuid,integer,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION heroloop_api.dungeon_chest_status(uuid),heroloop_api.dungeon_chest_open(uuid,uuid,integer,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heroloop_api.dungeon_chest_status(uuid),heroloop_api.dungeon_chest_open(uuid,uuid,integer,bigint)
  TO heroloop_api_runtime;

-- Final Boss claim: the reward-eligible entries (the same first three of the UTC week that earn
-- Scrolls) also earn one Dungeon Chest of the run's Depth, in the same Mailbox letter.
CREATE FUNCTION pg_temp.dungeon_chest_patch(p_definition text,p_old text,p_new text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_old='' OR length(p_definition)-length(replace(p_definition,p_old,'')) <> length(p_old) THEN
    RAISE EXCEPTION 'dungeon_chest_patch_anchor_mismatch';
  END IF;
  RETURN replace(p_definition,p_old,p_new);
END $$;
DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.dungeon_room_complete_before_delivery(uuid,uuid,bigint,uuid)'::regprocedure);
  IF position('dungeon_chests_awarded' in d)>0 THEN RETURN; END IF;
  d:=pg_temp.dungeon_chest_patch(d,
    $old$'[{"kind":"resource","resource_id":"summon_scroll","amount":2}]'::jsonb);$old$,
    $new$jsonb_build_array(jsonb_build_object('kind','resource','resource_id','summon_scroll','amount',2),
            jsonb_build_object('kind','resource','resource_id','dungeon_chest_d'||v_encounter.depth,'amount',1,
              'title','Dungeon Chest · Depth '||(ARRAY['I','II','III'])[v_encounter.depth])));$new$);
  d:=pg_temp.dungeon_chest_patch(d,
    $old$'[{"resource_id":"summon_scroll","delta":"2","source_key":"boss_summon_scroll"}]'::jsonb,$old$,
    $new$jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta','2','source_key','boss_summon_scroll'),
          jsonb_build_object('resource_id','dungeon_chest_d'||v_encounter.depth,'delta','1','source_key','dungeon_chest_reward')),$new$);
  d:=pg_temp.dungeon_chest_patch(d,
    '''scrolls_awarded'',v_scrolls,''rewards_mailed''',
    '''scrolls_awarded'',v_scrolls,''dungeon_chests_awarded'',CASE WHEN v_scrolls=2 THEN 1 ELSE 0 END,''dungeon_chest_depth'',v_encounter.depth,''rewards_mailed''');
  d:=pg_temp.dungeon_chest_patch(d,
    '''summon_scrolls'',v_scrolls,''dungeon_chests'',1,',
    '''summon_scrolls'',v_scrolls,''dungeon_chests'',CASE WHEN v_scrolls=2 THEN 1 ELSE 0 END,');
  d:=pg_temp.dungeon_chest_patch(d,
    'Summon Scrolls for clearing a dungeon. Claim them when you are ready.',
    'Summon Scrolls and a Dungeon Chest for clearing a dungeon. Claim them when you are ready.');
  EXECUTE d;
END
$patch$;
DROP FUNCTION pg_temp.dungeon_chest_patch(text,text,text);
COMMIT;
