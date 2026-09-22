-- Delete only the verified Auth account currently owning the exact username 111.
DELETE FROM auth.users
WHERE id = 'efa6c516-575c-4750-9862-28d114ecbe34'::uuid
  AND EXISTS (
    SELECT 1
    FROM public.players
    WHERE player_id = 'efa6c516-575c-4750-9862-28d114ecbe34'::uuid
      AND username = '111'
  );
