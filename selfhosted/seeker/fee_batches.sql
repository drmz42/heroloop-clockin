-- Opt-in accounting only. No runtime grants, signer, scheduler or RPC adapter.
-- Apply after commerce.sql in a disposable/private wallet database only.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.purchases') IS NULL THEN
    RAISE EXCEPTION 'fee_batches_require_private_commerce';
  END IF;
END $$;
ALTER TABLE seeker_skr.accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE seeker_skr.accounts ADD CONSTRAINT accounts_kind_check CHECK
  -- Same full kind list in every installer file, so re-applying any of them stays valid.
  (kind IN ('player','withdrawal_reserve','fees','merchant','rewards','chain','commerce_escrow',
    'fee_reserve','mining_reserve'));
CREATE TABLE IF NOT EXISTS seeker_skr.fee_batches (
  id uuid PRIMARY KEY,
  asset text NOT NULL CHECK (asset IN ('SKR','SOL')),
  destination text NOT NULL CHECK (destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  minimum_minor numeric(30,0) NOT NULL CHECK (minimum_minor BETWEEN 1 AND 18446744073709551615),
  amount_minor numeric(30,0) NOT NULL CHECK (amount_minor BETWEEN 1 AND 18446744073709551615),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','paying','paid','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reserve_event uuid NOT NULL REFERENCES seeker_skr.events(id),
  finish_event uuid REFERENCES seeker_skr.events(id),
  signature text UNIQUE,
  CHECK ((status IN ('paid','cancelled')) = (finish_event IS NOT NULL)),
  CHECK ((status = 'paid') = (signature IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fee_batch_one_open_asset ON seeker_skr.fee_batches(asset)
  WHERE status IN ('reserved','paying');

-- Parameters must come from an approved server policy, never a player payload.
-- The snapshot is all currently available earned fees, above the chosen minimum.
CREATE OR REPLACE FUNCTION seeker_skr.fee_batch_reserve(
  p_id uuid,p_asset text,p_destination text,p_minimum numeric
) RETURNS seeker_skr.fee_batches LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE b seeker_skr.fee_batches; v_fee uuid; v_reserve uuid; v_amount numeric; v_event uuid;
BEGIN
  IF p_id IS NULL OR p_asset IS NULL OR p_asset NOT IN ('SKR','SOL') OR p_destination IS NULL
    OR p_destination !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' OR p_minimum IS NULL
    OR p_minimum NOT BETWEEN 1 AND 18446744073709551615 OR trunc(p_minimum) <> p_minimum THEN
    RAISE EXCEPTION 'invalid_fee_batch_policy';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fee-batch:'||p_id::text,0));
  SELECT * INTO b FROM seeker_skr.fee_batches WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    IF b.asset<>p_asset OR b.destination<>p_destination OR b.minimum_minor<>p_minimum THEN
      RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
    RETURN b;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fee-batch-asset:'||p_asset,0));
  IF EXISTS (SELECT 1 FROM seeker_skr.fee_batches WHERE asset=p_asset AND status IN ('reserved','paying')) THEN
    RAISE EXCEPTION 'fee_batch_pending';
  END IF;
  v_fee:=seeker_skr.system_account('fees',p_asset);
  v_reserve:=seeker_skr.system_account('fee_reserve',p_asset);
  -- Match post() lock order before reading the mutable fee balance.
  PERFORM 1 FROM seeker_skr.accounts WHERE id IN (v_fee,v_reserve) ORDER BY id FOR UPDATE;
  SELECT balance_minor INTO v_amount FROM seeker_skr.accounts WHERE id=v_fee;
  IF v_amount<p_minimum THEN RAISE EXCEPTION 'fee_batch_below_threshold'; END IF;
  v_event:=seeker_skr.post(md5('fee-reserve:'||p_id::text)::uuid,'transfer',jsonb_build_array(
    jsonb_build_object('account_id',v_fee,'delta_minor',(-v_amount)::text),
    jsonb_build_object('account_id',v_reserve,'delta_minor',v_amount::text)));
  INSERT INTO seeker_skr.fee_batches(id,asset,destination,minimum_minor,amount_minor,reserve_event)
    VALUES(p_id,p_asset,p_destination,p_minimum,v_amount,v_event) RETURNING * INTO b;
  RETURN b;
END $$;

-- Call only after independent finalized reconciliation and network-reserve checks.
-- Mark paying BEFORE any submission. Unknown outcomes remain paying indefinitely.
CREATE OR REPLACE FUNCTION seeker_skr.fee_batch_begin(p_id uuid)
RETURNS seeker_skr.fee_batches LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE b seeker_skr.fee_batches;
BEGIN
  SELECT * INTO b FROM seeker_skr.fee_batches WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fee_batch_not_found'; END IF;
  IF b.status='paying' THEN RETURN b; END IF;
  IF b.status<>'reserved' THEN RAISE EXCEPTION 'fee_batch_state_conflict'; END IF;
  UPDATE seeker_skr.fee_batches SET status='paying' WHERE id=p_id RETURNING * INTO b;
  RETURN b;
END $$;
CREATE OR REPLACE FUNCTION seeker_skr.fee_batch_cancel(p_id uuid)
RETURNS seeker_skr.fee_batches LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE b seeker_skr.fee_batches; v_event uuid;
BEGIN
  SELECT * INTO b FROM seeker_skr.fee_batches WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fee_batch_not_found'; END IF;
  IF b.status='cancelled' THEN RETURN b; END IF;
  IF b.status<>'reserved' THEN RAISE EXCEPTION 'fee_batch_may_be_paid'; END IF;
  v_event:=seeker_skr.post(md5('fee-cancel:'||p_id::text)::uuid,'transfer',jsonb_build_array(
    jsonb_build_object('account_id',seeker_skr.system_account('fee_reserve',b.asset),'delta_minor',(-b.amount_minor)::text),
    jsonb_build_object('account_id',seeker_skr.system_account('fees',b.asset),'delta_minor',b.amount_minor::text)));
  UPDATE seeker_skr.fee_batches SET status='cancelled',finish_event=v_event WHERE id=p_id RETURNING * INTO b;
  RETURN b;
END $$;
-- Owner-only primitive: a future adapter MUST verify finalized exact asset,
-- amount, treasury payer and destination before passing the chain signature.
CREATE OR REPLACE FUNCTION seeker_skr.fee_batch_finalize(p_id uuid,p_signature text)
RETURNS seeker_skr.fee_batches LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,seeker_skr AS $$
DECLARE b seeker_skr.fee_batches; v_event uuid;
BEGIN
  IF p_signature IS NULL OR p_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' THEN
    RAISE EXCEPTION 'invalid_chain_reference';
  END IF;
  SELECT * INTO b FROM seeker_skr.fee_batches WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fee_batch_not_found'; END IF;
  IF b.status='paid' THEN
    IF b.signature<>p_signature THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
    RETURN b;
  END IF;
  IF b.status<>'paying' THEN RAISE EXCEPTION 'fee_batch_state_conflict'; END IF;
  v_event:=seeker_skr.post(md5('fee-finalize:'||p_id::text)::uuid,'withdraw_finalize',jsonb_build_array(
    jsonb_build_object('account_id',seeker_skr.system_account('fee_reserve',b.asset),'delta_minor',(-b.amount_minor)::text),
    jsonb_build_object('account_id',seeker_skr.system_account('chain',b.asset),'delta_minor',b.amount_minor::text)),p_signature);
  UPDATE seeker_skr.fee_batches SET status='paid',finish_event=v_event,signature=p_signature
    WHERE id=p_id RETURNING * INTO b;
  RETURN b;
END $$;
REVOKE ALL ON seeker_skr.fee_batches FROM PUBLIC,seeker_wallet_runtime;
REVOKE ALL ON FUNCTION seeker_skr.fee_batch_reserve(uuid,text,text,numeric),
  seeker_skr.fee_batch_begin(uuid),seeker_skr.fee_batch_cancel(uuid),
  seeker_skr.fee_batch_finalize(uuid,text) FROM PUBLIC,seeker_wallet_runtime;
COMMIT;
