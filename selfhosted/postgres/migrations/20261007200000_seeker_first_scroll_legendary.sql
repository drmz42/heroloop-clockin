-- Permanent Seeker-only first-Scroll guarantee. Account history is server-owned.
DO $patch$
DECLARE
  target regprocedure := 'public.seeker_settle_hero_summon(uuid,uuid,integer,bigint,text,uuid)'::regprocedure;
  source text := pg_get_functiondef(target);
  anchor text := '    v_rarity := v_rarities[v_rarity_index];';
  injection text := $guarantee$    -- SEEKER_FIRST_SCROLL_LEGENDARY_BEGIN
    IF p_payment_method = 'scroll' AND i = 1
      AND NOT EXISTS (SELECT 1 FROM public.summon_events
        WHERE player_id = p_player_id AND payment_method = 'scroll')
    THEN
      v_rarity_index := 5;
    END IF;
    -- SEEKER_FIRST_SCROLL_LEGENDARY_END
$guarantee$;
BEGIN
  IF (length(source) - length(replace(source, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'unexpected_seeker_summon_definition';
  END IF;
  IF position('SEEKER_FIRST_SCROLL_LEGENDARY_BEGIN' IN source) > 0 THEN
    IF position(injection IN source) = 0 THEN RAISE EXCEPTION 'unexpected_first_scroll_guarantee'; END IF;
    source := replace(source, injection, '');
  END IF;
  EXECUTE replace(source, anchor, injection || anchor);
END
$patch$;
