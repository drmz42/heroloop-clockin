-- Keep pending rewards reachable and return a consistent save snapshot on claim replay.
BEGIN;

CREATE OR REPLACE FUNCTION public.mail_letters_json(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', letter.id, 'source', letter.source, 'sender', letter.sender, 'title', letter.title, 'body', letter.body,
      'created_at', letter.created_at, 'read', letter.read_at IS NOT NULL, 'claimed', letter.claimed_at IS NOT NULL,
      'attachments', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', reward.id, 'kind', reward.kind, 'payload', reward.payload, 'claimed', reward.claimed_at IS NOT NULL)
          ORDER BY reward.created_at, reward.id)
        FROM public.player_mail_rewards reward WHERE reward.letter_id = letter.id
      ), '[]'::jsonb)
    ) ORDER BY (letter.read_at IS NOT NULL AND letter.claimed_at IS NOT NULL),
      CASE WHEN letter.read_at IS NULL OR letter.claimed_at IS NULL THEN letter.created_at END,
      letter.created_at DESC, letter.id), '[]'::jsonb)
  FROM (
    SELECT * FROM public.player_mail_letters
    WHERE player_id = p_player_id AND deleted_at IS NULL
    -- Old pending mail comes first; completed history fills only the remaining slots.
    ORDER BY (read_at IS NOT NULL AND claimed_at IS NOT NULL),
      CASE WHEN read_at IS NULL OR claimed_at IS NULL THEN created_at END,
      created_at DESC, id LIMIT 100
  ) letter
$function$;
REVOKE ALL ON FUNCTION public.mail_letters_json(uuid) FROM PUBLIC;

DO $patch$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  v_updated := replace(v_definition,
    $old$'gold', COALESCE((state->>'gold')::bigint, 0))$old$,
    $new$'gold', COALESCE((state->>'gold')::bigint, 0), 'revision', revision)$new$);
  IF v_updated = v_definition THEN RAISE EXCEPTION 'mail_claim_replay_revision_patch_failed'; END IF;
  v_definition := v_updated;
  v_updated := replace(v_definition,
    'p_mail_id IS NULL AND v_claimed = 0 AND v_items_full AND NOT v_chests_full',
    'p_mail_id IS NULL AND v_claimed = 0 AND NOT v_changed AND v_items_full AND NOT v_chests_full');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'mail_claim_text_letter_patch_failed'; END IF;
  EXECUTE v_updated;
END
$patch$;

COMMIT;
