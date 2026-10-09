-- Founder 2026-10-09: custom items and heroes built in the Founder Control Center and sent through letters.
-- Two kinds: account-bound ("without ID": stays on the account, can never be listed on a market) and ordinary
-- tradeable copies ("with ID": every recipient gets a fresh unique item or hero). Bound state is server-owned:
-- player_items.bound for items and public.player_bound_heroes for heroes; both market listing paths refuse them.
-- The client only shows the flag. Builder entries in the Reward Catalog: kind item_design (base item, rarity, level
-- range, roll quality range, chosen stat lines, enchant) is minted per recipient when the letter is sent, through
-- public.mail_catalog_attachments, and arrives as an ordinary item attachment; kind hero (hero, level, stars) becomes a
-- fresh hero on Claim. Limited rarities keep their rules: cursed/immortal/god are craft-only, divine/celestial use
-- the shared rarity_supply (heroes through the existing save trigger).
BEGIN;

ALTER TABLE public.player_items ADD COLUMN IF NOT EXISTS bound boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.player_bound_heroes (
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  hero_uid text NOT NULL CHECK (char_length(hero_uid) BETWEEN 1 AND 128),
  source text NOT NULL DEFAULT 'mail_grant',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (player_id, hero_uid)
);
ALTER TABLE public.player_bound_heroes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_bound_heroes FROM PUBLIC;

-- Markets: a bound item can never be listed, whatever function inserts the listing.
CREATE OR REPLACE FUNCTION public.refuse_bound_item_listing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.player_items WHERE id = NEW.item_id AND bound) THEN RAISE EXCEPTION 'item_bound'; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS refuse_bound_item_listing ON public.market_item_listings;
CREATE TRIGGER refuse_bound_item_listing BEFORE INSERT OR UPDATE OF item_id ON public.market_item_listings
  FOR EACH ROW EXECUTE FUNCTION public.refuse_bound_item_listing();

DO $patch$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('public.seeker_settle_market_list_hero(uuid,uuid,text,bigint)'::regprocedure);
  IF position('hero_bound' in d) > 0 THEN RETURN; END IF;
  n := replace(d, E'  IF p_price < 1 OR p_price > 1000000000 THEN RAISE EXCEPTION ''invalid_market_price''; END IF;\n',
    E'  IF p_price < 1 OR p_price > 1000000000 THEN RAISE EXCEPTION ''invalid_market_price''; END IF;\n  IF EXISTS (SELECT 1 FROM public.player_bound_heroes WHERE player_id = p_player_id AND hero_uid = p_hero_uid) THEN RAISE EXCEPTION ''hero_bound''; END IF;\n');
  IF n = d THEN RAISE EXCEPTION 'bound_hero_market_patch_failed'; END IF;
  EXECUTE n;
END
$patch$;

-- The loaded save and Mailbox items carry the ledger's bound flag for display.
DO $patch$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('heroloop_api.game_state_load_context(uuid)'::regprocedure);
  IF position('item.bound' in d) > 0 THEN RETURN; END IF;
  n := replace(d, E'''item_roll_version'', item.item_roll_version', E'''item_roll_version'', item.item_roll_version, ''bound'', item.bound');
  IF n = d THEN RAISE EXCEPTION 'bound_load_context_patch_failed'; END IF;
  EXECUTE n;
END
$patch$;
DO $patch$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('public.mail_item_json(public.player_items)'::regprocedure);
  IF position('bound' in d) > 0 THEN RETURN; END IF;
  n := replace(d, E'''serverOwned'', true', E'''serverOwned'', true,\n    ''bound'', p_item.bound');
  IF n = d THEN RAISE EXCEPTION 'bound_mail_item_patch_failed'; END IF;
  EXECUTE n;
END
$patch$;

-- Item stats for a custom design: the v5 roll with a chosen roll quality range (0 = weakest, 1 = strongest
-- natural roll) and optionally chosen stat lines (each must belong to the slot's pool).
CREATE OR REPLACE FUNCTION public.roll_item_stats_v5_custom(p_slot text, p_rarity text, p_item_level integer, p_base_item_id text,
  p_quality_min numeric, p_quality_max numeric, p_stat_keys text[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = public
AS $function$
DECLARE
  v_lines integer; v_rarity_mult numeric; v_pool text[]; v_class text; v_key text; v_choice integer; v_curve text;
  v_min numeric; v_max numeric; v_rarity_factor numeric; v_level_mult numeric; v_value numeric; v_percent boolean;
  v_stats jsonb := '[]'::jsonb; v_keys text[] := '{}'; i integer;
BEGIN
  IF p_quality_min IS NULL OR p_quality_max IS NULL OR p_quality_min < 0 OR p_quality_max > 1 OR p_quality_min > p_quality_max THEN
    RAISE EXCEPTION 'invalid_item_design';
  END IF;
  v_lines := CASE p_rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 WHEN 'epic' THEN 2 WHEN 'legendary' THEN 3 WHEN 'mythic' THEN 3 WHEN 'cosmic' THEN 4 WHEN 'divine' THEN 4 WHEN 'celestial' THEN 5 WHEN 'cursed' THEN 5 WHEN 'immortal' THEN 6 WHEN 'god' THEN 6 ELSE NULL END;
  v_rarity_mult := CASE p_rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1.15 WHEN 'rare' THEN 1.35 WHEN 'epic' THEN 1.6 WHEN 'legendary' THEN 1.9 WHEN 'mythic' THEN 2.25 WHEN 'cosmic' THEN 2.65 WHEN 'divine' THEN 3.1 WHEN 'celestial' THEN 3.6 WHEN 'cursed' THEN 4.1 WHEN 'immortal' THEN 4.7 WHEN 'god' THEN 5.4 ELSE NULL END;
  IF p_slot IS NULL OR p_base_item_id IS NULL OR v_lines IS NULL OR p_item_level NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_item_design'; END IF;
  v_class := split_part(p_base_item_id, '-', 2);
  v_pool := CASE p_slot
    WHEN 'class_weapon' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp']
    WHEN 'helmet' THEN ARRAY['hp','def','dodge','critChance','critDamage','goldBonus','xpBonus']
    WHEN 'chest' THEN ARRAY['hp','def','dodge','atk','critDamage','goldBonus','xpBonus']
    WHEN 'gloves' THEN ARRAY['atk','atkSpeed','critChance','critDamage','def','goldBonus','xpBonus']
    WHEN 'boots' THEN ARRAY['hp','def','dodge','atkSpeed','critChance','goldBonus','xpBonus']
    WHEN 'ring' THEN ARRAY['atk','critChance','critDamage','dodge','goldBonus','xpBonus','hp']
    WHEN 'amulet' THEN ARRAY['hp','def','critDamage','dodge','goldBonus','xpBonus','critChance']
    WHEN 'offhand' THEN CASE v_class
      WHEN 'warrior' THEN ARRAY['hp','def','dodge','atk','critChance'] WHEN 'mage' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp']
      WHEN 'assassin' THEN ARRAY['atk','atkSpeed','critChance','critDamage','dodge'] WHEN 'druid' THEN ARRAY['hp','def','atk','critChance','critDamage']
      WHEN 'crossbowman' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp'] ELSE NULL END
    ELSE NULL END;
  IF v_pool IS NULL THEN RAISE EXCEPTION 'invalid_item_design'; END IF;
  v_lines := LEAST(v_lines, array_length(v_pool, 1));
  -- Chosen lines first (in the given order), the rest at random from the remaining pool.
  FOREACH v_key IN ARRAY COALESCE(p_stat_keys, '{}') LOOP
    IF NOT v_key = ANY(v_pool) OR v_key = ANY(v_keys) THEN RAISE EXCEPTION 'invalid_item_design'; END IF;
    v_keys := v_keys || v_key;
  END LOOP;
  IF array_length(v_keys, 1) > v_lines THEN RAISE EXCEPTION 'invalid_item_design'; END IF;
  v_pool := ARRAY(SELECT key FROM unnest(v_pool) key WHERE NOT key = ANY(v_keys));
  WHILE COALESCE(array_length(v_keys, 1), 0) < v_lines LOOP
    v_choice := 1 + floor(random() * array_length(v_pool, 1))::integer;
    v_keys := v_keys || v_pool[v_choice];
    v_pool := array_remove(v_pool, v_pool[v_choice]);
  END LOOP;
  FOREACH v_key IN ARRAY v_keys LOOP
    SELECT stat_min, stat_max, stat_curve INTO v_min, v_max, v_curve FROM (VALUES
      ('hp', 3.658817373::numeric, 4.573521716::numeric, 'main'), ('atk', 0.914704343::numeric, 1.143380429::numeric, 'main'),
      ('def', 0.335391593::numeric, 0.419239491::numeric, 'main'), ('dodge', 0.001553236::numeric, 0.001941545::numeric, 'slow'),
      ('critChance', 0.003106472::numeric, 0.00388309::numeric, 'slow'), ('critDamage', 0.004400835::numeric, 0.005501044::numeric, 'slow'),
      ('atkSpeed', 0.003235908::numeric, 0.004044885::numeric, 'slow'), ('goldBonus', 0.005177453::numeric, 0.006471816::numeric, 'economy'),
      ('xpBonus', 0.005177453::numeric, 0.006471816::numeric, 'economy')
    ) AS ranges(stat_key, stat_min, stat_max, stat_curve) WHERE stat_key = v_key;
    v_percent := v_key NOT IN ('hp', 'atk', 'def');
    v_level_mult := 1 + (LEAST(99, p_item_level) - 1) * CASE WHEN v_curve = 'main' THEN 0.015 ELSE 0.005 END
      + 0.2 * floor((LEAST(99, p_item_level) - 1) / 15);
    v_rarity_factor := CASE WHEN v_curve = 'main' THEN v_rarity_mult ELSE sqrt(v_rarity_mult) END;
    v_value := (v_min + (p_quality_min + random() * (p_quality_max - p_quality_min)) * (v_max - v_min)) * v_rarity_factor * v_level_mult;
    v_value := round(v_value, 6);
    IF p_item_level > 99 AND v_key IN ('hp','atk','def') THEN v_value := round(v_value * (1 + (p_item_level - 99) * .009), 6); END IF;
    v_stats := v_stats || jsonb_build_array(jsonb_build_object('key', v_key, 'value', v_value, 'isPercent', v_percent));
  END LOOP;
  RETURN v_stats;
END
$function$;
REVOKE ALL ON FUNCTION public.roll_item_stats_v5_custom(text,text,integer,text,numeric,numeric,text[]) FROM PUBLIC;

-- Designs. Item: {"base_item_id","slot","rarity","level_min","level_max","quality_min","quality_max","stat_keys":[],"enchant_level"}.
-- Hero: {"hero_id","level","stars"}. "bound" decides whether copies are account-bound.
CREATE OR REPLACE FUNCTION public.validate_grant_design(p_kind text, p_design jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public
AS $function$
DECLARE v_base text; v_slot text; v_rarity text; v_rarities text := '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)';
BEGIN
  IF jsonb_typeof(p_design) <> 'object' THEN RAISE EXCEPTION 'invalid_item_design'; END IF;
  IF p_kind = 'item_design' THEN
    v_base := p_design->>'base_item_id';
    v_rarity := substring(v_base from v_rarities || '$');
    v_slot := CASE
      WHEN v_base ~ ('^weapon-(mage|assassin|warrior|druid|crossbowman)-' || v_rarities || '$') THEN 'class_weapon'
      WHEN v_base ~ ('^offhand-(mage|assassin|warrior|druid|crossbowman)-' || v_rarities || '$') THEN 'offhand'
      WHEN v_base ~ ('^armor-' || v_rarities || '$') THEN 'chest'
      WHEN v_base ~ ('^(helmet|gloves|boots|ring|amulet)-' || v_rarities || '$') THEN split_part(v_base, '-', 1)
      ELSE NULL END;
    IF v_slot IS NULL OR jsonb_typeof(p_design->'level_min') <> 'number' OR jsonb_typeof(p_design->'level_max') <> 'number'
      OR (p_design->>'level_min')::integer NOT BETWEEN 1 AND 200 OR (p_design->>'level_max')::integer NOT BETWEEN (p_design->>'level_min')::integer AND 200
      OR jsonb_typeof(p_design->'quality_min') <> 'number' OR jsonb_typeof(p_design->'quality_max') <> 'number'
      OR (p_design->>'quality_min')::numeric NOT BETWEEN 0 AND 1 OR (p_design->>'quality_max')::numeric NOT BETWEEN (p_design->>'quality_min')::numeric AND 1
      OR COALESCE((p_design->>'enchant_level')::integer, 0) NOT BETWEEN 0 AND 20
      OR (p_design ? 'stat_keys' AND jsonb_typeof(p_design->'stat_keys') <> 'array') THEN RAISE EXCEPTION 'invalid_item_design'; END IF;
    -- A trial roll proves the chosen stat lines fit the slot.
    PERFORM public.roll_item_stats_v5_custom(v_slot, v_rarity, (p_design->>'level_min')::integer, v_base, 0, 0,
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_design->'stat_keys', '[]'::jsonb))));
    RETURN jsonb_build_object('base_item_id', v_base, 'slot', v_slot, 'rarity', v_rarity,
      'level_min', (p_design->>'level_min')::integer, 'level_max', (p_design->>'level_max')::integer,
      'quality_min', (p_design->>'quality_min')::numeric, 'quality_max', (p_design->>'quality_max')::numeric,
      'stat_keys', COALESCE(p_design->'stat_keys', '[]'::jsonb), 'enchant_level', COALESCE((p_design->>'enchant_level')::integer, 0));
  ELSIF p_kind = 'hero' THEN
    IF p_design->>'hero_id' !~ ('^(knight|archer|assassin|shepherd|druid)-' || v_rarities || '$')
      OR jsonb_typeof(p_design->'level') <> 'number' OR (p_design->>'level')::integer NOT BETWEEN 1 AND 200
      OR jsonb_typeof(p_design->'stars') <> 'number' OR (p_design->>'stars')::integer NOT BETWEEN 0 AND 20 THEN RAISE EXCEPTION 'invalid_hero_design'; END IF;
    RETURN jsonb_build_object('hero_id', p_design->>'hero_id', 'level', (p_design->>'level')::integer, 'stars', (p_design->>'stars')::integer);
  END IF;
  RAISE EXCEPTION 'invalid_item_design';
END
$function$;
REVOKE ALL ON FUNCTION public.validate_grant_design(text,jsonb) FROM PUBLIC;

-- Catalog: builder designs and heroes join Gold, resources, chests and fixed item templates.
ALTER TABLE public.reward_catalog ADD COLUMN IF NOT EXISTS design jsonb;
ALTER TABLE public.reward_catalog ADD COLUMN IF NOT EXISTS bound boolean NOT NULL DEFAULT false;
ALTER TABLE public.reward_catalog DROP CONSTRAINT IF EXISTS reward_catalog_kind_check;
ALTER TABLE public.reward_catalog ADD CONSTRAINT reward_catalog_kind_check CHECK (kind IN ('gold', 'resource', 'chest', 'item', 'item_design', 'hero'));
ALTER TABLE public.reward_catalog DROP CONSTRAINT IF EXISTS reward_catalog_design_check;
ALTER TABLE public.reward_catalog ADD CONSTRAINT reward_catalog_design_check CHECK ((kind IN ('item_design', 'hero')) = (design IS NOT NULL));

-- Letters: a hero attachment carries its design; the hero is made when the letter is claimed.
ALTER TABLE public.player_mail_rewards DROP CONSTRAINT IF EXISTS player_mail_rewards_kind_check;
ALTER TABLE public.player_mail_rewards ADD CONSTRAINT player_mail_rewards_kind_check CHECK (kind IN ('chest', 'gold', 'resource', 'item', 'hero'));
DO $patch$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('public.mail_attachment_payload(jsonb)'::regprocedure);
  IF position('validate_grant_design' in d) > 0 THEN RETURN; END IF;
  n := replace(d, E'  END IF;\n  RAISE EXCEPTION ''invalid_mail_attachment'';\nEND',
E'  ELSIF p_attachment->>''kind'' = ''hero'' THEN\n    RETURN public.validate_grant_design(''hero'', p_attachment->''design'')\n      || jsonb_build_object(''bound'', COALESCE((p_attachment->>''bound'')::boolean, false), ''title'', left(COALESCE(p_attachment->>''title'', ''''), 60));\n  END IF;\n  RAISE EXCEPTION ''invalid_mail_attachment'';\nEND');
  IF n = d THEN RAISE EXCEPTION 'grant_attachment_patch_failed'; END IF;
  EXECUTE n;
END
$patch$;

-- One fresh item for a player from a builder design (limited rarities reserve the shared supply, like catalog templates).
CREATE OR REPLACE FUNCTION public.mail_create_item(p_player_id uuid, p_design jsonb)
RETURNS public.player_items LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE v_level integer; v_stats jsonb; v_item public.player_items%ROWTYPE;
BEGIN
  IF p_design->>'rarity' IN ('divine', 'celestial') THEN
    UPDATE public.rarity_supply SET existing_count = existing_count + 1, updated_at = now()
    WHERE rarity = p_design->>'rarity' AND existing_count < max_existing;
    IF NOT FOUND THEN RAISE EXCEPTION 'rarity_supply_exhausted'; END IF;
  END IF;
  v_level := (p_design->>'level_min')::integer + floor(random() * ((p_design->>'level_max')::integer - (p_design->>'level_min')::integer + 1))::integer;
  v_stats := public.roll_item_stats_v5_custom(p_design->>'slot', p_design->>'rarity', v_level, p_design->>'base_item_id',
    (p_design->>'quality_min')::numeric, (p_design->>'quality_max')::numeric, ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_design->'stat_keys', '[]'::jsonb))));
  INSERT INTO public.player_items(player_id, base_item_id, slot, rarity, item_level, stats, enchant_level, power, item_roll_version, enchant_stats_version, source_kind, bound, locked)
  VALUES (p_player_id, p_design->>'base_item_id', p_design->>'slot', p_design->>'rarity', v_level, v_stats, (p_design->>'enchant_level')::integer,
    public.calculate_item_power_v5(v_stats, (p_design->>'enchant_level')::integer), 5, 4, 'mail_grant', COALESCE((p_design->>'bound')::boolean, false),
    p_design->>'rarity' IN ('divine', 'celestial'))
  RETURNING * INTO v_item;
  RETURN v_item;
END
$function$;
REVOKE ALL ON FUNCTION public.mail_create_item(uuid,jsonb) FROM PUBLIC;

-- Sending: builder designs are minted for each recipient inside the letter's transaction; heroes ride as a design.
DO $patch$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('public.mail_catalog_attachments(uuid,jsonb)'::regprocedure);
  IF position('item_design' in d) > 0 THEN RETURN; END IF;
  n := replace(d, E'        ELSE\n          v_rarity:=substring(c.base_item_id',
E'        ELSIF c.kind=''item_design'' THEN\n          item:=public.mail_create_item(p_player, public.validate_grant_design(''item_design'', c.design) || jsonb_build_object(''bound'', c.bound));\n          attachments:=attachments||jsonb_build_array(jsonb_build_object(''kind'',''item'',''item_id'',item.id,''item'',public.mail_item_json(item)));\n        ELSIF c.kind=''hero'' THEN\n          attachments:=attachments||jsonb_build_array(jsonb_build_object(''kind'',''hero'',''design'',c.design,''bound'',c.bound,''title'',c.title));\n        ELSE\n          v_rarity:=substring(c.base_item_id');
  IF n = d THEN RAISE EXCEPTION 'grant_catalog_attachment_patch_failed'; END IF;
  EXECUTE n;
END
$patch$;

-- Claim: a hero needs room under heroCapacity; what does not fit stays attached.
DO $patch$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  IF position('player_bound_heroes' in d) > 0 THEN RETURN; END IF;
  n := replace(d, E'  v_resources_full boolean := false;\n', E'  v_resources_full boolean := false;\n  v_heroes jsonb;\n  v_heroes_full boolean := false;\n  v_hero_uid text;\n');
  n := replace(n, E'  v_chests := COALESCE(v_state->''chests'', ''[]''::jsonb);\n',
    E'  v_chests := COALESCE(v_state->''chests'', ''[]''::jsonb);\n  v_heroes := COALESCE(v_state->''ownedHeroes'', ''[]''::jsonb);\n');
  n := replace(n, E'      ELSIF v_reward.kind = ''resource'' THEN\n',
E'      ELSIF v_reward.kind = ''hero'' THEN\n        IF jsonb_array_length(v_heroes) >= COALESCE((v_state->>''heroCapacity'')::integer, 0) THEN v_heroes_full := true; CONTINUE; END IF;\n        v_hero_uid := gen_random_uuid()::text;\n        v_heroes := v_heroes || jsonb_build_array(jsonb_build_object(''uid'', v_hero_uid, ''heroId'', v_reward.payload->>''hero_id'', ''level'', (v_reward.payload->>''level'')::integer,\n          ''stars'', (v_reward.payload->>''stars'')::integer, ''xp'', 0, ''locked'', false, ''equipped'', ''{}''::jsonb, ''isNew'', true)\n          || CASE WHEN COALESCE((v_reward.payload->>''bound'')::boolean, false) THEN jsonb_build_object(''bound'', true) ELSE ''{}''::jsonb END);\n        IF COALESCE((v_reward.payload->>''bound'')::boolean, false) THEN\n          INSERT INTO public.player_bound_heroes(player_id, hero_uid) VALUES (p_player_id, v_hero_uid);\n        END IF;\n      ELSIF v_reward.kind = ''resource'' THEN\n');
  n := replace(n, E'    v_state := jsonb_set(v_state, ''{chests}'', v_chests, true);\n',
    E'    v_state := jsonb_set(v_state, ''{chests}'', v_chests, true);\n    v_state := jsonb_set(v_state, ''{ownedHeroes}'', v_heroes, true);\n');
  n := replace(n, E'''resources_full'', v_resources_full,', E'''resources_full'', v_resources_full, ''heroes_full'', v_heroes_full,');
  n := replace(n, E'''resources'', public.resource_snapshot(p_player_id)', E'''resources'', public.resource_snapshot(p_player_id), ''owned_heroes'', v_heroes');
  IF position('player_bound_heroes' in n) = 0 OR position('{ownedHeroes}' in n) = 0
    OR position('heroes_full'', v_heroes_full' in n) = 0 OR position('''owned_heroes'', v_heroes' in n) = 0 OR position('v_heroes := COALESCE' in n) = 0 THEN
    RAISE EXCEPTION 'mail_claim_grant_patch_failed';
  END IF;
  EXECUTE n;
END
$patch$;

COMMIT;
