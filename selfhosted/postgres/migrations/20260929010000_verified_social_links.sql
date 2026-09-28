\set ON_ERROR_STOP on

-- Verified social links for Partner Quests (HL-TASK-20260927232430-E773CE).
-- A typed handle proved nothing, so a link now needs the provider itself:
-- X OAuth 2.0 (PKCE) or a one-time /start code sent to our Telegram bot. The
-- API stores a hashed single-use challenge, the provider returns the stable
-- account id, and one provider account can belong to one player only.

ALTER TABLE public.player_social_link_events DROP CONSTRAINT player_social_link_events_kind;
ALTER TABLE public.player_social_link_events
  ADD COLUMN provider_user_id text,
  ADD CONSTRAINT player_social_link_events_kind CHECK (kind IN ('linked', 'changed', 'refreshed', 'unverified_removed'));

-- Typed, unverified handles are removed (logged); players link again.
INSERT INTO public.player_social_link_events(player_id, provider, kind, handle)
SELECT player_id, provider, 'unverified_removed', handle FROM public.player_social_links;
DELETE FROM public.player_social_links;

ALTER TABLE public.player_social_links
  DROP CONSTRAINT player_social_links_provider,
  DROP CONSTRAINT player_social_links_handle,
  DROP CONSTRAINT player_social_links_unique_handle,
  ADD COLUMN provider_user_id text NOT NULL,
  ADD CONSTRAINT player_social_links_provider CHECK (provider IN ('x', 'telegram', 'discord')),
  ADD CONSTRAINT player_social_links_handle CHECK (handle ~ '^[A-Za-z0-9_.]{1,32}$'),
  ADD CONSTRAINT player_social_links_provider_user_id CHECK (provider_user_id ~ '^[0-9]{1,25}$'),
  ADD CONSTRAINT player_social_links_unique_account UNIQUE (provider, provider_user_id);

CREATE TABLE public.player_social_link_challenges (
  state_hash text PRIMARY KEY CONSTRAINT player_social_link_challenges_state CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  provider text NOT NULL CONSTRAINT player_social_link_challenges_provider CHECK (provider IN ('x', 'telegram', 'discord')),
  code_verifier text CONSTRAINT player_social_link_challenges_verifier CHECK (code_verifier IS NULL OR code_verifier ~ '^[A-Za-z0-9_-]{43,128}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX player_social_link_challenges_player ON public.player_social_link_challenges(player_id, created_at DESC);
REVOKE ALL ON public.player_social_link_challenges FROM PUBLIC;
ALTER TABLE public.player_social_link_challenges ENABLE ROW LEVEL SECURITY;

DROP FUNCTION heroloop_api.social_link_set(uuid, text, text);

-- API: store a hashed one-time link challenge (10 minutes).
CREATE OR REPLACE FUNCTION heroloop_api.social_link_challenge_create(p_player_id uuid, p_provider text, p_state_hash text, p_code_verifier text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_expires timestamptz := now() + interval '10 minutes';
BEGIN
  IF p_player_id IS NULL OR p_provider NOT IN ('x', 'telegram', 'discord') THEN RAISE EXCEPTION 'invalid_social_provider'; END IF;
  PERFORM 1 FROM public.players WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  DELETE FROM public.player_social_link_challenges WHERE player_id = p_player_id AND expires_at < now() - interval '1 day';
  INSERT INTO public.player_social_link_challenges(state_hash, player_id, provider, code_verifier, expires_at)
  VALUES (p_state_hash, p_player_id, p_provider, p_code_verifier, v_expires);
  RETURN jsonb_build_object('expires_at', v_expires);
END
$function$;

-- API: redeem a challenge once. Unknown, expired or used challenges fail alike.
CREATE OR REPLACE FUNCTION heroloop_api.social_link_challenge_consume(p_provider text, p_state_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_row public.player_social_link_challenges%ROWTYPE;
BEGIN
  UPDATE public.player_social_link_challenges SET consumed_at = now()
  WHERE state_hash = p_state_hash AND provider = p_provider AND consumed_at IS NULL AND expires_at > now()
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'social_link_expired'; END IF;
  RETURN jsonb_build_object('player_id', v_row.player_id, 'code_verifier', v_row.code_verifier);
END
$function$;

-- API: record a provider-verified account. The same account refreshes its
-- username freely; switching to another account keeps the 24-hour cooldown.
CREATE OR REPLACE FUNCTION heroloop_api.social_link_verified_set(p_player_id uuid, p_provider text, p_provider_user_id text, p_handle text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_handle text := NULLIF(btrim(COALESCE(p_handle, '')), '');
  v_existing public.player_social_links%ROWTYPE;
BEGIN
  IF p_player_id IS NULL OR p_provider NOT IN ('x', 'telegram', 'discord')
    OR p_provider_user_id IS NULL OR p_provider_user_id !~ '^[0-9]{1,25}$' THEN
    RAISE EXCEPTION 'invalid_social_account';
  END IF;
  IF p_provider = 'telegram' AND v_handle IS NULL THEN v_handle := 'tg' || p_provider_user_id; END IF;
  IF v_handle IS NULL OR v_handle !~ '^[A-Za-z0-9_.]{1,32}$' THEN RAISE EXCEPTION 'invalid_social_account'; END IF;
  PERFORM 1 FROM public.players WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('social-link:' || p_provider || ':' || p_provider_user_id, 0));
  IF EXISTS (SELECT 1 FROM public.player_social_links
    WHERE provider = p_provider AND provider_user_id = p_provider_user_id AND player_id <> p_player_id) THEN
    RAISE EXCEPTION 'social_account_taken';
  END IF;
  SELECT * INTO v_existing FROM public.player_social_links WHERE player_id = p_player_id AND provider = p_provider FOR UPDATE;
  IF FOUND AND v_existing.provider_user_id = p_provider_user_id THEN
    IF v_existing.handle <> v_handle THEN
      UPDATE public.player_social_links SET handle = v_handle, handle_norm = lower(v_handle)
      WHERE player_id = p_player_id AND provider = p_provider;
      INSERT INTO public.player_social_link_events(player_id, provider, kind, handle, previous_handle, provider_user_id)
      VALUES (p_player_id, p_provider, 'refreshed', v_handle, v_existing.handle, p_provider_user_id);
    END IF;
  ELSIF FOUND THEN
    IF v_existing.updated_at > now() - interval '24 hours' THEN RAISE EXCEPTION 'social_link_cooldown'; END IF;
    UPDATE public.player_social_links SET handle = v_handle, handle_norm = lower(v_handle),
      provider_user_id = p_provider_user_id, updated_at = now()
    WHERE player_id = p_player_id AND provider = p_provider;
    INSERT INTO public.player_social_link_events(player_id, provider, kind, handle, previous_handle, provider_user_id)
    VALUES (p_player_id, p_provider, 'changed', v_handle, v_existing.handle, p_provider_user_id);
  ELSE
    INSERT INTO public.player_social_links(player_id, provider, handle, handle_norm, provider_user_id)
    VALUES (p_player_id, p_provider, v_handle, lower(v_handle), p_provider_user_id);
    INSERT INTO public.player_social_link_events(player_id, provider, kind, handle, provider_user_id)
    VALUES (p_player_id, p_provider, 'linked', v_handle, p_provider_user_id);
  END IF;
  RETURN heroloop_api.social_link_list(p_player_id);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.social_link_list(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'x', (SELECT jsonb_build_object('handle', handle, 'linked_at', linked_at, 'changeable_at', updated_at + interval '24 hours')
      FROM public.player_social_links WHERE player_id = p_player_id AND provider = 'x'),
    'telegram', (SELECT jsonb_build_object('handle', handle, 'linked_at', linked_at, 'changeable_at', updated_at + interval '24 hours')
      FROM public.player_social_links WHERE player_id = p_player_id AND provider = 'telegram'),
    'discord', (SELECT jsonb_build_object('handle', handle, 'linked_at', linked_at, 'changeable_at', updated_at + interval '24 hours')
      FROM public.player_social_links WHERE player_id = p_player_id AND provider = 'discord')
  );
$function$;

-- The rate limiter rejects unregistered actions: the typed-handle command is
-- replaced by the link start command.
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  IF to_regprocedure('heroloop_api.consume_rate_limit(uuid,text)') IS NULL THEN RETURN; END IF;
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''social_link_set'',5,300),', '(''social_link_start'',10,300),');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'social_link_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END
$$;

REVOKE ALL ON FUNCTION heroloop_api.social_link_challenge_create(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.social_link_challenge_consume(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.social_link_verified_set(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.social_link_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.social_link_challenge_create(uuid,text,text,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.social_link_challenge_consume(text,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.social_link_verified_set(uuid,text,text,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.social_link_list(uuid) TO heroloop_api;
