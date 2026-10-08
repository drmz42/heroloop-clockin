DO $$
DECLARE root text:=repeat('A',32); w text; i integer; o jsonb; p jsonb; sig text;
BEGIN
 INSERT INTO seeker_skr.campaign_accounts(wallet) VALUES(root);
 INSERT INTO seeker_skr.campaign_sessions VALUES('root',root,now()+interval '1 day');
 FOR i IN 1..5 LOOP
  w:=repeat(chr(65+i),32);
  INSERT INTO seeker_skr.campaign_accounts(wallet,inviter) VALUES(w,root);
  INSERT INTO seeker_skr.campaign_sessions VALUES('buyer'||i,w,now()+interval '1 day');
  o:=seeker_skr.campaign('intent',jsonb_build_object('token_hash','buyer'||i,'pack','starter','reference',repeat(chr(75+i),32),'treasury',repeat('T',32)));
  IF o->>'amount_minor'<>'100000' THEN RAISE EXCEPTION 'bad_price'; END IF;
  sig:=repeat(chr(65+i),64);
  PERFORM seeker_skr.campaign('settle',jsonb_build_object('token_hash','buyer'||i,'id',o->>'id','signature',sig));
  PERFORM seeker_skr.campaign('settle',jsonb_build_object('token_hash','buyer'||i,'id',o->>'id','signature',sig));
  -- Second pack for the same buyer must not produce a second point.
  o:=seeker_skr.campaign('intent',jsonb_build_object('token_hash','buyer'||i,'pack','founder','reference',repeat(chr(85+i),32),'treasury',repeat('T',32)));
  PERFORM seeker_skr.campaign('settle',jsonb_build_object('token_hash','buyer'||i,'id',o->>'id','signature',repeat('2'||i,32)));
 END LOOP;
 p:=seeker_skr.campaign('profile','{"token_hash":"root"}');
 IF (p->>'points')::integer<>5 OR jsonb_array_length(p->'entitlements')<>2 THEN RAISE EXCEPTION 'bad_milestones'; END IF;
 IF coalesce(p->>'short_code','') !~ '^[2-9A-HJ-NP-Za-km-z]{6}$' THEN RAISE EXCEPTION 'bad_short_code'; END IF;
 PERFORM seeker_skr.campaign('challenge',jsonb_build_object('wallet',repeat('Z',32),'ref',p->>'short_code','id',gen_random_uuid(),'binding','short-ref','message','m'));
 IF (SELECT inviter FROM seeker_skr.campaign_challenges WHERE binding='short-ref') IS DISTINCT FROM root THEN RAISE EXCEPTION 'bad_short_referral'; END IF;
 IF EXISTS(SELECT 1 FROM seeker_skr.campaign_entitlements WHERE delivered_at IS NOT NULL) THEN RAISE EXCEPTION 'premature_grant'; END IF;
 IF (SELECT count(*) FROM seeker_skr.campaign_points)<>5 OR (SELECT count(*) FROM seeker_skr.campaign_orders WHERE paid_at IS NOT NULL)<>10 THEN RAISE EXCEPTION 'bad_replay'; END IF;
 IF (SELECT sum(balance_minor) FROM seeker_skr.accounts WHERE asset='SOL')<>0 THEN RAISE EXCEPTION 'unbalanced_revenue'; END IF;
 BEGIN
  PERFORM seeker_skr.campaign('profile','{"token_hash":"missing"}');
  RAISE EXCEPTION 'bad_auth';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'campaign_sign_in_required' THEN RAISE; END IF; END;
 -- A campaign receipt must not also become an in-game deposit.
 BEGIN
  PERFORM seeker_skr.post(gen_random_uuid(),'deposit',jsonb_build_array(
   jsonb_build_object('account_id',seeker_skr.system_account('chain','SOL'),'delta_minor','-1'),
   jsonb_build_object('account_id',seeker_skr.system_account('merchant','SOL'),'delta_minor','1')),repeat('B',64));
  RAISE EXCEPTION 'duplicate_signature_accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
DO $$
DECLARE i integer; w text; o jsonb;
BEGIN
 INSERT INTO seeker_skr.campaign_accounts(wallet) VALUES(repeat('U',32));
 INSERT INTO seeker_skr.campaign_sessions VALUES('race-root',repeat('U',32),now()+interval '1 day');
 FOR i IN 1..4 LOOP
  w:=repeat(chr(85+i),32);
  INSERT INTO seeker_skr.campaign_accounts(wallet,inviter) VALUES(w,repeat('U',32));
  INSERT INTO seeker_skr.campaign_sessions VALUES('race'||i,w,now()+interval '1 day');
  o:=seeker_skr.campaign('intent',jsonb_build_object('token_hash','race'||i,'pack','scout','reference',repeat('3'||i,16),'treasury',repeat('T',32)));
  IF i<=2 THEN PERFORM seeker_skr.campaign('settle',jsonb_build_object('token_hash','race'||i,'id',o->>'id','signature',repeat('4'||i,32))); END IF;
 END LOOP;
END $$;
SET ROLE seeker_wallet_runtime;
SELECT seeker_skr.campaign('profile','{"token_hash":"root"}') IS NOT NULL;
RESET ROLE;
