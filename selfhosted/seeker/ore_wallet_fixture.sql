-- Reuse the closed synthetic session from mining_runtime_fixture.sql.
SET ROLE seeker_wallet_runtime;
DO $$
DECLARE p uuid:='88000000-0000-4000-8000-000000000001';
 s uuid:='89000000-0000-4000-8000-000000000001';
 k uuid:='8b000000-0000-4000-8000-000000000001';
 a jsonb; w jsonb; req uuid; original jsonb;
BEGIN
 -- A crash/concurrent preparer gets the first committed bytes and signature.
 a:=seeker_skr.mine_action_prepare(k,s,NULL,'ore_claim',repeat('J',64),repeat('A',100),123);
 original:=a;
 a:=seeker_skr.mine_action_prepare(k,s,NULL,'ore_claim',repeat('K',64),repeat('B',100),124);
 IF a->>'wire'<>original->>'wire' OR a->>'signature'<>original->>'signature' THEN
  RAISE EXCEPTION 'fixture_replaced_signed_action'; END IF;
 BEGIN
  PERFORM seeker_skr.mine_action_prepare(k,s,NULL,'checkpoint',repeat('K',64),repeat('B',100),124);
  RAISE EXCEPTION 'fixture_changed_action_kind';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
 PERFORM seeker_skr.mine_action_finish(k,'confirmed',100000000001,-2044280);
 PERFORM seeker_skr.mine_action_finish(k,'confirmed',100000000001,-2044280);
 BEGIN
  PERFORM seeker_skr.mine_action_finish(k,'confirmed',100000000002,-2044280);
  RAISE EXCEPTION 'fixture_changed_ore_receipt';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
 IF seeker_skr.wallet_snapshot(p)->'balances'->>'ORE'<>'100000000001'
  OR seeker_skr.mine_status(p)->'session'->>'credited_ore_minor'<>'100000000001' THEN
  RAISE EXCEPTION 'fixture_lost_ore_credit'; END IF;
 IF NOT (seeker_skr.mine_custody_owners()->'owners' @> to_jsonb(ARRAY[repeat('C',32)])) THEN
  RAISE EXCEPTION 'fixture_dropped_closed_custody'; END IF;
 w:=seeker_skr.withdrawal_intent(p,'ORE',100000000000,100,repeat('M',32)); req:=(w->>'request_id')::uuid;
 BEGIN
  PERFORM seeker_skr.mine_action_prepare('8b000000-0000-4000-8000-000000000002',NULL,req,'ore_payout',repeat('L',64),repeat('A',100),124);
  RAISE EXCEPTION 'fixture_signed_unapproved_payout';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'withdrawal_state_conflict' THEN RAISE; END IF; END;
 PERFORM seeker_skr.withdrawal_reserve(p,req);
 PERFORM seeker_skr.withdrawal_review(req,repeat('N',32),'begin_payout','');
 PERFORM seeker_skr.mine_action_prepare('8b000000-0000-4000-8000-000000000002',NULL,req,'ore_payout',repeat('L',64),repeat('A',100),124);
 w:=seeker_skr.mine_ore_payout_finalize(req,repeat('L',64),-10000);
 PERFORM seeker_skr.mine_ore_payout_finalize(req,repeat('L',64),-10000);
 IF seeker_skr.mine_action_get('8b000000-0000-4000-8000-000000000002')->>'status'<>'confirmed' THEN
  RAISE EXCEPTION 'fixture_lost_payout_confirmation'; END IF;
 IF w->>'payout_minor'<>'95000000000' OR w->>'fee_minor'<>'5000000000'
  OR seeker_skr.wallet_snapshot(p)->'balances'->>'ORE'<>'1' THEN
  RAISE EXCEPTION 'fixture_bad_ore_payout'; END IF;
 BEGIN
  PERFORM seeker_skr.withdrawal_reserve(p,(seeker_skr.withdrawal_intent(p,'ORE',100,100,repeat('M',32))->>'request_id')::uuid);
  RAISE EXCEPTION 'fixture_ore_overdraft';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_insufficient_balance_or_overflow' THEN RAISE; END IF; END;
 BEGIN
  UPDATE seeker_skr.ore_credits SET amount_minor=2;
  RAISE EXCEPTION 'fixture_runtime_edited_credits';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
DO $$
DECLARE p uuid:='88000000-0000-4000-8000-000000000001';
 s uuid:='89000000-0000-4000-8000-000000000002';
 r uuid:='89100000-0000-4000-8000-000000000002';
 policy jsonb:='{"session_limit":"100","daily_limit":"90","stake_per_round":"10","network_per_round":"2","protocol_per_round":"3","max_rounds":"5","fee_bps":"0"}'; a jsonb; b jsonb;
BEGIN
 PERFORM seeker_skr.mine_start(p,s,30,policy,'v1',repeat('C',32));
 a:=seeker_skr.mine_round_prepare(s,r,427256,repeat('q',64),repeat('A',100),1000);
 b:=seeker_skr.mine_round_prepare(s,r,427256,repeat('r',64),repeat('B',100),2000);
 IF b->>'submitted_signature'<>a->>'submitted_signature' OR b->>'submitted_wire'<>a->>'submitted_wire'
  OR b->>'last_valid_height'<>'1000' THEN RAISE EXCEPTION 'fixture_replaced_deploy'; END IF;
 BEGIN
  PERFORM seeker_skr.mine_round_prepare(s,r,427256,repeat('r',64));
  RAISE EXCEPTION 'fixture_runtime_used_legacy_resign';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM seeker_skr.mine_round_settle(r,14,repeat('q',64));
 PERFORM seeker_skr.mine_stop(p,s);
 PERFORM seeker_skr.mine_session_close(s);
END $$;
DO $$
DECLARE p uuid:='88000000-0000-4000-8000-000000000001'; w jsonb; req uuid;
 k uuid:='8b000000-0000-4000-8000-000000000003';
BEGIN
 w:=seeker_skr.withdrawal_intent(p,'SOL',10,100,repeat('M',32));req:=(w->>'request_id')::uuid;
 PERFORM seeker_skr.withdrawal_reserve(p,req);
 PERFORM seeker_skr.withdrawal_review(req,repeat('N',32),'begin_payout','');
 PERFORM seeker_skr.mine_action_prepare(k,NULL,req,'sol_payout',('Z'||repeat('W',63)),repeat('A',100),1000);
 IF seeker_skr.mine_runner_work()->>'sol_payout_pending_minor'<>'5009' THEN RAISE EXCEPTION 'fixture_lost_signed_sol_reserve'; END IF;
 BEGIN
  PERFORM seeker_skr.mine_custody_payout_finalize(req,repeat('Q',64),-5000);
  RAISE EXCEPTION 'fixture_changed_sol_signature';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'withdrawal_state_conflict' THEN RAISE; END IF; END;
 PERFORM seeker_skr.mine_custody_payout_finalize(req,('Z'||repeat('W',63)),-5000);
 PERFORM seeker_skr.mine_custody_payout_finalize(req,('Z'||repeat('W',63)),-5000);
 IF seeker_skr.mine_action_get(k)->>'status'<>'confirmed' OR seeker_skr.mine_runner_work()->>'sol_payout_pending_minor'<>'0' THEN
  RAISE EXCEPTION 'fixture_sol_payout_not_atomic'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM seeker_skr.ore_credits)<>1 THEN RAISE EXCEPTION 'fixture_duplicate_ore_credit'; END IF;
 IF EXISTS(SELECT asset FROM seeker_skr.accounts GROUP BY asset HAVING sum(balance_minor)<>0)
  OR EXISTS(SELECT event_id FROM seeker_skr.entries GROUP BY event_id HAVING sum(delta_minor)<>0) THEN
  RAISE EXCEPTION 'fixture_ore_conservation'; END IF;
END $$;

-- Auto-return checkpoints credit SOL atomically; exact replay repairs old receipts.
SET ROLE seeker_wallet_runtime;
DO $$
DECLARE p uuid:='88000000-0000-4000-8000-000000000001';
 s uuid:='89000000-0000-4000-8000-000000000001';
 k uuid:='8b000000-0000-4000-8000-000000000010'; before numeric;
BEGIN
 before:=(seeker_skr.wallet_snapshot(p)->'balances'->>'SOL')::numeric;
 PERFORM seeker_skr.mine_action_prepare(k,s,NULL,'checkpoint',('V'||repeat('Y',63)),repeat('A',100),123);
 PERFORM seeker_skr.mine_action_finish(k,'confirmed',NULL,17);
 PERFORM seeker_skr.mine_action_finish(k,'confirmed',NULL,17);
 IF (seeker_skr.wallet_snapshot(p)->'balances'->>'SOL')::numeric<>before+17 THEN
  RAISE EXCEPTION 'fixture_checkpoint_return_lost_or_doubled'; END IF;
 BEGIN
  PERFORM seeker_skr.mine_action_finish(k,'confirmed',NULL,18);
  RAISE EXCEPTION 'fixture_checkpoint_receipt_changed';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'skr_idempotency_conflict' THEN RAISE; END IF; END;
 PERFORM seeker_skr.mine_action_prepare('8b000000-0000-4000-8000-000000000011',
  '89000000-0000-4000-8000-000000000002',NULL,'checkpoint',('X'||repeat('Y',63)),repeat('A',100),123);
END $$;
RESET ROLE;
-- Simulate a pre-fix confirmation after a crash, with a verified stored SOL delta.
UPDATE seeker_skr.mine_actions SET status='confirmed',sol_delta=19
 WHERE id='8b000000-0000-4000-8000-000000000011';
SET ROLE seeker_wallet_runtime;
DO $$
DECLARE p uuid:='88000000-0000-4000-8000-000000000001'; before numeric;
BEGIN
 before:=(seeker_skr.wallet_snapshot(p)->'balances'->>'SOL')::numeric;
 PERFORM seeker_skr.mine_action_finish('8b000000-0000-4000-8000-000000000011','confirmed',NULL,19);
 PERFORM seeker_skr.mine_action_finish('8b000000-0000-4000-8000-000000000011','confirmed',NULL,19);
 IF (seeker_skr.wallet_snapshot(p)->'balances'->>'SOL')::numeric<>before+19 THEN
  RAISE EXCEPTION 'fixture_checkpoint_backfill_lost_or_doubled'; END IF;
END $$;
RESET ROLE;

-- Player history must preserve settled sessions, exact net receipts and isolation.
SET ROLE seeker_wallet_runtime;
DO $$
DECLARE p uuid:='88000000-0000-4000-8000-000000000001'; h jsonb; x jsonb; found boolean:=false;
BEGIN
 h:=seeker_skr.mine_status(p)->'history';
 IF jsonb_typeof(h)<>'array' OR jsonb_array_length(h)<2 OR jsonb_array_length(h)>10 THEN
   RAISE EXCEPTION 'fixture_history_missing_sessions'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(h) LOOP
   IF (x->>'net_sol_minor')::numeric<>(x->>'credited_minor')::numeric-(x->>'spent_minor')::numeric THEN
     RAISE EXCEPTION 'fixture_wrong_sol_result'; END IF;
   IF x->>'id'='89000000-0000-4000-8000-000000000001' THEN
     found:=true;
     IF x->>'status'<>'closed' OR x->>'credited_ore_minor'<>'100000000001' THEN
       RAISE EXCEPTION 'fixture_history_lost_net_ore'; END IF;
   END IF;
 END LOOP;
 IF NOT found THEN RAISE EXCEPTION 'fixture_history_lost_closed_session'; END IF;
 IF seeker_skr.mine_status('88000000-0000-4000-8000-000000000099')->'history'<>'[]'::jsonb THEN
   RAISE EXCEPTION 'fixture_history_cross_player_leak'; END IF;
END $$;
RESET ROLE;

-- Exercise the actual 60-round and 10-session boundaries without retained test rows.
BEGIN;
SELECT seeker_skr.post(md5('history-boundary-fund')::uuid,'transfer',jsonb_build_array(
 jsonb_build_object('account_id',seeker_skr.wallet_account('88000000-0000-4000-8000-000000000098','SOL'),'delta_minor','100'),
 jsonb_build_object('account_id',seeker_skr.system_account('chain','SOL'),'delta_minor','-100')));
SET LOCAL ROLE seeker_wallet_runtime;
DO $$
DECLARE p uuid:='88000000-0000-4000-8000-000000000098'; s uuid; r uuid; sig text; h jsonb;
 policy jsonb:='{"session_limit":"100","daily_limit":"100","stake_per_round":"1","network_per_round":"0","protocol_per_round":"0","max_rounds":"60","fee_bps":"0"}';
 alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
BEGIN
 PERFORM seeker_skr.mine_accept_terms(p,'v1');
 s:=md5('history-sixty-rounds')::uuid;
 PERFORM seeker_skr.mine_start(p,s,60,policy,'v1',repeat('H',32));
 FOR i IN 1..60 LOOP
   r:=md5('history-round:'||i)::uuid;
   sig:=repeat('S',62)||substr(alphabet,i/58+1,1)||substr(alphabet,i%58+1,1);
   PERFORM seeker_skr.mine_round_prepare(s,r,500000+i,sig,repeat('A',100),1000);
   PERFORM seeker_skr.mine_round_settle(r,0,sig);
 END LOOP;
 PERFORM seeker_skr.mine_stop(p,s);
 PERFORM seeker_skr.mine_session_close(s);
 h:=seeker_skr.mine_status(p)->'history';
 IF jsonb_array_length(h->0->'rounds')<>60 OR h->0->'rounds'->0->>'seq'<>'60'
   OR h->0->'rounds'->59->>'seq'<>'1' THEN RAISE EXCEPTION 'fixture_history_truncated_rounds'; END IF;
 FOR i IN 1..11 LOOP
   s:=md5('history-session:'||i)::uuid;
   PERFORM seeker_skr.mine_start(p,s,1,policy,'v1',repeat('H',32));
   PERFORM seeker_skr.mine_stop(p,s);
   PERFORM seeker_skr.mine_session_close(s);
 END LOOP;
 h:=seeker_skr.mine_status(p)->'history';
 IF jsonb_array_length(h)<>10 OR h->0->>'id'<>md5('history-session:11')::uuid::text
   OR h->9->>'id'<>md5('history-session:2')::uuid::text THEN
   RAISE EXCEPTION 'fixture_history_bound_or_order'; END IF;
END $$;
ROLLBACK;
