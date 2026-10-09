-- Catalog item rewards are rolled once on the server, owned in the ledger and
-- attached to letters. Claim moves the same uid to the bag; it never re-rolls.
BEGIN;
CREATE FUNCTION pg_temp.mail_patch(d text, old text, replacement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF old='' OR length(d)-length(replace(d,old,''))<>length(old) THEN
    RAISE EXCEPTION 'mail_reward_patch_anchor_mismatch';
  END IF;
  RETURN replace(d,old,replacement);
END $$;

ALTER TABLE public.reward_catalog DROP CONSTRAINT reward_catalog_kind_check;
ALTER TABLE public.reward_catalog ADD CONSTRAINT reward_catalog_kind_check CHECK(kind IN ('gold','resource','chest','item'));
ALTER TABLE public.reward_catalog ADD COLUMN base_item_id text;
ALTER TABLE public.reward_catalog ADD COLUMN item_level integer;
ALTER TABLE public.reward_catalog ADD CONSTRAINT reward_catalog_item_template_check CHECK(
  (kind='item' AND base_item_id IS NOT NULL AND item_level IS NOT NULL AND base_item_id ~ '^(weapon-(mage|assassin|warrior|druid|crossbowman)|offhand-(mage|assassin|warrior|druid|crossbowman)|helmet|armor|gloves|boots|amulet|ring)-(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$'
    AND item_level BETWEEN 1 AND 99 AND max_per_grant<=20)
  OR (kind<>'item' AND base_item_id IS NULL AND item_level IS NULL));
INSERT INTO public.reward_catalog(id,title,kind,base_item_id,item_level,max_per_grant)
SELECT 'item_'||replace(base,'-','_')||'_'||rarity,
  initcap(replace(base,'-',' '))||' · '||initcap(rarity),'item',base||'-'||rarity,1,1
FROM unnest(ARRAY['weapon-mage','weapon-assassin','weapon-warrior','weapon-druid','weapon-crossbowman',
  'offhand-mage','offhand-assassin','offhand-warrior','offhand-druid','offhand-crossbowman',
  'helmet','armor','gloves','boots','amulet','ring']) base
CROSS JOIN unnest(ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial']) rarity;

ALTER TABLE public.player_mail_rewards DROP CONSTRAINT player_mail_rewards_kind_check;
ALTER TABLE public.player_mail_rewards ADD CONSTRAINT player_mail_rewards_kind_check CHECK(kind IN ('gold','resource','chest','item'));
CREATE UNIQUE INDEX player_mail_rewards_pending_item ON public.player_mail_rewards((payload->>'item_id'))
  WHERE kind='item' AND claimed_at IS NULL;

-- Only trusted server reward producers may resolve catalog rows. No player role
-- can call this function or choose templates, quantity, stats or supply limits.
CREATE FUNCTION public.mail_catalog_attachments(p_player uuid,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row jsonb; c public.reward_catalog; attachments jsonb:='[]'; quantity integer; i integer;
  item public.player_items; v_rarity text; slot text; stats jsonb; supply public.rarity_supply;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>10 THEN RAISE EXCEPTION 'invalid_mail_rewards'; END IF;
  PERFORM 1 FROM public.players WHERE player_id=p_player FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    SELECT * INTO c FROM public.reward_catalog WHERE id=row->>'catalog_id' AND enabled FOR SHARE;
    IF NOT FOUND OR jsonb_typeof(row->'amount') IS DISTINCT FROM 'number'
      OR (row->>'amount')::numeric<>trunc((row->>'amount')::numeric)
      OR (row->>'amount')::numeric NOT BETWEEN 1 AND c.max_per_grant THEN RAISE EXCEPTION 'invalid_mail_rewards'; END IF;
    quantity:=(row->>'amount')::integer;
    IF c.kind IN ('gold','resource') THEN
      attachments:=attachments||jsonb_build_array(CASE WHEN c.kind='gold' THEN jsonb_build_object('kind','gold','amount',quantity)
        ELSE jsonb_build_object('kind','resource','resource_id',c.resource_id,'amount',quantity,'title',c.title) END);
    ELSE
      IF jsonb_array_length(attachments)+quantity>20 THEN RAISE EXCEPTION 'invalid_mail_rewards'; END IF;
      FOR i IN 1..quantity LOOP
        IF c.kind='chest' THEN
          attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','chest','stage',c.chest_stage,'boss',c.chest_boss));
        ELSE
          v_rarity:=substring(c.base_item_id from '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$');
          slot:=CASE WHEN c.base_item_id LIKE 'weapon-%' THEN 'class_weapon' WHEN c.base_item_id LIKE 'offhand-%' THEN 'offhand'
            WHEN c.base_item_id LIKE 'armor-%' THEN 'chest' ELSE split_part(c.base_item_id,'-',1) END;
          IF v_rarity IN ('divine','celestial') THEN
            SELECT * INTO supply FROM public.rarity_supply WHERE rarity_supply.rarity=v_rarity FOR UPDATE;
            IF NOT FOUND OR supply.existing_count>=supply.max_existing THEN RAISE EXCEPTION 'rarity_supply_exhausted'; END IF;
            UPDATE public.rarity_supply SET existing_count=existing_count+1,updated_at=now() WHERE rarity_supply.rarity=v_rarity;
          END IF;
          stats:=public.roll_item_stats_v5(slot,v_rarity,c.item_level,c.base_item_id);
          INSERT INTO public.player_items(player_id,base_item_id,slot,rarity,item_level,stats,power,locked,
            enchant_stats_version,item_roll_version,source_kind)
          VALUES(p_player,c.base_item_id,slot,v_rarity,c.item_level,stats,public.calculate_item_power_v5(stats,0),
            v_rarity IN ('divine','celestial'),4,5,'mail_catalog') RETURNING * INTO item;
          attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','item','item_id',item.id,'item',public.mail_item_json(item)));
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF jsonb_array_length(attachments)>20 THEN RAISE EXCEPTION 'invalid_mail_rewards'; END IF;
  RETURN attachments;
END $$;
REVOKE ALL ON FUNCTION public.mail_catalog_attachments(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.mail_attachment_payload(jsonb)'::regprocedure);
  d:=pg_temp.mail_patch(d,'  IF p_attachment->>''kind'' = ''chest'' THEN',
    $new$  IF p_attachment->>'kind' = 'item' THEN
    IF NOT EXISTS (SELECT 1 FROM public.player_items WHERE id=(p_attachment->>'item_id')::uuid AND removed_at IS NULL)
      THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    RETURN jsonb_build_object('item_id',(p_attachment->>'item_id')::uuid,'item',
      (SELECT public.mail_item_json(item) FROM public.player_items item WHERE id=(p_attachment->>'item_id')::uuid));
  END IF;
  IF p_attachment->>'kind' = 'chest' THEN$new$);
  EXECUTE d;
  d:=pg_get_functiondef('public.mail_send_letter(uuid,text,text,text,text,text,jsonb)'::regprocedure);
  d:=pg_temp.mail_patch(d,'  INSERT INTO public.player_mail_letters(',
    $new$  -- Catalog rows are resolved once, inside the letter's atomic transaction.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_attachments,'[]')) a WHERE a ? 'catalog_id') THEN
    p_attachments:=public.mail_catalog_attachments(p_player_id,p_attachments);
  END IF;
  INSERT INTO public.player_mail_letters($new$);
  d:=pg_temp.mail_patch(d,'    INSERT INTO public.player_mail_rewards(',
    $new$    IF v_attachment->>'kind'='item' AND (
      NOT EXISTS(SELECT 1 FROM public.player_items WHERE id=(v_attachment->>'item_id')::uuid AND player_id=p_player_id AND removed_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.player_mail_items WHERE item_id=(v_attachment->>'item_id')::uuid AND claimed_at IS NULL)
      OR EXISTS(SELECT 1 FROM public.market_item_listings WHERE item_id=(v_attachment->>'item_id')::uuid AND status='active')
      OR EXISTS(SELECT 1 FROM public.player_saves s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.state->'inventory','[]')) x
        WHERE s.player_id=p_player_id AND x->>'uid'=v_attachment->>'item_id')) THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    INSERT INTO public.player_mail_rewards($new$);
  EXECUTE d;
  d:=pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  d:=pg_temp.mail_patch(d,'      ELSIF v_reward.kind = ''gold'' THEN',
    $new$      ELSIF v_reward.kind='item' THEN
        SELECT * INTO v_item FROM public.player_items WHERE id=(v_reward.payload->>'item_id')::uuid
          AND player_id=p_player_id AND removed_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'mail_item_unavailable'; END IF;
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_inventory) x WHERE x->>'uid'=v_item.id::text) THEN
          IF v_free<=0 THEN v_items_full:=true; CONTINUE; END IF;
          v_inventory:=v_inventory||jsonb_build_array(public.mail_item_json(v_item));
          v_free:=v_free-1;
        END IF;
      ELSIF v_reward.kind = 'gold' THEN$new$);
  EXECUTE d;
END
$patch$;
COMMIT;
