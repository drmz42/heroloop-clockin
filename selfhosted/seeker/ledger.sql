-- Opt-in SKR accounting kernel. NOT in the ordinary game's migration path.
-- Install only in a new, isolated Seeker database. No runtime grants or endpoints.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.players') IS NOT NULL THEN
    RAISE EXCEPTION 'seeker_database_must_be_isolated';
  END IF;
END $$;
CREATE SCHEMA seeker_skr;
REVOKE ALL ON SCHEMA seeker_skr FROM PUBLIC;

CREATE TABLE seeker_skr.accounts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('player','withdrawal_reserve','fees','merchant','rewards','chain')),
  player_id uuid,
  balance_minor numeric(30,0) NOT NULL DEFAULT 0,
  CHECK ((kind IN ('player','withdrawal_reserve')) = (player_id IS NOT NULL)),
  CHECK (balance_minor BETWEEN -18446744073709551615 AND 18446744073709551615),
  CHECK (kind = 'chain' OR balance_minor >= 0)
);
CREATE UNIQUE INDEX player_account_kind ON seeker_skr.accounts (player_id,kind) WHERE player_id IS NOT NULL;
CREATE UNIQUE INDEX system_account_kind ON seeker_skr.accounts (kind) WHERE player_id IS NULL;
CREATE TABLE seeker_skr.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('deposit','transfer','withdraw_reserve','withdraw_release','withdraw_finalize')),
  request jsonb NOT NULL,
  chain_signature text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (chain_signature IS NULL OR chain_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$')
);
CREATE TABLE seeker_skr.entries (
  event_id uuid NOT NULL REFERENCES seeker_skr.events(id),
  account_id uuid NOT NULL REFERENCES seeker_skr.accounts(id),
  delta_minor numeric(30,0) NOT NULL CHECK (delta_minor <> 0 AND abs(delta_minor) <= 18446744073709551615),
  PRIMARY KEY (event_id,account_id)
);
CREATE FUNCTION seeker_skr.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'skr_ledger_immutable'; END $$;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON seeker_skr.events
FOR EACH ROW EXECUTE FUNCTION seeker_skr.immutable();
CREATE TRIGGER immutable_entries BEFORE UPDATE OR DELETE ON seeker_skr.entries
FOR EACH ROW EXECUTE FUNCTION seeker_skr.immutable();

-- Private accounting primitive: the eventual server adapters must authenticate,
-- verify finalized on-chain receipts and derive these legs from approved rules.
-- This function is intentionally not granted to the current game API/worker.
CREATE FUNCTION seeker_skr.post(
  p_key uuid, p_kind text, p_legs jsonb, p_signature text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,seeker_skr AS $$
DECLARE
  v_request jsonb; v_event uuid; v_previous jsonb; v_count integer;
BEGIN
  IF p_key IS NULL OR p_kind IS NULL OR p_kind NOT IN
    ('deposit','transfer','withdraw_reserve','withdraw_release','withdraw_finalize') THEN
    RAISE EXCEPTION 'invalid_skr_event';
  END IF;
  IF jsonb_typeof(p_legs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_skr_legs'; END IF;
  IF jsonb_array_length(p_legs) NOT BETWEEN 2 AND 8 THEN RAISE EXCEPTION 'invalid_skr_legs'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_legs) x WHERE
    jsonb_typeof(x) IS DISTINCT FROM 'object'
    OR NOT (x ? 'account_id' AND x ? 'delta_minor')
    OR (x - 'account_id' - 'delta_minor') <> '{}'::jsonb
    OR jsonb_typeof(x->'account_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(x->'delta_minor') IS DISTINCT FROM 'string'
    OR (x->>'account_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (x->>'delta_minor') !~ '^-?[1-9][0-9]{0,19}$') THEN
    RAISE EXCEPTION 'invalid_skr_legs';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_legs) x
    WHERE abs((x->>'delta_minor')::numeric) > 18446744073709551615)
    OR (SELECT sum((x->>'delta_minor')::numeric) FROM jsonb_array_elements(p_legs) x) <> 0
    OR (SELECT count(DISTINCT x->>'account_id') FROM jsonb_array_elements(p_legs) x) <> jsonb_array_length(p_legs) THEN
    RAISE EXCEPTION 'unbalanced_skr_event';
  END IF;
  IF (p_kind IN ('deposit','withdraw_finalize')) <> (p_signature IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_chain_reference';
  END IF;
  SELECT jsonb_build_object('kind',p_kind,'signature',p_signature,'legs',
    jsonb_agg(x ORDER BY x->>'account_id')) INTO v_request FROM jsonb_array_elements(p_legs) x;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text,0));
  SELECT id,request INTO v_event,v_previous FROM seeker_skr.events WHERE idempotency_key=p_key;
  IF FOUND THEN
    IF v_previous <> v_request THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
    RETURN v_event;
  END IF;
  -- Stable lock order serializes overlapping debits and avoids account deadlocks.
  PERFORM 1 FROM seeker_skr.accounts WHERE id IN
    (SELECT (x->>'account_id')::uuid FROM jsonb_array_elements(p_legs) x) ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_legs) THEN RAISE EXCEPTION 'skr_account_missing'; END IF;
  IF EXISTS (SELECT 1 FROM seeker_skr.accounts a JOIN jsonb_array_elements(p_legs) x
    ON a.id=(x->>'account_id')::uuid WHERE
    abs(a.balance_minor+(x->>'delta_minor')::numeric) > 18446744073709551615
    OR (a.kind <> 'chain' AND a.balance_minor+(x->>'delta_minor')::numeric < 0)) THEN
    RAISE EXCEPTION 'skr_insufficient_balance_or_overflow';
  END IF;
  INSERT INTO seeker_skr.events(idempotency_key,kind,request,chain_signature)
    VALUES(p_key,p_kind,v_request,p_signature) RETURNING id INTO v_event;
  INSERT INTO seeker_skr.entries(event_id,account_id,delta_minor)
    SELECT v_event,(x->>'account_id')::uuid,(x->>'delta_minor')::numeric FROM jsonb_array_elements(p_legs) x;
  UPDATE seeker_skr.accounts a SET balance_minor=a.balance_minor+(x->>'delta_minor')::numeric
    FROM jsonb_array_elements(p_legs) x WHERE a.id=(x->>'account_id')::uuid;
  RETURN v_event;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA seeker_skr FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA seeker_skr FROM PUBLIC;
COMMIT;
