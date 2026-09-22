-- One-time testing grant for every player that exists at deployment time.
UPDATE public.players
SET pending_tokens = pending_tokens + 20000,
    updated_at = now();
