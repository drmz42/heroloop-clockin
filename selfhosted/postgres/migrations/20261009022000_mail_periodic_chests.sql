-- Only databases with the explicitly installed Seeker progression policy mail periodic chests.
BEGIN;
-- A mailed settlement can include the complete existing 1000-chest daily allowance.
ALTER TABLE public.periodic_chest_events DROP CONSTRAINT periodic_chest_events_granted_check;
ALTER TABLE public.periodic_chest_events ADD CONSTRAINT periodic_chest_events_granted_check CHECK (granted BETWEEN 0 AND 1000);
DO $patch$
DECLARE v_definition text; v_updated text; v_old text;
BEGIN
  v_definition := pg_get_functiondef('public.settle_periodic_progression_legacy(uuid,timestamptz)'::regprocedure);
  v_updated := replace(v_definition, '  v_new_chests jsonb := ''[]''::jsonb;',
    '  v_new_chests jsonb := ''[]''::jsonb;
  v_mail_chests boolean := to_regclass(''public.seeker_progression_settings'') IS NOT NULL;
  v_mail_offset integer;');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'periodic_mail_declaration_patch_failed'; END IF;
  v_definition := v_updated;
  v_updated := replace(v_definition,
    'GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->''chests'', ''[]''::jsonb))),',
    'CASE WHEN v_mail_chests THEN 1000 ELSE GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->''chests'', ''[]''::jsonb))) END,');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'periodic_mail_capacity_patch_failed'; END IF;
  v_definition := v_updated;
  v_old := $old$    SELECT jsonb_agg(jsonb_build_object('stage', GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1))))
    INTO v_new_chests FROM generate_series(1, v_chests);
    v_state := jsonb_set(v_state, '{chests}', COALESCE(v_state->'chests', '[]'::jsonb) || COALESCE(v_new_chests, '[]'::jsonb));$old$;
  v_updated := replace(v_definition, v_old, $new$    IF v_mail_chests THEN
      FOR v_mail_offset IN 0..((v_chests - 1) / 50) LOOP
        PERFORM public.mail_send_chest_bundle(p_player_id, LEAST(50, v_chests - v_mail_offset * 50),
          LEAST(20, GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1))),
          'HeroLoop', 'Periodic chest rewards',
          'periodic:' || floor(extract(epoch FROM v_previous_tick) * 1000000)::bigint || ':' || v_mail_offset);
      END LOOP;
    ELSE
$new$ || v_old || E'\n    END IF;');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'periodic_mail_delivery_patch_failed'; END IF;
  EXECUTE v_updated;

  -- Mailed earnings are granted; the queue no longer blocks this source at settlement.
  v_definition := pg_get_functiondef('public.settle_periodic_progression_before_pending_normal_recovery(uuid,timestamptz)'::regprocedure);
  v_updated := replace(v_definition,
    'v_capacity_available := GREATEST(0, 500 - jsonb_array_length(COALESCE(v_before_state->''chests'', ''[]''::jsonb)));',
    'v_capacity_available := CASE WHEN to_regclass(''public.seeker_progression_settings'') IS NOT NULL THEN 1000
      ELSE GREATEST(0, 500 - jsonb_array_length(COALESCE(v_before_state->''chests'', ''[]''::jsonb))) END;');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'periodic_mail_telemetry_patch_failed'; END IF;
  EXECUTE v_updated;
END
$patch$;
COMMIT;
