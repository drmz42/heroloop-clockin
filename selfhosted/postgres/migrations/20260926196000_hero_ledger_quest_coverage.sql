\set ON_ERROR_STOP on

-- $HERO reconciliation coverage now checks quest rewards too: every settled
-- quest claim that paid $HERO must have its quest ledger row with the same
-- amount (docs/game/progression-and-economy.md). Same function, one more source.

CREATE OR REPLACE FUNCTION admin.hero_ledger_coverage()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sources jsonb := '{}'::jsonb;
  v_missing bigint;
  v_mismatch bigint;
  v_orphan bigint;
BEGIN
  IF to_regclass('public.token_spend_events') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> e.amount)
      INTO v_missing, v_mismatch
    FROM public.token_spend_events e
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'token_spend:' || e.idempotency_key
    WHERE e.amount > 0;
    SELECT count(*) INTO v_orphan FROM public.hero_economy_ledger l
    WHERE l.source_key LIKE 'token_spend:%' AND l.player_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.token_spend_events e WHERE 'token_spend:' || e.idempotency_key = l.source_key);
    v_sources := v_sources || jsonb_build_object('token_spend', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch, 'missing_source', v_orphan));
  END IF;

  IF to_regclass('public.distribution_log') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> d.amount_distributed)
      INTO v_missing, v_mismatch
    FROM public.distribution_log d
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'distribution:' || d.id
    WHERE d.amount_distributed > 0;
    SELECT count(*) INTO v_orphan FROM public.hero_economy_ledger l
    WHERE l.source_key LIKE 'distribution:%'
      AND NOT EXISTS (SELECT 1 FROM public.distribution_log d WHERE 'distribution:' || d.id = l.source_key);
    v_sources := v_sources || jsonb_build_object('distribution', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch, 'missing_source', v_orphan));
  END IF;

  IF to_regclass('public.market_item_events') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> (e.result->>'fee')::numeric)
      INTO v_missing, v_mismatch
    FROM public.market_item_events e
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'market_fee:' || e.idempotency_key
    WHERE e.action = 'buy' AND coalesce(e.result->>'fee', '') ~ '^[0-9]+([.][0-9]+)?$' AND (e.result->>'fee')::numeric > 0;
    v_sources := v_sources || jsonb_build_object('market_fee', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch));
  END IF;

  IF to_regclass('public.promo_code_redemptions') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> (e.result#>>'{rewards,hero}')::numeric)
      INTO v_missing, v_mismatch
    FROM public.promo_code_redemptions e
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'promo:' || e.idempotency_key
    WHERE coalesce(e.result#>>'{rewards,hero}', '') ~ '^[0-9]+([.][0-9]+)?$' AND (e.result#>>'{rewards,hero}')::numeric > 0;
    v_sources := v_sources || jsonb_build_object('promo', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch));
  END IF;

  -- Quest rewards: the key names the player and the quest instance; claims
  -- settled before 2026-08-27 used the instance alone.
  IF to_regclass('public.quest_claim_events') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> (e.result#>>'{reward,hero}')::numeric)
      INTO v_missing, v_mismatch
    FROM public.quest_claim_events e
    LEFT JOIN public.hero_economy_ledger l
      ON l.source_key IN ('quest:' || e.player_id || ':' || e.instance_key, 'quest:' || e.instance_key)
    WHERE coalesce(e.result#>>'{reward,hero}', '') ~ '^[0-9]+([.][0-9]+)?$' AND (e.result#>>'{reward,hero}')::numeric > 0;
    v_sources := v_sources || jsonb_build_object('quest', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch));
  END IF;

  RETURN jsonb_build_object(
    'sources', v_sources,
    'unknown_source_kinds', (SELECT count(DISTINCT source_kind) FROM public.hero_economy_ledger WHERE NOT (source_kind = ANY (admin.hero_ledger_known_kinds()))),
    'negative_balances', (SELECT count(*) FROM public.players WHERE coalesce(token_balance, 0) < 0 OR coalesce(pending_tokens, 0) < 0),
    -- source_key is UNIQUE, so this stays zero unless the constraint is lost.
    'duplicate_keys', (SELECT count(*) FROM (SELECT source_key FROM public.hero_economy_ledger GROUP BY source_key HAVING count(*) > 1) d),
    -- Both are written by the same statement that changes the balance, with no
    -- separate source event to compare against.
    'not_checked', jsonb_build_array('tester_credit', 'account_balance_extinguishment')
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.hero_ledger_coverage() FROM PUBLIC;
