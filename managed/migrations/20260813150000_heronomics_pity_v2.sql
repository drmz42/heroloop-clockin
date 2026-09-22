ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS pity_celestial bigint NOT NULL DEFAULT 0 CHECK (pity_celestial >= 0);

DO $$
DECLARE v_definition text:=pg_get_functiondef('public.settle_hero_summon(uuid,uuid,integer)'::regprocedure);
BEGIN
  IF position('WHEN v_divine >= 9999' in v_definition)=0 OR position('(v_mythic - 199) * 0.01' in v_definition)=0 THEN
    RAISE EXCEPTION 'summon_pity_v1_definition_mismatch';
  END IF;
  v_definition:=replace(v_definition,'v_divine bigint;'||chr(10),'v_divine bigint;'||chr(10)||'  v_celestial bigint;'||chr(10));
  v_definition:=replace(v_definition,
    'SELECT token_balance, pity_legendary, pity_mythic, pity_cosmic, pity_divine, ascension_focus',
    'SELECT token_balance, pity_legendary, pity_mythic, pity_cosmic, pity_divine, pity_celestial, ascension_focus');
  v_definition:=replace(v_definition,
    'INTO v_balance, v_legendary, v_mythic, v_cosmic, v_divine, v_focus',
    'INTO v_balance, v_legendary, v_mythic, v_cosmic, v_divine, v_celestial, v_focus');
  v_definition:=replace(v_definition,
    'WHEN v_divine >= 9999 THEN ''divine'''||chr(10)||'      WHEN v_cosmic >= 2499 THEN ''cosmic''',
    'WHEN v_celestial >= 19999 THEN ''celestial'''||chr(10)||'      WHEN v_divine >= 4999 THEN ''divine'''||chr(10)||'      WHEN v_cosmic >= 1999 THEN ''cosmic''');
  v_definition:=replace(v_definition,'WHEN v_legendary >= 99 THEN ''legendary''','WHEN v_legendary >= 149 THEN ''legendary''');
  v_definition:=replace(v_definition,
    'IF v_min_rarity = ''divine'' THEN',
    'IF v_min_rarity = ''celestial'' THEN'||chr(10)||'      v_rarity := ''celestial'';'||chr(10)||'    ELSIF v_min_rarity = ''divine'' THEN');
  v_definition:=replace(v_definition,
    'CASE WHEN v_mythic >= 200 THEN LEAST(2.99, (v_mythic - 199) * 0.01) ELSE 0 END',
    'CASE WHEN v_mythic >= 250 THEN LEAST(0.3735, (v_mythic - 249) * 0.0015) ELSE 0 END');
  v_definition:=replace(v_definition,
    'IF v_rarity IN (''divine'', ''celestial'') THEN v_divine := 0; ELSE v_divine := v_divine + 1; END IF;',
    'IF v_rarity IN (''divine'', ''celestial'') THEN v_divine := 0; ELSE v_divine := v_divine + 1; END IF;'||chr(10)||
    '    IF v_rarity = ''celestial'' THEN v_celestial := 0; ELSE v_celestial := v_celestial + 1; END IF;');
  v_definition:=replace(v_definition,
    'pity_divine = v_divine,'||chr(10)||'      ascension_focus',
    'pity_divine = v_divine,'||chr(10)||'      pity_celestial = v_celestial,'||chr(10)||'      ascension_focus');
  v_definition:=replace(v_definition,
    '''pity_cosmic'', v_cosmic, ''pity_divine'', v_divine,',
    '''pity_cosmic'', v_cosmic, ''pity_divine'', v_divine, ''pity_celestial'', v_celestial,');
  EXECUTE v_definition;
END $$;

REVOKE ALL ON FUNCTION public.settle_hero_summon(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_hero_summon(uuid,uuid,integer) TO service_role;
