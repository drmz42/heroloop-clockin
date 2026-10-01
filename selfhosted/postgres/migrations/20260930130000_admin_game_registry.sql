\set ON_ERROR_STOP on

-- Game registry for the Founder Control Center (HL-TASK-20260930122854-F4718C).
--
-- The Founder asked for a full register of every item, hero and account with
-- sorting and filters, and for one account's whole picture - roster, team,
-- gear, resources, tokens, purchases, sales and $HERO movements - so a dispute
-- or an anomaly can be investigated from the panel. That is a deliberate
-- exception to the "one exact lookup, never a list" rule of Player Support: it
-- is read-only, founder-only in the BFF, audited on every call, and it never
-- returns a mail address, a wallet key or any other contact detail in full.
--
-- The isolation promise is unchanged: heroloop_admin still holds no grant on
-- any public.* game table. It gains EXECUTE on four SECURITY DEFINER reads.
-- Nothing here writes.

-- Rarity in the order the game ranks it, so "sort by rarity" is not alphabetic.
CREATE OR REPLACE FUNCTION admin.game_registry_rarity_rank(p_rarity text)
RETURNS integer LANGUAGE sql IMMUTABLE
AS $function$
  SELECT coalesce(array_position(
    ARRAY['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god'],
    p_rarity
  ), 0)
$function$;

-- Every owned hero as a row. Heroes live inside the save document, so this is
-- the one place that unpacks it: the hero itself, its place in the team (1-3,
-- null when benched) and what its equipped items add up to.
CREATE OR REPLACE FUNCTION admin.game_registry_hero_rows(p_player_id uuid DEFAULT NULL)
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
  max_enchant integer
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
    gear.max_enchant
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
    SELECT sum(i.power) AS gear_power, count(*) AS gear_count, max(i.enchant_level) AS max_enchant
    FROM jsonb_each_text(
      CASE WHEN jsonb_typeof(h.value->'equipped') = 'object' THEN h.value->'equipped' ELSE '{}'::jsonb END
    ) e
    JOIN public.player_items i
      ON i.player_id = s.player_id AND i.removed_at IS NULL AND i.id::text = e.value
  ) gear ON true
  WHERE p_player_id IS NULL OR s.player_id = p_player_id
$function$;

-- The item register: every item the game has rolled, active or removed, with
-- its owner and the hero wearing it. One page per call; the filters and the
-- sort key are an allowlist, never SQL from the browser.
CREATE OR REPLACE FUNCTION admin.game_registry_items(p_query jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sort text := coalesce(nullif(p_query->>'sort', ''), 'power');
  v_desc boolean := coalesce(p_query->>'dir', 'desc') <> 'asc';
  v_limit integer := least(greatest(coalesce(nullif(p_query->>'limit', '')::integer, 50), 1), 200);
  v_offset integer := least(greatest(coalesce(nullif(p_query->>'offset', '')::integer, 0), 0), 5000000);
  v_state text := coalesce(nullif(p_query->>'state', ''), 'active');
  v_rarity text := nullif(p_query->>'rarity', '');
  v_slot text := nullif(p_query->>'slot', '');
  v_player uuid := nullif(p_query->>'player_id', '')::uuid;
  v_min_enchant integer := nullif(p_query->>'min_enchant', '')::integer;
  v_text text := nullif(btrim(coalesce(p_query->>'q', '')), '');
  v_like text;
  v_result jsonb;
BEGIN
  IF v_sort NOT IN ('power', 'enchant', 'level', 'rarity', 'rerolls', 'created', 'removed', 'owner', 'item', 'slot') THEN
    RAISE EXCEPTION 'invalid_sort' USING ERRCODE = '22023';
  END IF;
  IF v_state NOT IN ('active', 'removed', 'all') THEN
    RAISE EXCEPTION 'invalid_state' USING ERRCODE = '22023';
  END IF;
  IF v_text IS NOT NULL THEN
    v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH filtered AS (
    SELECT i.id, i.player_id, p.username, i.base_item_id, i.slot, i.rarity, i.item_level, i.enchant_level,
           i.power, i.locked, i.reroll_count, i.source_kind, i.created_at, i.removed_at
    FROM public.player_items i
    LEFT JOIN public.players p ON p.player_id = i.player_id
    WHERE (v_state = 'all' OR (v_state = 'active' AND i.removed_at IS NULL) OR (v_state = 'removed' AND i.removed_at IS NOT NULL))
      AND (v_rarity IS NULL OR i.rarity = v_rarity)
      AND (v_slot IS NULL OR i.slot = v_slot)
      AND (v_player IS NULL OR i.player_id = v_player)
      AND (v_min_enchant IS NULL OR i.enchant_level >= v_min_enchant)
      AND (v_like IS NULL OR p.username ILIKE v_like OR i.base_item_id ILIKE v_like OR i.id::text = lower(v_text))
  ), page AS (
    SELECT f.*, row_number() OVER (ORDER BY
      CASE WHEN v_desc THEN k.number_key END DESC NULLS LAST,
      CASE WHEN NOT v_desc THEN k.number_key END ASC NULLS LAST,
      CASE WHEN v_desc THEN k.text_key END DESC NULLS LAST,
      CASE WHEN NOT v_desc THEN k.text_key END ASC NULLS LAST,
      f.power DESC NULLS LAST, f.id
    ) AS position
    FROM filtered f
    CROSS JOIN LATERAL (SELECT
      CASE v_sort
        WHEN 'power' THEN f.power::numeric
        WHEN 'enchant' THEN f.enchant_level::numeric
        WHEN 'level' THEN f.item_level::numeric
        WHEN 'rarity' THEN admin.game_registry_rarity_rank(f.rarity)::numeric
        WHEN 'rerolls' THEN f.reroll_count::numeric
        WHEN 'created' THEN extract(epoch FROM f.created_at)
        WHEN 'removed' THEN extract(epoch FROM f.removed_at)
      END AS number_key,
      CASE v_sort
        WHEN 'owner' THEN lower(f.username)
        WHEN 'item' THEN f.base_item_id
        WHEN 'slot' THEN f.slot
      END AS text_key
    ) k
    ORDER BY position
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'version', 'game-registry-items.v1',
    'state', 'connected',
    'as_of', now(),
    'sort', v_sort,
    'dir', CASE WHEN v_desc THEN 'desc' ELSE 'asc' END,
    'limit', v_limit,
    'offset', v_offset,
    'total', (SELECT count(*) FROM filtered),
    'by_rarity', coalesce((
      SELECT jsonb_object_agg(r.rarity, r.items)
      FROM (SELECT coalesce(rarity, 'unknown') AS rarity, count(*) AS items FROM filtered GROUP BY 1) r
    ), '{}'::jsonb),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', pg.id,
        'player_id', pg.player_id,
        'username', pg.username,
        'base_item_id', pg.base_item_id,
        'slot', pg.slot,
        'rarity', pg.rarity,
        'item_level', pg.item_level,
        'enchant_level', pg.enchant_level,
        'power', pg.power,
        'locked', pg.locked,
        'reroll_count', pg.reroll_count,
        'source_kind', pg.source_kind,
        'created_at', pg.created_at,
        'removed_at', pg.removed_at,
        'hero_uid', worn.hero_uid,
        'hero_id', worn.hero_id,
        'team_slot', worn.team_slot
      ) ORDER BY pg.position)
      FROM page pg
      LEFT JOIN (
        -- The wearer is looked up once per owner on the page, not once per item.
        SELECT DISTINCT ON (o.player_id, e.value) o.player_id, e.value AS item_uid, hr.uid AS hero_uid, hr.hero_id, hr.team_slot
        FROM (SELECT DISTINCT player_id FROM page WHERE removed_at IS NULL) o
        CROSS JOIN LATERAL admin.game_registry_hero_rows(o.player_id) hr
        CROSS JOIN LATERAL jsonb_each_text(hr.equipped) e
        WHERE e.value IS NOT NULL
      ) worn ON worn.player_id = pg.player_id AND worn.item_uid = pg.id::text AND pg.removed_at IS NULL
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$function$;

-- The hero register: every owned hero across every account.
CREATE OR REPLACE FUNCTION admin.game_registry_heroes(p_query jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sort text := coalesce(nullif(p_query->>'sort', ''), 'level');
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
  IF v_sort NOT IN ('level', 'stars', 'rarity', 'gear_power', 'enchant', 'xp', 'account_power', 'team', 'owner', 'hero') THEN
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
      f.level DESC, f.stars DESC, f.uid
    ) AS position
    FROM filtered f
    CROSS JOIN LATERAL (SELECT
      CASE v_sort
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
    'version', 'game-registry-heroes.v1',
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

-- The account register: one row per player with what the other two registers
-- add up to, so an account can be picked by strength, wealth or activity.
CREATE OR REPLACE FUNCTION admin.game_registry_accounts(p_query jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sort text := coalesce(nullif(p_query->>'sort', ''), 'power');
  v_desc boolean := coalesce(p_query->>'dir', 'desc') <> 'asc';
  v_limit integer := least(greatest(coalesce(nullif(p_query->>'limit', '')::integer, 50), 1), 200);
  v_offset integer := least(greatest(coalesce(nullif(p_query->>'offset', '')::integer, 0), 0), 5000000);
  v_text text := nullif(btrim(coalesce(p_query->>'q', '')), '');
  v_like text;
  v_result jsonb;
BEGIN
  IF v_sort NOT IN ('power', 'combat_power', 'level', 'heroes', 'items', 'best_item', 'gold', 'hero_balance',
                    'claimed', 'location', 'last_seen', 'registered', 'username') THEN
    RAISE EXCEPTION 'invalid_sort' USING ERRCODE = '22023';
  END IF;
  IF v_text IS NOT NULL THEN
    v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH filtered AS (
    SELECT p.player_id, p.username, p.account_level, p.power, p.combat_power, p.heroes_owned, p.highest_location,
           p.token_balance, p.pending_tokens, p.total_claimed, p.online, p.last_heartbeat,
           u.created_at AS registered_at,
           coalesce(it.items, 0) AS items,
           it.best_item_power,
           CASE WHEN jsonb_typeof(s.state->'gold') = 'number' THEN (s.state->>'gold')::numeric END AS gold,
           CASE WHEN jsonb_typeof(s.state->'team') = 'array' THEN jsonb_array_length(s.state->'team') ELSE 0 END AS team_size,
           public.account_risk_level(p.player_id) AS risk_level
    FROM public.players p
    LEFT JOIN auth.users u ON u.id = p.player_id
    LEFT JOIN public.player_saves s ON s.player_id = p.player_id
    LEFT JOIN (
      SELECT i.player_id, count(*) AS items, max(i.power) AS best_item_power
      FROM public.player_items i WHERE i.removed_at IS NULL GROUP BY i.player_id
    ) it ON it.player_id = p.player_id
    WHERE v_like IS NULL OR p.username ILIKE v_like OR p.player_id::text = lower(v_text)
  ), page AS (
    SELECT f.*, row_number() OVER (ORDER BY
      CASE WHEN v_desc THEN k.number_key END DESC NULLS LAST,
      CASE WHEN NOT v_desc THEN k.number_key END ASC NULLS LAST,
      CASE WHEN v_desc THEN k.text_key END DESC NULLS LAST,
      CASE WHEN NOT v_desc THEN k.text_key END ASC NULLS LAST,
      f.power DESC NULLS LAST, f.player_id
    ) AS position
    FROM filtered f
    CROSS JOIN LATERAL (SELECT
      CASE v_sort
        WHEN 'power' THEN f.power::numeric
        WHEN 'combat_power' THEN f.combat_power::numeric
        WHEN 'level' THEN f.account_level::numeric
        WHEN 'heroes' THEN f.heroes_owned::numeric
        WHEN 'items' THEN f.items::numeric
        WHEN 'best_item' THEN f.best_item_power::numeric
        WHEN 'gold' THEN f.gold
        WHEN 'hero_balance' THEN f.token_balance
        WHEN 'claimed' THEN f.total_claimed
        WHEN 'location' THEN f.highest_location::numeric
        WHEN 'last_seen' THEN extract(epoch FROM f.last_heartbeat)
        WHEN 'registered' THEN extract(epoch FROM f.registered_at)
      END AS number_key,
      CASE v_sort WHEN 'username' THEN lower(f.username) END AS text_key
    ) k
    ORDER BY position
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'version', 'game-registry-accounts.v1',
    'state', 'connected',
    'as_of', now(),
    'sort', v_sort,
    'dir', CASE WHEN v_desc THEN 'desc' ELSE 'asc' END,
    'limit', v_limit,
    'offset', v_offset,
    'total', (SELECT count(*) FROM filtered),
    'online', (SELECT count(*) FROM filtered WHERE online),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'player_id', pg.player_id,
        'username', pg.username,
        'account_level', pg.account_level,
        'power', pg.power,
        'combat_power', pg.combat_power,
        'heroes_owned', pg.heroes_owned,
        'team_size', pg.team_size,
        'items', pg.items,
        'best_item_power', pg.best_item_power,
        'gold', pg.gold,
        'token_balance', pg.token_balance,
        'pending_tokens', pg.pending_tokens,
        'total_claimed', pg.total_claimed,
        'highest_location', pg.highest_location,
        'online', pg.online,
        'last_heartbeat', pg.last_heartbeat,
        'registered_at', pg.registered_at,
        'risk_level', pg.risk_level
      ) ORDER BY pg.position)
      FROM page pg
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$function$;

-- One account, whole: the card, the team, every hero and item, every balance
-- and the histories an investigation reads - $HERO ledger, $HERO spends,
-- purchases, item sales, enchants, summons, ascensions, resource movements and
-- Market listings. Contact details are masked here exactly as in Player
-- Support; unmasking stays there, behind its step-up. A history whose table a
-- database does not carry reads not_tracked rather than empty.
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
    'equipped', hr.equipped, 'gear_power', hr.gear_power, 'gear_count', hr.gear_count, 'max_enchant', hr.max_enchant
  ) ORDER BY hr.team_slot NULLS LAST, admin.game_registry_rarity_rank(hr.rarity) DESC, hr.level DESC, hr.uid), '[]'::jsonb)
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
    'version', 'game-registry-player.v1',
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

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand these to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.game_registry_rarity_rank(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_hero_rows(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_items(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_heroes(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_accounts(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_registry_player(uuid) FROM PUBLIC;

-- The two helpers get no grant: only the definer reads may call them.
GRANT EXECUTE ON FUNCTION admin.game_registry_items(jsonb) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.game_registry_heroes(jsonb) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.game_registry_accounts(jsonb) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.game_registry_player(uuid) TO heroloop_admin;

COMMENT ON FUNCTION admin.game_registry_items(jsonb) IS
  'Founder Control Center game registry: one page of items with owner and wearer; read-only.';
COMMENT ON FUNCTION admin.game_registry_heroes(jsonb) IS
  'Founder Control Center game registry: one page of owned heroes across accounts; read-only.';
COMMENT ON FUNCTION admin.game_registry_accounts(jsonb) IS
  'Founder Control Center game registry: one page of accounts with strength and balances; read-only.';
COMMENT ON FUNCTION admin.game_registry_player(uuid) IS
  'Founder Control Center game registry: one account whole, contacts masked; read-only.';
