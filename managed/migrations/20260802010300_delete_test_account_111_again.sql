-- One-time production cleanup requested on 2026-08-02.
-- The exact username predicate prevents deletion of unrelated accounts.
DELETE FROM auth.users AS auth_user
WHERE EXISTS (
  SELECT 1
  FROM public.players AS player
  WHERE player.player_id = auth_user.id
    AND btrim(player.username) = '111'
);
