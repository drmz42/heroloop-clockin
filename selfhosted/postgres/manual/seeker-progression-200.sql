-- Explicit Seeker-only installation, never part of the ordinary migration baseline.
-- Caller must select the isolated Seeker database and SET heroloop.edition = 'seeker'.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF current_setting('heroloop.edition', true) IS DISTINCT FROM 'seeker' THEN
    RAISE EXCEPTION 'seeker_progression_wrong_edition';
  END IF;
  IF to_regclass('public.seeker_progression_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'seeker_progression_already_installed';
  END IF;
END $$;

-- Block concurrent save creation and settlement throughout the policy cutover.
LOCK TABLE public.players, public.player_saves IN ACCESS EXCLUSIVE MODE;

CREATE TABLE public.seeker_progression_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.seeker_progression_settings(version) VALUES ('seeker-progression-200-v1');
REVOKE ALL ON public.seeker_progression_settings FROM PUBLIC, anon, authenticated, heroloop_api, heroloop_worker;

-- Settle old offline and Training intervals at one cutover time under the old policy.
DO $$ DECLARE r record; cutoff timestamptz; BEGIN
 SELECT activated_at INTO cutoff FROM public.seeker_progression_settings;
 FOR r IN SELECT player_id FROM public.player_saves LOOP
  PERFORM public.settle_periodic_progression(r.player_id, cutoff);
  UPDATE public.player_saves SET state=public.settle_training_state_at(state,cutoff,(SELECT LEAST(10,2+count(*))::integer FROM public.token_spend_events WHERE player_id=r.player_id AND action_kind='training-slot')), revision=revision+1 WHERE player_id=r.player_id;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.account_xp_needed(p_level integer)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
 SELECT CASE WHEN p_level < 20 THEN 1800 + p_level * 85
  WHEN p_level < 29 THEN 10400 + (p_level - 20) * 360
  WHEN p_level < 100 THEN LEAST(36000, 14000 + (p_level - 29) * 1100)
  ELSE 36000 + (LEAST(199, p_level) - 99) * 1100 END
$$;
CREATE OR REPLACE FUNCTION public.hero_level_mastery(p_level integer)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
 SELECT power(1.014::numeric, LEAST(99, GREATEST(1, p_level)) - 1)
   * (1 + GREATEST(0, LEAST(200, p_level) - 99) * .007)
$$;
CREATE OR REPLACE FUNCTION public.seeker_location_cap(p_state jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
 SELECT LEAST(20, GREATEST(1, COALESCE((p_state->>'highestLocation')::integer,1)),
   GREATEST(1 + (LEAST(200, GREATEST(1, COALESCE((p_state->>'accountLevel')::integer,1))) - 1) / 10,
     LEAST(20, GREATEST(1, COALESCE((p_state#>>'{seekerProgression,legacyLocationAccess}')::integer,1)))))
$$;

-- The entitlement is captured using the old gate before it is replaced.
UPDATE public.player_saves SET state = jsonb_set(state, '{seekerProgression}',
  jsonb_build_object('version',1,'accountXpRemainder',0,'heroXpRemainders','{}'::jsonb,
    'legacyLocationAccess', LEAST(20, GREATEST(1, COALESCE((state->>'highestLocation')::integer,1)),
      public.balance_v6_location_cap(COALESCE((state->>'accountLevel')::integer,1))),
    'activatedAt', (SELECT floor(extract(epoch FROM activated_at)*1000)::bigint FROM public.seeker_progression_settings))),
  revision = revision + 1;

CREATE OR REPLACE FUNCTION public.balance_v6_location_cap(p_account_level integer)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT 1 + (LEAST(200, GREATEST(1, COALESCE(p_account_level,1))) - 1) / 10
$$;

-- Only installed level-bound primitives are extended. Immutable historical migrations stay intact.
DO $$
DECLARE r record; d text; n text;
BEGIN
 FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
   WHERE s.nspname IN ('public','heroloop_api') AND p.prokind='f'
   AND p.proname NOT IN ('hero_level_mastery','account_xp_needed','seeker_location_cap')
 LOOP
  d := pg_get_functiondef(r.oid); n := d;
  n := regexp_replace(n, '\mleast\(99,', 'LEAST(200,', 'gi');
  n := regexp_replace(n, '\mBETWEEN 1 AND 99\M', 'BETWEEN 1 AND 200', 'gi');
  n := regexp_replace(n, '(v_(account_|hero_)?level\s*<\s*)99\M', '\1200', 'gi');
  n := regexp_replace(n, '(v_(account_|hero_)?level\s*>=\s*)99\M', '\1200', 'gi');
  n := replace(n, 'END >= 99 THEN', 'END >= 200 THEN');
  n := replace(n, 'IF v_level >= 200 THEN v_remaining := 0; END IF;',
    'IF v_level >= 200 THEN NULL; END IF;');
  n := replace(n, 'IF v_level >= v_account_level THEN v_remaining := 0; END IF;',
    'IF v_level >= v_account_level THEN NULL; END IF;');
  n := replace(n, 'v_max_xp constant bigint := 2445910;',
    'v_max_xp bigint := (SELECT sum(public.account_xp_needed(level)) FROM generate_series(1,199) level);');
  n := replace(n, 'EXIT WHEN v_hero_remaining < public.hero_xp_needed(v_hero_level);',
    'EXIT WHEN v_hero_level >= 200 OR v_hero_remaining < public.hero_xp_needed(v_hero_level);');
  -- Per-state gates preserve old discovered access, including Training and periodic settlement.
  n := replace(n, 'public.balance_v6_location_cap(COALESCE((v_save.state->>''accountLevel'')::integer, 1))', 'public.seeker_location_cap(v_save.state)');
  n := replace(n, 'public.balance_v6_location_cap(COALESCE((v_state->>''accountLevel'')::integer, 1))', 'public.seeker_location_cap(v_state)');
  n := replace(n, 'LEAST(10, public.seeker_location_cap(v_state))', 'LEAST(20, public.seeker_location_cap(v_state))');
  n := replace(n, 'ARRAY[1,5,10,16,23,28,33,38,43,48,53,58,63,68,73,78,83,88,92,96]',
    'ARRAY[1,11,21,31,41,51,61,71,81,91,101,111,121,131,141,151,161,171,181,191]');
  n := replace(n, 'IF v_account_level >= v_unlock_levels[v_index] THEN v_location := v_index; END IF;',
    'IF v_index <= public.seeker_location_cap(p_state) THEN v_location := v_index; END IF;');
  IF position('CREATE OR REPLACE FUNCTION public.item_v6_implicit' IN n)>0 THEN
   n := replace(n, '(1 + 0.008 * (level.value - 1)) * power(1.014::numeric, level.value - 1)',
    '(1 + 0.008 * (LEAST(99,level.value) - 1)) * power(1.014::numeric, LEAST(99,level.value) - 1) * (1 + GREATEST(0,level.value-99)*.009)');
  END IF;
  IF position('CREATE OR REPLACE FUNCTION public.roll_item_stats_v5' IN n)>0 THEN
   n := replace(n, '(p_item_level - 1)', '(LEAST(99,p_item_level) - 1)');
   n := replace(n, 'v_stats := v_stats ||',
     'IF p_item_level > 99 AND v_key IN (''hp'',''atk'',''def'') THEN v_value := round(v_value*(1+(p_item_level-99)*.009),6); END IF;
      v_stats := v_stats ||');
  END IF;
  -- Responses must return the committed state after the XP boundary, including Training.
  IF position('UPDATE public.player_saves' IN n)>0 AND position('p_player_id uuid' IN n)>0 THEN
   n := regexp_replace(n, '(''state'',\s*)(v_state|v_save\.state)',
     '\1(SELECT state FROM public.player_saves WHERE player_id=p_player_id)', 'g');
  END IF;
  IF n IS DISTINCT FROM d THEN EXECUTE n; END IF;
 END LOOP;
END $$;

-- Keep the Founder registry's read-only Power copy aligned when it is installed.
DO $$ DECLARE oid regprocedure; d text; n text; BEGIN
 oid:=to_regprocedure('admin.game_registry_hero_power(text,numeric,numeric,jsonb)');
 IF oid IS NOT NULL THEN
  d:=pg_get_functiondef(oid);
  -- The versioned Admin migration may already have installed the complete curve.
  -- Accept only its exact cap/mastery/item expressions; unknown definitions fail below.
  n:=regexp_replace(lower(d), '\s', '', 'g');
  IF position('v_levelinteger:=least(200,greatest(1,floor(coalesce(p_level,0))::integer))' IN n)>0
    AND position('v_item_level:=least(200,' IN n)>0
    AND position('v_mastery:=power(1::doubleprecision+0.014::doubleprecision,least(99,v_level)-1)*(1+greatest(0,v_level-99)*0.007::doubleprecision);' IN n)>0
    AND position('((1::doubleprecision+0.008::doubleprecision*(least(99,v_item_level)-1))*power(1::doubleprecision+0.014::doubleprecision,least(99,v_item_level)-1)*(1+greatest(0,v_item_level-99)*0.009::doubleprecision))' IN n)>0
  THEN RETURN; END IF;
  n:=regexp_replace(d,'\mleast\(99,','least(200,','gi');
  n:=replace(n,'((1::double precision + 0.008::double precision * (v_item_level - 1)) * power(1::double precision + 0.014::double precision, v_item_level - 1))',
    '((1::double precision + 0.008::double precision * (least(99,v_item_level) - 1)) * power(1::double precision + 0.014::double precision, least(99,v_item_level) - 1) * (1 + greatest(0,v_item_level-99)*0.009))');
  n:=replace(n,'v_mastery := power(1::double precision + 0.014::double precision, v_level - 1);',
    'v_mastery := power(1::double precision + 0.014::double precision, least(99,v_level) - 1) * (1 + greatest(0,v_level-99)*0.007);');
  IF n=d OR position('greatest(0,v_level-99)' IN n)=0 OR position('greatest(0,v_item_level-99)' IN n)=0 THEN
   RAISE EXCEPTION 'seeker_registry_power_patch_failed';
  END IF;
  EXECUTE n;
 END IF;
END $$;

-- Preserve old telemetry cohorts and add explicit bands for the new level range.
DO $$ DECLARE r record; d text; n text; BEGIN
 FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='telemetry' AND p.proname IN ('account_level_band','item_level_band') LOOP
  d:=pg_get_functiondef(r.oid);
  n:=replace(d, 'WHEN p_level BETWEEN 80 AND 99 THEN ''80-99''',
    'WHEN p_level BETWEEN 80 AND 99 THEN ''80-99''
     WHEN p_level BETWEEN 100 AND 149 THEN ''100-149''
     WHEN p_level BETWEEN 150 AND 200 THEN ''150-200''');
  IF n=d THEN RAISE EXCEPTION 'seeker_telemetry_band_patch_failed'; END IF;
  EXECUTE n;
 END LOOP;
 FOR r IN SELECT c.oid,c.conrelid,c.conname,pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
  WHERE c.contype='c' AND ns.nspname IN ('public','telemetry')
   AND pg_get_constraintdef(c.oid) LIKE '%''80-99''::text%' LOOP
  n:=replace(r.definition, '''80-99''::text', '''80-99''::text, ''100-149''::text, ''150-200''::text');
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.conrelid::regclass,r.conname);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.conrelid::regclass,r.conname,n);
 END LOOP;
END $$;

CREATE FUNCTION public.seeker_hero_lifetime_xp(p_hero jsonb)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
 SELECT COALESCE((SELECT sum(public.hero_xp_needed(level)) FROM generate_series(1,
   LEAST(200,GREATEST(1,COALESCE((p_hero->>'level')::integer,1)))-1) level),0)
   + GREATEST(0,COALESCE((p_hero->>'xp')::bigint,0))
$$;

-- One server delta boundary covers online, hidden/offline, Training and boost modifiers.
-- It runs before the existing level-cap trigger; replay and Gold-only updates have zero delta.
CREATE FUNCTION public.seeker_progression_reward_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 p jsonb; remainders jsonb; heroes jsonb := '[]'; h jsonb; old_h jsonb;
 gross bigint; weighted bigint; xp bigint; level integer; rem integer; uid text;
 bypass boolean := COALESCE(current_setting('heroloop.seeker_xp_bypass',true),'')='true';
BEGIN
 IF TG_OP='INSERT' THEN
  p := jsonb_build_object('version',1,'accountXpRemainder',0,'heroXpRemainders','{}'::jsonb,
    'legacyLocationAccess',1,'activatedAt', (SELECT floor(extract(epoch FROM activated_at)*1000)::bigint FROM public.seeker_progression_settings));
  NEW.state := jsonb_set(NEW.state,'{seekerProgression}',p); RETURN NEW;
 END IF;
 p := OLD.state->'seekerProgression';
 IF p IS NULL THEN RAISE EXCEPTION 'seeker_progression_uninitialized'; END IF;
 remainders := '{}'::jsonb;
 gross := GREATEST(0,COALESCE((NEW.state->>'accountXp')::bigint,0)-COALESCE((OLD.state->>'accountXp')::bigint,0));
 rem := COALESCE((p->>'accountXpRemainder')::integer,0);
 IF NOT bypass AND gross>0 THEN
  weighted := gross*17+rem;
  NEW.state := jsonb_set(NEW.state,'{accountXp}',to_jsonb(COALESCE((OLD.state->>'accountXp')::bigint,0)+weighted/20));
  p := jsonb_set(p,'{accountXpRemainder}',to_jsonb((weighted%20)::integer));
 END IF;
 xp := GREATEST(0,COALESCE((NEW.state->>'accountXp')::bigint,0)); level := 1;
 WHILE level<200 AND xp>=public.account_xp_needed(level) LOOP
  xp := xp-public.account_xp_needed(level); level:=level+1;
 END LOOP;
 NEW.state := jsonb_set(NEW.state,'{accountLevel}',to_jsonb(level));
 FOR h IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.state->'ownedHeroes','[]'::jsonb)) LOOP
  uid := h->>'uid';
  SELECT value INTO old_h FROM jsonb_array_elements(COALESCE(OLD.state->'ownedHeroes','[]'::jsonb)) WHERE value->>'uid'=uid;
  rem := COALESCE((p->'heroXpRemainders'->>uid)::integer,0);
  IF old_h IS NOT NULL AND NOT bypass THEN
   gross := GREATEST(0, public.seeker_hero_lifetime_xp(h)-public.seeker_hero_lifetime_xp(old_h));
   IF gross>0 THEN
    weighted := gross*17+rem; xp := public.seeker_hero_lifetime_xp(old_h)+weighted/20; rem := weighted%20;
    level := 1;
    WHILE level<200 AND xp>=public.hero_xp_needed(level) LOOP
     xp := xp-public.hero_xp_needed(level); level := level+1;
    END LOOP;
    h := jsonb_set(jsonb_set(h,'{level}',to_jsonb(level)),'{xp}',to_jsonb(CASE WHEN level=200 THEN 0 ELSE xp END));
    IF COALESCE(OLD.state#>'{trainingCamp,heroUids}','[]'::jsonb) ? uid
      AND NOT COALESCE(OLD.state->'team','[]'::jsonb) ? uid
      AND level >= (NEW.state->>'accountLevel')::integer THEN
     h := jsonb_set(jsonb_set(h,'{level}',NEW.state->'accountLevel'),'{xp}','0'); rem:=0;
    END IF;
   END IF;
  END IF;
  IF COALESCE((h->>'level')::integer,1)>=200 THEN rem:=0; END IF;
  remainders := remainders || jsonb_build_object(uid,rem);
  heroes := heroes || jsonb_build_array(h);
 END LOOP;
 IF COALESCE((NEW.state->>'accountXp')::bigint,0)>=(SELECT sum(public.account_xp_needed(n)) FROM generate_series(1,199) n) THEN
  p := jsonb_set(p,'{accountXpRemainder}','0');
 END IF;
 p := jsonb_set(p,'{heroXpRemainders}',remainders);
 NEW.state := jsonb_set(jsonb_set(NEW.state,'{ownedHeroes}',heroes),'{seekerProgression}',p);
 RETURN NEW;
END $$;
CREATE TRIGGER a_seeker_progression_rewards BEFORE INSERT OR UPDATE OF state ON public.player_saves
 FOR EACH ROW EXECUTE FUNCTION public.seeker_progression_reward_guard();

CREATE FUNCTION public.seeker_hero_xp_delta(p_before jsonb,p_after jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
 SELECT COALESCE(jsonb_object_agg(n.h->>'uid',GREATEST(0,public.seeker_hero_lifetime_xp(n.h)-public.seeker_hero_lifetime_xp(o.h))),'{}'::jsonb)
 FROM jsonb_array_elements(COALESCE(p_after->'ownedHeroes','[]'::jsonb)) n(h)
 JOIN jsonb_array_elements(COALESCE(p_before->'ownedHeroes','[]'::jsonb)) o(h) ON n.h->>'uid'=o.h->>'uid'
$$;

-- Periodic rewards report the net committed delta rather than the gross legacy return value.
ALTER FUNCTION public.settle_periodic_progression(uuid,timestamp with time zone) RENAME TO settle_periodic_progression_before_seeker200;
CREATE FUNCTION public.settle_periodic_progression(p_player_id uuid,p_tick timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE before_state jsonb; after_state jsonb; result jsonb; hero_rewards jsonb; hero_min bigint;
BEGIN
 SELECT state INTO before_state FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
 result := public.settle_periodic_progression_before_seeker200(p_player_id,p_tick);
 SELECT state INTO after_state FROM public.player_saves WHERE player_id=p_player_id;
 IF result IS NULL OR before_state IS NULL OR after_state IS NULL THEN RETURN result; END IF;
 hero_rewards:=public.seeker_hero_xp_delta(before_state,after_state);
 SELECT COALESCE(min(value::bigint),0) INTO hero_min FROM jsonb_each_text(hero_rewards) WHERE before_state->'team' ? key;
 RETURN result || jsonb_build_object('hero_xp',hero_min,'account_xp',GREATEST(0,(after_state->>'accountXp')::bigint-(before_state->>'accountXp')::bigint),
   'hero_xp_by_uid',hero_rewards);
END $$;
REVOKE ALL ON FUNCTION public.settle_periodic_progression(uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_periodic_progression(uuid,timestamp with time zone) TO service_role;

-- Frozen old waves retain their reward policy; only the new version receives the XP reduction.
DO $$
DECLARE d text; n text;
 old_version text := 'balance-v6-2026.09.29-v1-combat-effects-v2-auto-healing-v1';
 new_version text := 'seeker-200-2026.10.08-v1-combat-effects-v2-auto-healing-v1';
BEGIN
 d := pg_get_functiondef('public.normal_combat_balance_version_gate()'::regprocedure);
 n := replace(d, quote_literal(old_version) || ') THEN',
   quote_literal(old_version) || ',' || quote_literal(new_version) || ') THEN');
 IF n=d THEN RAISE EXCEPTION 'seeker_wave_version_gate_patch_failed'; END IF;
 EXECUTE n;
 FOR d IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
   WHERE s.nspname='public' AND p.prokind='f' AND p.proname LIKE 'normal_combat_%'
     AND p.proname<>'normal_combat_balance_version_gate'
 LOOP
  n := replace(d, 'balance_version=' || quote_literal(old_version),
    'balance_version IN (' || quote_literal(old_version) || ',' || quote_literal(new_version) || ')');
  n := replace(n, quote_literal(old_version) || ') THEN',
    quote_literal(old_version) || ',' || quote_literal(new_version) || ') THEN');
  IF n<>d THEN EXECUTE n; END IF;
 END LOOP;
 d := pg_get_functiondef('public.normal_combat_complete_without_auto_pot(uuid,uuid,uuid)'::regprocedure);
 n := replace(d, 'v_result jsonb;', 'v_result jsonb; v_seeker_before_xp bigint; v_seeker_bypass text; v_seeker_before_state jsonb; v_seeker_hero_rewards jsonb; v_seeker_hero_min bigint;');
 n := replace(n, 'v_state := v_save.state;',
   'v_state := v_save.state; v_seeker_before_state := v_save.state; v_seeker_before_xp := COALESCE((v_save.state->>''accountXp'')::bigint,0);');
 n := replace(n, 'UPDATE public.player_saves SET state = v_state,',
   'v_seeker_bypass := COALESCE(current_setting(''heroloop.seeker_xp_bypass'',true),'''');
    PERFORM set_config(''heroloop.seeker_xp_bypass'', CASE WHEN v_event.balance_version IN (' ||
      quote_literal(new_version) || ',''seeker-200-2026.10.09-v1-combat-effects-v2-ordinary-potion-v1'') THEN ''false'' ELSE ''true'' END,true);
    UPDATE public.player_saves SET state = v_state,');
 n := replace(n, 'v_result := jsonb_build_object(',
   'PERFORM set_config(''heroloop.seeker_xp_bypass'', v_seeker_bypass, true);
    v_account_xp := COALESCE((v_save.state->>''accountXp'')::bigint,0)-v_seeker_before_xp;
    v_seeker_hero_rewards := public.seeker_hero_xp_delta(v_seeker_before_state,v_save.state);
    SELECT COALESCE(min(value::bigint),0) INTO v_seeker_hero_min FROM jsonb_each_text(v_seeker_hero_rewards) WHERE v_event.outcome->''won_hero_uids'' ? key;
    v_result := jsonb_build_object(');
 n := regexp_replace(n, '(''hero_xp_per_winner'',\s*)[^,]+',
   '\1v_seeker_hero_min, ''hero_xp_by_uid'', v_seeker_hero_rewards');
 IF n=d OR position('v_seeker_before_xp := ' IN n)=0
   OR position('set_config(''heroloop.seeker_xp_bypass''' IN n)=0 THEN
  RAISE EXCEPTION 'seeker_completion_patch_failed';
 END IF;
 EXECUTE n;
END $$;

REVOKE ALL ON FUNCTION public.seeker_location_cap(jsonb), public.seeker_hero_lifetime_xp(jsonb), public.seeker_hero_xp_delta(jsonb,jsonb), public.seeker_progression_reward_guard() FROM PUBLIC, anon, authenticated;
COMMIT;
