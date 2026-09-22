BEGIN;

ALTER TABLE public.normal_combat_events
  ALTER COLUMN balance_version SET DEFAULT 'balance-v4-2026.09.01-v6-combat-effects-v1';

CREATE OR REPLACE FUNCTION public.normal_combat_balance_version_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_requested text := nullif(current_setting('heroloop.normal_combat_balance_version', true), '');
BEGIN
  v_requested := coalesce(v_requested, 'balance-v4-2026.09.01-v6-combat-effects-v1');
  IF v_requested NOT IN (
    'balance-v4-2026.09.01-v6-combat-effects-v1',
    'balance-v4-2026.09.06-v7-combat-effects-v2-candidate'
  ) THEN
    RAISE EXCEPTION 'normal_combat_balance_version_invalid';
  END IF;
  NEW.balance_version := v_requested;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normal_combat_balance_version_gate ON public.normal_combat_events;
CREATE TRIGGER normal_combat_balance_version_gate
BEFORE INSERT ON public.normal_combat_events
FOR EACH ROW EXECUTE FUNCTION public.normal_combat_balance_version_gate();

REVOKE ALL ON FUNCTION public.normal_combat_balance_version_gate() FROM PUBLIC, anon, authenticated;

COMMIT;
