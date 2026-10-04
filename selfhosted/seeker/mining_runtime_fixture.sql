-- Synthetic runtime-role fixtures. No chain requests or real money.
DO $$
DECLARE
  p uuid:='88000000-0000-4000-8000-000000000001'; other uuid:='88000000-0000-4000-8000-000000000002';
  k uuid:='89000000-0000-4000-8000-000000000001'; r1 uuid:='89100000-0000-4000-8000-000000000001';
  pol jsonb:='{"session_limit":"100","daily_limit":"90","stake_per_round":"10","network_per_round":"2","protocol_per_round":"3","max_rounds":"5","fee_bps":"0"}';
  custody text:=repeat('C',32); st jsonb;
BEGIN
  PERFORM seeker_skr.post('8a000000-0000-4000-8000-000000000001','transfer',jsonb_build_array(
    jsonb_build_object('account_id',seeker_skr.wallet_account(p,'SOL'),'delta_minor','100'),
    jsonb_build_object('account_id',seeker_skr.system_account('chain','SOL'),'delta_minor','-100')));
END $$;
SET ROLE seeker_wallet_runtime;
DO $$
DECLARE
  p uuid:='88000000-0000-4000-8000-000000000001'; other uuid:='88000000-0000-4000-8000-000000000002';
  k uuid:='89000000-0000-4000-8000-000000000001'; r1 uuid:='89100000-0000-4000-8000-000000000001';
  pol jsonb:='{"session_limit":"100","daily_limit":"90","stake_per_round":"10","network_per_round":"2","protocol_per_round":"3","max_rounds":"5","fee_bps":"0"}';
  custody text:=repeat('C',32); st jsonb; w jsonb;
BEGIN
  BEGIN
    PERFORM seeker_skr.mining_session_open(k,seeker_skr.wallet_account(p,'SOL'),30,pol);
    RAISE EXCEPTION 'fixture_runtime_reached_primitive';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  st:=seeker_skr.mine_status(p);
  IF st->>'terms_version' IS NOT NULL OR st->'session'<>'null'::jsonb OR st->>'available_minor'<>'100' THEN
    RAISE EXCEPTION 'fixture_bad_initial_status %',st;
  END IF;
  BEGIN
    PERFORM seeker_skr.mine_start(p,k,30,pol,'v1',custody);
    RAISE EXCEPTION 'fixture_started_without_terms';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_terms_required' THEN RAISE; END IF; END;
  PERFORM seeker_skr.mine_accept_terms(p,'v1');
  BEGIN
    PERFORM seeker_skr.mine_start(p,k,30,pol||'{"square_mask":"33554432"}','v1',custody);
    RAISE EXCEPTION 'fixture_accepted_wide_mask';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'invalid_mining_policy' THEN RAISE; END IF; END;
  PERFORM seeker_skr.mine_start(p,k,30,pol,'v1',custody);
  PERFORM seeker_skr.mine_start(p,k,30,pol,'v1',custody);
  BEGIN
    PERFORM seeker_skr.mine_start(p,k,30,pol,'v1',repeat('D',32));
    RAISE EXCEPTION 'fixture_changed_custody';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
  w:=seeker_skr.mine_runner_work();
  IF jsonb_array_length(w->'sessions')<>1 OR w->'sessions'->0->>'custody_address'<>custody THEN
    RAISE EXCEPTION 'fixture_bad_runner_work %',w;
  END IF;
  PERFORM seeker_skr.mine_round_prepare(k,r1,427255,repeat('E',64));
  -- Re-signing inside the same ORE round is allowed; another ORE round is not.
  PERFORM seeker_skr.mine_round_prepare(k,r1,427255,repeat('F',64));
  BEGIN
    PERFORM seeker_skr.mine_round_prepare(k,r1,427256,repeat('G',64));
    RAISE EXCEPTION 'fixture_moved_pending_round';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
  IF (seeker_skr.mine_runner_work()->'sessions'->0->'pending'->>'submitted_signature')<>repeat('F',64) THEN
    RAISE EXCEPTION 'fixture_lost_submitted_signature';
  END IF;
  PERFORM seeker_skr.mine_round_settle(r1,14,repeat('F',64));
  BEGIN
    PERFORM seeker_skr.mine_stop(other,k);
    RAISE EXCEPTION 'fixture_foreign_stop';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'mining_session_not_found' THEN RAISE; END IF; END;
  PERFORM seeker_skr.mine_credit('89200000-0000-4000-8000-000000000001',k,20,repeat('H',64));
  PERFORM seeker_skr.mine_stop(p,k);
  st:=seeker_skr.mine_session_close(k);
  IF st->>'released_minor'<>'16' OR st->>'credited_minor'<>'20' THEN RAISE EXCEPTION 'fixture_bad_close %',st; END IF;
  IF jsonb_array_length(seeker_skr.mine_player_rounds(p)->'rounds')<>1
    OR jsonb_array_length(seeker_skr.mine_player_rounds(other)->'rounds')<>0 THEN
    RAISE EXCEPTION 'fixture_bad_player_rounds';
  END IF;
  st:=seeker_skr.mine_status(p);
  -- 100 - 30 reserved + 16 released + 20 credited
  IF st->>'available_minor'<>'106' OR st->'session'->>'status'<>'closed' OR st->>'used_today_minor'<>'14' THEN
    RAISE EXCEPTION 'fixture_bad_final_status %',st;
  END IF;
END $$;
RESET ROLE;
