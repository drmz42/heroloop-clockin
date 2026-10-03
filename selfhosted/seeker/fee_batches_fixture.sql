-- Synthetic owner-only fixtures. No chain requests or real money.
DO $$
DECLARE
  b seeker_skr.fee_batches; v_fee uuid; v_chain uuid;
  k uuid:='71000000-0000-4000-8000-000000000001';
  k2 uuid:='71000000-0000-4000-8000-000000000002';
  v_before numeric; v_player_before numeric;
BEGIN
  IF has_function_privilege('seeker_wallet_runtime','seeker_skr.fee_batch_begin(uuid)','EXECUTE')
    OR has_table_privilege('seeker_wallet_runtime','seeker_skr.fee_batches','SELECT') THEN
    RAISE EXCEPTION 'fee_batch_runtime_privilege_leak';
  END IF;
  SELECT sum(balance_minor) INTO v_player_before FROM seeker_skr.accounts WHERE player_id IS NOT NULL;
  v_fee:=seeker_skr.system_account('fees','SKR');v_chain:=seeker_skr.system_account('chain','SKR');
  PERFORM seeker_skr.post('72000000-0000-4000-8000-000000000001','transfer',jsonb_build_array(
    jsonb_build_object('account_id',v_fee,'delta_minor','100'),
    jsonb_build_object('account_id',v_chain,'delta_minor','-100')));
  SELECT balance_minor INTO v_before FROM seeker_skr.accounts WHERE id=v_fee;
  BEGIN
    PERFORM seeker_skr.fee_batch_reserve(k,'SKR',repeat('A',32),v_before+1);
    RAISE EXCEPTION 'fixture_accepted_low_fees';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'fee_batch_below_threshold' THEN RAISE; END IF; END;
  b:=seeker_skr.fee_batch_reserve(k,'SKR',repeat('A',32),1);
  IF b.amount_minor<>v_before THEN RAISE EXCEPTION 'fixture_bad_snapshot'; END IF;
  PERFORM seeker_skr.fee_batch_reserve(k,'SKR',repeat('A',32),1);
  BEGIN
    PERFORM seeker_skr.fee_batch_reserve(k,'SKR',repeat('A',32),2);
    RAISE EXCEPTION 'fixture_accepted_changed_threshold';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.fee_batch_reserve(k,'SOL',repeat('A',32),1);
    RAISE EXCEPTION 'fixture_accepted_changed_replay';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.fee_batch_reserve(k2,'SKR',repeat('A',32),1);
    RAISE EXCEPTION 'fixture_accepted_second_batch';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'fee_batch_pending' THEN RAISE; END IF; END;
  PERFORM seeker_skr.post('72000000-0000-4000-8000-000000000002','transfer',jsonb_build_array(
    jsonb_build_object('account_id',v_fee,'delta_minor','7'),
    jsonb_build_object('account_id',v_chain,'delta_minor','-7')));
  PERFORM seeker_skr.fee_batch_begin(k);PERFORM seeker_skr.fee_batch_begin(k);
  BEGIN
    PERFORM seeker_skr.fee_batch_cancel(k);
    RAISE EXCEPTION 'fixture_released_unknown_payment';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'fee_batch_may_be_paid' THEN RAISE; END IF; END;
  b:=seeker_skr.fee_batch_finalize(k,repeat('B',64));
  PERFORM seeker_skr.fee_batch_finalize(k,repeat('B',64));
  IF b.amount_minor<>v_before OR (SELECT balance_minor FROM seeker_skr.accounts WHERE id=v_fee)<>7 THEN
    RAISE EXCEPTION 'fixture_new_fees_in_old_snapshot';
  END IF;
  PERFORM seeker_skr.fee_batch_reserve(k2,'SKR',repeat('A',32),1);
  PERFORM seeker_skr.fee_batch_begin(k2);
  BEGIN
    PERFORM seeker_skr.fee_batch_finalize(k2,repeat('B',64));
    RAISE EXCEPTION 'fixture_accepted_duplicate_signature';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  IF (SELECT status FROM seeker_skr.fee_batches WHERE id=k2)<>'paying' THEN
    RAISE EXCEPTION 'fixture_failed_payout_lost_reserve';
  END IF;
  PERFORM seeker_skr.fee_batch_finalize(k2,repeat('C',64));
  -- Cancellation before submission returns precisely the reserved fees.
  v_fee:=seeker_skr.system_account('fees','SOL');v_chain:=seeker_skr.system_account('chain','SOL');
  PERFORM seeker_skr.post('72000000-0000-4000-8000-000000000003','transfer',jsonb_build_array(
    jsonb_build_object('account_id',v_fee,'delta_minor','17'),
    jsonb_build_object('account_id',v_chain,'delta_minor','-17')));
  SELECT balance_minor INTO v_before FROM seeker_skr.accounts WHERE id=v_fee;
  PERFORM seeker_skr.fee_batch_reserve('71000000-0000-4000-8000-000000000003','SOL',repeat('A',32),1);
  PERFORM seeker_skr.fee_batch_cancel('71000000-0000-4000-8000-000000000003');
  PERFORM seeker_skr.fee_batch_cancel('71000000-0000-4000-8000-000000000003');
  IF (SELECT balance_minor FROM seeker_skr.accounts WHERE id=v_fee)<>v_before
    OR (SELECT sum(balance_minor) FROM seeker_skr.accounts WHERE player_id IS NOT NULL)<>v_player_before
    OR EXISTS (SELECT asset FROM seeker_skr.accounts GROUP BY asset HAVING sum(balance_minor)<>0) THEN
    RAISE EXCEPTION 'fixture_fee_batch_conservation';
  END IF;
END $$;
