-- Wallet session age: a Web3 subject authenticates only with its own session
-- younger than 8 hours, or 24 hours with Boost Max; other subjects are unchanged.
BEGIN;
INSERT INTO auth.users(instance_id,id,aud,role,created_at,updated_at) VALUES
  ('00000000-0000-0000-0000-000000000000','7a5e0000-0000-4000-8000-000000000001','authenticated','authenticated',now(),now()),
  ('00000000-0000-0000-0000-000000000000','7a5e0000-0000-4000-8000-000000000002','authenticated','authenticated',now(),now());
INSERT INTO auth.identities(provider_id,user_id,identity_data,provider,created_at,updated_at) VALUES
  ('web3:solana:SessionAgeFixture1111111111111111111111','7a5e0000-0000-4000-8000-000000000001','{}'::jsonb,'web3',now(),now());
INSERT INTO public.players(player_id,username) VALUES
  ('7a5e0000-0000-4000-8000-000000000001','SessionAgeWallet'),
  ('7a5e0000-0000-4000-8000-000000000002','SessionAgeGuest')
ON CONFLICT (player_id) DO NOTHING;
INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES
  ('7a5e1000-0000-4000-8000-000000000001','7a5e0000-0000-4000-8000-000000000001',now()-interval '1 hour',now()),
  ('7a5e1000-0000-4000-8000-000000000002','7a5e0000-0000-4000-8000-000000000001',now()-interval '9 hours',now()),
  ('7a5e1000-0000-4000-8000-000000000003','7a5e0000-0000-4000-8000-000000000001',now()-interval '25 hours',now()),
  ('7a5e1000-0000-4000-8000-000000000004','7a5e0000-0000-4000-8000-000000000002',now()-interval '3 days',now());
DO $fixture$
DECLARE
  w constant uuid := '7a5e0000-0000-4000-8000-000000000001';
  g constant uuid := '7a5e0000-0000-4000-8000-000000000002';
  v_seen text;
BEGIN
  v_seen := concat_ws(',',
    heroloop_api.resolve_authenticated_account_session(w,'7a5e1000-0000-4000-8000-000000000001')->>'authenticated',
    heroloop_api.resolve_authenticated_account_session(w,'7a5e1000-0000-4000-8000-000000000002')->>'reason',
    heroloop_api.resolve_authenticated_account_session(w,NULL)->>'reason',
    heroloop_api.resolve_authenticated_account_session(w,'7a5e1000-0000-4000-8000-000000000004')->>'reason',
    heroloop_api.resolve_authenticated_account_session(g,'7a5e1000-0000-4000-8000-000000000004')->>'authenticated',
    heroloop_api.resolve_authenticated_account_session(g,NULL)->>'authenticated');
  IF v_seen <> 'true,wallet_session_expired,wallet_session_unknown,wallet_session_unknown,true,true' THEN
    RAISE EXCEPTION 'wallet session age without Boost Max: %', v_seen;
  END IF;
  UPDATE public.players SET boost_max_active = true WHERE player_id = w;
  v_seen := concat_ws(',',
    heroloop_api.resolve_authenticated_account_session(w,'7a5e1000-0000-4000-8000-000000000002')->>'authenticated',
    heroloop_api.resolve_authenticated_account_session(w,'7a5e1000-0000-4000-8000-000000000003')->>'reason');
  IF v_seen <> 'true,wallet_session_expired' THEN
    RAISE EXCEPTION 'wallet session age with Boost Max: %', v_seen;
  END IF;
  IF has_function_privilege('authenticated','heroloop_api.resolve_authenticated_account_session(uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('heroloop_api','heroloop_api.resolve_authenticated_account_session(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'wallet session resolver privileges';
  END IF;
END
$fixture$;
ROLLBACK;
