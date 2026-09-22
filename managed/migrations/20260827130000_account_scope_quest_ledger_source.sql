-- Quest issuance source keys are globally unique in hero_economy_ledger, so include
-- the player identity before the daily/milestone instance key.
DO $$
DECLARE
  v_definition text;
  v_replacement text;
BEGIN
  v_definition := pg_get_functiondef('public.settle_quest_claim(uuid,uuid,text,bigint)'::regprocedure);
  v_replacement := replace(
    v_definition,
    $find$'quest:'||v_instance,p_player_id,v_hero$find$,
    $find$'quest:'||p_player_id::text||':'||v_instance,p_player_id,v_hero$find$
  );
  IF v_replacement = v_definition THEN
    RAISE EXCEPTION 'account_scoped_quest_ledger_source_patch_failed';
  END IF;
  EXECUTE v_replacement;
END;
$$;
