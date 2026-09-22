-- One-time production cleanup requested by the owner.
-- Delete only the exact username Eblan and fail closed if duplicates exist.
DO $$
DECLARE
  target_count integer;
  target_id uuid;
BEGIN
  SELECT count(*) INTO target_count FROM public.players WHERE btrim(username) = 'Eblan';
  SELECT player_id INTO target_id FROM public.players WHERE btrim(username) = 'Eblan' LIMIT 1;

  IF target_count > 1 THEN
    RAISE EXCEPTION 'Refusing to delete duplicate Eblan accounts';
  ELSIF target_count = 1 THEN
    DELETE FROM auth.users WHERE id = target_id;
  END IF;
END $$;
