-- Every limited Hero source checks the global Divine/Celestial supply before the Hero is granted.
-- 1. A Mailbox Hero (custom grants) waits in the Mailbox when its tier is sold out, instead of
--    failing the whole claim on the supply trigger.
-- 2. A Hero listed on the Market keeps holding its supply slot while in escrow, so a new Hero
--    cannot take that slot and leave the listing impossible to cancel or buy.
BEGIN;

CREATE FUNCTION pg_temp.limited_hero_patch(p_definition text,p_old text,p_new text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_old='' OR length(p_definition)-length(replace(p_definition,p_old,'')) <> length(p_old) THEN
    RAISE EXCEPTION 'limited_hero_patch_anchor_mismatch';
  END IF;
  RETURN replace(p_definition,p_old,p_new);
END $$;

-- Remaining supply for one limited tier, minus Heroes of that tier this transaction already added.
CREATE OR REPLACE FUNCTION public.limited_hero_slots_left(p_rarity text, p_added jsonb, p_before jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_left integer;
BEGIN
  IF p_rarity NOT IN ('divine','celestial') THEN RETURN 2147483647; END IF;
  SELECT max_existing-existing_count INTO v_left FROM public.rarity_supply WHERE rarity=p_rarity FOR UPDATE;
  IF v_left IS NULL THEN RAISE EXCEPTION 'rarity_supply_unavailable'; END IF;
  RETURN v_left
    - (SELECT count(*) FROM jsonb_array_elements(COALESCE(p_added,'[]'::jsonb)) h WHERE split_part(h->>'heroId','-',2)=p_rarity)::integer
    + (SELECT count(*) FROM jsonb_array_elements(COALESCE(p_before,'[]'::jsonb)) h WHERE split_part(h->>'heroId','-',2)=p_rarity)::integer;
END $fn$;
REVOKE ALL ON FUNCTION public.limited_hero_slots_left(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  IF position('v_heroes_limited' in d)=0 THEN
    d:=pg_temp.limited_hero_patch(d,'  v_heroes_full boolean := false;',
      E'  v_heroes_full boolean := false;\n  v_heroes_limited boolean := false;');
    d:=pg_temp.limited_hero_patch(d,
      'IF jsonb_array_length(v_heroes) >= COALESCE((v_state->>''heroCapacity'')::integer, 0) THEN v_heroes_full := true; CONTINUE; END IF;',
      'IF jsonb_array_length(v_heroes) >= COALESCE((v_state->>''heroCapacity'')::integer, 0) THEN v_heroes_full := true; CONTINUE; END IF;
        IF public.limited_hero_slots_left(split_part(v_reward.payload->>''hero_id'',''-'',2), v_heroes, v_state->''ownedHeroes'') <= 0 THEN v_heroes_limited := true; CONTINUE; END IF;');
    d:=pg_temp.limited_hero_patch(d,'''heroes_full'', v_heroes_full,','''heroes_full'', v_heroes_full, ''heroes_limited'', v_heroes_limited,');
    EXECUTE d;
  END IF;

  -- Listing: the supply trigger releases the slot when the Hero leaves ownedHeroes; hold it again.
  d:=pg_get_functiondef('public.seeker_settle_market_list_hero(uuid,uuid,text,bigint)'::regprocedure);
  IF position('market escrow keeps' in d)=0 THEN
    d:=pg_temp.limited_hero_patch(d,
      E'  UPDATE public.players SET heroes_owned = jsonb_array_length(v_owned) WHERE player_id = p_player_id\n    RETURNING token_balance INTO v_balance;',
      E'  UPDATE public.players SET heroes_owned = jsonb_array_length(v_owned) WHERE player_id = p_player_id\n    RETURNING token_balance INTO v_balance;\n  -- market escrow keeps the limited supply slot\n  UPDATE public.rarity_supply SET existing_count = existing_count + 1, updated_at = clock_timestamp()\n    WHERE rarity = split_part(v_target->>''heroId'', ''-'', 2) AND rarity IN (''divine'', ''celestial'');');
    EXECUTE d;
  END IF;
END
$patch$;

-- Cancel and buy: release the held slot just before the Hero re-enters a save (the trigger takes it back).
DO $patch$
DECLARE d text; signature text; v_hero_expr text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.seeker_settle_market_cancel_hero(uuid,uuid,uuid)','public.seeker_settle_market_buy_hero(uuid,uuid)'] LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    IF position('market escrow releases' in d)>0 THEN CONTINUE; END IF;
    d:=pg_temp.limited_hero_patch(d,
      E'  v_state := jsonb_set(v_state, ''{ownedHeroes}'', v_owned, true);\n',
      E'  v_state := jsonb_set(v_state, ''{ownedHeroes}'', v_owned, true);\n  -- market escrow releases the held limited supply slot\n  UPDATE public.rarity_supply SET existing_count = existing_count - 1, updated_at = clock_timestamp()\n    WHERE rarity = split_part(v_listing.hero->>''heroId'', ''-'', 2) AND rarity IN (''divine'', ''celestial'');\n');
    EXECUTE d;
  END LOOP;
END
$patch$;

-- Backfill: limited Heroes already in escrow take their slots back.
DO $backfill$
BEGIN
  IF to_regclass('public.limited_hero_escrow_backfill') IS NULL THEN
    CREATE TABLE public.limited_hero_escrow_backfill(rarity text PRIMARY KEY, held integer NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO public.limited_hero_escrow_backfill(rarity,held)
    SELECT split_part(hero->>'heroId','-',2),count(*) FROM public.market_hero_listings
    WHERE status='active' AND split_part(hero->>'heroId','-',2) IN ('divine','celestial') GROUP BY 1;
    UPDATE public.rarity_supply s SET existing_count=s.existing_count+b.held, updated_at=clock_timestamp()
    FROM public.limited_hero_escrow_backfill b WHERE b.rarity=s.rarity;
    IF EXISTS (SELECT 1 FROM public.rarity_supply WHERE existing_count>max_existing) THEN
      RAISE EXCEPTION 'limited_hero_escrow_backfill_over_supply';
    END IF;
  END IF;
END
$backfill$;
REVOKE ALL ON public.limited_hero_escrow_backfill FROM PUBLIC,anon,authenticated,service_role,heroloop_api_runtime;

DROP FUNCTION pg_temp.limited_hero_patch(text,text,text);
COMMIT;
