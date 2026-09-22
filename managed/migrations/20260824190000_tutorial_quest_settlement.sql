CREATE TABLE IF NOT EXISTS public.tutorial_quest_claim_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  quest_id text NOT NULL,
  expected_revision bigint NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tutorial_quest_claim_player_idx
  ON public.tutorial_quest_claim_events(player_id, created_at DESC);
ALTER TABLE public.tutorial_quest_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tutorial_quest_claim_events FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.tutorial_chest_open_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  chest_count integer NOT NULL CHECK (chest_count IN (1, 10)),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tutorial_chest_open_player_idx
  ON public.tutorial_chest_open_events(player_id, created_at DESC);
ALTER TABLE public.tutorial_chest_open_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tutorial_chest_open_events FROM PUBLIC, anon, authenticated;

-- Accounts that existed before the ordered chain was activated keep their completed compatibility state.
UPDATE public.player_saves
SET state = jsonb_set(state, '{tutorial}',
  COALESCE(state->'tutorial', '{}'::jsonb) || jsonb_build_object(
    'questOrdinal', 11, 'questCompleted', true, 'openedCount', 0,
    'chestBalance', COALESCE((public.resource_snapshot(player_id)#>>'{balances,tutorial_chest}')::bigint, 0),
    'bossKillsAtKeyGrant', COALESCE((state->>'totalBossKills')::bigint, 0)
  ), true)
WHERE NOT (COALESCE(state->'tutorial', '{}'::jsonb) ? 'questOrdinal');

CREATE OR REPLACE FUNCTION public.tutorial_quest_progress(p_state jsonb, p_ordinal integer)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v_team jsonb := COALESCE(p_state->'team','[]'::jsonb); v_owned jsonb := COALESCE(p_state->'ownedHeroes','[]'::jsonb);
BEGIN
  RETURN CASE p_ordinal
    WHEN 1 THEN GREATEST(0, COALESCE((p_state->>'totalKills')::bigint, 0))
    WHEN 2 THEN GREATEST(0, COALESCE((p_state#>>'{tutorial,openedCount}')::bigint, 0))
    WHEN 3 THEN CASE WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_owned) hero
      WHERE v_team ? (hero->>'uid') AND jsonb_typeof(hero->'equipped') = 'object' AND hero->'equipped' <> '{}'::jsonb
    ) THEN 1 ELSE 0 END
    WHEN 4 THEN GREATEST(0, COALESCE((p_state->>'summons')::bigint, 0))
    WHEN 5 THEN CASE WHEN jsonb_typeof(v_team) = 'array' THEN jsonb_array_length(v_team) ELSE 0 END
    WHEN 6 THEN GREATEST(0, COALESCE((p_state->>'summons')::bigint, 0))
    WHEN 7 THEN CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state#>'{trainingCamp,heroUids}','[]'::jsonb)) entry WHERE entry <> 'null'::jsonb) THEN 1 ELSE 0 END
    WHEN 8 THEN CASE WHEN COALESCE((p_state#>>'{autoPot,enabled}')::boolean, false) THEN 1 ELSE 0 END
    WHEN 9 THEN GREATEST(0, COALESCE((p_state->>'highestLocation')::bigint, 0))
    WHEN 10 THEN GREATEST(0, COALESCE((p_state->>'totalBossKills')::bigint, 0) - COALESCE((p_state#>>'{tutorial,bossKillsAtKeyGrant}')::bigint, 0))
    ELSE 0 END;
END $$;

CREATE OR REPLACE FUNCTION public.settle_tutorial_quest_claim(
  p_player_id uuid, p_idempotency_key uuid, p_quest_id text, p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.tutorial_quest_claim_events%ROWTYPE; v_save public.player_saves%ROWTYPE;
  v_ordinal integer; v_expected_id text; v_target bigint; v_progress bigint; v_reward jsonb; v_entries jsonb := '[]'::jsonb;
  v_resource jsonb; v_state jsonb; v_revision bigint; v_result jsonb; v_gold bigint; v_next integer;
  v_ids text[] := ARRAY['defeat-10-enemies','open-10-tutorial-chests','equip-active-hero','summon-two-heroes','fill-active-formation','summon-reserve-hero','assign-training-hero','enable-auto-pot','reach-location-2','defeat-tutorial-boss'];
  v_targets bigint[] := ARRAY[10,10,1,2,3,3,1,1,2,1];
BEGIN
  SELECT * INTO v_existing FROM public.tutorial_quest_claim_events WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id=p_player_id AND v_existing.quest_id=p_quest_id AND v_existing.expected_revision=p_expected_revision THEN RETURN v_existing.result || jsonb_build_object('replayed',true); END IF;
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_state := v_save.state; v_ordinal := COALESCE((v_state#>>'{tutorial,questOrdinal}')::integer, 11);
  IF COALESCE((v_state#>>'{tutorial,questCompleted}')::boolean, true) OR v_ordinal NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'tutorial_completed'; END IF;
  v_expected_id := v_ids[v_ordinal]; IF p_quest_id <> v_expected_id THEN RAISE EXCEPTION 'tutorial_quest_locked'; END IF;
  v_target := v_targets[v_ordinal]; v_progress := public.tutorial_quest_progress(v_state,v_ordinal);
  IF v_progress < v_target THEN RAISE EXCEPTION 'tutorial_quest_incomplete'; END IF;
  v_reward := CASE v_ordinal
    WHEN 1 THEN '{"tutorialChests":10}'::jsonb WHEN 2 THEN '{"gold":500}'::jsonb
    WHEN 3 THEN '{"summonScrolls":2}'::jsonb WHEN 4 THEN '{"summonScrolls":1}'::jsonb
    WHEN 5 THEN '{"potions":{"xs":3}}'::jsonb WHEN 6 THEN '{"gold":500}'::jsonb
    WHEN 7 THEN '{"potions":{"xs":3}}'::jsonb WHEN 8 THEN '{"bossKeys":1}'::jsonb
    WHEN 9 THEN '{"gold":1000}'::jsonb ELSE '{"summonScrolls":1,"tutorialComplete":true}'::jsonb END;
  v_entries := CASE v_ordinal
    WHEN 1 THEN '[{"resource_id":"tutorial_chest","delta":"10","source_key":"tutorial_chest"}]'::jsonb
    WHEN 3 THEN '[{"resource_id":"summon_scroll","delta":"2","source_key":"tutorial_summon_scroll"}]'::jsonb
    WHEN 4 THEN '[{"resource_id":"summon_scroll","delta":"1","source_key":"tutorial_summon_scroll"}]'::jsonb
    WHEN 5 THEN '[{"resource_id":"potion_xs","delta":"3","source_key":"tutorial_potion"}]'::jsonb
    WHEN 7 THEN '[{"resource_id":"potion_xs","delta":"3","source_key":"tutorial_potion"}]'::jsonb
    WHEN 8 THEN '[{"resource_id":"boss_key","delta":"1","source_key":"tutorial_boss_key"}]'::jsonb
    WHEN 10 THEN '[{"resource_id":"summon_scroll","delta":"1","source_key":"tutorial_summon_scroll"}]'::jsonb
    ELSE '[]'::jsonb END;
  v_next := v_ordinal+1; v_gold := GREATEST(0,COALESCE((v_state->>'gold')::bigint,0))+COALESCE((v_reward->>'gold')::bigint,0);
  IF jsonb_array_length(v_entries)>0 THEN
    v_resource := public.apply_resource_entries(p_player_id,p_idempotency_key,'tutorial_quest_claim',
      encode(extensions.digest((p_quest_id||':'||p_expected_revision::text)::bytea,'sha256'),'hex'),v_entries,v_save.revision+1);
  ELSE v_resource := public.resource_snapshot(p_player_id); END IF;
  v_state := jsonb_set(v_state,'{gold}',to_jsonb(v_gold),true);
  v_state := jsonb_set(v_state,'{tutorial,questOrdinal}',to_jsonb(v_next),true);
  v_state := jsonb_set(v_state,'{tutorial,questCompleted}',to_jsonb(v_next>10),true);
  v_state := jsonb_set(v_state,'{tutorial,chestBalance}',to_jsonb(COALESCE((v_resource#>>'{balances,tutorial_chest}')::bigint,0)),true);
  IF v_ordinal=8 THEN v_state := jsonb_set(v_state,'{tutorial,bossKillsAtKeyGrant}',to_jsonb(COALESCE((v_state->>'totalBossKills')::bigint,0)),true); END IF;
  v_state := jsonb_set(v_state,'{bossKeys}',to_jsonb(COALESCE((v_resource#>>'{balances,boss_key}')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{summonScrolls}',to_jsonb(COALESCE((v_resource#>>'{balances,summon_scroll}')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{potions,xs}',to_jsonb(COALESCE((v_resource#>>'{balances,potion_xs}')::bigint,0)),true);
  UPDATE public.player_saves SET state=v_state,revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING revision INTO v_revision;
  v_result := jsonb_build_object('quest_id',p_quest_id,'family','tutorial','claimed',true,'reward',v_reward,'gold',v_gold,'resources',v_resource,'tutorial',v_state->'tutorial','revision',v_revision,'replayed',false);
  INSERT INTO public.tutorial_quest_claim_events VALUES(p_idempotency_key,p_player_id,p_quest_id,p_expected_revision,v_result,now()); RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.settle_tutorial_chest_open(p_player_id uuid,p_idempotency_key uuid,p_count integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.tutorial_chest_open_events%ROWTYPE; v_save public.player_saves%ROWTYPE; v_entries jsonb; v_resource jsonb; v_result jsonb; v_chests jsonb := '[]'::jsonb; i integer;
BEGIN
  IF p_count NOT IN (1,10) THEN RAISE EXCEPTION 'invalid_tutorial_chest_count'; END IF;
  SELECT * INTO v_existing FROM public.tutorial_chest_open_events WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN IF v_existing.player_id=p_player_id AND v_existing.chest_count=p_count THEN RETURN v_existing.result || jsonb_build_object('replayed',true); END IF; RAISE EXCEPTION 'idempotency_conflict'; END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_entries := jsonb_build_array(jsonb_build_object('resource_id','tutorial_chest','delta',(-p_count)::text,'source_key','tutorial_chest_open'));
  v_resource := public.apply_resource_entries(p_player_id,p_idempotency_key,'tutorial_chest_open',encode(extensions.digest(p_count::text::bytea,'sha256'),'hex'),v_entries,v_save.revision+1);
  FOR i IN 1..p_count LOOP v_chests := v_chests || jsonb_build_array(jsonb_build_object('id','tutorial-'||p_idempotency_key::text||'-'||i,'stage',GREATEST(1,COALESCE((v_save.state->>'currentLocation')::integer,1)),'boss',false,'tutorial',true)); END LOOP;
  UPDATE public.player_saves SET state=jsonb_set(jsonb_set(state,'{chests}',v_chests||COALESCE(state->'chests','[]'::jsonb),true),'{tutorial,openedCount}',to_jsonb(COALESCE((state#>>'{tutorial,openedCount}')::integer,0)+p_count),true) WHERE player_id=p_player_id;
  v_result := public.settle_chest_open(p_player_id,p_idempotency_key,p_count);
  SELECT public.resource_snapshot(p_player_id) INTO v_resource;
  UPDATE public.player_saves SET state=jsonb_set(state,'{tutorial,chestBalance}',to_jsonb(COALESCE((v_resource#>>'{balances,tutorial_chest}')::bigint,0)),true) WHERE player_id=p_player_id;
  v_result := v_result || jsonb_build_object('resources',v_resource,'tutorial',(SELECT state->'tutorial' FROM public.player_saves WHERE player_id=p_player_id),'replayed',false);
  INSERT INTO public.tutorial_chest_open_events VALUES(p_idempotency_key,p_player_id,p_count,v_result,now()); RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.tutorial_quest_progress(jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.settle_tutorial_quest_claim(uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_tutorial_chest_open(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_tutorial_quest_claim(uuid,uuid,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_tutorial_chest_open(uuid,uuid,integer) TO service_role;
