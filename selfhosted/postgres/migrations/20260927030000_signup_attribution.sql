\set ON_ERROR_STOP on

-- Sign-up attribution (Founder decision 2026-09-27). The landing remembers the
-- first link that carried utm_source/utm_medium/utm_campaign, ref or promo and
-- account_register passes those labels here once. One row per account, written
-- once and never edited, removed with the account. Labels are lower-case
-- slugs only, so no free text, address or identity can be stored. A ref label
-- is not a referral relationship: the referral programme is not live and
-- nothing here grants a reward.

CREATE SCHEMA IF NOT EXISTS telemetry;

CREATE TABLE IF NOT EXISTS telemetry.signup_attribution (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  source text,
  medium text,
  campaign text,
  ref text,
  promo text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signup_attribution_labels CHECK (
    (source IS NULL OR source ~ '^[a-z0-9][a-z0-9._-]{0,63}$') AND
    (medium IS NULL OR medium ~ '^[a-z0-9][a-z0-9._-]{0,63}$') AND
    (campaign IS NULL OR campaign ~ '^[a-z0-9][a-z0-9._-]{0,63}$') AND
    (ref IS NULL OR ref ~ '^[a-z0-9][a-z0-9._-]{0,63}$') AND
    (promo IS NULL OR promo ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
  ),
  CONSTRAINT signup_attribution_not_empty CHECK (num_nonnulls(source, medium, campaign, ref, promo) > 0)
);
CREATE INDEX IF NOT EXISTS signup_attribution_recorded_at ON telemetry.signup_attribution(recorded_at);
REVOKE ALL ON telemetry.signup_attribution FROM PUBLIC;

-- Called by the API right after account_register succeeds. Only an account
-- whose Auth user is less than a day old can be attributed, so an old account
-- cannot rewrite where it came from; the first write wins.
CREATE OR REPLACE FUNCTION heroloop_api.signup_attribution_record(p_player_id uuid, p_attribution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_pattern constant text := '^[a-z0-9][a-z0-9._-]{0,63}$';
  v_source text; v_medium text; v_campaign text; v_ref text; v_promo text;
  v_rows integer;
BEGIN
  IF p_player_id IS NULL OR jsonb_typeof(p_attribution) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'invalid');
  END IF;
  v_source := CASE WHEN p_attribution->>'source' ~ v_pattern THEN p_attribution->>'source' END;
  v_medium := CASE WHEN p_attribution->>'medium' ~ v_pattern THEN p_attribution->>'medium' END;
  v_campaign := CASE WHEN p_attribution->>'campaign' ~ v_pattern THEN p_attribution->>'campaign' END;
  v_ref := CASE WHEN p_attribution->>'ref' ~ v_pattern THEN p_attribution->>'ref' END;
  v_promo := CASE WHEN p_attribution->>'promo' ~ v_pattern THEN p_attribution->>'promo' END;
  IF num_nonnulls(v_source, v_medium, v_campaign, v_ref, v_promo) = 0 THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'empty');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE player_id = p_player_id)
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_player_id AND created_at >= now() - interval '24 hours') THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'not_new');
  END IF;
  INSERT INTO telemetry.signup_attribution(player_id, source, medium, campaign, ref, promo)
  VALUES (p_player_id, v_source, v_medium, v_campaign, v_ref, v_promo)
  ON CONFLICT (player_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('recorded', v_rows = 1, 'reason', CASE WHEN v_rows = 1 THEN 'recorded' ELSE 'already_recorded' END);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.signup_attribution_record(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.signup_attribution_record(uuid, jsonb) TO heroloop_api;

-- Control Center read: sign-ups in the window, how many carried a label, and
-- totals per campaign (source/medium/campaign), ref label and promo label.
-- A group under five accounts is withheld; withheld groups are pooled into one
-- "other" row only when the pool itself reaches five.
CREATE OR REPLACE FUNCTION admin.signup_attribution(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
  v_min constant integer := 5;
  v_signups bigint;
  v_attributed bigint;
BEGIN
  SELECT count(*) INTO v_signups FROM auth.users WHERE created_at >= v_since;
  SELECT count(*) INTO v_attributed
  FROM telemetry.signup_attribution WHERE recorded_at >= v_since;

  RETURN jsonb_build_object(
    'version', 'signup-attribution.v1',
    'generated_at', now(),
    'window_days', v_days,
    'minimum_group', v_min,
    'collected_since', (SELECT min(recorded_at) FROM telemetry.signup_attribution),
    'signups', v_signups,
    'attributed', CASE WHEN v_attributed >= v_min OR v_attributed = 0 THEN v_attributed END,
    'attributed_withheld', v_attributed > 0 AND v_attributed < v_min,
    'groups', (
      WITH labelled AS (
        SELECT 'campaign' AS dimension,
               concat_ws(' / ', coalesce(source, '—'), coalesce(medium, '—'), coalesce(campaign, '—')) AS label
        FROM telemetry.signup_attribution
        WHERE recorded_at >= v_since AND num_nonnulls(source, medium, campaign) > 0
        UNION ALL
        SELECT 'ref', ref FROM telemetry.signup_attribution WHERE recorded_at >= v_since AND ref IS NOT NULL
        UNION ALL
        SELECT 'promo', promo FROM telemetry.signup_attribution WHERE recorded_at >= v_since AND promo IS NOT NULL
      ), counted AS (
        SELECT dimension, label, count(*) AS players FROM labelled GROUP BY dimension, label
      ), pooled AS (
        SELECT dimension, label, players FROM counted WHERE players >= v_min
        UNION ALL
        SELECT dimension, NULL, sum(players) FROM counted WHERE players < v_min
        GROUP BY dimension HAVING sum(players) >= v_min
      ), withheld AS (
        SELECT dimension, count(*) AS groups FROM counted WHERE players < v_min GROUP BY dimension
      )
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'dimension', d.dimension,
        'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('label', p.label, 'players', p.players)
                                           ORDER BY p.label IS NULL, p.players DESC, p.label)
                          FROM pooled p WHERE p.dimension = d.dimension), '[]'::jsonb),
        'withheld_groups', coalesce((SELECT w.groups FROM withheld w WHERE w.dimension = d.dimension), 0)
      ) ORDER BY d.ord), '[]'::jsonb)
      FROM (VALUES ('campaign', 1), ('ref', 2), ('promo', 3)) AS d(dimension, ord)
    )
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.signup_attribution(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.signup_attribution(integer) TO heroloop_admin;
