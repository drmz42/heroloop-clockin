\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_admin;
REVOKE ALL ON SCHEMA storage FROM PUBLIC;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  public boolean NOT NULL DEFAULT false CHECK (public = false),
  file_size_limit bigint NOT NULL CHECK (file_size_limit BETWEEN 1 AND 5242880),
  allowed_mime_types text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES storage.buckets(id),
  name text NOT NULL CHECK (
    length(name) BETWEEN 1 AND 200
    AND name ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND name !~ '(^|/)\.\.(/|$)'
    AND name !~ '//'
  ),
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  file_path text NOT NULL UNIQUE CHECK (file_path ~ '^objects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 5242880),
  mime_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA storage FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO storage.buckets(id, public, file_size_limit, allowed_mime_types)
VALUES
  ('player-files', false, 5242880, ARRAY['application/octet-stream','text/plain','image/jpeg','image/png','image/webp']),
  ('recovery-fixture', false, 65536, ARRAY['text/plain'])
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION heroloop_api.storage_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,storage AS $function$
  SELECT jsonb_build_object(
    'ready', true,
    'ready_objects', (SELECT count(*) FROM storage.objects WHERE status='ready')
  )
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.storage_reserve(
  p_player_id uuid, p_bucket_id text, p_name text, p_size_bytes bigint,
  p_mime_type text, p_sha256 text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,storage AS $function$
DECLARE v_bucket storage.buckets%ROWTYPE; v_id uuid:=gen_random_uuid();
BEGIN
  IF p_bucket_id <> 'player-files' OR p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 200
     OR p_name !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' OR p_name ~ '(^|/)\.\.(/|$)' OR p_name ~ '//'
     OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_storage_object';
  END IF;
  SELECT * INTO STRICT v_bucket FROM storage.buckets WHERE id=p_bucket_id AND public=false;
  IF p_size_bytes < 0 OR p_size_bytes > v_bucket.file_size_limit OR NOT (p_mime_type=ANY(v_bucket.allowed_mime_types)) THEN
    RAISE EXCEPTION 'invalid_storage_object';
  END IF;
  INSERT INTO storage.objects(id,bucket_id,name,owner_id,file_path,size_bytes,mime_type,sha256,status)
  VALUES(v_id,p_bucket_id,p_name,p_player_id,'objects/'||v_id::text,p_size_bytes,p_mime_type,p_sha256,'pending');
  RETURN jsonb_build_object('id',v_id,'file_path','objects/'||v_id::text);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'storage_object_exists';
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.storage_commit(p_player_id uuid,p_object_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,storage AS $function$
DECLARE v_object storage.objects%ROWTYPE;
BEGIN
  UPDATE storage.objects SET status='ready',updated_at=now()
  WHERE id=p_object_id AND owner_id=p_player_id AND status='pending'
  RETURNING * INTO v_object;
  IF NOT FOUND THEN RAISE EXCEPTION 'storage_reservation_not_found'; END IF;
  RETURN jsonb_build_object('id',v_object.id,'bucket_id',v_object.bucket_id,'name',v_object.name,
    'size_bytes',v_object.size_bytes,'mime_type',v_object.mime_type,'sha256',v_object.sha256);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.storage_abort(p_player_id uuid,p_object_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,storage AS $function$
  WITH removed AS (
    DELETE FROM storage.objects WHERE id=p_object_id AND owner_id=p_player_id AND status='pending'
    RETURNING id
  ) SELECT jsonb_build_object('removed', EXISTS(SELECT 1 FROM removed))
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.storage_open(p_player_id uuid,p_bucket_id text,p_name text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,storage AS $function$
  SELECT jsonb_build_object('id',id,'file_path',file_path,'size_bytes',size_bytes,
    'mime_type',mime_type,'sha256',sha256)
  FROM storage.objects
  WHERE bucket_id=p_bucket_id AND name=p_name AND owner_id=p_player_id AND status='ready'
$function$;

REVOKE ALL ON FUNCTION heroloop_api.storage_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.storage_reserve(uuid,text,text,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.storage_commit(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.storage_abort(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.storage_open(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.storage_health() TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.storage_reserve(uuid,text,text,bigint,text,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.storage_commit(uuid,uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.storage_abort(uuid,uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.storage_open(uuid,text,text) TO heroloop_api;

COMMENT ON TABLE storage.objects IS 'Private self-hosted file metadata; payload bytes live only in the protected Storage path.';
