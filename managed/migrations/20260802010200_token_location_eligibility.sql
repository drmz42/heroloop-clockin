ALTER TABLE public.players
ADD COLUMN IF NOT EXISTS token_eligible boolean NOT NULL DEFAULT true;
