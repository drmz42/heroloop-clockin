-- One-time Founder-authorized isolated SKR test reset, 2026-10-04.
-- Never a migration/startup script. The operator must first verify a fresh
-- restored ledger snapshot, an empty payout outbox and finalized chain history
-- excluding payments for every old paying request. No chain transfer is made.
-- Preserve immutable events/entries and all SOL/game/Auth data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
LOCK TABLE seeker_skr.accounts, seeker_skr.events, seeker_skr.entries,
  seeker_skr.withdrawals, seeker_skr.purchases, seeker_skr.deposit_intents IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE a record; v_player uuid; v_chain uuid; v_report jsonb;
  v_expected numeric; v_available numeric;
BEGIN
  IF current_database() <> 'seeker_skr' OR to_regclass('public.players') IS NOT NULL
    OR current_setting('heroloop.seeker_test_reset_verified',true) IS DISTINCT FROM '20261004'
    THEN RAISE EXCEPTION 'test_reset_operator_proof_required'; END IF;
  v_player:=current_setting('heroloop.seeker_test_reset_player')::uuid;
  v_expected:=current_setting('heroloop.seeker_test_reset_accounted')::numeric;
  v_available:=current_setting('heroloop.seeker_test_reset_balance')::numeric;
  IF v_expected<=10000000 OR v_available<=0
    OR (SELECT count(*) FROM seeker_skr.accounts WHERE asset='SKR' AND kind='player' AND player_id=v_player AND balance_minor=v_available)<>1
    OR (SELECT count(*) FROM seeker_skr.accounts WHERE asset='SKR' AND kind='player' AND balance_minor>0)<>2
    OR (SELECT sum(balance_minor) FROM seeker_skr.accounts WHERE asset='SKR' AND kind<>'chain')<>v_expected
    OR (SELECT sum(balance_minor) FROM seeker_skr.accounts WHERE asset='SKR' AND kind='chain')<>-v_expected
    THEN RAISE EXCEPTION 'test_reset_snapshot_changed'; END IF;
  IF EXISTS(SELECT 1 FROM seeker_skr.withdrawals WHERE asset='SKR' AND (status='paid' OR payout_signature IS NOT NULL))
    OR EXISTS(SELECT 1 FROM seeker_skr.purchases WHERE status='charged')
    OR EXISTS(SELECT 1 FROM seeker_skr.accounts WHERE asset='SKR' AND kind IN ('fee_reserve','mining_reserve','commerce_escrow') AND balance_minor<>0)
    THEN RAISE EXCEPTION 'test_reset_unresolved_operation'; END IF;
  v_report:=seeker_skr.liabilities();
  IF (v_report->'SKR'->>'cache_consistent')::boolean IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'test_reset_inconsistent_ledger'; END IF;
  v_chain:=seeker_skr.system_account('chain','SKR');
  FOR a IN SELECT id,balance_minor FROM seeker_skr.accounts
    WHERE asset='SKR' AND kind<>'chain' AND balance_minor>0 ORDER BY id LOOP
    PERFORM seeker_skr.post(md5('founder-test-reset-20261004:'||a.id::text)::uuid,'transfer',jsonb_build_array(
      jsonb_build_object('account_id',a.id,'delta_minor',(-a.balance_minor)::text),
      jsonb_build_object('account_id',v_chain,'delta_minor',a.balance_minor::text)));
  END LOOP;
  UPDATE seeker_skr.withdrawals SET status='rejected',
    reject_reason='Founder test reset; finalized history and empty outbox verified no payout.'
    WHERE asset='SKR' AND status IN ('authorization','pending','approval_required','paying');
  UPDATE seeker_skr.purchases SET expires_at=least(expires_at,clock_timestamp()) WHERE status='quoted';
  UPDATE seeker_skr.deposit_intents SET expires_at=least(expires_at,clock_timestamp())
    WHERE asset='SKR' AND settled_event IS NULL;
  -- The Founder supplied 10 real SKR to the payout treasury. Allocate that
  -- verified project funding to their identified test account, not a fake deposit.
  PERFORM seeker_skr.post(md5('founder-test-funding-20261004')::uuid,'transfer',jsonb_build_array(
    jsonb_build_object('account_id',v_chain,'delta_minor','-10000000'),
    jsonb_build_object('account_id',seeker_skr.wallet_account(v_player,'SKR'),'delta_minor','10000000')));
  v_report:=seeker_skr.liabilities();
  IF (v_report->'SKR'->>'accounted_minor')::numeric<>10000000
    OR (v_report->'SKR'->>'liabilities_minor')::numeric<>10000000
    OR (v_report->'SKR'->>'cache_consistent')::boolean IS DISTINCT FROM true
    OR EXISTS(SELECT 1 FROM seeker_skr.accounts WHERE asset='SKR' AND kind='withdrawal_reserve' AND balance_minor<>0)
    THEN RAISE EXCEPTION 'test_reset_postcondition_failed'; END IF;
END $$;
COMMIT;
