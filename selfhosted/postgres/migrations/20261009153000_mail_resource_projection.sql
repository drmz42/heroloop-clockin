-- Reconcile shared catalog claims with canonical save/player resource counters and fresh replay snapshots.
BEGIN;
DO $patch$
DECLARE d text; n text;
BEGIN
  d:=pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  IF position('v_resources_changed boolean' in d)=0 OR position('''mail_reward''' in d)=0 THEN
    RAISE EXCEPTION 'mail_catalog_claim_definition_mismatch'; END IF;
  n:=replace(d,'  v_gold bigint := 0;',E'  v_gold bigint := 0;\n  v_resource jsonb;');
  n:=replace(n,'  SELECT state, revision INTO v_state, v_revision FROM public.player_saves',
    E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT state, revision INTO v_state, v_revision FROM public.player_saves');
  n:=replace(n,'          PERFORM public.apply_resource_entries(p_player_id, v_reward.id,',
    '          v_resource:=public.apply_resource_entries(p_player_id, v_reward.id,');
  n:=replace(n,$old$'source_key', 'mail_reward')));$old$,$new$'source_key', 'mail_reward')),v_revision+1);$new$);
  n:=replace(n,'          v_resources_changed := true;',$new$          v_resources_changed := true;
          v_state:=jsonb_set(jsonb_set(v_state,'{summonScrolls}',to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint),true),
            '{bossKeys}',to_jsonb((v_resource#>>'{balances,boss_key}')::bigint),true);
          v_state:=jsonb_set(v_state,'{potions}',COALESCE(v_state->'potions','{}'::jsonb)||jsonb_build_object(
            'xs',(v_resource#>>'{balances,potion_xs}')::bigint,'sm',(v_resource#>>'{balances,potion_sm}')::bigint,
            'md',(v_resource#>>'{balances,potion_md}')::bigint,'lg',(v_resource#>>'{balances,potion_lg}')::bigint,
            'xl',(v_resource#>>'{balances,potion_xl}')::bigint,'xxl',(v_resource#>>'{balances,potion_xxl}')::bigint),true);
          UPDATE public.players SET boss_keys=(v_resource#>>'{balances,boss_key}')::integer WHERE player_id=p_player_id;$new$);
  n:=replace(n,'AND NOT v_changed AND v_items_full AND NOT v_chests_full',
    'AND NOT v_changed AND v_items_full AND NOT v_chests_full AND NOT v_resources_full');
  n:=replace(n,$old$'gold', COALESCE((state->>'gold')::bigint, 0), 'revision', revision)$old$,
    $new$'gold', COALESCE((state->>'gold')::bigint, 0), 'revision', revision,
      'summon_scrolls',COALESCE((state->>'summonScrolls')::bigint,0),'boss_keys',COALESCE((state->>'bossKeys')::bigint,0))$new$);
  n:=replace(n,$old$'resources', public.resource_snapshot(p_player_id));$old$,
    $new$'resources', public.resource_snapshot(p_player_id),
      'summon_scrolls',COALESCE((v_state->>'summonScrolls')::bigint,0),'boss_keys',COALESCE((v_state->>'bossKeys')::bigint,0));$new$);
  IF n=d OR position('v_resource:=public.apply_resource_entries' in n)=0
    OR position(')),v_revision+1);' in n)=0 OR position('UPDATE public.players SET boss_keys=' in n)=0
    OR position('AND NOT v_resources_full' in n)=0 OR position('''summon_scrolls'',COALESCE((state' in n)=0
    OR position('''summon_scrolls'',COALESCE((v_state' in n)=0 THEN
    RAISE EXCEPTION 'mail_resource_projection_patch_failed'; END IF;
  EXECUTE n;
END
$patch$;
COMMIT;
