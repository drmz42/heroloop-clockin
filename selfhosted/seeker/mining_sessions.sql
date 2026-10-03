-- Opt-in accounting only. No runtime grants, signer, ORE adapter, scheduler or RPC.
-- Durable form of mining_budget.ts. Apply after fee_batches.sql in a disposable/private
-- wallet database only. All amounts are SOL lamports. ORE rewards are not recorded here.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.fee_batches') IS NULL THEN
    RAISE EXCEPTION 'mining_sessions_require_private_fee_batches';
  END IF;
END $$;
ALTER TABLE seeker_skr.accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE seeker_skr.accounts ADD CONSTRAINT accounts_kind_check CHECK
  (kind IN ('player','withdrawal_reserve','fees','merchant','rewards','chain','commerce_escrow',
    'fee_reserve','mining_reserve'));
CREATE TABLE IF NOT EXISTS seeker_skr.mining_sessions (
  id uuid PRIMARY KEY,
  source_account uuid NOT NULL REFERENCES seeker_skr.accounts(id),
  day date NOT NULL,
  -- Approved policy snapshot; a replay with different inputs is a conflict.
  policy jsonb NOT NULL,
  reserved_minor numeric(30,0) NOT NULL CHECK (reserved_minor BETWEEN 1 AND 18446744073709551615),
  round_cost_minor numeric(30,0) NOT NULL CHECK (round_cost_minor BETWEEN 1 AND reserved_minor),
  round_limit integer NOT NULL CHECK (round_limit BETWEEN 1 AND 10000),
  spent_minor numeric(30,0) NOT NULL DEFAULT 0 CHECK (spent_minor >= 0),
  completed integer NOT NULL DEFAULT 0 CHECK (completed >= 0),
  released_minor numeric(30,0) CHECK (released_minor >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reserve_event uuid NOT NULL REFERENCES seeker_skr.events(id),
  release_event uuid REFERENCES seeker_skr.events(id),
  CHECK (completed <= round_limit AND spent_minor <= reserved_minor),
  CHECK ((status = 'closed') = (released_minor IS NOT NULL)),
  CHECK (released_minor IS NULL OR spent_minor + released_minor = reserved_minor)
);
-- One unclosed session per funding account; its pending round is the only exposure.
CREATE UNIQUE INDEX IF NOT EXISTS mining_session_one_open_source
  ON seeker_skr.mining_sessions(source_account) WHERE status <> 'closed';
CREATE TABLE IF NOT EXISTS seeker_skr.mining_rounds (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES seeker_skr.mining_sessions(id),
  seq integer NOT NULL CHECK (seq >= 1),
  cap_minor numeric(30,0) NOT NULL CHECK (cap_minor >= 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled')),
  cost_minor numeric(30,0) CHECK (cost_minor >= 0 AND cost_minor <= cap_minor),
  signature text UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  settle_event uuid REFERENCES seeker_skr.events(id),
  UNIQUE (session_id, seq),
  CHECK ((status = 'settled') = (signature IS NOT NULL AND cost_minor IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS mining_round_one_pending
  ON seeker_skr.mining_rounds(session_id) WHERE status = 'pending';

-- Policy must come from approved server configuration, never a player payload.
-- The UTC daily allowance counts every session's unreleased exposure for that day.
CREATE OR REPLACE FUNCTION seeker_skr.mining_session_open(
  p_id uuid,p_source uuid,p_budget numeric,p_policy jsonb
) RETURNS seeker_skr.mining_sessions LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE s seeker_skr.mining_sessions; a seeker_skr.accounts; v_day date; v_used numeric;
  v_session numeric; v_daily numeric; v_stake numeric; v_net numeric; v_proto numeric;
  v_rounds numeric; v_cost numeric; v_event uuid; v_reserve uuid; k text;
BEGIN
  IF p_id IS NULL OR p_source IS NULL OR p_budget IS NULL OR p_policy IS NULL
    OR jsonb_typeof(p_policy)<>'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_policy))<>6 THEN
    RAISE EXCEPTION 'invalid_mining_policy';
  END IF;
  FOREACH k IN ARRAY ARRAY['session_limit','daily_limit','stake_per_round','network_per_round',
      'protocol_per_round','max_rounds'] LOOP
    IF jsonb_typeof(p_policy->k) IS DISTINCT FROM 'string'
      OR (p_policy->>k) !~ '^(0|[1-9][0-9]{0,19})$' THEN RAISE EXCEPTION 'invalid_mining_policy'; END IF;
  END LOOP;
  v_session:=(p_policy->>'session_limit')::numeric; v_daily:=(p_policy->>'daily_limit')::numeric;
  v_stake:=(p_policy->>'stake_per_round')::numeric; v_net:=(p_policy->>'network_per_round')::numeric;
  v_proto:=(p_policy->>'protocol_per_round')::numeric; v_rounds:=(p_policy->>'max_rounds')::numeric;
  v_cost:=v_stake+v_net+v_proto;
  IF v_session<1 OR v_stake<1 OR v_rounds NOT BETWEEN 1 AND 10000
    OR GREATEST(v_session,v_daily,v_cost)>18446744073709551615
    OR p_budget NOT BETWEEN 1 AND 18446744073709551615 OR trunc(p_budget)<>p_budget THEN
    RAISE EXCEPTION 'invalid_mining_policy';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mining-session:'||p_id::text,0));
  SELECT * INTO s FROM seeker_skr.mining_sessions WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    IF s.source_account<>p_source OR s.reserved_minor<>p_budget OR s.policy<>p_policy THEN
      RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
    RETURN s;
  END IF;
  SELECT * INTO a FROM seeker_skr.accounts WHERE id=p_source;
  IF NOT FOUND OR a.asset<>'SOL' OR a.kind NOT IN ('player','fees','merchant','rewards') THEN
    RAISE EXCEPTION 'invalid_mining_source';
  END IF;
  IF p_budget>v_session OR p_budget>v_daily THEN RAISE EXCEPTION 'mining_budget_exceeded'; END IF;
  IF p_budget<v_cost THEN RAISE EXCEPTION 'mining_budget_below_round_cost'; END IF;
  v_day:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
  -- Serialize the day's allowance and the source before reading either.
  PERFORM pg_advisory_xact_lock(hashtextextended('mining-day:'||v_day::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('mining-source:'||p_source::text,0));
  IF EXISTS (SELECT 1 FROM seeker_skr.mining_sessions WHERE source_account=p_source AND status<>'closed') THEN
    RAISE EXCEPTION 'mining_session_pending';
  END IF;
  SELECT COALESCE(sum(reserved_minor-COALESCE(released_minor,0)),0) INTO v_used
    FROM seeker_skr.mining_sessions WHERE day=v_day;
  IF v_used+p_budget>v_daily THEN RAISE EXCEPTION 'mining_budget_exceeded'; END IF;
  v_reserve:=seeker_skr.system_account('mining_reserve','SOL');
  -- post() rejects an overdraft of the source, so available funds bound the budget.
  v_event:=seeker_skr.post(md5('mining-reserve:'||p_id::text)::uuid,'transfer',jsonb_build_array(
    jsonb_build_object('account_id',p_source,'delta_minor',(-p_budget)::text),
    jsonb_build_object('account_id',v_reserve,'delta_minor',p_budget::text)));
  INSERT INTO seeker_skr.mining_sessions(id,source_account,day,policy,reserved_minor,round_cost_minor,
      round_limit,reserve_event)
    VALUES(p_id,p_source,v_day,p_policy,p_budget,v_cost,LEAST(v_rounds,trunc(p_budget/v_cost))::integer,v_event)
    RETURNING * INTO s;
  RETURN s;
END $$;

-- Persist BEFORE submitting a protocol transaction. A timeout keeps the round
-- pending and its cap reserved; it is never an instruction to submit another round.
CREATE OR REPLACE FUNCTION seeker_skr.mining_round_begin(p_session uuid,p_round uuid)
RETURNS seeker_skr.mining_rounds LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE s seeker_skr.mining_sessions; r seeker_skr.mining_rounds;
BEGIN
  IF p_session IS NULL OR p_round IS NULL THEN RAISE EXCEPTION 'invalid_mining_round'; END IF;
  SELECT * INTO s FROM seeker_skr.mining_sessions WHERE id=p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mining_session_not_found'; END IF;
  SELECT * INTO r FROM seeker_skr.mining_rounds WHERE id=p_round;
  IF FOUND THEN
    IF r.session_id<>p_session THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
    RETURN r;
  END IF;
  IF s.status<>'active' OR s.completed>=s.round_limit
    OR s.spent_minor+s.round_cost_minor>s.reserved_minor
    OR EXISTS (SELECT 1 FROM seeker_skr.mining_rounds WHERE session_id=p_session AND status='pending') THEN
    RAISE EXCEPTION 'mining_round_unavailable';
  END IF;
  INSERT INTO seeker_skr.mining_rounds(id,session_id,seq,cap_minor)
    VALUES(p_round,p_session,s.completed+1,s.round_cost_minor) RETURNING * INTO r;
  RETURN r;
END $$;

-- Owner-only primitive: a future adapter MUST verify the finalized protocol
-- transaction (program, payer, total SOL outflow) before passing its signature.
-- Rewards and recovered SOL never increase the session budget (no reinvestment).
CREATE OR REPLACE FUNCTION seeker_skr.mining_round_settle(p_round uuid,p_cost numeric,p_signature text)
RETURNS seeker_skr.mining_rounds LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE s seeker_skr.mining_sessions; r seeker_skr.mining_rounds; v_event uuid; v_session uuid;
BEGIN
  IF p_signature IS NULL OR p_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' THEN
    RAISE EXCEPTION 'invalid_chain_reference';
  END IF;
  IF p_cost IS NULL OR p_cost<0 OR trunc(p_cost)<>p_cost THEN RAISE EXCEPTION 'invalid_mining_round_result'; END IF;
  SELECT session_id INTO v_session FROM seeker_skr.mining_rounds WHERE id=p_round;
  IF NOT FOUND THEN RAISE EXCEPTION 'mining_round_not_found'; END IF;
  -- Same lock order as begin: session, then round.
  SELECT * INTO s FROM seeker_skr.mining_sessions WHERE id=v_session FOR UPDATE;
  SELECT * INTO r FROM seeker_skr.mining_rounds WHERE id=p_round FOR UPDATE;
  IF r.status='settled' THEN
    IF r.signature<>p_signature OR r.cost_minor<>p_cost THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
    RETURN r;
  END IF;
  IF p_cost>r.cap_minor THEN RAISE EXCEPTION 'invalid_mining_round_result'; END IF;
  -- A zero-cost receipt posts no event, so check global signature reuse here.
  IF EXISTS (SELECT 1 FROM seeker_skr.events WHERE chain_signature=p_signature) THEN
    RAISE EXCEPTION 'duplicate_chain_reference';
  END IF;
  IF p_cost>0 THEN
    v_event:=seeker_skr.post(md5('mining-settle:'||p_round::text)::uuid,'withdraw_finalize',jsonb_build_array(
      jsonb_build_object('account_id',seeker_skr.system_account('mining_reserve','SOL'),'delta_minor',(-p_cost)::text),
      jsonb_build_object('account_id',seeker_skr.system_account('chain','SOL'),'delta_minor',p_cost::text)),p_signature);
  END IF;
  UPDATE seeker_skr.mining_rounds SET status='settled',cost_minor=p_cost,signature=p_signature,settle_event=v_event
    WHERE id=p_round RETURNING * INTO r;
  UPDATE seeker_skr.mining_sessions SET spent_minor=spent_minor+p_cost,completed=completed+1 WHERE id=s.id;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.mining_session_stop(p_session uuid)
RETURNS seeker_skr.mining_sessions LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE s seeker_skr.mining_sessions;
BEGIN
  SELECT * INTO s FROM seeker_skr.mining_sessions WHERE id=p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mining_session_not_found'; END IF;
  IF s.status<>'active' THEN RETURN s; END IF;
  UPDATE seeker_skr.mining_sessions SET status='stopped' WHERE id=p_session RETURNING * INTO s;
  RETURN s;
END $$;

-- Returns the unspent reserve to its source. A pending round blocks closing:
-- its outcome is unknown until a verified receipt settles it.
CREATE OR REPLACE FUNCTION seeker_skr.mining_session_close(p_session uuid)
RETURNS seeker_skr.mining_sessions LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE s seeker_skr.mining_sessions; v_left numeric; v_event uuid;
BEGIN
  SELECT * INTO s FROM seeker_skr.mining_sessions WHERE id=p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mining_session_not_found'; END IF;
  IF s.status='closed' THEN RETURN s; END IF;
  IF s.status<>'stopped' THEN RAISE EXCEPTION 'mining_session_not_stopped'; END IF;
  IF EXISTS (SELECT 1 FROM seeker_skr.mining_rounds WHERE session_id=p_session AND status='pending') THEN
    RAISE EXCEPTION 'mining_round_pending';
  END IF;
  v_left:=s.reserved_minor-s.spent_minor;
  IF v_left>0 THEN
    v_event:=seeker_skr.post(md5('mining-release:'||p_session::text)::uuid,'transfer',jsonb_build_array(
      jsonb_build_object('account_id',seeker_skr.system_account('mining_reserve','SOL'),'delta_minor',(-v_left)::text),
      jsonb_build_object('account_id',s.source_account,'delta_minor',v_left::text)));
  END IF;
  UPDATE seeker_skr.mining_sessions SET status='closed',released_minor=v_left,release_event=v_event
    WHERE id=p_session RETURNING * INTO s;
  RETURN s;
END $$;
REVOKE ALL ON seeker_skr.mining_sessions,seeker_skr.mining_rounds FROM PUBLIC,seeker_wallet_runtime;
REVOKE ALL ON FUNCTION seeker_skr.mining_session_open(uuid,uuid,numeric,jsonb),
  seeker_skr.mining_round_begin(uuid,uuid),seeker_skr.mining_round_settle(uuid,numeric,text),
  seeker_skr.mining_session_stop(uuid),seeker_skr.mining_session_close(uuid)
  FROM PUBLIC,seeker_wallet_runtime;
COMMIT;
