BEGIN;

ALTER TABLE public.normal_combat_events
  ALTER COLUMN balance_version SET DEFAULT 'balance-v4-2026.09.01-v6-combat-effects-v1';

-- Pending waves have no settled outcome to preserve. Rebind only those snapshots
-- so a reconnect can resume through the new resolver and its legacy timer migration.
UPDATE public.normal_combat_events
SET balance_version = 'balance-v4-2026.09.01-v6-combat-effects-v1'
WHERE outcome IS NULL
  AND balance_version <> 'balance-v4-2026.09.01-v6-combat-effects-v1';

COMMIT;
