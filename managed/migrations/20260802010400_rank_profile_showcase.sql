ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS lineup jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS avatar_hero_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS summons bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens_earned numeric NOT NULL DEFAULT 0;
