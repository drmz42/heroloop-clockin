-- Seeker wallet layer over the SKR accounting kernel (ledger.sql).
-- Adds a per-account asset (SKR or SOL), wallet deposit intents and the narrow
-- functions the private wallet service may call. Install only in seeker_skr,
-- after ledger.sql. Idempotent: a second run is a no-op.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.events') IS NULL THEN
    RAISE EXCEPTION 'seeker_wallet_requires_isolated_ledger';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='seeker_skr' AND table_name='accounts' AND column_name='asset') THEN
    ALTER TABLE seeker_skr.accounts ADD COLUMN asset text NOT NULL DEFAULT 'SKR'
      CHECK (asset IN ('SKR','SOL'));
    DROP INDEX seeker_skr.player_account_kind;
    DROP INDEX seeker_skr.system_account_kind;
    CREATE UNIQUE INDEX player_account_kind ON seeker_skr.accounts (player_id,kind,asset) WHERE player_id IS NOT NULL;
    CREATE UNIQUE INDEX system_account_kind ON seeker_skr.accounts (kind,asset) WHERE player_id IS NULL;
  END IF;
END $$;

-- One event never moves two different assets.
CREATE OR REPLACE FUNCTION seeker_skr.single_asset_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM seeker_skr.entries e
      JOIN seeker_skr.accounts a ON a.id=e.account_id
      WHERE e.event_id=NEW.event_id
        AND a.asset <> (SELECT asset FROM seeker_skr.accounts WHERE id=NEW.account_id)) THEN
    RAISE EXCEPTION 'skr_mixed_asset_event';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS single_asset_entries ON seeker_skr.entries;
CREATE TRIGGER single_asset_entries BEFORE INSERT ON seeker_skr.entries
FOR EACH ROW EXECUTE FUNCTION seeker_skr.single_asset_entry();

CREATE TABLE IF NOT EXISTS seeker_skr.deposit_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL,
  asset text NOT NULL CHECK (asset IN ('SKR','SOL')),
  amount_minor numeric(30,0) NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 18446744073709551615),
  payer text NOT NULL CHECK (payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster text NOT NULL CHECK (cluster IN ('devnet','mainnet')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  settled_signature text UNIQUE CHECK (settled_signature IS NULL OR settled_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  settled_event uuid REFERENCES seeker_skr.events(id),
  settled_at timestamptz,
  CHECK ((settled_signature IS NULL) = (settled_event IS NULL) AND (settled_event IS NULL) = (settled_at IS NULL))
);
CREATE INDEX IF NOT EXISTS deposit_intents_player ON seeker_skr.deposit_intents (player_id, created_at DESC);

CREATE OR REPLACE FUNCTION seeker_skr.wallet_account(p_player uuid, p_asset text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,seeker_skr AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO seeker_skr.accounts(id,kind,player_id,asset) VALUES (gen_random_uuid(),'player',p_player,p_asset)
    ON CONFLICT (player_id,kind,asset) WHERE player_id IS NOT NULL DO NOTHING;
  SELECT id INTO v_id FROM seeker_skr.accounts WHERE player_id=p_player AND kind='player' AND asset=p_asset;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.system_account(p_kind text, p_asset text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,seeker_skr AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO seeker_skr.accounts(id,kind,player_id,asset) VALUES (gen_random_uuid(),p_kind,NULL,p_asset)
    ON CONFLICT (kind,asset) WHERE player_id IS NULL DO NOTHING;
  SELECT id INTO v_id FROM seeker_skr.accounts WHERE player_id IS NULL AND kind=p_kind AND asset=p_asset;
  RETURN v_id;
END $$;

-- Balances, open intents and the last 20 movements of one player.
CREATE OR REPLACE FUNCTION seeker_skr.wallet_snapshot(p_player uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object(
    'balances', (SELECT jsonb_object_agg(x.asset, COALESCE(a.balance_minor,0)::text)
      FROM (VALUES ('SKR'),('SOL')) x(asset)
      LEFT JOIN seeker_skr.accounts a ON a.player_id=p_player AND a.kind='player' AND a.asset=x.asset),
    'pending_deposits', COALESCE((SELECT jsonb_agg(jsonb_build_object('intent_id',i.id,'asset',i.asset,
        'amount_minor',i.amount_minor::text,'expires_at',i.expires_at) ORDER BY i.created_at DESC)
      FROM seeker_skr.deposit_intents i
      WHERE i.player_id=p_player AND i.settled_event IS NULL AND i.expires_at > clock_timestamp()), '[]'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(h ORDER BY h->>'at' DESC) FROM (
      SELECT jsonb_build_object('event_id',e.id,'kind',e.kind,'asset',a.asset,
        'delta_minor',en.delta_minor::text,'signature',e.chain_signature,'at',e.created_at) h
      FROM seeker_skr.entries en
      JOIN seeker_skr.accounts a ON a.id=en.account_id AND a.player_id=p_player AND a.kind='player'
      JOIN seeker_skr.events e ON e.id=en.event_id
      ORDER BY e.created_at DESC LIMIT 20) t), '[]'::jsonb))
$$;

-- The service generates the reference; the database bounds open intents per player.
CREATE OR REPLACE FUNCTION seeker_skr.deposit_intent_create(
  p_player uuid, p_asset text, p_amount numeric, p_payer text, p_reference text, p_cluster text, p_ttl_seconds integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,seeker_skr AS $$
DECLARE v_row seeker_skr.deposit_intents;
BEGIN
  IF p_ttl_seconds NOT BETWEEN 60 AND 1800 THEN RAISE EXCEPTION 'invalid_deposit_ttl'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('deposit:'||p_player::text,0));
  IF (SELECT count(*) FROM seeker_skr.deposit_intents WHERE player_id=p_player
      AND settled_event IS NULL AND expires_at > clock_timestamp()) >= 3 THEN
    RAISE EXCEPTION 'deposit_intent_limit';
  END IF;
  INSERT INTO seeker_skr.deposit_intents(player_id,asset,amount_minor,payer,reference,cluster,expires_at)
    VALUES (p_player,p_asset,p_amount,p_payer,p_reference,p_cluster,clock_timestamp()+make_interval(secs=>p_ttl_seconds))
    RETURNING * INTO v_row;
  RETURN jsonb_build_object('intent_id',v_row.id,'asset',v_row.asset,'amount_minor',v_row.amount_minor::text,
    'payer',v_row.payer,'reference',v_row.reference,'cluster',v_row.cluster,
    'created_at',v_row.created_at,'expires_at',v_row.expires_at);
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.deposit_intent_get(p_player uuid, p_intent uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object('intent_id',id,'asset',asset,'amount_minor',amount_minor::text,'payer',payer,
    'reference',reference,'cluster',cluster,'created_at',created_at,'expires_at',expires_at,
    'settled_signature',settled_signature,'settled_event',settled_event)
  FROM seeker_skr.deposit_intents WHERE id=p_intent AND player_id=p_player
$$;

-- Called only after the service verified the finalized on-chain transfer.
-- Credits the intent amount once; the intent id is the idempotency key and the
-- signature can settle at most one intent (ledger and intent uniqueness).
CREATE OR REPLACE FUNCTION seeker_skr.deposit_settle(p_player uuid, p_intent uuid, p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,seeker_skr AS $$
DECLARE v_row seeker_skr.deposit_intents; v_event uuid; v_player uuid; v_chain uuid;
BEGIN
  SELECT * INTO v_row FROM seeker_skr.deposit_intents WHERE id=p_intent AND player_id=p_player FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deposit_intent_not_found'; END IF;
  IF v_row.settled_event IS NOT NULL THEN
    IF v_row.settled_signature <> p_signature THEN RAISE EXCEPTION 'deposit_already_settled'; END IF;
    RETURN jsonb_build_object('event_id',v_row.settled_event,'replayed',true);
  END IF;
  IF EXISTS (SELECT 1 FROM seeker_skr.deposit_intents WHERE settled_signature=p_signature) THEN
    RAISE EXCEPTION 'deposit_signature_used';
  END IF;
  v_player := seeker_skr.wallet_account(p_player, v_row.asset);
  v_chain := seeker_skr.system_account('chain', v_row.asset);
  v_event := seeker_skr.post(p_intent,'deposit',jsonb_build_array(
    jsonb_build_object('account_id',v_player,'delta_minor',v_row.amount_minor::text),
    jsonb_build_object('account_id',v_chain,'delta_minor',(-v_row.amount_minor)::text)),p_signature);
  UPDATE seeker_skr.deposit_intents SET settled_signature=p_signature, settled_event=v_event,
    settled_at=clock_timestamp() WHERE id=p_intent;
  RETURN jsonb_build_object('event_id',v_event,'replayed',false);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA seeker_skr FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA seeker_skr FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='seeker_wallet_runtime') THEN
    CREATE ROLE seeker_wallet_runtime LOGIN NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA seeker_skr TO seeker_wallet_runtime;
GRANT EXECUTE ON FUNCTION seeker_skr.wallet_snapshot(uuid),
  seeker_skr.deposit_intent_create(uuid,text,numeric,text,text,text,integer),
  seeker_skr.deposit_intent_get(uuid,uuid),
  seeker_skr.deposit_settle(uuid,uuid,text) TO seeker_wallet_runtime;
COMMIT;
