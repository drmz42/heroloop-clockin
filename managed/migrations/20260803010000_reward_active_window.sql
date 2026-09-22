ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS reward_active_until timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS players_reward_active_until_idx
  ON public.players (reward_active_until)
  WHERE token_eligible = true AND power > 0;

COMMENT ON COLUMN public.players.reward_active_until IS
  'Server-renewed reward eligibility deadline: eight hours after the latest verified game heartbeat.';
