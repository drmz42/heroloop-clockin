-- Forward-only tutorial corrections. No historical rewards or saves are rewritten.
ALTER TABLE public.boss_encounters
  ADD COLUMN tutorial_key_refundable boolean NOT NULL DEFAULT false;

DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.tutorial_quest_progress(jsonb,integer)'::regprocedure);
  v_new := replace(v_def,
    $find$WHEN 9 THEN GREATEST(0, COALESCE((p_state->>'highestLocation')::bigint, 0))$find$,
    $patch$WHEN 9 THEN LEAST(GREATEST(0, COALESCE((p_state->>'highestLocation')::bigint, 0)),
      public.balance_v6_location_cap(GREATEST(1, COALESCE((p_state->>'accountLevel')::integer, 1))))$patch$);
  IF v_new = v_def THEN RAISE EXCEPTION 'tutorial_location_patch_failed'; END IF;
  EXECUTE v_new;

  -- The first item is a class-independent helmet at the account's level.
  -- Keep the standard rarity roll and v5 stat/Power generation unchanged.
  v_def := pg_get_functiondef('public.settle_chest_open(uuid,uuid,integer)'::regprocedure);
  v_new := replace(v_def,
    'v_stat_count := (ARRAY[1,1,2,2,3,3,4,4,5])[v_rarity_index];',
    $patch$IF i = 1 AND COALESCE((v_chest->>'tutorial')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM public.tutorial_chest_open_events WHERE player_id = p_player_id) THEN
      v_slot := 'helmet';
      v_base_item_id := 'helmet-' || v_rarity;
      v_item_level := LEAST(99, v_level);
    END IF;
    v_stat_count := (ARRAY[1,1,2,2,3,3,4,4,5])[v_rarity_index];$patch$);
  IF v_new = v_def THEN RAISE EXCEPTION 'tutorial_starter_item_patch_failed'; END IF;
  EXECUTE v_new;

  -- Snapshot eligibility in the Boss record; room run_state is rebuilt in combat.
  v_def := pg_get_functiondef('public.summon_boss(uuid,integer,uuid)'::regprocedure);
  v_new := replace(v_def,
    'SET dungeon_encounter_id = v_dungeon WHERE id = v_boss;',
    $patch$SET dungeon_encounter_id = v_dungeon,
      tutorial_key_refundable = NOT COALESCE((v_save.state#>>'{tutorial,questCompleted}')::boolean, true)
        AND COALESCE((v_save.state#>>'{tutorial,questOrdinal}')::integer, 11) IN (9,10)
        AND public.tutorial_quest_progress(v_save.state, 10) = 0
        AND EXISTS (SELECT 1 FROM public.tutorial_quest_claim_events
          WHERE player_id = p_player_id AND quest_id = 'enable-auto-pot')
    WHERE id = v_boss;$patch$);
  IF v_new = v_def THEN RAISE EXCEPTION 'tutorial_boss_marker_patch_failed'; END IF;
  EXECUTE v_new;

  -- Both mutation validation and report-only reconciliation recognize refunds.
  v_def := pg_get_functiondef('public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)'::regprocedure);
  v_new := replace(v_def, '''tutorial_boss_key''', '''tutorial_boss_key'',''tutorial_boss_key_refund''');
  IF v_new = v_def THEN RAISE EXCEPTION 'tutorial_refund_source_patch_failed'; END IF;
  EXECUTE v_new;
  v_def := pg_get_functiondef('public.resource_ledger_reconciliation()'::regprocedure);
  v_new := replace(v_def, '''tutorial_boss_key''', '''tutorial_boss_key'',''tutorial_boss_key_refund''');
  IF v_new = v_def THEN RAISE EXCEPTION 'tutorial_refund_reconciliation_patch_failed'; END IF;
  EXECUTE v_new;
END $$;

-- AFTER the established terminal-state trigger marks the Boss lost. One refund
-- shares the encounter transaction and uses its UUID for replay protection.
CREATE OR REPLACE FUNCTION public.refund_tutorial_boss_key()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_save public.player_saves%ROWTYPE; v_resource jsonb; v_keys bigint;
BEGIN
  IF OLD.status <> 'active' OR NEW.status NOT IN ('failed','abandoned')
    OR NOT EXISTS (SELECT 1 FROM public.boss_encounters
      WHERE dungeon_encounter_id = NEW.id AND player_id = NEW.player_id AND status = 'lost'
        AND tutorial_key_refundable) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = NEW.player_id FOR UPDATE;
  IF NOT FOUND OR COALESCE((v_save.state#>>'{tutorial,questCompleted}')::boolean, true)
    OR public.tutorial_quest_progress(v_save.state, 10) > 0 THEN RETURN NEW; END IF;
  v_resource := public.apply_resource_entries(NEW.player_id, NEW.id, 'tutorial_boss_refund',
    encode(extensions.digest(('tutorial-boss-refund:' || NEW.id::text)::bytea, 'sha256'),'hex'),
    '[{"resource_id":"boss_key","delta":"1","source_key":"tutorial_boss_key_refund"}]'::jsonb,
    v_save.revision + 1);
  v_keys := (v_resource#>>'{balances,boss_key}')::bigint;
  UPDATE public.player_saves SET state = jsonb_set(state, '{bossKeys}', to_jsonb(v_keys), true),
    revision = revision + 1, updated_at = now() WHERE player_id = NEW.player_id;
  UPDATE public.players SET boss_keys = v_keys, updated_at = now() WHERE player_id = NEW.player_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.refund_tutorial_boss_key() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER dungeon_refund_tutorial_boss_key AFTER UPDATE OF status ON public.dungeon_encounters
FOR EACH ROW EXECUTE FUNCTION public.refund_tutorial_boss_key();
