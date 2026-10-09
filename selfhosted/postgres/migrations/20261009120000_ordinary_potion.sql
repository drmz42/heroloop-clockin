BEGIN;
-- All eight former bottle types consolidate 1:1 into potion_xs. No bottle is lost.
UPDATE public.resource_catalog SET maximum_balance=8000000000 WHERE resource_id='potion_xs';
DO $patch$
DECLARE d text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)',
    'public.resource_ledger_reconciliation()'] LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    IF position('ordinary_potion_conversion' in d)=0 THEN
      IF position('''potion_use''' in d)=0 THEN RAISE EXCEPTION 'ordinary_resource_definition_mismatch'; END IF;
      EXECUTE replace(d,'''potion_use''','''potion_use'',''ordinary_potion_conversion''');
    END IF;
  END LOOP;
END $patch$;
-- Only the Seeker API selects this version. Pending waves keep their frozen policy.
CREATE TABLE public.ordinary_potion_state (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  heroes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(heroes)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ordinary_potion_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ordinary_potion_state FROM PUBLIC,anon,authenticated,service_role,heroloop_api_runtime;

CREATE FUNCTION heroloop_api.ordinary_potion_context(p_player_id uuid,p_start_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE r jsonb; s public.player_saves; entries jsonb; bottles bigint; resources jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('normal-combat:'||p_player_id::text,0));
  IF NOT EXISTS (SELECT 1 FROM public.normal_combat_events WHERE player_id=p_player_id AND start_key=p_start_key
    AND completed_at IS NULL AND outcome IS NULL
    AND balance_version='seeker-200-2026.10.09-v1-combat-effects-v2-ordinary-potion-v1') THEN
    RAISE EXCEPTION 'normal_combat_not_found';
  END IF;
  -- Preparation already excludes other active waves. Never touch frozen legacy stock.
  IF EXISTS(SELECT 1 FROM public.normal_combat_events WHERE player_id=p_player_id AND completed_at IS NULL
    AND start_key<>p_start_key) THEN RAISE EXCEPTION 'active_encounter_exists'; END IF;
  SELECT * INTO STRICT s FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
  PERFORM 1 FROM public.player_resource_state WHERE player_id=p_player_id FOR UPDATE;
  SELECT sum(quantity_bigint),jsonb_agg(jsonb_build_object('resource_id',resource_id,
    'delta',(-quantity_bigint)::text,'source_key','ordinary_potion_conversion') ORDER BY resource_id)
  INTO bottles,entries FROM public.player_resource_balances WHERE player_id=p_player_id
    AND resource_id IN ('potion_sm','potion_md','potion_lg','potion_xl','potion_xxl','premium_potion_weak','premium_potion_strong')
    AND quantity_bigint>0;
  IF bottles>0 THEN
    entries:=entries||jsonb_build_array(jsonb_build_object('resource_id','potion_xs','delta',bottles::text,'source_key','ordinary_potion_conversion'));
    resources:=public.apply_resource_entries(p_player_id,gen_random_uuid(),'ordinary_potion_conversion',
      encode(extensions.digest(entries::text,'sha256'),'hex'),entries,s.revision+1);
    UPDATE public.player_saves SET state=jsonb_set(state,'{potions}',jsonb_build_object(
      'xs',(resources#>>'{balances,potion_xs}')::bigint,'sm',0,'md',0,'lg',0,'xl',0,'xxl',0)),
      revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING * INTO s;
    UPDATE public.normal_combat_events SET state_revision=s.revision WHERE start_key=p_start_key;
  END IF;
  SELECT heroes INTO r FROM public.ordinary_potion_state WHERE player_id=p_player_id;
  RETURN COALESCE(r,'{}'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION heroloop_api.ordinary_potion_context(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heroloop_api.ordinary_potion_context(uuid,uuid) TO heroloop_api_runtime;

ALTER FUNCTION public.normal_combat_auto_potions_valid(jsonb,jsonb) RENAME TO normal_combat_legacy_auto_potions_valid;
CREATE FUNCTION public.normal_combat_auto_potions_valid(p_initial_units jsonb,p_outcome jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $fn$
DECLARE e jsonb; h jsonb; prior integer:=-1; total bigint:=0; used jsonb:='{}'::jsonb; uid text;
BEGIN
  IF p_outcome->>'healing_policy' IS DISTINCT FROM 'ordinary-potion-v1' THEN
    RETURN public.normal_combat_legacy_auto_potions_valid(p_initial_units,p_outcome);
  END IF;
  IF jsonb_typeof(p_outcome->'auto_potions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_outcome->'auto_potions')>15
    OR COALESCE(p_outcome->>'auto_pot_gold_cost','') !~ '^[0-9]+$'
    OR jsonb_typeof(p_outcome->'ordinary_potion_state') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_outcome->'auto_potions') LOOP
    uid:=e->>'hero_uid';
    SELECT value INTO h FROM jsonb_array_elements(p_initial_units) WHERE value->>'side'='hero' AND value->>'uid'=uid;
    IF h IS NULL OR e - ARRAY['elapsed_ms','hero_uid','tier','hp_restore','from_stock','gold_cost']<>'{}'::jsonb
      OR e->>'tier' IS DISTINCT FROM 'xs' OR jsonb_typeof(e->'from_stock') IS DISTINCT FROM 'boolean'
      OR COALESCE(e->>'elapsed_ms','') !~ '^[0-9]+$' OR COALESCE(e->>'gold_cost','') !~ '^[0-9]+$'
      OR COALESCE(e->>'hp_restore','') !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
    IF (e->>'elapsed_ms')::integer NOT BETWEEN 0 AND (p_outcome->>'elapsed_ms')::integer
      OR (e->>'elapsed_ms')::integer<prior
      OR (e->>'hp_restore')::bigint<>(h->>'maxHp')::bigint
      OR (e->>'gold_cost')::integer<>(CASE WHEN (e->>'from_stock')::boolean THEN 0 ELSE 3 END)
      OR (used ? uid AND (e->>'elapsed_ms')::integer-(used->>uid)::integer<30000) THEN RETURN false; END IF;
    prior:=(e->>'elapsed_ms')::integer;
    total:=total+(e->>'gold_cost')::integer;
    used:=jsonb_set(used,ARRAY[uid],e->'elapsed_ms');
  END LOOP;
  FOR uid,h IN SELECT key,value FROM jsonb_each(p_outcome->'ordinary_potion_state') LOOP
    IF jsonb_typeof(h) IS DISTINCT FROM 'object' OR h-ARRAY['cooldown_until_ms','buff']<>'{}'::jsonb
      OR COALESCE(h->>'cooldown_until_ms','') !~ '^[0-9]+$' THEN RETURN false; END IF;
    IF h->'buff'<>'null'::jsonb AND (jsonb_typeof(h->'buff') IS DISTINCT FROM 'object'
      OR (h->'buff')-ARRAY['total','ticks','next_ms']<>'{}'::jsonb
      OR COALESCE(h#>>'{buff,total}','') !~ '^[1-9][0-9]*$'
      OR COALESCE(h#>>'{buff,ticks}','') !~ '^[0-3]$'
      OR COALESCE(h#>>'{buff,next_ms}','') !~ '^[0-9]+$') THEN RETURN false; END IF;
  END LOOP;
  RETURN total=(p_outcome->>'auto_pot_gold_cost')::bigint;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.normal_combat_auto_potions_valid(jsonb,jsonb),
  public.normal_combat_legacy_auto_potions_valid(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE d text; n text; signature text;
  ordinary text:='seeker-200-2026.10.09-v1-combat-effects-v2-ordinary-potion-v1';
  seeker text:='seeker-200-2026.10.08-v1-combat-effects-v2-auto-healing-v1';
  legacy text:='balance-v6-2026.09.29-v1-combat-effects-v2-auto-healing-v1';
BEGIN
  d:=pg_get_functiondef('public.normal_combat_balance_version_gate()'::regprocedure);
  n:=replace(d,quote_literal(legacy),quote_literal(ordinary)||','||quote_literal(legacy));
  IF n=d THEN RAISE EXCEPTION 'ordinary_version_gate_mismatch'; END IF;
  EXECUTE n;
  d:=pg_get_functiondef('public.normal_combat_store_outcome(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  n:=replace(d,'IF NOT public.normal_combat_auto_potions_valid(p_initial_units, p_outcome) THEN',
    'IF EXISTS (SELECT 1 FROM public.normal_combat_events WHERE start_key=p_start_key AND player_id=p_player_id
      AND ((balance_version='||quote_literal(ordinary)||') <> COALESCE(p_outcome->>''healing_policy''=''ordinary-potion-v1'',false))) THEN
      RAISE EXCEPTION ''normal_combat_invalid_outcome''; END IF;
    IF NOT public.normal_combat_auto_potions_valid(p_initial_units, p_outcome) THEN');
  IF n=d THEN RAISE EXCEPTION 'ordinary_store_guard_mismatch'; END IF;
  EXECUTE n;
  d:=pg_get_functiondef('public.normal_combat_complete_without_auto_pot(uuid,uuid,uuid)'::regprocedure);
  n:=replace(d,'THEN 2 ELSE 1 END','THEN 2 WHEN v_event.balance_version='||quote_literal(ordinary)||' THEN 2 ELSE 1 END');
  n:=replace(n,'v_event.balance_version='||quote_literal(seeker),
    'v_event.balance_version IN ('||quote_literal(seeker)||','||quote_literal(ordinary)||')');
  IF n=d THEN RAISE EXCEPTION 'ordinary_reward_guard_mismatch'; END IF;
  EXECUTE n;
  d:=pg_get_functiondef('telemetry.stamp_economy_settlement()'::regprocedure);
  n:=replace(d,quote_literal(legacy),quote_literal(ordinary)||','||quote_literal(legacy));
  IF n=d THEN RAISE EXCEPTION 'ordinary_telemetry_guard_mismatch'; END IF;
  EXECUTE n;
END $patch$;

ALTER FUNCTION public.normal_combat_complete(uuid,uuid,uuid) RENAME TO normal_combat_complete_before_ordinary_potion;
CREATE FUNCTION public.normal_combat_complete(p_player_id uuid,p_start_key uuid,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE r jsonb; wave public.normal_combat_events;
BEGIN
  r:=public.normal_combat_complete_before_ordinary_potion(p_player_id,p_start_key,p_idempotency_key);
  IF COALESCE((r->>'replayed')::boolean,false) THEN RETURN r; END IF;
  SELECT * INTO STRICT wave FROM public.normal_combat_events WHERE player_id=p_player_id AND start_key=p_start_key;
  IF wave.balance_version='seeker-200-2026.10.09-v1-combat-effects-v2-ordinary-potion-v1' THEN
    INSERT INTO public.ordinary_potion_state(player_id,heroes) VALUES(p_player_id,wave.outcome->'ordinary_potion_state')
      ON CONFLICT(player_id) DO UPDATE SET heroes=EXCLUDED.heroes,updated_at=now();
  END IF;
  RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION public.normal_combat_complete_before_ordinary_potion(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.normal_combat_complete(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.normal_combat_complete(uuid,uuid,uuid) TO service_role;

-- Retained frozen Boss resolvers may execute repeatedly in one transaction.
-- Reset only their session-local event buffer; historical receipts remain intact.
DO $patch$
DECLARE signature text; d text; marker text:='CREATE TEMP TABLE premium_potion_events (';
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.dungeon_room_four_retinue_action(uuid,uuid,bigint,text,uuid)',
    'public.dungeon_shared_boss_basic_action(uuid,uuid,bigint,text,uuid)',
    'public.dungeon_shared_boss_v2_basic_action(uuid,uuid,bigint,text,uuid)'] LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    IF position(marker in d)=0 THEN RAISE EXCEPTION 'ordinary_legacy_resolver_mismatch'; END IF;
    EXECUTE replace(d,marker,'DROP TABLE IF EXISTS pg_temp.premium_potion_events; '||marker);
  END LOOP;
END $patch$;

-- New promo codes cannot contain potions. Existing redemption receipts remain immutable;
-- new uses of mixed legacy codes receive their other rewards, without potion issuance.
ALTER FUNCTION public.promo_code_reward_valid(jsonb) RENAME TO promo_code_reward_valid_before_ordinary_potion;
CREATE FUNCTION public.promo_code_reward_valid(p_reward jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $fn$
  SELECT NOT (p_reward ?| ARRAY['potion_xs','potion_sm','potion_md','potion_lg','potion_xl','potion_xxl'])
    AND public.promo_code_reward_valid_before_ordinary_potion(p_reward);
$fn$;
REVOKE ALL ON FUNCTION public.promo_code_reward_valid(jsonb),public.promo_code_reward_valid_before_ordinary_potion(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE d text; n text;
BEGIN
  d:=pg_get_functiondef('public.redeem_promo_code(uuid,text,uuid)'::regprocedure);
  n:=replace(d,'v_amount := COALESCE((v_code.rewards->>(''potion_'' || v_tier))::bigint, 0);','v_amount := 0;');
  IF n=d THEN RAISE EXCEPTION 'ordinary_promo_retirement_mismatch'; END IF;
  EXECUTE n;
END $patch$;
COMMIT;
