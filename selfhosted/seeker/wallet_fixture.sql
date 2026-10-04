-- Disposable proof for wallet.sql; run by scripts/check-seeker-skr-ledger.sh after ledger_fixture.sql.
\set ON_ERROR_STOP 1
DO $$
DECLARE
  p uuid := '50000000-0000-4000-8000-000000000001';
  q uuid := '50000000-0000-4000-8000-000000000002';
  payer text := '61SB7agWUXtGqZSbfoqJG82FrVMaY7PPj5yq6kfjM4mL';
  sig1 text := repeat('5',64);
  sig2 text := repeat('6',64);
  i1 jsonb; i2 jsonb; r jsonb; failed boolean;
BEGIN
  SET LOCAL ROLE seeker_wallet_runtime;
  -- The runtime role reaches no table and not the raw posting primitive.
  BEGIN PERFORM 1 FROM seeker_skr.accounts; failed := false; EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'wallet role read accounts'; END IF;
  BEGIN PERFORM seeker_skr.post(gen_random_uuid(),'transfer','[]'); failed := false; EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'wallet role reached post'; END IF;

  i1 := seeker_skr.deposit_intent_create(p,'SKR',1500000,payer,'Ref1111111111111111111111111111111111111111',
    'mainnet',900);
  i2 := seeker_skr.deposit_intent_create(p,'SOL',250000000,payer,'Ref2222222222222222222222222222222222222222',
    'mainnet',900);
  PERFORM seeker_skr.deposit_intent_create(p,'SKR',1,payer,'Ref3333333333333333333333333333333333333333','mainnet',900);
  BEGIN
    PERFORM seeker_skr.deposit_intent_create(p,'SKR',1,payer,'Ref4444444444444444444444444444444444444444','mainnet',900);
    failed := false;
  EXCEPTION WHEN raise_exception THEN failed := SQLERRM = 'deposit_intent_limit'; END;
  IF NOT failed THEN RAISE EXCEPTION 'open intent limit missing'; END IF;
  -- Another player cannot read or settle this intent.
  IF seeker_skr.deposit_intent_get(q,(i1->>'intent_id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'foreign intent visible'; END IF;
  BEGIN PERFORM seeker_skr.deposit_settle(q,(i1->>'intent_id')::uuid,sig1); failed := false;
  EXCEPTION WHEN raise_exception THEN failed := SQLERRM = 'deposit_intent_not_found'; END;
  IF NOT failed THEN RAISE EXCEPTION 'foreign settle accepted'; END IF;

  r := seeker_skr.deposit_settle(p,(i1->>'intent_id')::uuid,sig1);
  IF (r->>'replayed')::boolean THEN RAISE EXCEPTION 'first settle replayed'; END IF;
  r := seeker_skr.deposit_settle(p,(i1->>'intent_id')::uuid,sig1);
  IF NOT (r->>'replayed')::boolean THEN RAISE EXCEPTION 'replay not detected'; END IF;
  BEGIN PERFORM seeker_skr.deposit_settle(p,(i1->>'intent_id')::uuid,sig2); failed := false;
  EXCEPTION WHEN raise_exception THEN failed := SQLERRM = 'deposit_already_settled'; END;
  IF NOT failed THEN RAISE EXCEPTION 'second signature settled one intent'; END IF;
  BEGIN PERFORM seeker_skr.deposit_settle(p,(i2->>'intent_id')::uuid,sig1); failed := false;
  EXCEPTION WHEN raise_exception THEN failed := SQLERRM = 'deposit_signature_used'; END;
  IF NOT failed THEN RAISE EXCEPTION 'one signature settled two intents'; END IF;
  PERFORM seeker_skr.deposit_settle(p,(i2->>'intent_id')::uuid,sig2);

  r := seeker_skr.wallet_snapshot(p);
  IF r->'balances' <> '{"SKR":"1500000","SOL":"250000000","ORE":"0"}'::jsonb THEN RAISE EXCEPTION 'balances %', r->'balances'; END IF;
  IF jsonb_array_length(r->'history') <> 2 OR jsonb_array_length(r->'pending_deposits') <> 1 THEN
    RAISE EXCEPTION 'snapshot shape %', r;
  END IF;
  IF seeker_skr.wallet_snapshot(q)->'balances' <> '{"SKR":"0","SOL":"0","ORE":"0"}'::jsonb THEN RAISE EXCEPTION 'empty snapshot'; END IF;
END $$;

-- Owner-level checks: conservation per asset and no mixed-asset event.
DO $$
DECLARE failed boolean;
BEGIN
  IF EXISTS (SELECT asset FROM seeker_skr.accounts GROUP BY asset HAVING sum(balance_minor) <> 0) THEN
    RAISE EXCEPTION 'asset not conserved';
  END IF;
  BEGIN
    PERFORM seeker_skr.post('60000000-0000-4000-8000-000000000001','transfer',jsonb_build_array(
      jsonb_build_object('account_id',(SELECT id FROM seeker_skr.accounts WHERE kind='player' AND asset='SOL' LIMIT 1),'delta_minor','-1'),
      jsonb_build_object('account_id',(SELECT id FROM seeker_skr.accounts WHERE kind='player' AND asset='SKR'
        AND player_id='50000000-0000-4000-8000-000000000001'),'delta_minor','1')));
    failed := false;
  EXCEPTION WHEN raise_exception THEN failed := SQLERRM = 'skr_mixed_asset_event'; END;
  IF NOT failed THEN RAISE EXCEPTION 'mixed asset event accepted'; END IF;
END $$;
