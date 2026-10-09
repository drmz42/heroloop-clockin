-- Founder 2026-10-09: one Reward Catalog holds everything the game can hand out (Gold, every ledger resource,
-- chests by Location). It is edited only in the Founder Control Center (add an entry, switch it off); letters,
-- promo codes and any later reward form pick from it. Letters store the resolved reward, so a later catalog
-- edit never changes a letter already sent. Ledger resources (scrolls, keys, potions, materials) now ride in
-- letters too and land through public.apply_resource_entries with the source key mail_reward.
BEGIN;

CREATE TABLE IF NOT EXISTS public.reward_catalog (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,63}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK (kind IN ('gold', 'resource', 'chest')),
  resource_id text REFERENCES public.resource_catalog(resource_id),
  chest_stage integer CHECK (chest_stage BETWEEN 1 AND 20),
  chest_boss boolean NOT NULL DEFAULT false,
  max_per_grant bigint NOT NULL CHECK (max_per_grant BETWEEN 1 AND 100000000),
  enabled boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL DEFAULT 'system',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'resource') = (resource_id IS NOT NULL)),
  CHECK ((kind = 'chest') = (chest_stage IS NOT NULL))
);
ALTER TABLE public.reward_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reward_catalog FROM PUBLIC;

-- Starting entries: Gold, every enabled ledger resource, a normal and a Boss chest for each Location.
INSERT INTO public.reward_catalog(id, title, kind, max_per_grant) VALUES ('gold', 'Gold', 'gold', 100000000) ON CONFLICT DO NOTHING;
INSERT INTO public.reward_catalog(id, title, kind, resource_id, max_per_grant)
SELECT resource.resource_id,
  CASE resource.resource_id
    WHEN 'summon_scroll' THEN 'Summon Scroll' WHEN 'boss_key' THEN 'Boss Key' WHEN 'potion_xs' THEN 'Healing Potion'
    WHEN 'premium_potion_weak' THEN 'Weak Premium Potion' WHEN 'premium_potion_strong' THEN 'Strong Premium Potion'
    WHEN 'tutorial_chest' THEN 'Tutorial Chest' WHEN 'iron_scrap' THEN 'Iron Scrap' WHEN 'arcane_dust' THEN 'Arcane Dust'
    WHEN 'astral_shard' THEN 'Astral Shard' WHEN 'godforged_core' THEN 'Godforged Core'
    ELSE initcap(replace(resource.resource_id, '_', ' ')) END,
  'resource', resource.resource_id, LEAST(resource.maximum_balance, 10000)
FROM public.resource_catalog resource
WHERE resource.enabled AND resource.resource_id NOT IN ('potion_sm', 'potion_md', 'potion_lg', 'potion_xl', 'potion_xxl')
ON CONFLICT DO NOTHING;
INSERT INTO public.reward_catalog(id, title, kind, chest_stage, chest_boss, max_per_grant)
SELECT 'chest_l' || stage, 'Chest · Location ' || stage, 'chest', stage, false, 10 FROM generate_series(1, 20) stage
UNION ALL
SELECT 'boss_chest_l' || stage, 'Boss Chest · Location ' || stage, 'chest', stage, true, 10 FROM generate_series(1, 20) stage
ON CONFLICT DO NOTHING;

-- Letters accept ledger resources: {"kind":"resource","resource_id":"summon_scroll","amount":5,"title":"Summon Scroll"}.
ALTER TABLE public.player_mail_rewards DROP CONSTRAINT IF EXISTS player_mail_rewards_kind_check;
ALTER TABLE public.player_mail_rewards ADD CONSTRAINT player_mail_rewards_kind_check CHECK (kind IN ('chest', 'gold', 'resource'));

CREATE OR REPLACE FUNCTION public.mail_attachment_payload(p_attachment jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF jsonb_typeof(p_attachment) <> 'object' THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
  IF p_attachment->>'kind' = 'chest' THEN
    IF jsonb_typeof(p_attachment->'stage') <> 'number' OR (p_attachment->>'stage')::numeric NOT BETWEEN 1 AND 20
      OR (p_attachment->>'stage')::numeric <> trunc((p_attachment->>'stage')::numeric) THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    RETURN jsonb_build_object('stage', (p_attachment->>'stage')::integer, 'boss', COALESCE((p_attachment->>'boss')::boolean, false));
  ELSIF p_attachment->>'kind' = 'gold' THEN
    IF jsonb_typeof(p_attachment->'amount') <> 'number' OR (p_attachment->>'amount')::numeric NOT BETWEEN 1 AND 1000000000000
      OR (p_attachment->>'amount')::numeric <> trunc((p_attachment->>'amount')::numeric) THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    RETURN jsonb_build_object('amount', (p_attachment->>'amount')::bigint);
  ELSIF p_attachment->>'kind' = 'resource' THEN
    IF NOT EXISTS (SELECT 1 FROM public.resource_catalog WHERE resource_id = p_attachment->>'resource_id' AND enabled)
      OR jsonb_typeof(p_attachment->'amount') <> 'number' OR (p_attachment->>'amount')::numeric NOT BETWEEN 1 AND 100000000
      OR (p_attachment->>'amount')::numeric <> trunc((p_attachment->>'amount')::numeric) THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    RETURN jsonb_build_object('resource_id', p_attachment->>'resource_id', 'amount', (p_attachment->>'amount')::bigint,
      'title', left(COALESCE(NULLIF(p_attachment->>'title', ''), p_attachment->>'resource_id'), 60));
  END IF;
  RAISE EXCEPTION 'invalid_mail_attachment';
END
$function$;
REVOKE ALL ON FUNCTION public.mail_attachment_payload(jsonb) FROM PUBLIC;

-- The resource ledger accepts mail_reward as a source; reconciliation knows it too.
DO $patch$
DECLARE d text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)', 'public.resource_ledger_reconciliation()'] LOOP
    d := pg_get_functiondef(signature::regprocedure);
    IF position('''mail_reward''' in d) = 0 THEN
      IF position('''potion_use'',' in d) = 0 THEN RAISE EXCEPTION 'mail_reward_resource_definition_mismatch'; END IF;
      EXECUTE replace(d, '''potion_use'',', '''potion_use'',''mail_reward'',');
    END IF;
  END LOOP;
END
$patch$;

-- Claiming a letter lands its resources through the ledger; a full resource balance leaves that attachment in
-- the letter (like a full chest queue), every other attachment still lands.
DO $patch$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  IF position('resources_full' in d) > 0 THEN RETURN; END IF;
  n := replace(d, E'  v_is_letter boolean := false;\n', E'  v_is_letter boolean := false;\n  v_resources_changed boolean := false;\n  v_resources_full boolean := false;\n');
  n := replace(n, E'      ELSIF v_reward.kind = ''gold'' THEN\n        v_gold := v_gold + (v_reward.payload->>''amount'')::bigint;\n      END IF;\n',
E'      ELSIF v_reward.kind = ''gold'' THEN\n        v_gold := v_gold + (v_reward.payload->>''amount'')::bigint;\n      ELSIF v_reward.kind = ''resource'' THEN\n        BEGIN\n          PERFORM public.apply_resource_entries(p_player_id, v_reward.id, ''mail_claim'', encode(extensions.digest(v_reward.id::text, ''sha256''), ''hex''),\n            jsonb_build_array(jsonb_build_object(''resource_id'', v_reward.payload->>''resource_id'', ''delta'', v_reward.payload->>''amount'', ''source_key'', ''mail_reward'')));\n          v_resources_changed := true;\n        EXCEPTION WHEN OTHERS THEN\n          IF SQLERRM = ''resource_balance_cap'' THEN v_resources_full := true; CONTINUE; END IF;\n          RAISE;\n        END;\n      END IF;\n');
  n := replace(n, E'''items_full'', v_items_full, ''chests_full'', v_chests_full, ''gold_claimed'', v_gold);',
    E'''items_full'', v_items_full, ''chests_full'', v_chests_full, ''gold_claimed'', v_gold,\n    ''resources_full'', v_resources_full, ''resources_changed'', v_resources_changed);');
  n := replace(n, E'  RETURN v_result || jsonb_build_object(''inventory'', v_inventory, ''chests'', v_chests, ''gold'', COALESCE((v_state->>''gold'')::bigint, 0));',
    E'  RETURN v_result || jsonb_build_object(''inventory'', v_inventory, ''chests'', v_chests, ''gold'', COALESCE((v_state->>''gold'')::bigint, 0),\n    ''resources'', public.resource_snapshot(p_player_id));');
  IF position('''mail_reward''' in n) = 0 OR position('resources_full' in n) = 0 OR position('resource_snapshot' in n) = 0 THEN
    RAISE EXCEPTION 'mail_claim_resource_patch_failed';
  END IF;
  EXECUTE n;
END
$patch$;

COMMIT;
