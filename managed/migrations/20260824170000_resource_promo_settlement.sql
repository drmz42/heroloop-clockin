CREATE OR REPLACE FUNCTION public.resource_promo_redemption_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scrolls bigint := COALESCE((NEW.result#>>'{rewards,summon_scrolls}')::bigint, 0);
  v_boss_keys bigint := COALESCE((NEW.result#>>'{rewards,boss_keys}')::bigint, 0);
  v_entries jsonb := '[]'::jsonb;
  v_resource jsonb;
  v_hash text;
BEGIN
  IF v_scrolls > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'resource_id', 'summon_scroll', 'delta', v_scrolls::text, 'source_key', 'promo_summon_scroll'));
  END IF;
  IF v_boss_keys > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'resource_id', 'boss_key', 'delta', v_boss_keys::text, 'source_key', 'promo_boss_key'));
  END IF;
  IF jsonb_array_length(v_entries) = 0 THEN RETURN NEW; END IF;
  v_hash := encode(extensions.digest(jsonb_build_object(
    'promo_code_id', NEW.promo_code_id, 'resources', v_entries)::text, 'sha256'), 'hex');
  v_resource := public.apply_resource_entries(NEW.player_id, NEW.idempotency_key, 'promo_code', v_hash,
    v_entries, (NEW.result->>'revision')::bigint);
  UPDATE public.players SET boss_keys = (v_resource#>>'{balances,boss_key}')::integer, updated_at = now()
  WHERE player_id = NEW.player_id;
  UPDATE public.player_saves SET state = jsonb_set(
      jsonb_set(state, '{bossKeys}', to_jsonb((v_resource#>>'{balances,boss_key}')::bigint), true),
      '{summonScrolls}', to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint), true),
    updated_at = now()
  WHERE player_id = NEW.player_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER promo_redemption_resource_ledger
AFTER INSERT ON public.promo_code_redemptions
FOR EACH ROW EXECUTE FUNCTION public.resource_promo_redemption_trigger();

REVOKE ALL ON FUNCTION public.resource_promo_redemption_trigger() FROM PUBLIC, anon, authenticated, service_role;
