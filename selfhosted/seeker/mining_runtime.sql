-- Wallet-runtime entry points for the Seeker ORE Mine. Apply after mining_sessions.sql.
-- Player calls resolve the player's own SOL account; the client never names accounts,
-- amounts beyond a stake tier, or chain results. Runner calls are made only by the
-- wallet service after it verified finalized receipts with selfhosted/seeker/ore.ts.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.mining_sessions') IS NULL THEN
    RAISE EXCEPTION 'mining_runtime_requires_private_mining_sessions';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS seeker_skr.mining_terms (
  player_id uuid PRIMARY KEY,
  version text NOT NULL CHECK (version ~ '^[a-z0-9.-]{1,32}$'),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION seeker_skr.mine_session_json(s seeker_skr.mining_sessions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object('id',s.id,'status',s.status,'reserved_minor',s.reserved_minor::text,
    'spent_minor',s.spent_minor::text,'released_minor',s.released_minor::text,'completed',s.completed,
    'round_limit',s.round_limit,'stake_minor',s.policy->>'stake_per_round','square_mask',s.policy->>'square_mask','custody_address',s.custody_address,
    'created_at',s.created_at,
    'credited_minor',(SELECT COALESCE(sum(c.amount_minor),0)::text FROM seeker_skr.mining_credits c WHERE c.session_id=s.id),
    'rounds',(SELECT COALESCE(jsonb_agg(jsonb_build_object('seq',r.seq,'status',r.status,'ore_round_id',r.ore_round_id::text,
      'cost_minor',r.cost_minor::text,'signature',COALESCE(r.signature,r.submitted_signature)) ORDER BY r.seq DESC),'[]'::jsonb)
      FROM (SELECT * FROM seeker_skr.mining_rounds WHERE session_id=s.id ORDER BY seq DESC LIMIT 20) r))
$$;

CREATE OR REPLACE FUNCTION seeker_skr.mine_status(p_player uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE v_account uuid; s seeker_skr.mining_sessions; v_day date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  v_account:=seeker_skr.wallet_account(p_player,'SOL');
  SELECT * INTO s FROM seeker_skr.mining_sessions WHERE source_account=v_account
    ORDER BY (status<>'closed') DESC, created_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'terms_version',(SELECT version FROM seeker_skr.mining_terms WHERE player_id=p_player),
    'available_minor',(SELECT balance_minor::text FROM seeker_skr.accounts WHERE id=v_account),
    'used_today_minor',(SELECT COALESCE(sum(reserved_minor-COALESCE(released_minor,0)),0)::text
      FROM seeker_skr.mining_sessions WHERE source_account=v_account AND day=v_day),
    'session',CASE WHEN s.id IS NULL THEN NULL ELSE seeker_skr.mine_session_json(s) END,
    'history',(SELECT COALESCE(jsonb_agg(seeker_skr.mine_session_json(h) ORDER BY h.created_at DESC,h.id DESC),'[]'::jsonb)
      FROM (SELECT * FROM seeker_skr.mining_sessions WHERE source_account=v_account
        ORDER BY created_at DESC,id DESC LIMIT 10) h));
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.mine_accept_terms(p_player uuid,p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
BEGIN
  IF p_version IS NULL OR p_version !~ '^[a-z0-9.-]{1,32}$' THEN RAISE EXCEPTION 'invalid_mining_terms'; END IF;
  INSERT INTO seeker_skr.mining_terms(player_id,version) VALUES(p_player,p_version)
    ON CONFLICT (player_id) DO UPDATE SET version=EXCLUDED.version,accepted_at=clock_timestamp()
    WHERE mining_terms.version<>EXCLUDED.version;
  RETURN seeker_skr.mine_status(p_player);
END $$;

-- The wallet service builds p_policy from its approved configuration and the chosen tier.
CREATE OR REPLACE FUNCTION seeker_skr.mine_start(
  p_player uuid,p_session uuid,p_budget numeric,p_policy jsonb,p_terms text,p_custody text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE s seeker_skr.mining_sessions;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seeker_skr.mining_terms WHERE player_id=p_player AND version=p_terms) THEN
    RAISE EXCEPTION 'mining_terms_required';
  END IF;
  IF p_custody IS NULL OR p_custody !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN RAISE EXCEPTION 'invalid_mining_custody'; END IF;
  -- A shared protocol Miner has one owner session until all its claims settle.
  -- Serialize across players in SQL, including concurrent start requests.
  PERFORM pg_advisory_xact_lock(hashtextextended('mine-custody:'||p_custody,0));
  IF EXISTS (SELECT 1 FROM seeker_skr.mining_sessions
      WHERE custody_address=p_custody AND status<>'closed' AND id<>p_session) THEN
    RAISE EXCEPTION 'mining_shared_wallet_busy';
  END IF;
  s:=seeker_skr.mining_session_open(p_session,seeker_skr.wallet_account(p_player,'SOL'),p_budget,p_policy);
  IF s.custody_address IS NULL THEN
    UPDATE seeker_skr.mining_sessions SET custody_address=p_custody WHERE id=s.id RETURNING * INTO s;
  ELSIF s.custody_address<>p_custody THEN RAISE EXCEPTION 'skr_idempotency_conflict';
  END IF;
  RETURN seeker_skr.mine_session_json(s);
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.mine_stop(p_player uuid,p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE s seeker_skr.mining_sessions;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seeker_skr.mining_sessions WHERE id=p_session
      AND source_account=seeker_skr.wallet_account(p_player,'SOL')) THEN
    RAISE EXCEPTION 'mining_session_not_found';
  END IF;
  s:=seeker_skr.mining_session_stop(p_session);
  RETURN seeker_skr.mine_session_json(s);
END $$;

-- Runner: unclosed sessions with their player, policy and pending round.
CREATE OR REPLACE FUNCTION seeker_skr.mine_runner_work() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object('sessions',COALESCE(jsonb_agg(jsonb_build_object(
    'id',s.id,'player_id',a.player_id,'status',s.status,'policy',s.policy,'custody_address',s.custody_address,
    'reserved_minor',s.reserved_minor::text,'spent_minor',s.spent_minor::text,'completed',s.completed,
    'round_limit',s.round_limit,'round_cost_minor',s.round_cost_minor::text,
    'last_ore_round_id',(SELECT max(r.ore_round_id)::text FROM seeker_skr.mining_rounds r WHERE r.session_id=s.id),
    'pending',(SELECT jsonb_build_object('id',r.id,'ore_round_id',r.ore_round_id::text,'submitted_signature',r.submitted_signature)
      FROM seeker_skr.mining_rounds r WHERE r.session_id=s.id AND r.status='pending')) ORDER BY s.created_at),'[]'::jsonb))
  FROM seeker_skr.mining_sessions s JOIN seeker_skr.accounts a ON a.id=s.source_account
  WHERE s.status<>'closed'
$$;

-- Persist the round, its ORE round and the exact signature BEFORE sending.
CREATE OR REPLACE FUNCTION seeker_skr.mine_round_prepare(
  p_session uuid,p_round uuid,p_ore_round numeric,p_signature text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE r seeker_skr.mining_rounds;
BEGIN
  IF p_ore_round IS NULL OR p_ore_round<0 OR trunc(p_ore_round)<>p_ore_round
    OR p_signature IS NULL OR p_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' THEN
    RAISE EXCEPTION 'invalid_mining_round';
  END IF;
  r:=seeker_skr.mining_round_begin(p_session,p_round);
  IF r.status<>'pending' THEN RETURN to_jsonb(r); END IF;
  IF r.ore_round_id IS NOT NULL AND r.ore_round_id<>p_ore_round THEN RAISE EXCEPTION 'skr_idempotency_conflict'; END IF;
  -- A pending round may be re-signed with a fresh blockhash only within its ORE round;
  -- ORE ignores a second deploy to an already deployed square of the same round.
  UPDATE seeker_skr.mining_rounds SET ore_round_id=p_ore_round,submitted_signature=p_signature
    WHERE id=p_round RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

CREATE OR REPLACE FUNCTION seeker_skr.mine_round_settle(p_round uuid,p_cost numeric,p_signature text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT to_jsonb(seeker_skr.mining_round_settle(p_round,p_cost,p_signature))
$$;
CREATE OR REPLACE FUNCTION seeker_skr.mine_runner_stop(p_session uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT seeker_skr.mine_session_json(seeker_skr.mining_session_stop(p_session))
$$;
CREATE OR REPLACE FUNCTION seeker_skr.mine_session_close(p_session uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT seeker_skr.mine_session_json(seeker_skr.mining_session_close(p_session))
$$;
-- Credits verified claimed SOL to the player who owns the session's custody wallet.
CREATE OR REPLACE FUNCTION seeker_skr.mine_credit(p_claim uuid,p_session uuid,p_amount numeric,p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE v_account uuid; c seeker_skr.mining_credits;
BEGIN
  SELECT source_account INTO v_account FROM seeker_skr.mining_sessions WHERE id=p_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'mining_session_not_found'; END IF;
  c:=seeker_skr.mining_credit(p_claim,v_account,p_amount,p_signature);
  IF c.session_id IS NULL THEN
    UPDATE seeker_skr.mining_credits SET session_id=p_session WHERE id=p_claim RETURNING * INTO c;
  END IF;
  -- A claim already attributed to an earlier session stays there (rescanning is idempotent).
  RETURN to_jsonb(c);
END $$;

-- Verified rounds (non-zero settled cost) for game quests; newest 500.
CREATE OR REPLACE FUNCTION seeker_skr.mine_player_rounds(p_player uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
  SELECT jsonb_build_object('rounds',COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'at',x.at)),'[]'::jsonb))
  FROM (SELECT r.id,e.created_at AS at FROM seeker_skr.mining_rounds r
    JOIN seeker_skr.events e ON e.id=r.settle_event
    JOIN seeker_skr.mining_sessions s ON s.id=r.session_id
    JOIN seeker_skr.accounts a ON a.id=s.source_account
    WHERE a.player_id=p_player AND r.cost_minor>0 ORDER BY e.created_at DESC LIMIT 500) x
$$;

REVOKE ALL ON seeker_skr.mining_terms FROM PUBLIC,seeker_wallet_runtime;
REVOKE ALL ON FUNCTION seeker_skr.mine_session_json(seeker_skr.mining_sessions) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.mine_player_rounds(uuid),seeker_skr.mine_status(uuid),seeker_skr.mine_accept_terms(uuid,text),
  seeker_skr.mine_start(uuid,uuid,numeric,jsonb,text,text),seeker_skr.mine_stop(uuid,uuid),
  seeker_skr.mine_runner_work(),seeker_skr.mine_round_prepare(uuid,uuid,numeric,text),
  seeker_skr.mine_round_settle(uuid,numeric,text),seeker_skr.mine_runner_stop(uuid),
  seeker_skr.mine_session_close(uuid),seeker_skr.mine_credit(uuid,uuid,numeric,text)
  TO seeker_wallet_runtime;
COMMIT;
