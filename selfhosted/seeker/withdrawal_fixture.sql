\set ON_ERROR_STOP 1
DO $$
DECLARE p uuid:='70000000-0000-4000-8000-000000000001'; p2 uuid:='70000000-0000-4000-8000-000000000002';
 w jsonb; w2 jsonb; d jsonb; failed boolean; sig text:=repeat('7',64);
BEGIN
 SET LOCAL ROLE seeker_wallet_runtime;
 d:=seeker_skr.deposit_intent_create(p,'SKR',10000000000,repeat('1',32),'Ref5555555555555555555555555555555555555555','devnet',600);
 PERFORM seeker_skr.deposit_settle(p,(d->>'intent_id')::uuid,repeat('8',64));
 w:=seeker_skr.withdrawal_intent(p,'SKR',1000000,1500,repeat('1',32));
 w:=seeker_skr.withdrawal_reserve(p,(w->>'request_id')::uuid);
 IF w->>'status'<>'pending' THEN RAISE EXCEPTION 'ordinary request not pending'; END IF;
 PERFORM seeker_skr.withdrawal_reserve(p,(w->>'request_id')::uuid);
 IF seeker_skr.wallet_snapshot(p)#>>'{balances,SKR}'<>'9999000000' THEN RAISE EXCEPTION 'double reserve'; END IF;
 w2:=seeker_skr.withdrawal_intent(p,'SKR',1000000,600,repeat('1',32));
 w2:=seeker_skr.withdrawal_reserve(p,(w2->>'request_id')::uuid);
 IF w2->>'status'<>'approval_required' THEN RAISE EXCEPTION 'daily limit bypass'; END IF;
 BEGIN PERFORM seeker_skr.withdrawal_reserve(p2,(w2->>'request_id')::uuid);failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='withdrawal_not_found'; END;
 IF NOT failed THEN RAISE EXCEPTION 'foreign request reserved'; END IF;
 PERFORM seeker_skr.withdrawal_review((w2->>'request_id')::uuid,'founder','reject','Not approved');
 PERFORM seeker_skr.withdrawal_review((w2->>'request_id')::uuid,'founder','reject','Not approved');
 IF seeker_skr.wallet_snapshot(p)#>>'{balances,SKR}'<>'9999000000' THEN RAISE EXCEPTION 'double release'; END IF;
 PERFORM seeker_skr.withdrawal_review((w->>'request_id')::uuid,'founder','begin_payout','');
 BEGIN PERFORM seeker_skr.withdrawal_review((w->>'request_id')::uuid,'founder','reject','Timeout');failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='withdrawal_may_be_paid'; END;
 IF NOT failed THEN RAISE EXCEPTION 'possibly paid request released'; END IF;
 PERFORM seeker_skr.withdrawal_finalize((w->>'request_id')::uuid,sig);
 PERFORM seeker_skr.withdrawal_finalize((w->>'request_id')::uuid,sig);
 IF w->>'fee_minor'<>'50000' OR w->>'payout_minor'<>'950000' THEN RAISE EXCEPTION 'withdrawal fee not 5%%: %',w; END IF;
 RESET ROLE;
 IF NOT EXISTS(SELECT 1 FROM seeker_skr.entries e JOIN seeker_skr.accounts a ON a.id=e.account_id JOIN seeker_skr.withdrawals x ON x.payout_event=e.event_id WHERE x.id=(w->>'request_id')::uuid
  AND a.kind='fees' AND e.delta_minor=50000) THEN RAISE EXCEPTION 'withdrawal fee not credited'; END IF;
 SET LOCAL ROLE seeker_wallet_runtime;
 BEGIN PERFORM seeker_skr.withdrawal_intent(p,'SKR',1,1,repeat('1',32));failed:=false;
 EXCEPTION WHEN raise_exception THEN failed:=SQLERRM='withdrawal_amount_too_small'; END;
 IF NOT failed THEN RAISE EXCEPTION 'zero payout accepted'; END IF;
 w2:=seeker_skr.withdrawal_intent(p,'SKR',1000000,100,repeat('1',32));
 PERFORM seeker_skr.withdrawal_reserve(p,(w2->>'request_id')::uuid);
 PERFORM seeker_skr.withdrawal_review((w2->>'request_id')::uuid,'founder','begin_payout','');
 BEGIN PERFORM seeker_skr.withdrawal_finalize((w2->>'request_id')::uuid,sig);failed:=false;
 EXCEPTION WHEN unique_violation THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'duplicate payout paid two requests'; END IF;
END $$;
DO $$ BEGIN IF EXISTS(SELECT asset FROM seeker_skr.accounts GROUP BY asset HAVING sum(balance_minor)<>0)
 THEN RAISE EXCEPTION 'withdrawal asset conservation'; END IF; END $$;
