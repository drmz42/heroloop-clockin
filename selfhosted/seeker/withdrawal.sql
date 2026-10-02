BEGIN;
DO $$ BEGIN IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.purchases') IS NULL
 THEN RAISE EXCEPTION 'withdrawal_requires_private_commerce'; END IF; END $$;
CREATE TABLE IF NOT EXISTS seeker_skr.withdrawals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),player_id uuid NOT NULL,asset text NOT NULL CHECK(asset IN ('SKR','SOL')),
 amount_minor numeric(30,0) NOT NULL CHECK(amount_minor BETWEEN 1 AND 18446744073709551615),
 usd_cents integer NOT NULL CHECK(usd_cents>0),destination text NOT NULL CHECK(destination~'^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 status text NOT NULL DEFAULT 'authorization' CHECK(status IN ('authorization','pending','approval_required','paying','paid','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 reserved_at timestamptz,approved_by text,payout_signature text UNIQUE,payout_event uuid REFERENCES seeker_skr.events(id),
 reject_reason text,
 CHECK((payout_signature IS NULL)=(payout_event IS NULL))
);
CREATE INDEX IF NOT EXISTS withdrawals_player ON seeker_skr.withdrawals(player_id,created_at DESC);
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_json(w seeker_skr.withdrawals) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,seeker_skr AS $$
 SELECT jsonb_build_object('request_id',w.id,'player_id',w.player_id,'asset',w.asset,'amount_minor',w.amount_minor::text,
  'usd_cents',w.usd_cents,'destination',w.destination,'status',w.status,'created_at',w.created_at,'expires_at',w.expires_at,
  'signature',w.payout_signature,'reject_reason',w.reject_reason)
$$;
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_intent(p_player uuid,p_asset text,p_amount numeric,p_cents integer,p_destination text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE w seeker_skr.withdrawals;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('withdraw:'||p_player::text,0));
 IF (SELECT count(*) FROM seeker_skr.withdrawals WHERE player_id=p_player AND status='authorization' AND expires_at>clock_timestamp())>=3
  THEN RAISE EXCEPTION 'withdrawal_intent_limit'; END IF;
 INSERT INTO seeker_skr.withdrawals(player_id,asset,amount_minor,usd_cents,destination)
 VALUES(p_player,p_asset,p_amount,p_cents,p_destination) RETURNING * INTO w;
 RETURN seeker_skr.withdrawal_json(w);
END $$;
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_get(p_player uuid,p_key uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
 SELECT seeker_skr.withdrawal_json(w) FROM seeker_skr.withdrawals w WHERE id=p_key AND player_id=p_player
$$;
CREATE OR REPLACE FUNCTION seeker_skr.reserve_account(p_player uuid,p_asset text) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,seeker_skr AS $$
DECLARE v_id uuid;
BEGIN
 INSERT INTO seeker_skr.accounts(id,kind,player_id,asset) VALUES(gen_random_uuid(),'withdrawal_reserve',p_player,p_asset)
 ON CONFLICT(player_id,kind,asset) WHERE player_id IS NOT NULL DO NOTHING;
 SELECT id INTO v_id FROM seeker_skr.accounts WHERE player_id=p_player AND kind='withdrawal_reserve' AND asset=p_asset;
 RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_reserve(p_player uuid,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE w seeker_skr.withdrawals; v_total integer; v_player uuid; v_reserve uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('withdraw:'||p_player::text,0));
 SELECT * INTO w FROM seeker_skr.withdrawals WHERE id=p_key AND player_id=p_player FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal_not_found'; END IF;
 IF w.status<>'authorization' THEN RETURN seeker_skr.withdrawal_json(w); END IF;
 IF w.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'withdrawal_authorization_expired'; END IF;
 SELECT COALESCE(sum(usd_cents),0) INTO v_total FROM seeker_skr.withdrawals WHERE player_id=p_player
  AND reserved_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  AND status IN ('pending','paying','paid');
 v_player:=seeker_skr.wallet_account(p_player,w.asset);v_reserve:=seeker_skr.reserve_account(p_player,w.asset);
 PERFORM seeker_skr.post(p_key,'withdraw_reserve',jsonb_build_array(
  jsonb_build_object('account_id',v_player,'delta_minor',(-w.amount_minor)::text),
  jsonb_build_object('account_id',v_reserve,'delta_minor',w.amount_minor::text)));
 UPDATE seeker_skr.withdrawals SET status=CASE WHEN v_total+w.usd_cents>2000 THEN 'approval_required' ELSE 'pending' END,
  reserved_at=clock_timestamp() WHERE id=p_key RETURNING * INTO w;
 RETURN seeker_skr.withdrawal_json(w);
END $$;
-- Claim the request BEFORE opening Phantom. Once paying, rejection is forbidden:
-- a timeout or an unsubmitted signature cannot prove that no payout was sent.
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_review(p_key uuid,p_actor text,p_action text,p_reason text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE w seeker_skr.withdrawals; v_player uuid; v_reserve uuid;
BEGIN
 SELECT * INTO w FROM seeker_skr.withdrawals WHERE id=p_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal_not_found'; END IF;
 IF p_action='begin_payout' THEN
  IF w.status NOT IN ('pending','approval_required','paying') THEN RAISE EXCEPTION 'withdrawal_state_conflict'; END IF;
  UPDATE seeker_skr.withdrawals SET status='paying',approved_by=p_actor WHERE id=p_key RETURNING * INTO w;
 ELSIF p_action='reject' THEN
  IF w.status='rejected' THEN RETURN seeker_skr.withdrawal_json(w); END IF;
  IF w.status NOT IN ('pending','approval_required') THEN RAISE EXCEPTION 'withdrawal_may_be_paid'; END IF;
  IF length(p_reason) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'withdrawal_rejection_reason_required'; END IF;
  v_player:=seeker_skr.wallet_account(w.player_id,w.asset);v_reserve:=seeker_skr.reserve_account(w.player_id,w.asset);
  PERFORM seeker_skr.post(md5('withdraw-release:'||p_key::text)::uuid,'withdraw_release',jsonb_build_array(
   jsonb_build_object('account_id',v_reserve,'delta_minor',(-w.amount_minor)::text),
   jsonb_build_object('account_id',v_player,'delta_minor',w.amount_minor::text)));
  UPDATE seeker_skr.withdrawals SET status='rejected',reject_reason=p_reason WHERE id=p_key RETURNING * INTO w;
 ELSE RAISE EXCEPTION 'invalid_withdrawal_review'; END IF;
 RETURN seeker_skr.withdrawal_json(w);
END $$;
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_finalize(p_key uuid,p_signature text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE w seeker_skr.withdrawals; v_reserve uuid; v_chain uuid; v_event uuid;
BEGIN
 SELECT * INTO w FROM seeker_skr.withdrawals WHERE id=p_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal_not_found'; END IF;
 IF w.status='paid' THEN
  IF w.payout_signature<>p_signature THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
  RETURN seeker_skr.withdrawal_json(w);
 END IF;
 IF w.status<>'paying' THEN RAISE EXCEPTION 'withdrawal_state_conflict'; END IF;
 v_reserve:=seeker_skr.reserve_account(w.player_id,w.asset);v_chain:=seeker_skr.system_account('chain',w.asset);
 v_event:=seeker_skr.post(md5('withdraw-finalize:'||p_key::text)::uuid,'withdraw_finalize',jsonb_build_array(
  jsonb_build_object('account_id',v_reserve,'delta_minor',(-w.amount_minor)::text),
  jsonb_build_object('account_id',v_chain,'delta_minor',w.amount_minor::text)),p_signature);
 UPDATE seeker_skr.withdrawals SET status='paid',payout_signature=p_signature,payout_event=v_event WHERE id=p_key RETURNING * INTO w;
 RETURN seeker_skr.withdrawal_json(w);
END $$;
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_list(p_player uuid,p_founder boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
 SELECT jsonb_build_object('withdrawals',COALESCE(jsonb_agg(seeker_skr.withdrawal_json(w) ORDER BY w.created_at DESC),'[]'::jsonb))
 FROM (SELECT * FROM seeker_skr.withdrawals WHERE (p_founder OR player_id=p_player)
  AND status<>'authorization' ORDER BY created_at DESC LIMIT 100) w
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA seeker_skr FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA seeker_skr FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.withdrawal_intent(uuid,text,numeric,integer,text),seeker_skr.withdrawal_get(uuid,uuid),
 seeker_skr.withdrawal_reserve(uuid,uuid),seeker_skr.withdrawal_review(uuid,text,text,text),
 seeker_skr.withdrawal_finalize(uuid,text),seeker_skr.withdrawal_list(uuid,boolean) TO seeker_wallet_runtime;
COMMIT;
CREATE OR REPLACE FUNCTION seeker_skr.withdrawal_admin_get(p_key uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
 SELECT seeker_skr.withdrawal_json(w) FROM seeker_skr.withdrawals w WHERE id=p_key
$$;
REVOKE ALL ON FUNCTION seeker_skr.withdrawal_admin_get(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.withdrawal_admin_get(uuid) TO seeker_wallet_runtime;
