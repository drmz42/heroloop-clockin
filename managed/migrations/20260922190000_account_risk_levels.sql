-- Account risk levels (docs/game/storage-and-retention-policy.md, decisions 2026-09-21).
-- Normal has no row. Review and Hold refuse every token/$HERO debit server-side;
-- earning and Gold-only actions continue. Only the Founder lowers Review or Hold.
-- No foreign key to players: the case record survives account deletion.
CREATE TABLE public.account_risk_levels (
  player_id uuid PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('watch', 'review', 'hold')),
  reason_codes text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(reason_codes) <= 16),
  set_by text NOT NULL CHECK (set_by IN ('system', 'founder')),
  review_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.account_risk_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id uuid NOT NULL,
  from_level text NOT NULL CHECK (from_level IN ('normal', 'watch', 'review', 'hold')),
  to_level text NOT NULL CHECK (to_level IN ('normal', 'watch', 'review', 'hold')),
  actor text NOT NULL CHECK (actor IN ('system', 'founder')),
  reason_codes text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(reason_codes) <= 16),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  review_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_risk_events_player_created_idx
  ON public.account_risk_events(player_id, created_at);

ALTER TABLE public.account_risk_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_risk_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_risk_levels FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.account_risk_events FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.account_risk_level(p_player_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    (SELECT level FROM public.account_risk_levels WHERE player_id = p_player_id),
    'normal'
  )
$$;

CREATE FUNCTION public.assert_account_value_allowed(p_player_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.account_risk_level(p_player_id) IN ('review', 'hold') THEN
    RAISE EXCEPTION 'account_restricted';
  END IF;
END
$$;

-- Every token spend, purchase, Market payment and $HERO-paid upgrade lowers
-- players.token_balance, so one row trigger enforces the freeze for all of them
-- and judges mixed Gold/$HERO actions by the currency actually charged.
CREATE FUNCTION public.guard_restricted_token_debit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_account_value_allowed(NEW.player_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER players_restricted_token_debit
  BEFORE UPDATE OF token_balance ON public.players
  FOR EACH ROW
  WHEN (NEW.token_balance < OLD.token_balance)
  EXECUTE FUNCTION public.guard_restricted_token_debit();

CREATE FUNCTION public.set_account_risk_level(
  p_player_id uuid,
  p_level text,
  p_actor text,
  p_reason_codes text[] DEFAULT '{}',
  p_note text DEFAULT NULL,
  p_review_deadline timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rank constant jsonb := '{"normal":0,"watch":1,"review":2,"hold":3}';
  v_current text;
  v_deadline timestamptz := p_review_deadline;
  v_reasons text[] := COALESCE(p_reason_codes, '{}');
BEGIN
  IF p_player_id IS NULL THEN RAISE EXCEPTION 'invalid_player'; END IF;
  IF NOT v_rank ? COALESCE(p_level, '') THEN RAISE EXCEPTION 'invalid_risk_level'; END IF;
  IF p_actor IS NULL OR p_actor NOT IN ('system', 'founder') THEN RAISE EXCEPTION 'invalid_risk_actor'; END IF;
  IF cardinality(v_reasons) > 16
    OR EXISTS (SELECT 1 FROM unnest(v_reasons) reason WHERE reason !~ '^[a-z0-9_]{1,64}$') THEN
    RAISE EXCEPTION 'invalid_reason_codes';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('account_risk:' || p_player_id::text, 0));
  v_current := public.account_risk_level(p_player_id);

  IF v_current IN ('review', 'hold')
    AND (v_rank->>p_level)::int < (v_rank->>v_current)::int
    AND p_actor <> 'founder' THEN
    RAISE EXCEPTION 'founder_clear_required';
  END IF;
  -- An automatic Review/Hold must not freeze a player silently: it always
  -- carries a review deadline for the Founder alert.
  IF p_actor = 'system' AND p_level IN ('review', 'hold') AND v_deadline IS NULL THEN
    v_deadline := now() + interval '1 hour';
  END IF;
  IF p_level NOT IN ('review', 'hold') THEN v_deadline := NULL; END IF;

  IF p_level = 'normal' THEN
    DELETE FROM public.account_risk_levels WHERE player_id = p_player_id;
  ELSE
    INSERT INTO public.account_risk_levels(player_id, level, reason_codes, set_by, review_deadline)
    VALUES (p_player_id, p_level, v_reasons, p_actor, v_deadline)
    ON CONFLICT (player_id) DO UPDATE SET
      level = EXCLUDED.level,
      reason_codes = EXCLUDED.reason_codes,
      set_by = EXCLUDED.set_by,
      review_deadline = EXCLUDED.review_deadline,
      updated_at = now();
  END IF;

  INSERT INTO public.account_risk_events(
    player_id, from_level, to_level, actor, reason_codes, note, review_deadline
  ) VALUES (
    p_player_id, v_current, p_level, p_actor, v_reasons, left(p_note, 500), v_deadline
  );

  RETURN jsonb_build_object(
    'player_id', p_player_id,
    'from_level', v_current,
    'level', p_level,
    'review_deadline', v_deadline
  );
END
$$;

REVOKE ALL ON FUNCTION public.account_risk_level(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_account_value_allowed(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_restricted_token_debit() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_account_risk_level(uuid, text, text, text[], text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.set_account_risk_level(uuid, text, text, text[], text, timestamptz) IS
  'Operator/admin only. Lowering Review or Hold requires actor founder; AI models are advisory and never call this.';
