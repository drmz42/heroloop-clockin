CREATE TABLE public.hero_summon_purchase_quotes (
  quote_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  summon_count integer NOT NULL CHECK (summon_count IN (1, 10, 100)),
  catalogue_usd_micros bigint NOT NULL CHECK (catalogue_usd_micros IN (20000, 200000, 2000000)),
  token_cost numeric NOT NULL CHECK (token_cost > 0),
  dex_quote_id uuid NOT NULL REFERENCES public.hero_usd_dex_quotes(quote_id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  used_by_idempotency_key uuid,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((used_by_idempotency_key IS NULL) = (used_at IS NULL))
);
CREATE INDEX hero_summon_purchase_quotes_player_created_idx
  ON public.hero_summon_purchase_quotes(player_id, created_at DESC);
ALTER TABLE public.hero_summon_purchase_quotes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hero_summon_purchase_quotes FROM PUBLIC, anon, authenticated;

ALTER TABLE public.summon_events
  DROP CONSTRAINT IF EXISTS summon_events_token_cost_check;
ALTER TABLE public.summon_events
  ADD CONSTRAINT summon_events_token_cost_check CHECK (token_cost >= 0),
  ADD COLUMN expected_revision bigint,
  ADD COLUMN payment_method text NOT NULL DEFAULT 'legacy_paid'
    CHECK (payment_method IN ('legacy_paid', 'paid', 'scroll')),
  ADD COLUMN scroll_cost integer NOT NULL DEFAULT 0 CHECK (scroll_cost IN (0, 1, 10, 100)),
  ADD COLUMN catalogue_usd_micros bigint CHECK (catalogue_usd_micros > 0),
  ADD COLUMN purchase_quote_id uuid REFERENCES public.hero_summon_purchase_quotes(quote_id) ON DELETE RESTRICT,
  ADD COLUMN dex_quote_id uuid REFERENCES public.hero_usd_dex_quotes(quote_id) ON DELETE RESTRICT,
  ADD COLUMN hero_usd_quote_micros numeric CHECK (hero_usd_quote_micros > 0),
  ADD COLUMN dex_source text,
  ADD COLUMN dex_mint_address text,
  ADD COLUMN dex_source_block bigint,
  ADD COLUMN dex_observed_at timestamptz,
  ADD COLUMN quote_expires_at timestamptz;
CREATE UNIQUE INDEX summon_events_purchase_quote_unique
  ON public.summon_events(purchase_quote_id) WHERE purchase_quote_id IS NOT NULL;

-- rarity_supply is the shared global inventory for limited Divine/Celestial
-- instances. Bring existing embedded Heroes into the same count before
-- installing the lifecycle trigger that follows every authoritative save.
WITH item_counts AS (
  SELECT rarity, count(*)::integer AS quantity
  FROM public.player_items
  WHERE removed_at IS NULL AND rarity IN ('divine', 'celestial')
  GROUP BY rarity
), hero_counts AS (
  SELECT split_part(hero->>'heroId', '-', 2) AS rarity, count(*)::integer AS quantity
  FROM public.player_saves save
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(save.state->'ownedHeroes') = 'array'
      THEN save.state->'ownedHeroes' ELSE '[]'::jsonb END
  ) hero
  WHERE split_part(hero->>'heroId', '-', 2) IN ('divine', 'celestial')
  GROUP BY split_part(hero->>'heroId', '-', 2)
), totals AS (
  SELECT supply.rarity,
    COALESCE(items.quantity, 0) + COALESCE(heroes.quantity, 0) AS quantity
  FROM public.rarity_supply supply
  LEFT JOIN item_counts items USING (rarity)
  LEFT JOIN hero_counts heroes USING (rarity)
  WHERE supply.rarity IN ('divine', 'celestial')
)
UPDATE public.rarity_supply supply
SET existing_count = totals.quantity, updated_at = clock_timestamp()
FROM totals
WHERE supply.rarity = totals.rarity;

CREATE OR REPLACE FUNCTION public.sync_limited_hero_supply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rarity text;
  v_old_count integer;
  v_new_count integer;
  v_delta integer;
  v_supply public.rarity_supply%ROWTYPE;
BEGIN
  FOR v_rarity IN SELECT unnest(ARRAY['celestial', 'divine']::text[]) LOOP
    SELECT count(*)::integer INTO v_old_count
    FROM jsonb_array_elements(CASE WHEN TG_OP <> 'INSERT' AND jsonb_typeof(OLD.state->'ownedHeroes') = 'array'
      THEN OLD.state->'ownedHeroes' ELSE '[]'::jsonb END) hero
    WHERE split_part(hero->>'heroId', '-', 2) = v_rarity;
    SELECT count(*)::integer INTO v_new_count
    FROM jsonb_array_elements(CASE WHEN TG_OP <> 'DELETE' AND jsonb_typeof(NEW.state->'ownedHeroes') = 'array'
      THEN NEW.state->'ownedHeroes' ELSE '[]'::jsonb END) hero
    WHERE split_part(hero->>'heroId', '-', 2) = v_rarity;
    v_delta := v_new_count - v_old_count;
    IF v_delta <> 0 THEN
      SELECT * INTO v_supply FROM public.rarity_supply WHERE rarity = v_rarity FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'rarity_supply_unavailable'; END IF;
      IF v_supply.existing_count + v_delta < 0 THEN RAISE EXCEPTION 'rarity_supply_underflow'; END IF;
      IF v_supply.existing_count + v_delta > v_supply.max_existing THEN RAISE EXCEPTION 'rarity_limit_reached'; END IF;
      UPDATE public.rarity_supply
      SET existing_count = existing_count + v_delta, updated_at = clock_timestamp()
      WHERE rarity = v_rarity;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS player_save_limited_hero_supply ON public.player_saves;
CREATE TRIGGER player_save_limited_hero_supply
AFTER INSERT OR UPDATE OF state OR DELETE ON public.player_saves
FOR EACH ROW EXECUTE FUNCTION public.sync_limited_hero_supply();
REVOKE ALL ON FUNCTION public.sync_limited_hero_supply() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.quote_hero_summon(
  p_player_id uuid,
  p_expected_revision bigint,
  p_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state jsonb;
  v_revision bigint;
  v_catalogue_usd_micros bigint;
  v_cost numeric;
  v_dex public.hero_usd_dex_quotes%ROWTYPE;
  v_quote public.hero_summon_purchase_quotes%ROWTYPE;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 1 OR p_count NOT IN (1, 10, 100) THEN
    RAISE EXCEPTION 'invalid_hero_summon_quote';
  END IF;
  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  IF jsonb_typeof(v_state->'ownedHeroes') <> 'array' THEN RAISE EXCEPTION 'invalid_owned_heroes'; END IF;
  IF jsonb_array_length(v_state->'ownedHeroes') + p_count > COALESCE((v_state->>'heroCapacity')::integer, 500) THEN
    RAISE EXCEPTION 'hero_capacity_exceeded';
  END IF;
  SELECT * INTO v_dex
  FROM public.hero_usd_dex_quotes
  WHERE observed_at <= clock_timestamp()
    AND observed_at >= clock_timestamp() - interval '5 minutes'
    AND expires_at > clock_timestamp()
  ORDER BY observed_at DESC, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'dex_quote_unavailable'; END IF;
  v_catalogue_usd_micros := p_count * 20000;
  v_cost := ceil(v_catalogue_usd_micros::numeric / v_dex.usd_micros_per_hero);
  IF v_cost <= 0 OR v_cost > 9007199254740991 THEN RAISE EXCEPTION 'dex_quote_unavailable'; END IF;
  INSERT INTO public.hero_summon_purchase_quotes(
    player_id, expected_revision, summon_count, catalogue_usd_micros,
    token_cost, dex_quote_id, expires_at
  ) VALUES (
    p_player_id, v_revision, p_count, v_catalogue_usd_micros,
    v_cost, v_dex.quote_id, LEAST(v_dex.expires_at, clock_timestamp() + interval '60 seconds')
  ) RETURNING * INTO v_quote;
  RETURN jsonb_build_object(
    'quote_id', v_quote.quote_id,
    'summon_count', v_quote.summon_count,
    'catalogue_usd_micros', v_quote.catalogue_usd_micros,
    'token_cost', v_quote.token_cost,
    'hero_usd_quote_micros', v_dex.usd_micros_per_hero,
    'dex_source', v_dex.source,
    'dex_mint_address', v_dex.mint_address,
    'dex_source_block', v_dex.source_block,
    'dex_observed_at', v_dex.observed_at,
    'expires_at', v_quote.expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_hero_summon(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_count integer,
  p_expected_revision bigint,
  p_payment_method text,
  p_quote_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  v_existing public.summon_events%ROWTYPE;
  v_quote public.hero_summon_purchase_quotes%ROWTYPE;
  v_dex public.hero_usd_dex_quotes%ROWTYPE;
  v_state jsonb;
  v_owned jsonb;
  v_initial_owned jsonb;
  v_results jsonb := '[]'::jsonb;
  v_balance numeric;
  v_cost numeric := 0;
  v_scroll_cost integer := 0;
  v_catalogue_usd_micros bigint;
  v_legendary bigint;
  v_mythic bigint;
  v_cosmic bigint;
  v_divine bigint;
  v_celestial bigint;
  v_focus jsonb;
  v_focus_locked jsonb;
  v_focus_target text;
  v_rarities text[] := ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial'];
  v_weights double precision[];
  v_min_index integer;
  v_rarity_index integer;
  v_rarity text;
  v_class text;
  v_roll double precision;
  v_cursor double precision;
  v_total double precision;
  v_extra_pct double precision;
  v_uid text;
  v_hero jsonb;
  v_result jsonb;
  v_resource jsonb;
  v_scroll_balance bigint;
  v_summons bigint;
  v_revision bigint;
  v_divine_remaining integer;
  v_celestial_remaining integer;
  v_divine_available boolean;
  v_celestial_available boolean;
  i integer;
  j integer;
BEGIN
  IF p_idempotency_key IS NULL OR p_count NOT IN (1, 10, 100)
    OR p_expected_revision IS NULL OR p_expected_revision < 1
    OR p_payment_method NOT IN ('paid', 'scroll')
    OR (p_payment_method = 'paid' AND p_quote_id IS NULL)
    OR (p_payment_method = 'scroll' AND p_quote_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_summon';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.summon_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.summon_count <> p_count
      OR v_existing.expected_revision IS DISTINCT FROM p_expected_revision
      OR v_existing.payment_method <> p_payment_method
      OR v_existing.purchase_quote_id IS DISTINCT FROM p_quote_id THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  IF EXISTS (SELECT 1 FROM public.token_spend_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;

  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  SELECT token_balance, pity_legendary, pity_mythic, pity_cosmic, pity_divine, pity_celestial, ascension_focus
  INTO v_balance, v_legendary, v_mythic, v_cosmic, v_divine, v_celestial, v_focus
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' THEN RAISE EXCEPTION 'invalid_owned_heroes'; END IF;
  IF jsonb_array_length(v_owned) + p_count > COALESCE((v_state->>'heroCapacity')::integer, 500) THEN
    RAISE EXCEPTION 'hero_capacity_exceeded';
  END IF;

  IF p_payment_method = 'paid' THEN
    SELECT * INTO v_quote FROM public.hero_summon_purchase_quotes
    WHERE quote_id = p_quote_id AND player_id = p_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'hero_summon_quote_not_found'; END IF;
    IF v_quote.used_by_idempotency_key IS NOT NULL THEN RAISE EXCEPTION 'hero_summon_quote_used'; END IF;
    IF v_quote.expected_revision <> p_expected_revision OR v_quote.summon_count <> p_count THEN
      RAISE EXCEPTION 'hero_summon_quote_mismatch';
    END IF;
    IF v_quote.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'hero_summon_quote_expired'; END IF;
    SELECT * INTO v_dex FROM public.hero_usd_dex_quotes WHERE quote_id = v_quote.dex_quote_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'dex_quote_unavailable'; END IF;
    v_cost := v_quote.token_cost;
    v_catalogue_usd_micros := v_quote.catalogue_usd_micros;
    IF v_balance < v_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
  ELSE
    v_scroll_cost := p_count;
    v_catalogue_usd_micros := p_count * 20000;
  END IF;

  -- Lock both limited tiers in stable order. The save trigger applies the final
  -- delta while these locks are still held, so concurrent awards cannot exceed
  -- the shared global cap.
  PERFORM rarity FROM public.rarity_supply
  WHERE rarity IN ('celestial', 'divine') ORDER BY rarity FOR UPDATE;
  SELECT max_existing - existing_count INTO v_celestial_remaining
  FROM public.rarity_supply WHERE rarity = 'celestial';
  SELECT max_existing - existing_count INTO v_divine_remaining
  FROM public.rarity_supply WHERE rarity = 'divine';
  IF v_celestial_remaining IS NULL OR v_divine_remaining IS NULL THEN
    RAISE EXCEPTION 'rarity_supply_unavailable';
  END IF;

  v_initial_owned := v_owned;
  v_focus := COALESCE(v_focus, '{}'::jsonb);
  v_focus_locked := v_focus;
  FOR i IN 1..p_count LOOP
    v_divine_available := v_divine_remaining > 0;
    v_celestial_available := v_celestial_remaining > 0;
    v_min_index := CASE
      WHEN v_celestial >= 19999 AND v_celestial_available THEN 9
      WHEN v_divine >= 4999 AND v_divine_available THEN 8
      WHEN v_cosmic >= 1999 THEN 7
      WHEN v_mythic >= 499 THEN 6
      WHEN v_legendary >= 149 THEN 5
      ELSE 1
    END;
    v_weights := ARRAY[62.25,28,5,3,1.2,0.4,0.1,0.04,0.01]::double precision[];
    IF v_min_index = 1 AND v_mythic >= 250 THEN
      v_extra_pct := LEAST(0.3735, (v_mythic - 249) * 0.0015);
      v_weights[1] := v_weights[1] - v_extra_pct;
      v_weights[6] := v_weights[6] + v_extra_pct;
    END IF;
    IF NOT v_divine_available THEN v_weights[8] := 0; END IF;
    IF NOT v_celestial_available THEN v_weights[9] := 0; END IF;
    v_total := 0;
    FOR j IN v_min_index..9 LOOP v_total := v_total + v_weights[j]; END LOOP;
    IF v_total <= 0 THEN RAISE EXCEPTION 'summon_rarity_unavailable'; END IF;
    v_roll := random() * v_total;
    v_cursor := 0;
    v_rarity_index := 0;
    FOR j IN v_min_index..9 LOOP
      v_cursor := v_cursor + v_weights[j];
      IF v_roll < v_cursor THEN v_rarity_index := j; EXIT; END IF;
    END LOOP;
    IF v_rarity_index = 0 THEN
      FOR j IN REVERSE 9..v_min_index LOOP
        IF v_weights[j] > 0 THEN v_rarity_index := j; EXIT; END IF;
      END LOOP;
    END IF;
    IF v_rarity_index = 0 THEN RAISE EXCEPTION 'summon_rarity_unavailable'; END IF;
    v_rarity := v_rarities[v_rarity_index];
    IF v_rarity = 'divine' THEN v_divine_remaining := v_divine_remaining - 1; END IF;
    IF v_rarity = 'celestial' THEN v_celestial_remaining := v_celestial_remaining - 1; END IF;

    v_focus_target := v_focus->>v_rarity;
    IF v_focus_target IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_initial_owned) hero WHERE hero->>'heroId' = v_focus_target
    ) THEN
      v_class := split_part(v_focus_target, '-', 1);
    ELSE
      IF v_focus_target IS NOT NULL THEN v_focus := v_focus - v_rarity; END IF;
      v_class := (ARRAY['shepherd','assassin','knight','druid','archer'])[1 + floor(random() * 5)::integer];
    END IF;
    v_uid := gen_random_uuid()::text;
    v_hero := jsonb_build_object(
      'uid',v_uid,'heroId',v_class||'-'||v_rarity,'level',1,'stars',0,
      'equipped','{}'::jsonb,'xp',0,'isNew',true
    );
    v_results := v_results || jsonb_build_array(v_hero);
    v_owned := v_owned || jsonb_build_array(v_hero);

    IF v_rarity_index >= 5 THEN v_legendary := 0; ELSE v_legendary := v_legendary + 1; END IF;
    IF v_rarity_index >= 6 THEN v_mythic := 0; ELSE v_mythic := v_mythic + 1; END IF;
    IF v_rarity_index >= 7 THEN v_cosmic := 0; ELSE v_cosmic := v_cosmic + 1; END IF;
    IF v_rarity_index >= 8 THEN v_divine := 0;
      ELSIF v_divine_available THEN v_divine := v_divine + 1; END IF;
    IF v_rarity_index >= 9 THEN v_celestial := 0;
      ELSIF v_celestial_available THEN v_celestial := v_celestial + 1; END IF;
  END LOOP;

  v_summons := GREATEST(0, COALESCE((v_state->>'summons')::bigint, 0)) + p_count;
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_owned, true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance - v_cost), true);
  v_state := jsonb_set(v_state, '{summons}', to_jsonb(v_summons), true);
  IF p_payment_method = 'scroll' THEN
    v_resource := public.apply_resource_entries(
      p_player_id, p_idempotency_key, 'hero_summon_scroll',
      encode(extensions.digest(jsonb_build_object('count',p_count,'payment_method','scroll')::text, 'sha256'), 'hex'),
      jsonb_build_array(jsonb_build_object(
        'resource_id','summon_scroll','delta',(-v_scroll_cost)::text,'source_key','free_summon_scroll'
      )), p_expected_revision + 1
    );
    v_scroll_balance := (v_resource#>>'{balances,summon_scroll}')::bigint;
    v_state := jsonb_set(v_state, '{summonScrolls}', to_jsonb(v_scroll_balance), true);
  ELSE
    v_scroll_balance := COALESCE((v_state->>'summonScrolls')::bigint, 0);
  END IF;

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE player_id = p_player_id AND revision = p_expected_revision
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_balance := v_balance - v_cost;
  UPDATE public.players
  SET token_balance = v_balance,
      boost_tokens_spent = boost_tokens_spent + v_cost,
      summons = summons + p_count,
      pity_legendary = v_legendary,
      pity_mythic = v_mythic,
      pity_cosmic = v_cosmic,
      pity_divine = v_divine,
      pity_celestial = v_celestial,
      ascension_focus = v_focus,
      updated_at = clock_timestamp()
  WHERE player_id = p_player_id;
  IF p_payment_method = 'paid' THEN
    INSERT INTO public.token_spend_events(idempotency_key,player_id,amount,action_kind)
    VALUES (p_idempotency_key,p_player_id,v_cost,'hero-summon');
    UPDATE public.hero_summon_purchase_quotes
    SET used_by_idempotency_key = p_idempotency_key, used_at = clock_timestamp()
    WHERE quote_id = p_quote_id;
  END IF;

  v_result := jsonb_build_object(
    'player_id',p_player_id,'heroes',v_results,'payment_method',p_payment_method,
    'spent',v_cost,'scrolls_spent',v_scroll_cost,'summon_scrolls',v_scroll_balance,
    'token_balance',v_balance,'revision',v_revision,
    'catalogue_usd_micros',v_catalogue_usd_micros,
    'pity_legendary',v_legendary,'pity_mythic',v_mythic,
    'pity_cosmic',v_cosmic,'pity_divine',v_divine,'pity_celestial',v_celestial,
    'focus_locked',v_focus_locked,'ascension_focus',v_focus,
    'rarity_capacity',jsonb_build_object(
      'divine',v_divine_remaining > 0,'celestial',v_celestial_remaining > 0
    )
  );
  INSERT INTO public.summon_events(
    idempotency_key,player_id,summon_count,token_cost,result,expected_revision,payment_method,
    scroll_cost,catalogue_usd_micros,purchase_quote_id,dex_quote_id,hero_usd_quote_micros,
    dex_source,dex_mint_address,dex_source_block,dex_observed_at,quote_expires_at
  ) VALUES (
    p_idempotency_key,p_player_id,p_count,v_cost,v_result,p_expected_revision,p_payment_method,
    v_scroll_cost,v_catalogue_usd_micros,p_quote_id,v_quote.dex_quote_id,v_dex.usd_micros_per_hero,
    v_dex.source,v_dex.mint_address,v_dex.source_block,v_dex.observed_at,v_quote.expires_at
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.quote_hero_summon(uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_hero_summon(uuid,uuid,integer,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_hero_summon(uuid,uuid,integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.quote_hero_summon(uuid,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_hero_summon(uuid,uuid,integer,bigint,text,uuid) TO service_role;

COMMENT ON TABLE public.hero_summon_purchase_quotes IS
  'Player/revision/count-bound 60-second HERO/USD quotes for the fixed $0.02-per-roll Summon catalogue.';
COMMENT ON FUNCTION public.quote_hero_summon(uuid,bigint,integer) IS
  'Locks a $0.02-per-roll USD catalogue value to one fresh trusted post-TGE DEX observation.';
COMMENT ON FUNCTION public.settle_hero_summon(uuid,uuid,integer,bigint,text,uuid) IS
  'Atomically settles paid or Scroll Summons through one target-odds, recurring-Pity and global-cap path.';
