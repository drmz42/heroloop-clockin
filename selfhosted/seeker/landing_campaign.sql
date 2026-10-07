-- Apply only to the isolated seeker_skr database after wallet.sql. No game grants.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'seeker_skr' AND current_database()<>'postgres' THEN RAISE EXCEPTION 'campaign_wrong_database'; END IF;
 IF to_regclass('public.players') IS NOT NULL OR to_regclass('seeker_skr.deposit_intents') IS NULL THEN RAISE EXCEPTION 'campaign_requires_isolated_wallet'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS seeker_skr.campaign_accounts (
 wallet text PRIMARY KEY CHECK(wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 code uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 inviter text REFERENCES seeker_skr.campaign_accounts(wallet),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(inviter IS DISTINCT FROM wallet)
);
CREATE TABLE IF NOT EXISTS seeker_skr.campaign_challenges (
 id uuid PRIMARY KEY, wallet text NOT NULL, inviter text REFERENCES seeker_skr.campaign_accounts(wallet),
 binding text NOT NULL, message text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS seeker_skr.campaign_sessions (
 token_hash text PRIMARY KEY, wallet text NOT NULL REFERENCES seeker_skr.campaign_accounts(wallet),
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS seeker_skr.campaign_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet text NOT NULL REFERENCES seeker_skr.campaign_accounts(wallet),
 pack text NOT NULL CHECK(pack IN ('starter','scout','veteran','elite','founder')),
 catalog_version text NOT NULL DEFAULT 'sol-landing-v1',
 amount_minor bigint NOT NULL CHECK(amount_minor IN (50000000,100000000,250000000,500000000,1000000000)),
 reference text NOT NULL UNIQUE, treasury text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 submitted_signature text, checked_at timestamptz,
 signature text UNIQUE, paid_at timestamptz, CHECK((signature IS NULL)=(paid_at IS NULL))
);
CREATE TABLE IF NOT EXISTS seeker_skr.campaign_points (
 buyer text PRIMARY KEY REFERENCES seeker_skr.campaign_accounts(wallet),
 inviter text NOT NULL REFERENCES seeker_skr.campaign_accounts(wallet),
 order_id uuid NOT NULL UNIQUE REFERENCES seeker_skr.campaign_orders(id), earned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS seeker_skr.campaign_entitlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet text NOT NULL REFERENCES seeker_skr.campaign_accounts(wallet),
 source text NOT NULL CHECK(source IN ('purchase','referral')), source_id text NOT NULL,
 pack text NOT NULL, catalog_version text NOT NULL DEFAULT 'sol-landing-v1', threshold integer, earned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 delivered_player uuid, delivery_receipt uuid UNIQUE, delivered_at timestamptz,
 UNIQUE(source,source_id), CHECK((delivered_at IS NULL)=(delivery_receipt IS NULL)),
 CHECK((delivered_player IS NULL)=(delivery_receipt IS NULL))
);
CREATE INDEX IF NOT EXISTS campaign_points_inviter ON seeker_skr.campaign_points(inviter);
CREATE INDEX IF NOT EXISTS campaign_orders_wallet ON seeker_skr.campaign_orders(wallet,created_at);
-- Campaign revenue is separate from the spendable game wallet ledger. A global
-- receipt registry prevents the same SOL transfer becoming a pack and a deposit.
CREATE TABLE IF NOT EXISTS seeker_skr.campaign_chain_receipts (
 signature text PRIMARY KEY, source text NOT NULL CHECK(source IN ('wallet','campaign')), source_id uuid NOT NULL
);
INSERT INTO seeker_skr.campaign_chain_receipts
 SELECT chain_signature,'wallet',idempotency_key FROM seeker_skr.events WHERE chain_signature IS NOT NULL ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION seeker_skr.campaign_wallet_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
BEGIN
 IF NEW.chain_signature IS NOT NULL THEN
  INSERT INTO seeker_skr.campaign_chain_receipts VALUES(NEW.chain_signature,'wallet',NEW.idempotency_key);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS campaign_wallet_receipt ON seeker_skr.events;
CREATE TRIGGER campaign_wallet_receipt BEFORE INSERT ON seeker_skr.events FOR EACH ROW EXECUTE FUNCTION seeker_skr.campaign_wallet_receipt();
CREATE OR REPLACE FUNCTION seeker_skr.campaign(p_action text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seeker_skr AS $$
DECLARE w text; inv text; c seeker_skr.campaign_challenges; o seeker_skr.campaign_orders; amount bigint; n integer; result jsonb;
BEGIN
 IF p_action='pending' THEN
  WITH selected AS (SELECT id FROM seeker_skr.campaign_orders WHERE signature IS NULL AND submitted_signature IS NOT NULL
   AND (checked_at IS NULL OR checked_at<clock_timestamp()-interval '1 minute') ORDER BY checked_at NULLS FIRST LIMIT 10),
   touched AS (UPDATE seeker_skr.campaign_orders SET checked_at=clock_timestamp() WHERE id IN(SELECT id FROM selected) RETURNING *)
  SELECT jsonb_build_object('orders',coalesce(jsonb_agg(to_jsonb(touched)||jsonb_build_object('amount_minor',amount_minor::text)),'[]'::jsonb)) INTO result FROM touched;
  RETURN result;
 END IF;
 IF p_action='challenge' THEN
  DELETE FROM seeker_skr.campaign_challenges WHERE expires_at<clock_timestamp();
  DELETE FROM seeker_skr.campaign_sessions WHERE expires_at<clock_timestamp();
  w:=p->>'wallet';
  IF (SELECT count(*) FROM seeker_skr.campaign_challenges WHERE binding=p->>'binding' OR wallet=w)>=5 THEN RAISE EXCEPTION 'campaign_rate_limited'; END IF;
  IF EXISTS(SELECT 1 FROM seeker_skr.campaign_accounts WHERE wallet=w) THEN
   SELECT inviter INTO inv FROM seeker_skr.campaign_accounts WHERE wallet=w;
  ELSIF coalesce(p->>'ref','')<>'' THEN
   SELECT wallet INTO inv FROM seeker_skr.campaign_accounts WHERE code=(p->>'ref')::uuid;
   IF inv IS NULL OR inv=w THEN RAISE EXCEPTION 'campaign_invalid_referral'; END IF;
  END IF;
  INSERT INTO seeker_skr.campaign_challenges VALUES((p->>'id')::uuid,w,inv,p->>'binding',p->>'message',clock_timestamp()+interval '5 minutes');
  RETURN jsonb_build_object('message',p->>'message','id',p->>'id');
 END IF;
 IF p_action IN ('challenge_get','verify') THEN
  SELECT * INTO c FROM seeker_skr.campaign_challenges WHERE id=(p->>'id')::uuid AND binding=p->>'binding' AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_challenge_expired'; END IF;
  IF p_action='challenge_get' THEN RETURN to_jsonb(c); END IF;
  INSERT INTO seeker_skr.campaign_accounts(wallet,inviter) VALUES(c.wallet,c.inviter) ON CONFLICT DO NOTHING;
  DELETE FROM seeker_skr.campaign_challenges WHERE id=c.id;
  INSERT INTO seeker_skr.campaign_sessions VALUES(p->>'token_hash',c.wallet,clock_timestamp()+interval '7 days');
  RETURN jsonb_build_object('wallet',c.wallet);
 END IF;
 IF p_action='settle_pending' THEN
  SELECT wallet INTO w FROM seeker_skr.campaign_orders WHERE id=(p->>'id')::uuid AND submitted_signature=p->>'signature';
 ELSE
  SELECT wallet INTO w FROM seeker_skr.campaign_sessions WHERE token_hash=p->>'token_hash' AND expires_at>clock_timestamp();
 END IF;
 IF w IS NULL THEN RAISE EXCEPTION 'campaign_sign_in_required'; END IF;
 IF p_action='logout' THEN DELETE FROM seeker_skr.campaign_sessions WHERE token_hash=p->>'token_hash'; RETURN '{}'::jsonb; END IF;
 IF p_action='intent' THEN
  amount:=CASE p->>'pack' WHEN 'starter' THEN 50000000 WHEN 'scout' THEN 100000000 WHEN 'veteran' THEN 250000000 WHEN 'elite' THEN 500000000 WHEN 'founder' THEN 1000000000 END;
  IF amount IS NULL THEN RAISE EXCEPTION 'campaign_invalid_pack'; END IF;
  IF (SELECT count(*) FROM seeker_skr.campaign_orders WHERE wallet=w AND paid_at IS NULL AND expires_at>clock_timestamp())>=3 THEN RAISE EXCEPTION 'campaign_order_limit'; END IF;
  INSERT INTO seeker_skr.campaign_orders(wallet,pack,amount_minor,reference,treasury,expires_at)
   VALUES(w,p->>'pack',amount,p->>'reference',p->>'treasury',clock_timestamp()+interval '10 minutes') RETURNING * INTO o;
  RETURN to_jsonb(o)||jsonb_build_object('amount_minor',o.amount_minor::text);
 END IF;
 IF p_action IN ('order','submit','settle','settle_pending') THEN
  SELECT * INTO o FROM seeker_skr.campaign_orders WHERE id=(p->>'id')::uuid AND wallet=w FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_order_not_found'; END IF;
  IF p_action='order' THEN RETURN to_jsonb(o)||jsonb_build_object('amount_minor',o.amount_minor::text); END IF;
  IF p_action='submit' THEN
   IF o.signature IS NULL THEN UPDATE seeker_skr.campaign_orders SET submitted_signature=p->>'signature',checked_at=NULL WHERE id=o.id; END IF;
   RETURN to_jsonb(o)||jsonb_build_object('amount_minor',o.amount_minor::text);
  END IF;
  IF o.signature IS NOT NULL THEN
   IF o.signature<>p->>'signature' THEN RAISE EXCEPTION 'campaign_signature_conflict'; END IF;
  ELSE
   UPDATE seeker_skr.campaign_orders SET signature=p->>'signature',paid_at=clock_timestamp() WHERE id=o.id;
   INSERT INTO seeker_skr.campaign_chain_receipts VALUES(p->>'signature','campaign',o.id);
   INSERT INTO seeker_skr.campaign_entitlements(wallet,source,source_id,pack) VALUES(w,'purchase',o.id::text,o.pack);
   SELECT inviter INTO inv FROM seeker_skr.campaign_accounts WHERE wallet=w;
   IF inv IS NOT NULL THEN
    -- Lock the inviter before counting to serialize different buyers at a threshold.
    PERFORM 1 FROM seeker_skr.campaign_accounts WHERE wallet=inv FOR UPDATE;
    INSERT INTO seeker_skr.campaign_points(buyer,inviter,order_id) VALUES(w,inv,o.id) ON CONFLICT(buyer) DO NOTHING;
    SELECT count(*) INTO n FROM seeker_skr.campaign_points WHERE inviter=inv;
    INSERT INTO seeker_skr.campaign_entitlements(wallet,source,source_id,pack,threshold)
     SELECT inv,'referral',inv||':'||t.threshold,t.pack,t.threshold
     FROM (VALUES(3,'starter'),(5,'scout'),(10,'veteran'),(25,'elite'),(50,'founder')) AS t(threshold,pack)
     WHERE t.threshold<=n ON CONFLICT(source,source_id) DO NOTHING;
   END IF;
  END IF;
 END IF;
 IF p_action NOT IN ('profile','settle','settle_pending') THEN RAISE EXCEPTION 'campaign_invalid_action'; END IF;
 SELECT jsonb_build_object('wallet',w,'code',a.code,
  'registered',(SELECT count(*) FROM seeker_skr.campaign_accounts WHERE inviter=w),
  'points',(SELECT count(*) FROM seeker_skr.campaign_points WHERE inviter=w),
  'entitlements',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY earned_at) FROM seeker_skr.campaign_entitlements e WHERE wallet=w),'[]'::jsonb),
  'orders',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('amount_minor',r.amount_minor::text)) FROM seeker_skr.campaign_orders r WHERE wallet=w AND (paid_at IS NOT NULL OR expires_at>clock_timestamp())),'[]'::jsonb))
 INTO result FROM seeker_skr.campaign_accounts a WHERE a.wallet=w;
 RETURN result;
END $$;
REVOKE ALL ON seeker_skr.campaign_accounts,seeker_skr.campaign_challenges,seeker_skr.campaign_sessions,seeker_skr.campaign_orders,seeker_skr.campaign_points,seeker_skr.campaign_entitlements FROM PUBLIC,seeker_wallet_runtime;
REVOKE ALL ON seeker_skr.campaign_chain_receipts FROM PUBLIC,seeker_wallet_runtime;
REVOKE ALL ON FUNCTION seeker_skr.campaign_wallet_receipt() FROM PUBLIC,seeker_wallet_runtime;
REVOKE ALL ON FUNCTION seeker_skr.campaign(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seeker_skr.campaign(text,jsonb) TO seeker_wallet_runtime;
COMMIT;
