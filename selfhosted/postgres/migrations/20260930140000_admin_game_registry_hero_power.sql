\set ON_ERROR_STOP on

-- Game registry, second slice (HL-TASK-20260930122854-F4718C): a hero's real
-- Power. The first slice could only show level, Stars and the sum of item
-- power, because Power is derived in the game server's code and stored per
-- account, never per hero. This adds the same derivation as a database
-- function so the hero register can sort every hero by it and an account's
-- profile can show it, still without any grant on a game table.

-- Hero Power exactly as the game server derives it for rewards
-- (managed/functions/player-sync/authority.mjs canonicalStats and
-- balance-v6.mjs): archetype base stats scaled by rarity, level, Stars and
-- mastery, plus the worn items with Enchant, Set Bonus and Resonance, turned
-- into damage per second, effective HP and sustain. It is a second copy of a
-- formula the game owns, so scripts/admin-game-registry-parity.mjs compares it
-- with the game's own code inside check:admin-foundation and fails on drift.
-- Arithmetic stays in double precision and rounds as JavaScript does, so the
-- two agree to the last digit that is shown. A hero whose id the game does not
-- rank (no known class or rarity) has no Power here either.
CREATE OR REPLACE FUNCTION admin.game_registry_hero_power(p_hero_id text, p_level numeric, p_stars numeric, p_items jsonb)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_id text := coalesce(p_hero_id, '');
  v_split integer;
  v_class text;
  v_rarity text;
  v_tier integer;
  v_scale double precision;
  -- archetype: hp, atk, def, speed, growth x3, crit, crit damage, dps, hp mult, regen, dodge, attack speed, caps x5
  a double precision[];
  v_level integer := least(99, greatest(1, floor(coalesce(p_level, 0))::integer));
  v_stars integer := least(20, greatest(0, floor(coalesce(p_stars, 0))::integer));
  v_items jsonb := CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END;
  v_count integer;
  v_set double precision := 0;
  v_resonance double precision := 0;
  v_item jsonb;
  v_stat jsonb;
  v_key text;
  v_version numeric;
  v_v3 boolean;
  v_enchant integer;
  v_base_main double precision;
  v_base_other double precision;
  v_extra double precision;
  v_multiplier double precision;
  v_value double precision;
  v_percent boolean;
  v_effective double precision;
  v_slot text;
  v_implicit_scale double precision;
  v_item_level integer;
  i_hp double precision := 0;
  i_atk double precision := 0;
  i_def double precision := 0;
  i_speed double precision := 0;
  i_crit double precision := 0;
  i_crit_damage double precision := 0;
  i_dodge double precision := 0;
  v_star_scale double precision;
  v_mastery double precision;
  v_growth double precision;
  v_hp double precision;
  v_atk double precision;
  v_def double precision;
  v_speed double precision;
  v_attack_speed double precision;
  v_interval double precision;
  v_crit double precision;
  v_crit_damage double precision;
  v_dodge double precision;
  v_dps double precision;
  v_mitigation double precision;
BEGIN
  v_id := CASE v_id
    WHEN 'ironfoot' THEN 'knight-common' WHEN 'greenscout' THEN 'archer-common' WHEN 'cutpurse' THEN 'assassin-common'
    WHEN 'acolyte' THEN 'shepherd-common' WHEN 'shrubmage' THEN 'druid-common' WHEN 'dawnknight' THEN 'knight-uncommon'
    WHEN 'thornranger' THEN 'archer-uncommon' WHEN 'moonpriest' THEN 'shepherd-uncommon' WHEN 'grovekeeper' THEN 'druid-uncommon'
    WHEN 'stoneguard' THEN 'knight-rare' WHEN 'stormsniper' THEN 'archer-rare' WHEN 'duskblade' THEN 'assassin-rare'
    WHEN 'irondruid' THEN 'druid-rare' WHEN 'voidknight' THEN 'knight-epic' WHEN 'starfall' THEN 'archer-epic'
    WHEN 'deathwhisper' THEN 'assassin-epic' WHEN 'solarsage' THEN 'shepherd-epic' WHEN 'stormdruid' THEN 'druid-epic'
    WHEN 'sunpaladin' THEN 'knight-legendary' WHEN 'eternalbow' THEN 'archer-legendary' WHEN 'soulreaper' THEN 'assassin-legendary'
    WHEN 'divinehealer' THEN 'shepherd-legendary' WHEN 'worldtree' THEN 'druid-legendary' WHEN 'worldender' THEN 'knight-mythic'
    WHEN 'cosmosarcher' THEN 'archer-mythic' WHEN 'voidstalker' THEN 'assassin-mythic' WHEN 'ancientknight' THEN 'knight-mythic'
    WHEN 'relicdruid' THEN 'druid-mythic' WHEN 'cursedknight' THEN 'knight-mythic' WHEN 'cursedarcher' THEN 'archer-mythic'
    WHEN 'cosmicmage' THEN 'shepherd-cosmic' WHEN 'divine' THEN 'shepherd-divine'
    ELSE v_id END;
  v_split := length(v_id) - position('-' IN reverse(v_id));
  IF position('-' IN v_id) = 0 THEN RETURN NULL; END IF;
  v_class := left(v_id, v_split);
  v_rarity := substr(v_id, v_split + 2);
  v_tier := array_position(ARRAY['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'], v_rarity);
  a := CASE v_class
    WHEN 'shepherd' THEN ARRAY[340, 86, 12, 104, .007, .0115, .0035, .12, 1.85, 1.1, 1, 0, 0, 0, .4, .15, .5, 2.3, .2]
    WHEN 'assassin' THEN ARRAY[310, 78, 10, 130, .0065, .01, .003, .23, 2, 1, 1, 0, .05, 0, .4, .3, .6, 2.5, .25]
    WHEN 'knight' THEN ARRAY[500, 56, 28, 92, .012, .0055, .009, .08, 1.6, 1, 1.15, 0, 0, 0, .6, .1, .45, 2, .2]
    WHEN 'druid' THEN ARRAY[450, 60, 20, 100, .0105, .0065, .0065, .1, 1.7, 1, 1.1, .004, 0, 0, .5, .15, .45, 2.1, .2]
    WHEN 'archer' THEN ARRAY[360, 70, 14, 124, .008, .009, .0045, .15, 2.15, 1, 1, 0, 0, .08, .45, .2, .55, 2.7, .25]
  END::double precision[];
  IF a IS NULL OR v_tier IS NULL THEN RETURN NULL; END IF;
  v_tier := v_tier - 1;
  v_scale := (ARRAY[1, 1.441163, 2.147372, 3.084756, 4.435796, 6.370091, 9.143236, 13.119459, 18.814853]::double precision[])[v_tier + 1];

  -- Set Bonus needs all eight slots in one rarity; Resonance follows the lowest Enchant of a full set.
  v_count := jsonb_array_length(v_items);
  IF v_count = 8 THEN
    IF (SELECT count(DISTINCT coalesce(e->>'rarity', '')) = 1 FROM jsonb_array_elements(v_items) e) THEN
      v_set := coalesce((jsonb_build_object(
        'common', 5, 'uncommon', 10, 'rare', 15, 'epic', 20, 'legendary', 30, 'mythic', 40, 'relic', 40,
        'cosmic', 50, 'divine', 60, 'celestial', 70, 'cursed', 80, 'immortal', 90, 'god', 100
      )->>(v_items->0->>'rarity'))::double precision, 0) / 100;
    END IF;
    v_resonance := (ARRAY[0, 1, 2, 4, 7, 11, 16, 22, 30, 39, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]::double precision[])[
      1 + (SELECT min(least(20, greatest(0, CASE WHEN jsonb_typeof(e->'enchant_level') = 'number' THEN floor((e->>'enchant_level')::numeric)::integer ELSE 0 END)))
           FROM jsonb_array_elements(v_items) e)
    ] / 100;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_version := CASE WHEN jsonb_typeof(v_item->'enchant_stats_version') = 'number' THEN (v_item->>'enchant_stats_version')::numeric END;
    v_v3 := v_version IS NOT DISTINCT FROM 3;
    v_enchant := least(20, greatest(0, CASE WHEN jsonb_typeof(v_item->'enchant_level') = 'number' THEN floor((v_item->>'enchant_level')::numeric)::integer ELSE 0 END));
    -- Enchant multiplier per stat family: version 4 is Balance v6 (+11% a level),
    -- version 3 gave 10% to hp/atk/def and 5% to the rest, older items 10% to all.
    v_base_main := CASE WHEN v_version IS NOT DISTINCT FROM 4 THEN 1::double precision + v_enchant * 0.11::double precision ELSE 1::double precision + v_enchant * 0.1::double precision END;
    v_base_other := CASE WHEN v_version IS NOT DISTINCT FROM 4 THEN v_base_main
                         WHEN v_v3 THEN 1::double precision + v_enchant * 0.05::double precision ELSE v_base_main END;
    v_extra := CASE WHEN v_v3 THEN 0 ELSE v_resonance END;

    FOR v_stat IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_item->'stats') = 'array' THEN v_item->'stats' ELSE '[]'::jsonb END) LOOP
      v_key := v_stat->>'key';
      CONTINUE WHEN v_key IS NULL OR v_key NOT IN ('hp', 'atk', 'def', 'atkSpeed', 'critChance', 'critDamage', 'dodge');
      CONTINUE WHEN jsonb_typeof(v_stat->'value') IS DISTINCT FROM 'number';
      v_value := least(1000000000::double precision, greatest(-1000000000::double precision, (v_stat->>'value')::double precision));
      v_percent := v_stat->'isPercent' = 'true'::jsonb;
      v_multiplier := (CASE WHEN v_key IN ('hp', 'atk', 'def') THEN v_base_main ELSE v_base_other END) + v_set + v_extra;
      v_effective := CASE WHEN v_percent THEN floor(v_value * v_multiplier * 1000 + 0.5) / 1000 ELSE floor(v_value * v_multiplier + 0.5) END;
      CASE v_key
        WHEN 'hp' THEN i_hp := i_hp + v_effective;
        WHEN 'atk' THEN i_atk := i_atk + v_effective;
        WHEN 'def' THEN i_def := i_def + v_effective;
        -- Legacy flat Attack Speed rolls are milliseconds against a one-second reference.
        WHEN 'atkSpeed' THEN i_speed := i_speed + v_effective / (CASE WHEN v_percent THEN 1 ELSE 1000 END);
        WHEN 'critChance' THEN i_crit := i_crit + v_effective;
        WHEN 'critDamage' THEN i_crit_damage := i_crit_damage + v_effective;
        ELSE i_dodge := i_dodge + v_effective;
      END CASE;
    END LOOP;

    -- The fixed base stat every item carries for the slot it is worn in.
    v_slot := coalesce(v_item->>'slot', '');
    v_slot := CASE v_slot WHEN 'weapon' THEN 'class_weapon' WHEN 'armor' THEN 'chest' WHEN 'ring1' THEN 'ring' WHEN 'ring2' THEN 'ring' ELSE v_slot END;
    v_implicit_scale := (jsonb_build_object(
      'common', 1, 'uncommon', 1.61, 'rare', 2.35, 'epic', 3.54, 'legendary', 5.15, 'mythic', 7.68, 'relic', 7.68,
      'cosmic', 11.4, 'divine', 17.1, 'celestial', 25.8, 'cursed', 25.8, 'immortal', 25.8, 'god', 25.8
    )->>coalesce(v_item->>'rarity', ''))::double precision;
    CONTINUE WHEN v_implicit_scale IS NULL;
    v_item_level := least(99, greatest(1, CASE WHEN jsonb_typeof(v_item->'item_level') = 'number' THEN floor((v_item->>'item_level')::numeric)::integer ELSE 0 END));
    v_implicit_scale := v_implicit_scale * ((1::double precision + 0.008::double precision * (v_item_level - 1)) * power(1::double precision + 0.014::double precision, v_item_level - 1));
    IF v_slot IN ('class_weapon', 'gloves', 'ring', 'amulet') THEN
      i_atk := i_atk + floor(1::double precision * 1.661::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
    ELSIF v_slot IN ('helmet', 'boots', 'offhand') THEN
      i_hp := i_hp + floor(1::double precision * 53.9::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
    ELSIF v_slot = 'chest' THEN
      i_hp := i_hp + floor(0.5::double precision * 53.9::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
      i_def := i_def + floor(0.5::double precision * 9.5::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
    END IF;
  END LOOP;

  v_star_scale := power(1::double precision + 0.06::double precision, v_stars);
  v_mastery := power(1::double precision + 0.014::double precision, v_level - 1);
  v_growth := 1::double precision + v_tier * 0.02::double precision;
  v_hp := floor((a[1] * v_scale * 0.2::double precision * (1 + a[5] * v_growth * (v_level - 1)) * v_star_scale * v_mastery + i_hp) * a[11] + 0.5);
  v_atk := floor(a[2] * v_scale * 0.2::double precision * (1 + a[6] * v_growth * (v_level - 1)) * v_star_scale * v_mastery + i_atk + 0.5);
  v_def := floor(a[3] * v_scale * 0.2::double precision * (1 + a[7] * v_growth * (v_level - 1)) * v_star_scale * v_mastery + i_def + 0.5);
  v_speed := a[4] * (1 + v_tier * 0.01::double precision) + v_stars * 0.1::double precision;
  v_attack_speed := least(a[14] + i_speed, a[19]);
  v_interval := greatest(600::double precision, (1540 - least(v_speed * 2.2::double precision, 700::double precision)) / (1 + v_attack_speed));
  v_crit := least(a[8] + i_crit, a[17]);
  v_crit_damage := least(a[9] + i_crit_damage, a[18]);
  v_dodge := least(a[13] + i_dodge, a[16]);
  v_dps := v_atk * (1000 / v_interval) * (1 + v_crit * (v_crit_damage - 1)) * a[10];
  v_mitigation := least(a[15], v_def / (v_def + 200));
  RETURN 4 * v_dps + 0.08::double precision * (v_hp / (1 - v_mitigation) / (1 - v_dodge)) + 1.5::double precision * (v_hp * a[12]);
END
$function$;

-- The hero rows gain the Power column, which changes the row type, so the
-- helper is dropped and recreated; the reads that use it follow.
DROP FUNCTION IF EXISTS admin.game_registry_hero_rows(uuid);
CREATE FUNCTION admin.game_registry_hero_rows(p_player_id uuid DEFAULT NULL)
RETURNS TABLE (
  player_id uuid,
  username text,
  account_level integer,
  account_power bigint,
  uid text,
  hero_id text,
  hero_class text,
  rarity text,
  level integer,
  stars integer,
  xp numeric,
  locked boolean,
  team_slot integer,
  equipped jsonb,
  gear_power bigint,
  gear_count integer,
  max_enchant integer,
  power double precision
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT
    s.player_id,
    p.username,
    p.account_level,
    p.combat_power,
    h.value->>'uid',
    h.value->>'heroId',
    regexp_replace(coalesce(h.value->>'heroId', ''), '-[a-z]+$', ''),
    substring(h.value->>'heroId' from '-([a-z]+)$'),
    CASE WHEN jsonb_typeof(h.value->'level') = 'number' THEN (h.value->>'level')::numeric::integer ELSE 0 END,
    CASE WHEN jsonb_typeof(h.value->'stars') = 'number' THEN (h.value->>'stars')::numeric::integer ELSE 0 END,
    CASE WHEN jsonb_typeof(h.value->'xp') = 'number' THEN (h.value->>'xp')::numeric ELSE 0 END,
    coalesce(h.value->'locked' = 'true'::jsonb, false),
    team.pos,
    CASE WHEN jsonb_typeof(h.value->'equipped') = 'object' THEN h.value->'equipped' ELSE '{}'::jsonb END,
    coalesce(gear.gear_power, 0)::bigint,
    coalesce(gear.gear_count, 0)::integer,
    gear.max_enchant,
    admin.game_registry_hero_power(
      h.value->>'heroId',
      CASE WHEN jsonb_typeof(h.value->'level') = 'number' THEN (h.value->>'level')::numeric ELSE 0 END,
      CASE WHEN jsonb_typeof(h.value->'stars') = 'number' THEN (h.value->>'stars')::numeric ELSE 0 END,
      coalesce(gear.worn, '[]'::jsonb)
    )
  FROM public.player_saves s
  JOIN public.players p ON p.player_id = s.player_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.state->'ownedHeroes') = 'array' THEN s.state->'ownedHeroes' ELSE '[]'::jsonb END
  ) h
  LEFT JOIN LATERAL (
    SELECT min(t.ord)::integer AS pos
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(s.state->'team') = 'array' THEN s.state->'team' ELSE '[]'::jsonb END
    ) WITH ORDINALITY t(hero_uid, ord)
    WHERE t.hero_uid = h.value->>'uid'
  ) team ON true
  LEFT JOIN LATERAL (
    SELECT sum(i.power) AS gear_power, count(*) AS gear_count, max(i.enchant_level) AS max_enchant,
           jsonb_agg(jsonb_build_object(
             'slot', e.key, 'rarity', i.rarity, 'item_level', i.item_level, 'enchant_level', i.enchant_level,
             'enchant_stats_version', i.enchant_stats_version, 'stats', i.stats
           )) AS worn
    FROM jsonb_each_text(
      CASE WHEN jsonb_typeof(h.value->'equipped') = 'object' THEN h.value->'equipped' ELSE '{}'::jsonb END
    ) e
    JOIN public.player_items i
      ON i.player_id = s.player_id AND i.removed_at IS NULL AND i.id::text = e.value
  ) gear ON true
  WHERE p_player_id IS NULL OR s.player_id = p_player_id
$function$;

-- The hero register sorts by Power first.
CREATE OR REPLACE FUNCTION admin.game_registry_heroes(p_query jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sort text := coalesce(nullif(p_query->>'sort', ''), 'power');
  v_desc boolean := coalesce(p_query->>'dir', 'desc') <> 'asc';
  v_limit integer := least(greatest(coalesce(nullif(p_query->>'limit', '')::integer, 50), 1), 200);
  v_offset integer := least(greatest(coalesce(nullif(p_query->>'offset', '')::integer, 0), 0), 5000000);
  v_rarity text := nullif(p_query->>'rarity', '');
  v_class text := nullif(p_query->>'hero_class', '');
  v_player uuid := nullif(p_query->>'player_id', '')::uuid;
  v_min_stars integer := nullif(p_query->>'min_stars', '')::integer;
  v_team boolean := coalesce(p_query->>'team', '') = 'only';
  v_text text := nullif(btrim(coalesce(p_query->>'q', '')), '');
  v_like text;
  v_result jsonb;
BEGIN
  IF v_sort NOT IN ('power', 'level', 'stars', 'rarity', 'gear_power', 'enchant', 'xp', 'account_power', 'team', 'owner', 'hero') THEN
    RAISE EXCEPTION 'invalid_sort' USING ERRCODE = '22023';
  END IF;
  IF v_text IS NOT NULL THEN
    v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH filtered AS (
    SELECT hr.*
    FROM admin.game_registry_hero_rows(v_player) hr
    WHERE (v_rarity IS NULL OR hr.rarity = v_rarity)
      AND (v_class IS NULL OR hr.hero_class = v_class)
      AND (v_min_stars IS NULL OR hr.stars >= v_min_stars)
      AND (NOT v_team OR hr.team_slot IS NOT NULL)
      AND (v_like IS NULL OR hr.username ILIKE v_like OR hr.hero_id ILIKE v_like OR hr.uid = v_text)
  ), page AS (
    SELECT f.*, row_number() OVER (ORDER BY
      CASE WHEN v_desc THEN k.number_key END DESC NULLS LAST,
      CASE WHEN NOT v_desc THEN k.number_key END ASC NULLS LAST,
      CASE WHEN v_desc THEN k.text_key END DESC NULLS LAST,
      CASE WHEN NOT v_desc THEN k.text_key END ASC NULLS LAST,
      f.power DESC NULLS LAST, f.level DESC, f.stars DESC, f.uid
    ) AS position
    FROM filtered f
    CROSS JOIN LATERAL (SELECT
      CASE v_sort
        WHEN 'power' THEN f.power::numeric
        WHEN 'level' THEN f.level::numeric
        WHEN 'stars' THEN f.stars::numeric
        WHEN 'rarity' THEN admin.game_registry_rarity_rank(f.rarity)::numeric
        WHEN 'gear_power' THEN f.gear_power::numeric
        WHEN 'enchant' THEN f.max_enchant::numeric
        WHEN 'xp' THEN f.xp
        WHEN 'account_power' THEN f.account_power::numeric
        -- Team members first, in slot order, whichever way the column points.
        WHEN 'team' THEN CASE WHEN f.team_slot IS NULL THEN NULL ELSE (10 - f.team_slot)::numeric END
      END AS number_key,
      CASE v_sort
        WHEN 'owner' THEN lower(f.username)
        WHEN 'hero' THEN f.hero_id
      END AS text_key
    ) k
    ORDER BY position
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'version', 'game-registry-heroes.v2',
    'state', 'connected',
    'as_of', now(),
    'sort', v_sort,
    'dir', CASE WHEN v_desc THEN 'desc' ELSE 'asc' END,
    'limit', v_limit,
    'offset', v_offset,
    'total', (SELECT count(*) FROM filtered),
    'in_team', (SELECT count(*) FROM filtered WHERE team_slot IS NOT NULL),
    'by_rarity', coalesce((
      SELECT jsonb_object_agg(r.rarity, r.heroes)
      FROM (SELECT coalesce(rarity, 'unknown') AS rarity, count(*) AS heroes FROM filtered GROUP BY 1) r
    ), '{}'::jsonb),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'uid', pg.uid,
        'player_id', pg.player_id,
        'username', pg.username,
        'account_level', pg.account_level,
        'account_power', pg.account_power,
        'hero_id', pg.hero_id,
        'hero_class', pg.hero_class,
        'rarity', pg.rarity,
        'level', pg.level,
        'stars', pg.stars,
        'xp', pg.xp,
        'locked', pg.locked,
        'team_slot', pg.team_slot,
        'power', round(pg.power::numeric, 1),
        'gear_power', pg.gear_power,
        'gear_count', pg.gear_count,
        'max_enchant', pg.max_enchant
      ) ORDER BY pg.position)
      FROM page pg
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$function$;

-- One account, whole, with each hero's Power.
CREATE OR REPLACE FUNCTION admin.game_registry_player(p_player_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_player jsonb;
  v_state jsonb;
  v_save_revision bigint;
  v_save_updated timestamptz;
  v_email text;
  v_registered timestamptz;
  v_wallet text;
  v_heroes jsonb;
  v_items jsonb;
  v_removed jsonb;
  v_resources jsonb := jsonb_build_object('state', 'not_tracked', 'rows', '[]'::jsonb);
  v_resource_history jsonb := jsonb_build_object('state', 'not_tracked', 'rows', '[]'::jsonb);
  v_ledger jsonb;
  v_spends jsonb := jsonb_build_object('state', 'not_tracked', 'totals', '[]'::jsonb, 'rows', '[]'::jsonb);
  v_purchases jsonb := '[]'::jsonb;
  v_purchase_sources jsonb := '{}'::jsonb;
  v_part jsonb;
  v_sales jsonb := jsonb_build_object('state', 'not_tracked', 'rows', '[]'::jsonb);
  v_upgrades jsonb := jsonb_build_object('state', 'not_tracked', 'rows', '[]'::jsonb);
  v_summons jsonb := jsonb_build_object('state', 'not_tracked', 'rows', '[]'::jsonb);
  v_ascensions jsonb := jsonb_build_object('state', 'not_tracked', 'rows', '[]'::jsonb);
  v_market jsonb := jsonb_build_object('state', 'not_tracked', 'rows', '[]'::jsonb);
BEGIN
  SELECT to_jsonb(p) INTO v_player FROM public.players p WHERE p.player_id = p_player_id;
  IF v_player IS NULL THEN
    RETURN jsonb_build_object('version', 'game-registry-player.v1', 'state', 'not_found');
  END IF;

  SELECT s.state, s.revision, s.updated_at INTO v_state, v_save_revision, v_save_updated
  FROM public.player_saves s WHERE s.player_id = p_player_id;
  v_state := coalesce(v_state, '{}'::jsonb);

  SELECT u.email, u.created_at INTO v_email, v_registered FROM auth.users u WHERE u.id = p_player_id;
  SELECT i.provider_subject INTO v_wallet FROM heroloop_api.account_identities i
  WHERE i.account_id = p_player_id AND i.provider = 'solana' AND i.revoked_at IS NULL
  ORDER BY i.created_at LIMIT 1;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'uid', hr.uid, 'hero_id', hr.hero_id, 'hero_class', hr.hero_class, 'rarity', hr.rarity,
    'level', hr.level, 'stars', hr.stars, 'xp', hr.xp, 'locked', hr.locked, 'team_slot', hr.team_slot,
    'equipped', hr.equipped, 'power', round(hr.power::numeric, 1), 'gear_power', hr.gear_power, 'gear_count', hr.gear_count, 'max_enchant', hr.max_enchant
  ) ORDER BY hr.team_slot NULLS LAST, hr.power DESC NULLS LAST, hr.level DESC, hr.uid), '[]'::jsonb)
  INTO v_heroes
  FROM admin.game_registry_hero_rows(p_player_id) hr;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'base_item_id', i.base_item_id, 'slot', i.slot, 'rarity', i.rarity, 'item_level', i.item_level,
    'enchant_level', i.enchant_level, 'power', i.power, 'locked', i.locked, 'reroll_count', i.reroll_count,
    'source_kind', i.source_kind, 'created_at', i.created_at, 'stats', i.stats
  ) ORDER BY i.power DESC NULLS LAST, i.id), '[]'::jsonb)
  INTO v_items
  FROM public.player_items i WHERE i.player_id = p_player_id AND i.removed_at IS NULL;

  SELECT coalesce(jsonb_agg(entry ORDER BY (entry->>'removed_at')::timestamptz DESC), '[]'::jsonb) INTO v_removed
  FROM (
    SELECT jsonb_build_object(
      'id', i.id, 'base_item_id', i.base_item_id, 'slot', i.slot, 'rarity', i.rarity, 'item_level', i.item_level,
      'enchant_level', i.enchant_level, 'power', i.power, 'created_at', i.created_at, 'removed_at', i.removed_at
    ) AS entry
    FROM public.player_items i WHERE i.player_id = p_player_id AND i.removed_at IS NOT NULL
    ORDER BY i.removed_at DESC LIMIT 100
  ) recent;

  IF to_regclass('public.player_resource_balances') IS NOT NULL AND to_regclass('public.resource_catalog') IS NOT NULL THEN
    SELECT jsonb_build_object('state', 'connected', 'rows', coalesce(jsonb_agg(jsonb_build_object(
      'resource_id', c.resource_id, 'family', c.family, 'quantity', coalesce(b.quantity_bigint, 0), 'updated_at', b.updated_at
    ) ORDER BY c.display_order, c.resource_id), '[]'::jsonb))
    INTO v_resources
    FROM public.resource_catalog c
    LEFT JOIN public.player_resource_balances b ON b.resource_id = c.resource_id AND b.player_id = p_player_id;
  END IF;

  -- Potions spent by auto-battle are one movement per fight and would bury
  -- everything else, so they are counted and the rest is listed.
  IF to_regclass('public.resource_transactions') IS NOT NULL AND to_regclass('public.resource_entries') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', 'connected',
      'auto_potion_movements', (SELECT count(*) FROM public.resource_transactions t WHERE t.player_id = p_player_id AND t.action = 'normal_combat_auto_pot'),
      'rows', coalesce(jsonb_agg(entry ORDER BY (entry->>'at')::timestamptz DESC), '[]'::jsonb)
    ) INTO v_resource_history
    FROM (
      SELECT jsonb_build_object(
        'at', t.created_at, 'action', t.action,
        'entries', coalesce((
          SELECT jsonb_agg(jsonb_build_object('resource_id', e.resource_id, 'delta', e.delta_bigint, 'balance_after', e.balance_after_bigint) ORDER BY e.sequence)
          FROM public.resource_entries e WHERE e.transaction_id = t.transaction_id
        ), '[]'::jsonb)
      ) AS entry
      FROM public.resource_transactions t
      WHERE t.player_id = p_player_id AND t.action <> 'normal_combat_auto_pot'
      ORDER BY t.created_at DESC LIMIT 100
    ) recent;
  END IF;

  -- $HERO ledger. Pool payouts arrive every tick, so they are totalled and
  -- shown per day; every other entry is listed newest first. The metadata
  -- document is left in the database: it belongs to the system that wrote it.
  SELECT jsonb_build_object(
    'state', 'connected',
    'totals', coalesce((
      SELECT jsonb_agg(jsonb_build_object('flow', g.flow, 'source_kind', g.source_kind, 'entries', g.entries,
        'amount', g.amount, 'first_at', g.first_at, 'last_at', g.last_at) ORDER BY g.amount DESC)
      FROM (
        SELECT l.flow, l.source_kind, count(*) AS entries, sum(l.amount) AS amount, min(l.occurred_at) AS first_at, max(l.occurred_at) AS last_at
        FROM public.hero_economy_ledger l WHERE l.player_id = p_player_id GROUP BY l.flow, l.source_kind
      ) g
    ), '[]'::jsonb),
    'pool_daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'entries', d.entries, 'amount', d.amount) ORDER BY d.day DESC)
      FROM (
        SELECT (l.occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS entries, sum(l.amount) AS amount
        FROM public.hero_economy_ledger l
        WHERE l.player_id = p_player_id AND l.source_kind = 'mining_pool' AND l.occurred_at >= now() - interval '30 days'
        GROUP BY 1
      ) d
    ), '[]'::jsonb),
    'rows', coalesce((
      SELECT jsonb_agg(entry ORDER BY (entry->>'id')::bigint DESC)
      FROM (
        SELECT jsonb_build_object('id', l.id, 'at', l.occurred_at, 'flow', l.flow, 'source_kind', l.source_kind,
          'amount', l.amount, 'source_key', l.source_key) AS entry
        FROM public.hero_economy_ledger l
        WHERE l.player_id = p_player_id AND l.source_kind <> 'mining_pool'
        ORDER BY l.occurred_at DESC, l.id DESC LIMIT 200
      ) recent
    ), '[]'::jsonb)
  ) INTO v_ledger;

  IF to_regclass('public.token_spend_events') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', 'connected',
      'totals', coalesce((
        SELECT jsonb_agg(jsonb_build_object('action_kind', g.action_kind, 'spends', g.spends, 'amount', g.amount, 'last_at', g.last_at) ORDER BY g.amount DESC)
        FROM (
          SELECT t.action_kind, count(*) AS spends, sum(t.amount) AS amount, max(t.created_at) AS last_at
          FROM public.token_spend_events t WHERE t.player_id = p_player_id GROUP BY t.action_kind
        ) g
      ), '[]'::jsonb),
      'rows', coalesce((
        SELECT jsonb_agg(entry ORDER BY (entry->>'at')::timestamptz DESC)
        FROM (
          SELECT jsonb_build_object('at', t.created_at, 'action_kind', t.action_kind, 'amount', t.amount,
            'source_key', 'token_spend:' || t.idempotency_key::text) AS entry
          FROM public.token_spend_events t WHERE t.player_id = p_player_id
          ORDER BY t.created_at DESC LIMIT 200
        ) recent
      ), '[]'::jsonb)
    ) INTO v_spends;
  END IF;

  -- Purchases: everything bought with a catalogue price, from every table that
  -- records one. Each source reports whether this database tracks it.
  IF to_regclass('public.reward_boost_purchase_events') IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', 'reward_boost', 'title', e.plan,
      'hero_cost', e.token_cost, 'gold_cost', NULL, 'usd_cents', e.catalogue_usd_cents, 'quantity', 1)), '[]'::jsonb)
    INTO v_part FROM public.reward_boost_purchase_events e WHERE e.player_id = p_player_id;
    v_purchases := v_purchases || v_part;
    v_purchase_sources := v_purchase_sources || jsonb_build_object('reward_boost', 'connected');
  ELSE
    v_purchase_sources := v_purchase_sources || jsonb_build_object('reward_boost', 'not_tracked');
  END IF;
  IF to_regclass('public.shop_bundle_purchase_events') IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', 'shop_bundle', 'title', e.bundle,
      'hero_cost', e.token_cost, 'gold_cost', NULL, 'usd_cents', e.catalogue_usd_cents, 'quantity', e.quantity)), '[]'::jsonb)
    INTO v_part FROM public.shop_bundle_purchase_events e WHERE e.player_id = p_player_id;
    v_purchases := v_purchases || v_part;
    v_purchase_sources := v_purchase_sources || jsonb_build_object('shop_bundle', 'connected');
  ELSE
    v_purchase_sources := v_purchase_sources || jsonb_build_object('shop_bundle', 'not_tracked');
  END IF;
  IF to_regclass('public.store_purchase_events') IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', 'store_gold',
      'title', coalesce(e.result#>>'{item,itemId}', e.result#>>'{item,id}'),
      'hero_cost', NULL,
      'gold_cost', CASE WHEN jsonb_typeof(e.result->'price') = 'number' THEN (e.result->>'price')::numeric END,
      'usd_cents', NULL, 'quantity', 1)), '[]'::jsonb)
    INTO v_part FROM public.store_purchase_events e WHERE e.player_id = p_player_id;
    v_purchases := v_purchases || v_part;
    v_purchase_sources := v_purchase_sources || jsonb_build_object('store_gold', 'connected');
  ELSE
    v_purchase_sources := v_purchase_sources || jsonb_build_object('store_gold', 'not_tracked');
  END IF;
  IF to_regclass('public.inventory_bag_purchase_events') IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', 'inventory_bag', 'title', e.kind || ' ' || e.bag,
      'hero_cost', e.token_cost, 'gold_cost', NULL, 'usd_cents', e.catalogue_usd_cents, 'quantity', 1)), '[]'::jsonb)
    INTO v_part FROM public.inventory_bag_purchase_events e WHERE e.player_id = p_player_id;
    v_purchases := v_purchases || v_part;
    v_purchase_sources := v_purchase_sources || jsonb_build_object('inventory_bag', 'connected');
  ELSE
    v_purchase_sources := v_purchase_sources || jsonb_build_object('inventory_bag', 'not_tracked');
  END IF;
  IF to_regclass('public.hero_capacity_upgrade_events') IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', 'hero_capacity',
      'title', e.previous_capacity || ' → ' || e.hero_capacity,
      'hero_cost', e.token_cost, 'gold_cost', NULL, 'usd_cents', e.catalogue_usd_cents, 'quantity', 1)), '[]'::jsonb)
    INTO v_part FROM public.hero_capacity_upgrade_events e WHERE e.player_id = p_player_id;
    v_purchases := v_purchases || v_part;
    v_purchase_sources := v_purchase_sources || jsonb_build_object('hero_capacity', 'connected');
  ELSE
    v_purchase_sources := v_purchase_sources || jsonb_build_object('hero_capacity', 'not_tracked');
  END IF;
  SELECT coalesce(jsonb_agg(entry ORDER BY (entry->>'at')::timestamptz DESC), '[]'::jsonb) INTO v_purchases
  FROM (SELECT p.entry FROM jsonb_array_elements(v_purchases) AS p(entry) ORDER BY (p.entry->>'at')::timestamptz DESC LIMIT 200) newest;

  IF to_regclass('public.item_mutation_events') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', 'connected',
      'sales', count(*),
      'items_sold', coalesce(sum(cardinality(e.item_ids)), 0),
      'gold_total', coalesce(sum(CASE WHEN jsonb_typeof(e.result->'gold_refund') = 'number' THEN (e.result->>'gold_refund')::numeric ELSE 0 END), 0),
      'rows', coalesce((
        SELECT jsonb_agg(entry ORDER BY (entry->>'at')::timestamptz DESC)
        FROM (
          SELECT jsonb_build_object('at', r.created_at, 'items', cardinality(r.item_ids), 'item_ids', to_jsonb(r.item_ids),
            'gold', CASE WHEN jsonb_typeof(r.result->'gold_refund') = 'number' THEN (r.result->>'gold_refund')::numeric END) AS entry
          FROM public.item_mutation_events r
          WHERE r.player_id = p_player_id AND r.action_kind = 'sell'
          ORDER BY r.created_at DESC LIMIT 100
        ) recent
      ), '[]'::jsonb)
    ) INTO v_sales
    FROM public.item_mutation_events e WHERE e.player_id = p_player_id AND e.action_kind = 'sell';
  END IF;

  IF to_regclass('public.item_upgrade_events') IS NOT NULL THEN
    SELECT jsonb_build_object('state', 'connected', 'rows', coalesce(jsonb_agg(entry ORDER BY (entry->>'at')::timestamptz DESC), '[]'::jsonb))
    INTO v_upgrades
    FROM (
      SELECT jsonb_build_object(
        'at', e.created_at, 'action', e.action_kind, 'item_id', e.item_id, 'use_charm', e.use_charm,
        'success', e.result->'success', 'destroyed', e.result->'destroyed', 'guaranteed', e.result->'guaranteed',
        'gold_cost', e.result->'gold_cost', 'hero_cost', e.result->'token_cost', 'success_chance', e.result->'success_chance',
        'enchant_level', e.result#>'{item,enchantLevel}'
      ) AS entry
      FROM public.item_upgrade_events e WHERE e.player_id = p_player_id
      ORDER BY e.created_at DESC LIMIT 100
    ) recent;
  END IF;

  IF to_regclass('public.summon_events') IS NOT NULL THEN
    SELECT jsonb_build_object('state', 'connected', 'rows', coalesce(jsonb_agg(entry ORDER BY (entry->>'at')::timestamptz DESC), '[]'::jsonb))
    INTO v_summons
    FROM (
      SELECT jsonb_build_object('at', e.created_at, 'count', e.summon_count, 'payment_method', e.payment_method,
        'hero_cost', e.token_cost, 'scroll_cost', e.scroll_cost,
        'heroes', CASE WHEN jsonb_typeof(e.result->'heroes') = 'array'
          THEN (SELECT jsonb_agg(h->>'heroId') FROM jsonb_array_elements(e.result->'heroes') h) END
      ) AS entry
      FROM public.summon_events e WHERE e.player_id = p_player_id
      ORDER BY e.created_at DESC LIMIT 100
    ) recent;
  END IF;

  IF to_regclass('public.hero_ascension_events') IS NOT NULL THEN
    SELECT jsonb_build_object('state', 'connected', 'rows', coalesce(jsonb_agg(entry ORDER BY (entry->>'at')::timestamptz DESC), '[]'::jsonb))
    INTO v_ascensions
    FROM (
      SELECT jsonb_build_object('at', e.created_at, 'target_uid', e.target_uid, 'hero_cost', e.token_cost,
        'stars_added', e.result->'stars_added', 'target_stars', e.result->'target_stars',
        'consumed', CASE WHEN jsonb_typeof(e.result->'consumed_uids') = 'array' THEN jsonb_array_length(e.result->'consumed_uids') END
      ) AS entry
      FROM public.hero_ascension_events e WHERE e.player_id = p_player_id
      ORDER BY e.created_at DESC LIMIT 100
    ) recent;
  END IF;

  IF to_regclass('public.market_item_listings') IS NOT NULL THEN
    SELECT jsonb_build_object('state', 'connected', 'rows', coalesce(jsonb_agg(entry ORDER BY (entry->>'created_at')::timestamptz DESC), '[]'::jsonb))
    INTO v_market
    FROM (
      SELECT jsonb_build_object(
        'id', m.id, 'item_id', m.item_id, 'price', m.price, 'status', m.status,
        'side', CASE WHEN m.seller_id = p_player_id THEN 'seller' ELSE 'buyer' END,
        'counterparty_id', CASE WHEN m.seller_id = p_player_id THEN m.buyer_id ELSE m.seller_id END,
        'counterparty', (SELECT c.username FROM public.players c
                         WHERE c.player_id = CASE WHEN m.seller_id = p_player_id THEN m.buyer_id ELSE m.seller_id END),
        'created_at', m.created_at, 'completed_at', m.completed_at
      ) AS entry
      FROM public.market_item_listings m
      WHERE m.seller_id = p_player_id OR m.buyer_id = p_player_id
      ORDER BY m.created_at DESC LIMIT 100
    ) recent;
  END IF;

  RETURN jsonb_build_object(
    'version', 'game-registry-player.v2',
    'state', 'connected',
    'as_of', now(),
    'account', jsonb_build_object(
      'player_id', v_player->'player_id',
      'username', v_player->'username',
      'account_level', v_player->'account_level',
      'power', v_player->'power',
      'combat_power', v_player->'combat_power',
      'collection_power', v_player->'collection_power',
      'heroes_owned', v_player->'heroes_owned',
      'highest_location', v_player->'highest_location',
      'total_kills', v_player->'total_kills',
      'boss_kills', v_player->'boss_kills',
      'chests_opened', v_player->'chests_opened',
      'summons', v_player->'summons',
      'online', v_player->'online',
      'last_heartbeat', v_player->'last_heartbeat',
      'updated_at', v_player->'updated_at',
      'registered_at', v_registered,
      'email_masked', admin.mask_email(v_email),
      'wallet_masked', admin.mask_key(v_wallet),
      'risk_level', public.account_risk_level(p_player_id)
    ),
    'tokens', jsonb_build_object(
      'token_balance', v_player->'token_balance',
      'pending_tokens', v_player->'pending_tokens',
      'total_claimed', v_player->'total_claimed',
      'total_tokens_earned', v_player->'total_tokens_earned',
      'token_eligible', v_player->'token_eligible',
      'boost_tokens_earned', v_player->'boost_tokens_earned',
      'boost_tokens_spent', v_player->'boost_tokens_spent',
      'reward_active_until', v_player->'reward_active_until'
    ),
    'save', jsonb_build_object(
      'revision', v_save_revision,
      'updated_at', v_save_updated,
      'gold', v_state->'gold',
      'total_gold_earned', v_state->'totalGoldEarned',
      'summon_scrolls', v_state->'summonScrolls',
      'boss_keys', v_state->'bossKeys',
      'hero_capacity', v_state->'heroCapacity',
      'current_location', v_state->'currentLocation',
      'potions', CASE WHEN jsonb_typeof(v_state->'potions') = 'object' THEN v_state->'potions' ELSE '{}'::jsonb END,
      'pity', jsonb_build_object(
        'legendary', v_player->'pity_legendary', 'mythic', v_player->'pity_mythic', 'cosmic', v_player->'pity_cosmic',
        'divine', v_player->'pity_divine', 'celestial', v_player->'pity_celestial'
      )
    ),
    'heroes', v_heroes,
    'items', v_items,
    'removed_items', v_removed,
    'resources', v_resources,
    'resource_history', v_resource_history,
    'hero_ledger', v_ledger,
    'hero_spends', v_spends,
    'purchases', jsonb_build_object('sources', v_purchase_sources, 'rows', v_purchases),
    'sales', v_sales,
    'upgrades', v_upgrades,
    'summons', v_summons,
    'ascensions', v_ascensions,
    'market', v_market
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.game_registry_hero_power(text, numeric, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_hero_rows(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_heroes(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_player(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.game_registry_heroes(jsonb) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.game_registry_player(uuid) TO heroloop_admin;
