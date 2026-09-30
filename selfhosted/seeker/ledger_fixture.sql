\set ON_ERROR_STOP on
-- Disposable database only. Names are fixtures, never mainnet addresses.
INSERT INTO seeker_skr.accounts(id,kind,player_id) VALUES
('00000000-0000-4000-8000-000000000001','chain',NULL),
('00000000-0000-4000-8000-000000000002','player','10000000-0000-4000-8000-000000000001'),
('00000000-0000-4000-8000-000000000003','player','10000000-0000-4000-8000-000000000002'),
('00000000-0000-4000-8000-000000000004','fees',NULL),
('00000000-0000-4000-8000-000000000005','withdrawal_reserve','10000000-0000-4000-8000-000000000001');
CREATE FUNCTION pg_temp.legs(a integer,b integer,amount text) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_array(
 jsonb_build_object('account_id','00000000-0000-4000-8000-'||lpad(a::text,12,'0'),'delta_minor','-'||amount),
 jsonb_build_object('account_id','00000000-0000-4000-8000-'||lpad(b::text,12,'0'),'delta_minor',amount));
$$;
CREATE FUNCTION pg_temp.expect_error(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
   IF position(expected IN SQLERRM)>0 THEN RETURN; END IF; RAISE;
 END;
 RAISE EXCEPTION 'expected error: %',expected;
END $$;
DO $$ DECLARE first uuid; second uuid; BEGIN
 first := seeker_skr.post('20000000-0000-4000-8000-000000000001','deposit',pg_temp.legs(1,2,'1000000'),repeat('1',88));
 second := seeker_skr.post('20000000-0000-4000-8000-000000000001','deposit',pg_temp.legs(1,2,'1000000'),repeat('1',88));
 IF first<>second THEN RAISE EXCEPTION 'replay changed event'; END IF;
 -- Reordered legs are the same canonical request.
 second := seeker_skr.post('20000000-0000-4000-8000-000000000001','deposit',
   jsonb_build_array(pg_temp.legs(1,2,'1000000')->1,pg_temp.legs(1,2,'1000000')->0),repeat('1',88));
 IF first<>second THEN RAISE EXCEPTION 'reordered replay changed event'; END IF;
END $$;
SELECT pg_temp.expect_error($q$SELECT seeker_skr.post('20000000-0000-4000-8000-000000000001','deposit',pg_temp.legs(1,2,'2000000'),repeat('1',88))$q$,'skr_idempotency_conflict');
SELECT pg_temp.expect_error($q$SELECT seeker_skr.post('20000000-0000-4000-8000-000000000002','deposit',pg_temp.legs(1,2,'1000000'),repeat('1',88))$q$,'duplicate key');
SELECT pg_temp.expect_error($q$SELECT seeker_skr.post('20000000-0000-4000-8000-000000000003','transfer',pg_temp.legs(2,3,'1000001'))$q$,'skr_insufficient');
SELECT pg_temp.expect_error($q$SELECT seeker_skr.post('20000000-0000-4000-8000-000000000003','transfer',pg_temp.legs(2,9,'1'))$q$,'skr_account_missing');
SELECT pg_temp.expect_error($q$SELECT seeker_skr.post('20000000-0000-4000-8000-000000000003','deposit',pg_temp.legs(1,2,'1'))$q$,'invalid_chain_reference');
SELECT pg_temp.expect_error($q$SELECT seeker_skr.post('20000000-0000-4000-8000-000000000003','transfer','[{"account_id":"00000000-0000-4000-8000-000000000002","delta_minor":"-1"},{"account_id":"00000000-0000-4000-8000-000000000003","delta_minor":"2"}]')$q$,'unbalanced_skr_event');
SELECT pg_temp.expect_error($q$SELECT seeker_skr.post('20000000-0000-4000-8000-000000000003','transfer','[{"account_id":"00000000-0000-4000-8000-000000000002","delta_minor":-1},{"account_id":"00000000-0000-4000-8000-000000000003","delta_minor":1}]')$q$,'invalid_skr_legs');
-- Marketplace-like transfer: seller 0.19, project fee 0.01. Fixture values are NOT approved fees.
SELECT seeker_skr.post('20000000-0000-4000-8000-000000000004','transfer',
'[{"account_id":"00000000-0000-4000-8000-000000000002","delta_minor":"-200000"},{"account_id":"00000000-0000-4000-8000-000000000003","delta_minor":"190000"},{"account_id":"00000000-0000-4000-8000-000000000004","delta_minor":"10000"}]');
-- A failed/unsigned withdrawal can release its reservation without changing custody.
SELECT seeker_skr.post('20000000-0000-4000-8000-000000000005','withdraw_reserve',pg_temp.legs(2,5,'300000'));
SELECT seeker_skr.post('20000000-0000-4000-8000-000000000006','withdraw_release',pg_temp.legs(5,2,'300000'));
-- Finalized withdrawal reduces reserved liability and the clearing offset together.
SELECT seeker_skr.post('20000000-0000-4000-8000-000000000007','withdraw_reserve',pg_temp.legs(2,5,'100000'));
SELECT seeker_skr.post('20000000-0000-4000-8000-000000000008','withdraw_finalize',pg_temp.legs(5,1,'100000'),repeat('2',88));
SELECT pg_temp.expect_error('UPDATE seeker_skr.events SET kind=''transfer''','skr_ledger_immutable');
SELECT pg_temp.expect_error('DELETE FROM seeker_skr.entries','skr_ledger_immutable');
DO $$ BEGIN
 IF (SELECT balance_minor FROM seeker_skr.accounts WHERE id='00000000-0000-4000-8000-000000000002')<>700000
   OR (SELECT count(*) FROM seeker_skr.events)<>6
   OR (SELECT sum(balance_minor) FROM seeker_skr.accounts)<>0 THEN RAISE EXCEPTION 'wrong fixture totals'; END IF;
 IF EXISTS (SELECT 1 FROM seeker_skr.accounts a WHERE balance_minor <>
   COALESCE((SELECT sum(delta_minor) FROM seeker_skr.entries e WHERE e.account_id=a.id),0)) THEN RAISE EXCEPTION 'reconciliation failed'; END IF;
 IF has_function_privilege('public','seeker_skr.post(uuid,text,jsonb,text)','EXECUTE') THEN RAISE EXCEPTION 'public can post'; END IF;
END $$;
