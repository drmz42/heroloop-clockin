ALTER TABLE players
  ADD COLUMN IF NOT EXISTS boss_keys integer NOT NULL DEFAULT 0 CHECK (boss_keys >= 0);

CREATE TABLE IF NOT EXISTS rarity_supply (
  rarity text PRIMARY KEY,
  max_existing integer NOT NULL CHECK (max_existing > 0),
  existing_count integer NOT NULL DEFAULT 0 CHECK (existing_count >= 0 AND existing_count <= max_existing),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO rarity_supply (rarity, max_existing)
VALUES
  ('divine', 10000),
  ('celestial', 5000),
  ('cursed', 2500),
  ('immortal', 1000),
  ('god', 500)
ON CONFLICT (rarity) DO UPDATE SET max_existing = EXCLUDED.max_existing;

CREATE TABLE IF NOT EXISTS player_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  base_item_id text NOT NULL,
  slot text NOT NULL,
  rarity text NOT NULL,
  item_level integer NOT NULL CHECK (item_level >= 1),
  stats jsonb NOT NULL DEFAULT '[]'::jsonb,
  enchant_level integer NOT NULL DEFAULT 0 CHECK (enchant_level >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_player_items_owner_active
  ON player_items(player_id, created_at DESC)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_player_items_rarity_active
  ON player_items(rarity)
  WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS boss_encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id integer NOT NULL CHECK (location_id >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'won', 'lost', 'claimed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (player_id, id)
);

ALTER TABLE rarity_supply ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE boss_encounters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS player_items_read_own ON player_items;
CREATE POLICY player_items_read_own ON player_items
  FOR SELECT TO authenticated USING (auth.uid() = player_id);

DROP POLICY IF EXISTS boss_encounters_read_own ON boss_encounters;
CREATE POLICY boss_encounters_read_own ON boss_encounters
  FOR SELECT TO authenticated USING (auth.uid() = player_id);

CREATE OR REPLACE FUNCTION reserve_limited_item(
  p_player_id uuid,
  p_base_item_id text,
  p_slot text,
  p_rarity text,
  p_item_level integer,
  p_stats jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supply rarity_supply%ROWTYPE;
  new_id uuid;
BEGIN
  IF p_rarity IN ('cursed', 'immortal', 'god') THEN
    RAISE EXCEPTION 'craft_only_rarity';
  END IF;

  IF p_rarity IN ('divine', 'celestial') THEN
    SELECT * INTO supply FROM rarity_supply WHERE rarity = p_rarity FOR UPDATE;
    IF NOT FOUND OR supply.existing_count >= supply.max_existing THEN
      RAISE EXCEPTION 'rarity_limit_reached';
    END IF;
    UPDATE rarity_supply
      SET existing_count = existing_count + 1, updated_at = now()
      WHERE rarity = p_rarity;
  END IF;

  INSERT INTO player_items (player_id, base_item_id, slot, rarity, item_level, stats)
  VALUES (p_player_id, p_base_item_id, p_slot, p_rarity, GREATEST(1, p_item_level), COALESCE(p_stats, '[]'::jsonb))
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION remove_player_item(p_player_id uuid, p_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed_rarity text;
BEGIN
  UPDATE player_items
    SET removed_at = now()
    WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL
    RETURNING rarity INTO removed_rarity;

  IF NOT FOUND THEN RETURN false; END IF;

  IF removed_rarity IN ('divine', 'celestial', 'cursed', 'immortal', 'god') THEN
    UPDATE rarity_supply
      SET existing_count = GREATEST(0, existing_count - 1), updated_at = now()
      WHERE rarity = removed_rarity;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION reserve_limited_item(uuid, text, text, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION remove_player_item(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION summon_boss(p_player_id uuid, p_location integer)
RETURNS TABLE(encounter_id uuid, remaining_keys integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_encounter uuid;
  v_keys integer;
BEGIN
  UPDATE players
    SET boss_keys = boss_keys - 1, updated_at = now()
    WHERE player_id = p_player_id AND boss_keys > 0
    RETURNING boss_keys INTO v_keys;

  IF NOT FOUND THEN RAISE EXCEPTION 'boss_key_required'; END IF;

  INSERT INTO boss_encounters(player_id, location_id)
    VALUES (p_player_id, GREATEST(1, p_location))
    RETURNING id INTO v_encounter;

  RETURN QUERY SELECT v_encounter, v_keys;
END;
$$;

REVOKE ALL ON FUNCTION summon_boss(uuid, integer) FROM PUBLIC;
