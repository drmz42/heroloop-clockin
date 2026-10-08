-- Isolated ORE custody accounting. No game database, seed, or public SQL access.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.mining_terms') IS NULL THEN
  RAISE EXCEPTION 'ore_wallet_requires_private_mining_runtime';
 END IF;
END $$;
ALTER TABLE seeker_skr.accounts DROP CONSTRAINT IF EXISTS accounts_asset_check;
ALTER TABLE seeker_skr.accounts ADD CONSTRAINT accounts_asset_check CHECK(asset IN ('SKR','SOL','ORE'));
ALTER TABLE seeker_skr.withdrawals DROP CONSTRAINT IF EXISTS withdrawals_asset_check;
ALTER TABLE seeker_skr.withdrawals ADD CONSTRAINT withdrawals_asset_check CHECK(asset IN ('SKR','SOL','ORE'));

-- A round can only replay its original signed transaction.
ALTER TABLE seeker_skr.mining_rounds ADD COLUMN IF NOT EXISTS submitted_wire text;
ALTER TABLE seeker_skr.mining_rounds ADD COLUMN IF NOT EXISTS last_valid_height numeric(20,0);
CREATE OR REPLACE FUNCTION seeker_skr.mine_round_prepare(p_session uuid,p_round uuid,p_ore_round numeric,
 p_signature text,p_wire text,p_height numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE r seeker_skr.mining_rounds;
BEGIN
 IF p_wire IS NULL OR length(p_wire) NOT BETWEEN 80 AND 1700 OR p_height IS NULL OR p_height<0 OR trunc(p_height)<>p_height
  OR p_ore_round IS NULL OR p_ore_round<0 OR trunc(p_ore_round)<>p_ore_round
  OR p_signature IS NULL OR p_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' THEN RAISE EXCEPTION 'invalid_mining_round'; END IF;
 r:=seeker_skr.mining_round_begin(p_session,p_round);
 IF r.submitted_signature IS NOT NULL THEN
  IF r.ore_round_id<>p_ore_round THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
  IF r.submitted_wire IS NULL THEN RAISE EXCEPTION 'mine_action_review_required'; END IF;
 ELSE
  UPDATE seeker_skr.mining_rounds SET ore_round_id=p_ore_round,submitted_signature=p_signature,
   submitted_wire=p_wire,last_valid_height=p_height WHERE id=p_round RETURNING * INTO r;
 END IF;
 RETURN to_jsonb(r)||jsonb_build_object('last_valid_height',r.last_valid_height::text);
END $$;
REVOKE ALL ON FUNCTION seeker_skr.mine_round_prepare(uuid,uuid,numeric,text) FROM seeker_wallet_runtime;
REVOKE ALL ON FUNCTION seeker_skr.mine_round_prepare(uuid,uuid,numeric,text,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.mine_round_prepare(uuid,uuid,numeric,text,text,numeric) TO seeker_wallet_runtime;


-- Retain every custody owner, including closed sessions. Tokens never disappear
-- from reconciliation merely because their originating session has ended.
CREATE OR REPLACE FUNCTION seeker_skr.mine_custody_owners() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
 SELECT jsonb_build_object('owners',COALESCE(jsonb_agg(DISTINCT custody_address),'[]'::jsonb))
 FROM seeker_skr.mining_sessions WHERE custody_address IS NOT NULL
$$;
CREATE TABLE IF NOT EXISTS seeker_skr.mine_actions (
 id uuid PRIMARY KEY, session_id uuid REFERENCES seeker_skr.mining_sessions(id),
 request_id uuid UNIQUE REFERENCES seeker_skr.withdrawals(id),
 kind text NOT NULL CHECK(kind IN ('fund','ore_claim','ore_gas','ore_payout','sol_claim','checkpoint','sweep')),
 signature text NOT NULL UNIQUE CHECK(signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
 wire text NOT NULL CHECK(length(wire) BETWEEN 80 AND 1700),
 last_valid_height numeric(20,0) NOT NULL CHECK(last_valid_height>=0),
 status text NOT NULL DEFAULT 'signed' CHECK(status IN ('signed','confirmed','attention')),
 amount_minor numeric(30,0), sol_delta numeric(30,0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='ore_payout')=(request_id IS NOT NULL)),
 CHECK((kind<>'ore_payout')=(session_id IS NOT NULL))
);
-- Allow the existing Mine float to pay an approved SOL withdrawal directly.
ALTER TABLE seeker_skr.mine_actions DROP CONSTRAINT IF EXISTS mine_actions_kind_check;
ALTER TABLE seeker_skr.mine_actions ADD CONSTRAINT mine_actions_kind_check CHECK(kind IN ('fund','ore_claim','ore_gas','ore_payout','sol_payout','sol_claim','checkpoint','sweep'));
ALTER TABLE seeker_skr.mine_actions DROP CONSTRAINT IF EXISTS mine_actions_check;
ALTER TABLE seeker_skr.mine_actions DROP CONSTRAINT IF EXISTS mine_actions_check1;
ALTER TABLE seeker_skr.mine_actions ADD CONSTRAINT mine_actions_check CHECK((kind IN ('ore_payout','sol_payout'))=(request_id IS NOT NULL));
ALTER TABLE seeker_skr.mine_actions ADD CONSTRAINT mine_actions_check1 CHECK((kind NOT IN ('ore_payout','sol_payout'))=(session_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS mine_action_session_kind ON seeker_skr.mine_actions(session_id,kind);
CREATE OR REPLACE FUNCTION seeker_skr.mine_runner_work() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object('sol_payout_pending_minor',(SELECT COALESCE(sum(w.amount_minor-w.fee_minor+5000),0)::text FROM seeker_skr.mine_actions a JOIN seeker_skr.withdrawals w ON w.id=a.request_id WHERE a.kind='sol_payout' AND a.status='signed' AND w.status='paying'),'sessions',COALESCE(jsonb_agg(jsonb_build_object(
    'id',s.id,'player_id',a.player_id,'status',s.status,'policy',s.policy,'custody_address',s.custody_address,
    'reserved_minor',s.reserved_minor::text,'spent_minor',s.spent_minor::text,'completed',s.completed,
    'round_limit',s.round_limit,'round_cost_minor',s.round_cost_minor::text,
    'last_ore_round_id',(SELECT max(r.ore_round_id)::text FROM seeker_skr.mining_rounds r WHERE r.session_id=s.id),
    'pending',(SELECT jsonb_build_object('id',r.id,'ore_round_id',r.ore_round_id::text,'submitted_signature',r.submitted_signature,'submitted_wire',r.submitted_wire,'last_valid_height',r.last_valid_height::text)
      FROM seeker_skr.mining_rounds r WHERE r.session_id=s.id AND r.status='pending')) ORDER BY s.created_at),'[]'::jsonb))
  FROM seeker_skr.mining_sessions s JOIN seeker_skr.accounts a ON a.id=s.source_account
  WHERE s.status<>'closed'
$$;
CREATE TABLE IF NOT EXISTS seeker_skr.ore_credits (
 action_id uuid PRIMARY KEY REFERENCES seeker_skr.mine_actions(id),
 session_id uuid NOT NULL REFERENCES seeker_skr.mining_sessions(id),
 player_account uuid NOT NULL REFERENCES seeker_skr.accounts(id),
 amount_minor numeric(30,0) NOT NULL CHECK(amount_minor BETWEEN 1 AND 18446744073709551615),
 signature text NOT NULL UNIQUE, credit_event uuid NOT NULL UNIQUE REFERENCES seeker_skr.events(id)
);
DROP TRIGGER IF EXISTS immutable_ore_credits ON seeker_skr.ore_credits;
CREATE TRIGGER immutable_ore_credits BEFORE UPDATE OR DELETE ON seeker_skr.ore_credits
 FOR EACH ROW EXECUTE FUNCTION seeker_skr.immutable();
CREATE OR REPLACE FUNCTION seeker_skr.mine_action_get(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
 SELECT COALESCE((SELECT to_jsonb(a)||jsonb_build_object('last_valid_height',a.last_valid_height::text,
  'amount_minor',a.amount_minor::text,'sol_delta',a.sol_delta::text) FROM seeker_skr.mine_actions a WHERE id=p_id),'{}'::jsonb)
$$;
CREATE OR REPLACE FUNCTION seeker_skr.mine_action_prepare(p_id uuid,p_session uuid,p_request uuid,
 p_kind text,p_signature text,p_wire text,p_height numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE a seeker_skr.mine_actions;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('mine-action:'||p_id::text,0));
 SELECT * INTO a FROM seeker_skr.mine_actions WHERE id=p_id;
 IF FOUND THEN
  IF a.session_id IS DISTINCT FROM p_session OR a.request_id IS DISTINCT FROM p_request OR a.kind<>p_kind
   THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
  -- A concurrent preparer returns the already committed bytes, never replaces them.
  RETURN seeker_skr.mine_action_get(p_id);
 END IF;
 IF p_kind IN ('ore_payout','sol_payout') AND NOT EXISTS(SELECT 1 FROM seeker_skr.withdrawals
  WHERE id=p_request AND asset=CASE p_kind WHEN 'ore_payout' THEN 'ORE' ELSE 'SOL' END AND status='paying' AND approved_by IS NOT NULL)
  THEN RAISE EXCEPTION 'withdrawal_state_conflict'; END IF;
 INSERT INTO seeker_skr.mine_actions(id,session_id,request_id,kind,signature,wire,last_valid_height)
  VALUES(p_id,p_session,p_request,p_kind,p_signature,p_wire,p_height);
 RETURN seeker_skr.mine_action_get(p_id);
END $$;
CREATE OR REPLACE FUNCTION seeker_skr.mine_action_finish(p_id uuid,p_status text,p_amount numeric,p_sol numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE a seeker_skr.mine_actions; v_player uuid; v_account uuid; v_event uuid;
BEGIN
 SELECT * INTO a FROM seeker_skr.mine_actions WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'mine_action_not_found'; END IF;
 IF a.status='confirmed' THEN
  IF p_status<>'confirmed' OR a.amount_minor IS DISTINCT FROM p_amount OR a.sol_delta IS DISTINCT FROM p_sol
   THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
  -- ORE auto_return pays SOL during checkpoint, without a claim_sol action.
  -- Replaying the exact persisted receipt also repairs pre-fix confirmations.
  IF a.kind='checkpoint' AND a.sol_delta>0 THEN
   PERFORM seeker_skr.mine_credit(a.id,a.session_id,a.sol_delta,a.signature);
  END IF;
  RETURN seeker_skr.mine_action_get(p_id);
 END IF;
 IF a.status='attention' OR p_status NOT IN ('confirmed','attention') THEN RAISE EXCEPTION 'mine_action_review_required'; END IF;
 IF p_status='confirmed' AND a.kind='checkpoint' AND p_sol>0 THEN
  PERFORM seeker_skr.mine_credit(a.id,a.session_id,p_sol,a.signature);
 END IF;
 IF p_status='confirmed' AND a.kind='ore_claim' THEN
  IF p_amount IS NULL OR p_amount<1 OR trunc(p_amount)<>p_amount OR p_amount>18446744073709551615
   THEN RAISE EXCEPTION 'invalid_ore_credit'; END IF;
  SELECT x.player_id INTO v_player FROM seeker_skr.mining_sessions s
   JOIN seeker_skr.accounts x ON x.id=s.source_account WHERE s.id=a.session_id;
  v_account:=seeker_skr.wallet_account(v_player,'ORE');
  v_event:=seeker_skr.post(a.id,'deposit',jsonb_build_array(
   jsonb_build_object('account_id',v_account,'delta_minor',p_amount::text),
   jsonb_build_object('account_id',seeker_skr.system_account('chain','ORE'),'delta_minor',(-p_amount)::text)),a.signature);
  INSERT INTO seeker_skr.ore_credits VALUES(a.id,a.session_id,v_account,p_amount,a.signature,v_event);
 END IF;
 UPDATE seeker_skr.mine_actions SET status=p_status,amount_minor=p_amount,sol_delta=p_sol WHERE id=p_id;
 RETURN seeker_skr.mine_action_get(p_id);
END $$;
-- Commit the verified payout and its durable action in one database transaction.
CREATE OR REPLACE FUNCTION seeker_skr.mine_custody_payout_finalize(p_request uuid,p_signature text,p_sol numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE a seeker_skr.mine_actions; w seeker_skr.withdrawals; result jsonb;
BEGIN
 SELECT * INTO a FROM seeker_skr.mine_actions WHERE request_id=p_request AND kind IN ('ore_payout','sol_payout') FOR UPDATE;
 SELECT * INTO w FROM seeker_skr.withdrawals WHERE id=p_request;
 IF a.id IS NULL OR w.id IS NULL OR w.asset<>(CASE a.kind WHEN 'ore_payout' THEN 'ORE' ELSE 'SOL' END) OR a.signature<>p_signature
  OR p_sol IS NULL OR trunc(p_sol)<>p_sol OR p_sol>0 THEN RAISE EXCEPTION 'withdrawal_state_conflict'; END IF;
 result:=seeker_skr.withdrawal_finalize(p_request,p_signature);
 PERFORM seeker_skr.mine_action_finish(a.id,'confirmed',w.amount_minor-w.fee_minor,p_sol);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION seeker_skr.mine_custody_payout_finalize(uuid,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.mine_custody_payout_finalize(uuid,text,numeric) TO seeker_wallet_runtime;
CREATE OR REPLACE FUNCTION seeker_skr.mine_ore_payout_finalize(p_request uuid,p_signature text,p_sol numeric)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
 SELECT seeker_skr.mine_custody_payout_finalize(p_request,p_signature,p_sol)
$$;
REVOKE ALL ON FUNCTION seeker_skr.mine_ore_payout_finalize(uuid,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.mine_ore_payout_finalize(uuid,text,numeric) TO seeker_wallet_runtime;
CREATE OR REPLACE FUNCTION seeker_skr.mine_session_json(s seeker_skr.mining_sessions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object('id',s.id,'status',s.status,'reserved_minor',s.reserved_minor::text,
    'spent_minor',s.spent_minor::text,'released_minor',s.released_minor::text,'completed',s.completed,
    'round_limit',s.round_limit,'stake_minor',s.policy->>'stake_per_round','square_mask',s.policy->>'square_mask','custody_address',s.custody_address,
    'created_at',s.created_at,
    -- Player SOL balance change only. ORE is a separate asset, not realized SOL profit.
    'net_sol_minor',((SELECT COALESCE(sum(c.amount_minor),0) FROM seeker_skr.mining_credits c WHERE c.session_id=s.id)-s.spent_minor)::text,
    'credited_ore_minor',(SELECT COALESCE(sum(c.amount_minor),0)::text FROM seeker_skr.ore_credits c WHERE c.session_id=s.id),
    'credited_minor',(SELECT COALESCE(sum(c.amount_minor),0)::text FROM seeker_skr.mining_credits c WHERE c.session_id=s.id),
    'rounds',(SELECT COALESCE(jsonb_agg(jsonb_build_object('seq',r.seq,'status',r.status,'ore_round_id',r.ore_round_id::text,
      'cost_minor',r.cost_minor::text,'signature',COALESCE(r.signature,r.submitted_signature)) ORDER BY r.seq DESC),'[]'::jsonb)
      FROM (SELECT * FROM seeker_skr.mining_rounds WHERE session_id=s.id ORDER BY seq DESC LIMIT 60) r))
$$;

REVOKE ALL ON seeker_skr.mine_actions,seeker_skr.ore_credits FROM PUBLIC,seeker_wallet_runtime;
REVOKE ALL ON FUNCTION seeker_skr.mine_custody_owners(),seeker_skr.mine_action_get(uuid),
 seeker_skr.mine_action_prepare(uuid,uuid,uuid,text,text,text,numeric),seeker_skr.mine_action_finish(uuid,text,numeric,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.mine_custody_owners(),seeker_skr.mine_action_get(uuid),
 seeker_skr.mine_action_prepare(uuid,uuid,uuid,text,text,text,numeric),seeker_skr.mine_action_finish(uuid,text,numeric,numeric)
 TO seeker_wallet_runtime;
COMMIT;
