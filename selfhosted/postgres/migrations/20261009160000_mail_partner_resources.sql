-- Approved Seeker partner rewards enter Mailbox before any balances are credited.
-- Preserve legacy potion bottle counts; ordinary-wave consolidation remains separate.
BEGIN;
CREATE FUNCTION pg_temp.mail_partner_patch(p_definition text,p_old text,p_new text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_old='' OR length(p_definition)-length(replace(p_definition,p_old,'')) <> length(p_old) THEN
    RAISE EXCEPTION 'mail_partner_patch_anchor_mismatch';
  END IF;
  RETURN replace(p_definition,p_old,p_new);
END $$;
DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('heroloop_api.seeker_partner_quest_claim(uuid,uuid,bigint,bigint)'::regprocedure);
  d:=pg_temp.mail_partner_patch(d,'  SELECT * INTO v_save FROM public.player_saves',
    E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT * INTO v_save FROM public.player_saves');
  d:=pg_temp.mail_partner_patch(d,$old$  FOREACH v_key IN ARRAY ARRAY['summon_scroll','boss_key','potion_xs','potion_sm','potion_md','potion_lg','potion_xl','potion_xxl'] LOOP
    IF v_reward ? v_key THEN
      v_entries := v_entries || jsonb_build_array(jsonb_build_object(
        'resource_id', v_key, 'delta', (v_reward->>v_key), 'source_key', 'partner_quest_reward'));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_entries) > 0 THEN
    v_resource := public.apply_resource_entries(p_player_id, p_idempotency_key, 'partner_quest_claim',
      encode(extensions.digest(('partner-quest:' || v_submission.id::text)::bytea, 'sha256'), 'hex'),
      v_entries, v_save.revision + 1);
    v_state := jsonb_set(v_state, '{summonScrolls}', to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint), true);
    v_state := jsonb_set(v_state, '{bossKeys}', to_jsonb((v_resource#>>'{balances,boss_key}')::bigint), true);
    v_state := jsonb_set(v_state, '{potions}', COALESCE(v_state->'potions', '{}'::jsonb) || jsonb_build_object(
      'xs', (v_resource#>>'{balances,potion_xs}')::bigint, 'sm', (v_resource#>>'{balances,potion_sm}')::bigint,
      'md', (v_resource#>>'{balances,potion_md}')::bigint, 'lg', (v_resource#>>'{balances,potion_lg}')::bigint,
      'xl', (v_resource#>>'{balances,potion_xl}')::bigint, 'xxl', (v_resource#>>'{balances,potion_xxl}')::bigint), true);
    UPDATE public.players SET boss_keys = (v_resource#>>'{balances,boss_key}')::integer WHERE player_id = p_player_id;
  END IF;
$old$,$new$  IF v_gold > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('kind','gold','amount',v_gold));
  END IF;
  FOREACH v_key IN ARRAY ARRAY['summon_scroll','boss_key','potion_xs','potion_sm','potion_md','potion_lg','potion_xl','potion_xxl'] LOOP
    IF COALESCE((v_reward->>v_key)::bigint,0)>0 THEN
      v_entries := v_entries || jsonb_build_array(jsonb_build_object(
        'kind','resource','resource_id',v_key,'amount',(v_reward->>v_key)::bigint));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_entries)>0 THEN
    PERFORM public.mail_send_letter(p_player_id,'system','Partner Quests','Partner quest reward',
      'Your approved rewards are attached. Claim them when you are ready.',
      'partner-quest-resources:' || v_submission.id,v_entries);
  END IF;
$new$);
  d:=pg_temp.mail_partner_patch(d,$old$  IF v_gold > 0 THEN
    v_state := jsonb_set(v_state, '{gold}', to_jsonb(GREATEST(0, COALESCE((v_state->>'gold')::bigint, 0)) + v_gold), true);
    v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold), true);
  END IF;
$old$,'');
  d:=pg_temp.mail_partner_patch(d,'''claimed'', true, ''reward'', v_reward,',
    '''claimed'', true, ''mailed'', true, ''reward'', v_reward,');
  EXECUTE d;
END
$patch$;
DROP FUNCTION pg_temp.mail_partner_patch(text,text,text);
COMMIT;
