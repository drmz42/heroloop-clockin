-- Balance v5 renamed the normal-combat runtime stamps. The database gate and the
-- economy telemetry stamp must accept them, or every Normal Combat start fails
-- with normal_combat_balance_version_invalid. Older stamps stay valid so stored
-- events keep their meaning.
BEGIN;

CREATE OR REPLACE FUNCTION public.normal_combat_balance_version_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_requested text := nullif(current_setting('heroloop.normal_combat_balance_version', true), '');
BEGIN
  v_requested := coalesce(v_requested, 'balance-v5-progression-2026.09.28-v1-combat-effects-v1');
  IF v_requested NOT IN (
    'balance-v4-2026.09.01-v6-combat-effects-v1',
    'balance-v4-2026.09.06-v7-combat-effects-v2-candidate',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v1',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v2'
  ) THEN
    RAISE EXCEPTION 'normal_combat_balance_version_invalid';
  END IF;
  NEW.balance_version := v_requested;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.normal_combat_balance_version_gate() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION telemetry.stamp_economy_settlement()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE
  v_enabled boolean;
  v_config_version text;
  v_version text;
  v_player_id uuid;
  v_level_text text;
  v_band text;
BEGIN
  SELECT enabled, balance_version INTO v_enabled, v_config_version
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NEW; END IF;

  v_version := CASE WHEN TG_ARGV[0] = 'row_balance_version'
    THEN to_jsonb(NEW)->>'balance_version' ELSE v_config_version END;
  IF v_version IS NULL OR v_version NOT IN (
    '2026.08.02-v2',
    'hero-power-proposal-2026.08.12-v3',
    'balance-v4',
    'balance-v4-2026.09.01-v6-combat-effects-v1',
    'balance-v4-2026.09.06-v7-combat-effects-v2-candidate',
    'balance-v5-progression-2026.09.28-v1',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v1',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v2'
  ) THEN RETURN NEW; END IF;

  BEGIN
    v_player_id := (to_jsonb(NEW)->>'player_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;
  IF v_player_id IS NULL THEN RETURN NEW; END IF;

  SELECT state->>'accountLevel' INTO v_level_text
  FROM public.player_saves WHERE player_id = v_player_id;
  IF v_level_text IS NULL OR v_level_text !~ '^[0-9]{1,3}$' THEN RETURN NEW; END IF;
  v_band := telemetry.account_level_band(v_level_text::integer);
  IF v_band IS NULL THEN RETURN NEW; END IF;

  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'economy_balance_version', v_version,
    'economy_account_level_band', v_band
  ));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION telemetry.stamp_economy_settlement() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
