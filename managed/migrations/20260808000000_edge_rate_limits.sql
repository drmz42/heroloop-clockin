CREATE TABLE IF NOT EXISTS public.edge_rate_limits (
  subject_key text NOT NULL,
  action text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  PRIMARY KEY (subject_key, action)
);

ALTER TABLE public.edge_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_edge_rate_limit(
  p_subject_key text,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count integer;
BEGIN
  IF length(p_subject_key) NOT BETWEEN 1 AND 128
    OR p_action !~ '^[a-z0-9_-]{1,64}$'
    OR p_limit NOT BETWEEN 1 AND 1000
    OR p_window_seconds NOT BETWEEN 1 AND 86400 THEN
    RETURN false;
  END IF;

  INSERT INTO public.edge_rate_limits AS limits (
    subject_key, action, window_started_at, request_count
  ) VALUES (
    p_subject_key, p_action, v_now, 1
  )
  ON CONFLICT (subject_key, action) DO UPDATE SET
    window_started_at = CASE
      WHEN limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now THEN v_now
      ELSE limits.window_started_at
    END,
    request_count = CASE
      WHEN limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now THEN 1
      ELSE limits.request_count + 1
    END
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

REVOKE ALL ON TABLE public.edge_rate_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_edge_rate_limit(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_edge_rate_limit(text, text, integer, integer) TO service_role;

COMMENT ON TABLE public.edge_rate_limits IS
  'One bounded current rate-limit bucket per authenticated subject and Edge Function action; no request bodies, tokens or IP addresses are stored.';
