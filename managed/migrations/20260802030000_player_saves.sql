-- Persistent account state. Browser storage is only a one-time legacy import source.
CREATE TABLE IF NOT EXISTS player_saves (
  player_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  imported_legacy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE player_saves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE player_saves FROM anon, authenticated;
