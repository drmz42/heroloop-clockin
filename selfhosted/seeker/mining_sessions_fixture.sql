-- Synthetic owner-only fixtures. No chain requests, ORE rounds or real money.
DO $$
DECLARE
  s seeker_skr.mining_sessions; r seeker_skr.mining_rounds; v_src uuid; v_chain uuid; v_player_before numeric;
  pol jsonb:='{"session_limit":"100","daily_limit":"90","stake_per_round":"10","network_per_round":"2","protocol_per_round":"3","max_rounds":"5"}';
  k uuid:='81000000-0000-4000-8000-000000000001';
  k2 uuid:='81000000-0000-4000-8000-000000000002';
  r1 uuid:='82000000-0000-4000-8000-000000000001';
  r2 uuid:='82000000-0000-4000-8000-000000000002';
BEGIN
  IF has_function_privilege('seeker_wallet_runtime','seeker_skr.mining_round_begin(uuid,uuid)','EXECUTE')
    OR has_table_privilege('seeker_wallet_runtime','seeker_skr.mining_sessions','SELECT') THEN
    RAISE EXCEPTION 'mining_runtime_privilege_leak';
  END IF;
  SELECT sum(balance_minor) INTO v_player_before FROM seeker_skr.accounts WHERE player_id IS NOT NULL;
  v_src:=seeker_skr.system_account('rewards','SOL');v_chain:=seeker_skr.system_account('chain','SOL');
  PERFORM seeker_skr.post('83000000-0000-4000-8000-000000000001','transfer',jsonb_build_array(
    jsonb_build_object('account_id',v_src,'delta_minor','100'),
    jsonb_build_object('account_id',v_chain,'delta_minor','-100')));
  BEGIN
    PERFORM seeker_skr.mining_session_open(k,v_src,31,pol-'max_rounds');
    RAISE EXCEPTION 'fixture_accepted_partial_policy';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'invalid_mining_policy' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.mining_session_open(k,seeker_skr.system_account('rewards','SKR'),31,pol);
    RAISE EXCEPTION 'fixture_accepted_skr_source';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'invalid_mining_source' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.mining_session_open(k,v_src,14,pol);
    RAISE EXCEPTION 'fixture_accepted_budget_below_round';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_budget_below_round_cost' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.mining_session_open(k,v_src,91,pol);
    RAISE EXCEPTION 'fixture_accepted_daily_excess';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_budget_exceeded' THEN RAISE; END IF; END;
  s:=seeker_skr.mining_session_open(k,v_src,31,pol);
  IF s.round_limit<>2 OR s.round_cost_minor<>15
    OR (SELECT balance_minor FROM seeker_skr.accounts WHERE id=v_src)<>69 THEN
    RAISE EXCEPTION 'fixture_bad_mining_reservation';
  END IF;
  PERFORM seeker_skr.mining_session_open(k,v_src,31,pol);
  BEGIN
    PERFORM seeker_skr.mining_session_open(k,v_src,30,pol);
    RAISE EXCEPTION 'fixture_accepted_changed_replay';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.mining_session_open(k2,v_src,20,pol);
    RAISE EXCEPTION 'fixture_accepted_second_session';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_session_pending' THEN RAISE; END IF; END;
  r:=seeker_skr.mining_round_begin(k,r1);
  IF r.seq<>1 OR r.cap_minor<>15 THEN RAISE EXCEPTION 'fixture_bad_round'; END IF;
  PERFORM seeker_skr.mining_round_begin(k,r1);
  BEGIN
    PERFORM seeker_skr.mining_round_begin(k,r2);
    RAISE EXCEPTION 'fixture_accepted_second_pending_round';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_round_unavailable' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.mining_session_close(k);
    RAISE EXCEPTION 'fixture_closed_active_session';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_session_not_stopped' THEN RAISE; END IF; END;
  -- Stop during an unknown outcome keeps the round's cap reserved.
  PERFORM seeker_skr.mining_session_stop(k);
  BEGIN
    PERFORM seeker_skr.mining_session_close(k);
    RAISE EXCEPTION 'fixture_released_unknown_round';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_round_pending' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.mining_round_settle(r1,16,repeat('M',64));
    RAISE EXCEPTION 'fixture_accepted_cost_above_cap';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'invalid_mining_round_result' THEN RAISE; END IF; END;
  PERFORM seeker_skr.mining_round_settle(r1,12,repeat('M',64));
  PERFORM seeker_skr.mining_round_settle(r1,12,repeat('M',64));
  BEGIN
    PERFORM seeker_skr.mining_round_settle(r1,11,repeat('M',64));
    RAISE EXCEPTION 'fixture_accepted_changed_receipt';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
  BEGIN
    PERFORM seeker_skr.mining_round_begin(k,r2);
    RAISE EXCEPTION 'fixture_mined_after_stop';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_round_unavailable' THEN RAISE; END IF; END;
  s:=seeker_skr.mining_session_close(k);
  PERFORM seeker_skr.mining_session_close(k);
  IF s.released_minor<>19 OR s.spent_minor<>12 OR s.completed<>1
    OR (SELECT balance_minor FROM seeker_skr.accounts WHERE id=v_src)<>88
    OR (SELECT balance_minor FROM seeker_skr.accounts WHERE id=seeker_skr.system_account('mining_reserve','SOL'))<>0 THEN
    RAISE EXCEPTION 'fixture_bad_mining_release';
  END IF;
  -- Released budget returns to the daily allowance; spent SOL does not.
  BEGIN
    PERFORM seeker_skr.mining_session_open(k2,v_src,79,pol);
    RAISE EXCEPTION 'fixture_daily_ignored_spent';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_budget_exceeded' THEN RAISE; END IF; END;
  PERFORM seeker_skr.mining_session_open(k2,v_src,78,pol);
  -- Zero-cost receipts still need a globally unique chain signature.
  PERFORM seeker_skr.mining_round_begin(k2,r2);
  BEGIN
    PERFORM seeker_skr.mining_round_settle(r2,0,repeat('M',64));
    RAISE EXCEPTION 'fixture_accepted_duplicate_signature';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'duplicate_chain_reference' THEN RAISE; END IF; END;
  PERFORM seeker_skr.mining_round_settle(r2,0,repeat('N',64));
  PERFORM seeker_skr.mining_session_stop(k2);
  s:=seeker_skr.mining_session_close(k2);
  IF s.released_minor<>78 OR (SELECT balance_minor FROM seeker_skr.accounts WHERE id=v_src)<>88
    OR (SELECT sum(balance_minor) FROM seeker_skr.accounts WHERE player_id IS NOT NULL)<>v_player_before
    OR EXISTS (SELECT asset FROM seeker_skr.accounts GROUP BY asset HAVING sum(balance_minor)<>0) THEN
    RAISE EXCEPTION 'fixture_mining_conservation';
  END IF;
END $$;
