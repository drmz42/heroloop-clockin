\set ON_ERROR_STOP on

-- Founder risk queue for the Control Center Security screen
-- (docs/game/decisions.md, 2026-09-26 "Control Center risk queue may list
-- accounts to the Founder").
--
-- One row per account at Watch, Review or Hold: level, reason codes, who set
-- it, the review deadline and how long the case has been open. The row carries
-- no player id, name, mail or wallet; it carries an opaque reference instead,
-- and opening that reference goes through admin.player_support_find with Player
-- Support's reason, unmask and audit rules. The BFF serves this to a founder
-- session only.
--
-- The reference is a truncated SHA-256 of the account id under a fixed label.
-- It is stable, so a reload does not reshuffle the queue, and it only resolves
-- while the account is in the queue: once the level returns to Normal the row
-- is gone and the reference opens nothing.

CREATE OR REPLACE FUNCTION admin.risk_queue_ref(p_player_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT left(encode(sha256(convert_to('heroloop-risk-queue:' || p_player_id::text, 'UTF8')), 'hex'), 20)
$function$;

CREATE OR REPLACE FUNCTION admin.risk_queue_list(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_now timestamptz := now();
  v_total bigint;
  v_rows jsonb;
BEGIN
  SELECT count(*) INTO v_total FROM public.account_risk_levels;

  -- Hold first, then Review, then Watch; inside a level the most urgent
  -- deadline first, and a case without a deadline after the ones that have it.
  SELECT coalesce(jsonb_agg(row_data ORDER BY rank DESC, deadline NULLS LAST, opened), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      CASE r.level WHEN 'hold' THEN 3 WHEN 'review' THEN 2 ELSE 1 END AS rank,
      r.review_deadline AS deadline,
      r.created_at AS opened,
      jsonb_build_object(
        'ref', admin.risk_queue_ref(r.player_id),
        'level', r.level,
        'reason_codes', to_jsonb(r.reason_codes),
        'set_by', r.set_by,
        'review_deadline', r.review_deadline,
        'overdue', r.review_deadline IS NOT NULL AND r.review_deadline < v_now,
        'opened_at', r.created_at,
        'updated_at', r.updated_at,
        'age_hours', floor(extract(epoch FROM (v_now - r.created_at)) / 3600)::bigint
      ) AS row_data
    FROM public.account_risk_levels r
    ORDER BY CASE r.level WHEN 'hold' THEN 3 WHEN 'review' THEN 2 ELSE 1 END DESC,
             r.review_deadline NULLS LAST, r.created_at
    LIMIT v_limit
  ) q;

  RETURN jsonb_build_object(
    'version', 'risk-queue.v1',
    'as_of', v_now,
    'timezone', 'UTC',
    'total', v_total,
    'limit', v_limit,
    'truncated', v_total > v_limit,
    'rows', v_rows
  );
END
$function$;

-- The reference back to an account id, only for an account still in the
-- queue. The BFF passes the id straight to admin.player_support_find and never
-- returns it on its own.
CREATE OR REPLACE FUNCTION admin.risk_queue_resolve(p_ref text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT r.player_id FROM public.account_risk_levels r
  WHERE p_ref ~ '^[0-9a-f]{20}$' AND admin.risk_queue_ref(r.player_id) = p_ref
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION admin.risk_queue_ref(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.risk_queue_list(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.risk_queue_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.risk_queue_list(integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.risk_queue_resolve(text) TO heroloop_admin;

COMMENT ON FUNCTION admin.risk_queue_list(integer) IS
  'Founder risk queue: one masked row per account at Watch/Review/Hold (level, reason codes, deadline, age, opaque ref); never a player id, name, mail or wallet.';
COMMENT ON FUNCTION admin.risk_queue_resolve(text) IS
  'Resolves a risk queue ref to its account id while the account is still in the queue; used only to open the case through Player Support.';
