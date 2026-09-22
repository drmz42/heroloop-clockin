-- Forward-only additive reward collection-power transition.
--
-- collection_power persists the server-derived full-roster collection metric
-- (bounded 0..10,000,000) while power remains the reward-scored Training Camp
-- discounted metric. This migration records the existing reward metric into
-- collection_power and immediately re-derives power from combat_power with the
-- live Training Camp factor so no row keeps a stale full-roster reward window.
-- Token balances and all ledger rows are untouched.

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS collection_power bigint NOT NULL DEFAULT 0
  CHECK (collection_power BETWEEN 0 AND 10000000);

-- Backfill from the prior reward-scored power so existing rows keep history.
UPDATE public.players
SET collection_power = GREATEST(0, LEAST(10000000, power))
WHERE collection_power = 0 AND power <> 0;

-- Transition reward power to floor(combat_power * Training Camp factor):
-- training_hero_count 0=>1, 1=>.9, 2=>.75, 3=>.5, 4=>.25, >=5=>.1.
UPDATE public.players
SET power = FLOOR(
  GREATEST(0, combat_power) * (
    CASE GREATEST(0, LEAST(10, training_hero_count))
      WHEN 0 THEN 1
      WHEN 1 THEN 0.9
      WHEN 2 THEN 0.75
      WHEN 3 THEN 0.5
      WHEN 4 THEN 0.25
      ELSE 0.1
    END
  )
)::bigint;