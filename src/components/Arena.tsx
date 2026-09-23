import { memo, useEffect, useRef, useState } from 'react';
import type { CombatUnit, FloatingNumber, GameState, OwnedHero, OwnedItem } from '@/game/types';
import { HERO_MAP, RARITY_COLORS } from '@/game/heroes';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { enemyArtSrc } from '@/game/art';
import { ChevronsUp, Crown, Crosshair, Shield, Skull, Star, Swords, DoorOpen, Flame, Moon, Sparkles, Timer, Users, Zap } from 'lucide-react';
import { MAX_HERO_STARS } from '@/game/state';

const STAR_COLORS = ['#fbbf24', '#a855f7', '#ef4444', '#ec4899'];
const HEALTH_NUMBER_FORMAT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const DUNGEON_BOSS_ART: Record<string, string> = {
  'iron-warden': 'boss-titan', 'ash-warlock': 'boss-lich', 'thorn-shaman': 'boss-ogre',
  'rift-behemoth': 'boss-dragon', 'grave-necromancer': 'boss-lich',
};

function formatHealth(value: number) {
  const rounded = Math.max(0, Math.ceil(value));
  return rounded >= 10_000 ? HEALTH_NUMBER_FORMAT.format(rounded) : rounded.toLocaleString('en-US');
}

function BattleHeroStars({ stars }: { stars: number }) {
  const clamped = Number.isFinite(stars) ? Math.max(0, Math.min(MAX_HERO_STARS, stars)) : 0;
  if (clamped === 0) return null;
  const tier = Math.floor((clamped - 1) / 5);
  const currentCount = ((clamped - 1) % 5) + 1;
  return (
    <span className="battle-hero-stars" aria-label={`${clamped} of ${MAX_HERO_STARS} hero stars`}>
      {Array.from({ length: 5 }, (_, index) => {
        const slotTier = index < currentCount ? tier : tier - 1;
        const color = slotTier >= 0 ? STAR_COLORS[slotTier] : undefined;
        return <Star key={index} className={color ? '' : 'text-[#625c50]'} style={color ? { color, fill: color } : undefined} />;
      })}
    </span>
  );
}

type VisualEnemyRank = NonNullable<CombatUnit['enemyRank']>;

function EnemyRankOrnament({ rank }: { rank: VisualEnemyRank }) {
  if (rank === 'normal') return null;
  const common = { size: 15, strokeWidth: 2.4, 'aria-hidden': true };
  if (rank === 'veteran') return <span className="enemy-rank-ornament enemy-rank-ornament-veteran" role="img" aria-label="Veteran enemy"><ChevronsUp {...common} /></span>;
  if (rank === 'elite') return <span className="enemy-rank-ornament enemy-rank-ornament-elite" role="img" aria-label="Elite enemy"><Swords {...common} /></span>;
  if (rank === 'epic') return <span className="enemy-rank-ornament enemy-rank-ornament-epic" role="img" aria-label="Epic enemy"><Crown {...common} /></span>;
  return <span className="enemy-rank-ornament enemy-rank-ornament-boss" role="img" aria-label={rank === 'dungeon-boss' ? 'Dungeon Boss' : 'Field Boss'}>{rank === 'dungeon-boss' ? <Skull {...common} /> : <Crown {...common} />}</span>;
}

function EnemyAffixMark({ affix }: { affix: NonNullable<CombatUnit['eliteAffix']> }) {
  const common = { size: 11, strokeWidth: 2.5, 'aria-hidden': true };
  const icon = affix === 'guard-aura' || affix === 'barrier' ? <Shield {...common} />
    : affix === 'mending' ? <Sparkles {...common} />
    : affix === 'enrage' ? <Flame {...common} />
    : affix === 'curse' ? <Moon {...common} />
    : affix === 'lane-blast' ? <Zap {...common} />
    : affix === 'summoner' ? <Users {...common} />
    : <Swords {...common} />;
  return <span className="enemy-affix-mark" role="img" aria-label={`${affix.replace('-', ' ')} enemy affix`}>{icon}</span>;
}

interface ArenaProps {
  units: CombatUnit[];
  floaters: FloatingNumber[];
  ownedHeroes?: OwnedHero[];
  inventory?: OwnedItem[];
  potionFx?: { uid: string; born: number } | null;
  respawnCountdowns?: Record<string, number>;
  animationMode: GameState['battleAnimationMode'];
  dungeonPanelOpen?: boolean;
  locationId?: number;
  dungeonBossScene?: {
    phase: 'retinue' | 'shared'; bossId: string; bossName: string; targetUid?: string;
    cast?: { name: string; remaining: number; impact: boolean } | null;
    momentum?: 'party' | 'even' | 'boss'; elapsedSeconds?: number;
    room: number; depth: number; status?: string; mechanic?: string; mechanicState?: string;
    threshold?: number; summons?: number; enrage?: boolean; transition?: string | null;
  } | null;
  dungeonRoom?: { room: number; depth: number; label: string; status?: string } | null;
}

function HealthBar({ hp, maxHp, color }: { hp: number; maxHp: number; color: string }) {
  const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  const low = pct < 30;
  return (
    <div className="health-track h-2.5 w-full overflow-hidden">
      <div className="h-full transition-all duration-150" style={{ width: `${pct}%`, background: low ? 'linear-gradient(90deg,#7e242a,#d45359)' : `linear-gradient(90deg,${color}99,${color})`, boxShadow: `0 0 6px ${color}66` }} />
    </div>
  );
}

// Damage always sits on the left of a fighter; everything else (heals, MISS, text effects such as
// poison or Barrier) sits on the right. Numbers also play in a short time queue (floater-queue.mjs).
function floaterOffset(f: FloatingNumber): { x: number; y: number } {
  if (!f.effect && !f.label && !f.miss && !f.heal) return { x: -24, y: 0 };
  return { x: 24, y: f.id % 2 === 0 ? 0 : -14 };
}

function UnitView({ unit, floaters, side, heroData, respawnSeconds, opponentAlive, animationMode, targeted = false }: { unit: CombatUnit; floaters: FloatingNumber[]; side: 'hero' | 'enemy'; heroData?: OwnedHero; respawnSeconds?: number; opponentAlive: boolean; animationMode: GameState['battleAnimationMode']; targeted?: boolean }) {
  const lastOutgoing = useRef(0);
  const lastIncoming = useRef(0);
  const [attackPhase, setAttackPhase] = useState<0 | 1 | 2>(0);
  const attackTimer = useRef(0);
  const [hit, setHit] = useState(false);
  const [slash, setSlash] = useState(false);
  const [heal, setHeal] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const myFloaters = floaters.filter((f) => f.targetUid === unit.uid);
  const outgoingEvent = [...floaters].reverse().find((event) => event.sourceUid === unit.uid && event.id > lastOutgoing.current);
  const incomingEvent = [...myFloaters].reverse().find((event) => event.id > lastIncoming.current);
  const motionEnabled = animationMode !== 'off';

  useEffect(() => {
    if (!motionEnabled || !unit.alive || !opponentAlive) {
      window.clearTimeout(attackTimer.current);
      setAttackPhase(0); setHit(false); setSlash(false); setHeal(false);
      return;
    }
    if (outgoingEvent) {
      lastOutgoing.current = outgoingEvent.id;
      // Alternate two identical animations so every attack restarts the lunge; the reset timer must
      // outlive this effect run (the event is consumed on the next render).
      setAttackPhase((phase) => (phase === 1 ? 2 : 1));
      window.clearTimeout(attackTimer.current);
      attackTimer.current = window.setTimeout(() => setAttackPhase(0), 520);
    }
  }, [outgoingEvent, unit.alive, opponentAlive, motionEnabled]);

  useEffect(() => () => window.clearTimeout(attackTimer.current), []);

  useEffect(() => {
    if (!motionEnabled) {
      setHit(false); setSlash(false); setHeal(false);
      return undefined;
    }
    if (!incomingEvent) return undefined;
    lastIncoming.current = incomingEvent.id;
    if (!incomingEvent.heal && (!incomingEvent.effect || incomingEvent.label?.startsWith('BLAST')) && unit.alive) {
      setHit(true); setSlash(true);
      const t1 = setTimeout(() => setHit(false), 220);
      const t2 = setTimeout(() => setSlash(false), 420);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    if (incomingEvent.heal) {
      setHeal(true);
      const t = setTimeout(() => setHeal(false), 620);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [incomingEvent, unit.alive, motionEnabled]);

  const portraitSrc = (() => {
    if (side === 'enemy') return enemyArtSrc(unit.uid, unit.role, unit.enemyPresentationId);
    if (!heroData) return null;
    const base = HERO_MAP[heroData.heroId];
    if (!base) return null;
    return heroPortraitSrc(base.id, base.heroClass, base.rarity, base.color);
  })();
  const portraitCrop = heroData && HERO_MAP[heroData.heroId]
    ? heroPortraitStyle(heroData.heroId, HERO_MAP[heroData.heroId].heroClass)
    : undefined;
  const heroRarityColor = heroData ? RARITY_COLORS[HERO_MAP[heroData.heroId]?.rarity] : undefined;
  const portraitColor = heroRarityColor ?? unit.color;
  const dungeonBoss = unit.uid.endsWith('-dungeon-shared');
  const protectedBoss = unit.uid.endsWith('-dungeon-protected');

  return (
    <div className={`arena-unit relative flex items-center gap-2 transition-opacity duration-300 ${side === 'enemy' ? 'flex-row-reverse' : ''} ${dungeonBoss ? 'dungeon-shared-boss' : ''} ${protectedBoss ? 'dungeon-protected-boss' : ''} ${targeted ? 'dungeon-heavy-target' : ''} ${unit.alive ? 'opacity-100' : 'opacity-40 grayscale'}`}>
      {targeted && <div className="dungeon-target-sigil" aria-hidden="true" />}
      {targeted && <div className="dungeon-target-label"><Crosshair size={11} /> HEAVY TARGET</div>}
      {/* Unit name + HP bar + HP numbers */}
      <div className="arena-unit-info grid h-[64px] w-[88px] shrink-0 grid-rows-[24px_10px_14px] content-center gap-1 rounded-lg border border-[#4b4234] bg-black/45 px-2 shadow-[0_6px_14px_rgba(0,0,0,.25)] sm:w-[104px]" aria-label={`${unit.name}, ${side}`}>
        <div className={`arena-unit-name flex items-center justify-center text-center font-bold ${side === 'enemy' ? 'text-rose-200' : 'text-[#eee5d5]'}`}>{unit.name}</div>
        <HealthBar hp={unit.hp} maxHp={unit.maxHp} color={unit.color} />
        <div className="whitespace-nowrap text-center text-[9px] font-bold tabular-nums text-[#bdb6a9]" aria-label={`${Math.ceil(unit.hp)} of ${unit.maxHp} health`}>{formatHealth(unit.hp)} / {formatHealth(unit.maxHp)}</div>
      </div>
      {/* Portrait */}
      <div className={side === 'enemy' ? `relative enemy-rank-frame ${unit.enemyRank ? `enemy-rank-${unit.enemyRank}` : ''}` : 'relative'}>
      {/* Floating combat numbers sit over the portrait */}
      <div className="absolute -top-4 left-1/2 -translate-x-1/2 pointer-events-none z-20 w-24 h-16">
        {myFloaters.map((f) => {
          const { x, y } = floaterOffset(f);
          return (
          <div key={f.id} className="absolute pointer-events-none" style={{ left: `calc(50% + ${x}px)`, top: y, transform: 'translateX(-50%)', zIndex: f.crit && !f.heal ? 30 : undefined }}>
            <div className={`anim-float font-bold whitespace-nowrap font-vt ${f.crit && !f.heal ? 'crit-floater' : f.effect ? 'text-cyan-200 text-sm' : f.heal ? 'text-px-green text-2xl' : f.miss ? 'text-px-dim text-lg' : 'text-white text-2xl'}`} style={{ textShadow: f.crit ? '0 0 8px #f5c518, 2px 2px 0 #3d2008' : '2px 2px 0 #000', animationDelay: `${f.delayMs ?? 0}ms`, ['--float-delay' as string]: `${f.delayMs ?? 0}ms` }}>
              {f.crit && !f.heal && f.value > 0 ? (
                <span className="crit-hit-number" aria-label={`Critical hit, ${f.value} damage`}>
                  <span className="crit-blood crit-blood-a" /><span className="crit-blood crit-blood-b" /><span className="crit-blood crit-blood-c" />
                  <span className="crit-label">CRIT!</span><span className="crit-damage">-{f.value}</span>
                </span>
              ) : f.label ?? (f.miss ? 'MISS' : f.heal ? `+${f.value}` : `-${f.value}`)}
            </div>
          </div>
          );
        })}
      </div>
      <div className={`relative ${side === 'enemy' ? 'h-full w-full' : ''} ${unit.alive && motionEnabled ? 'anim-bob' : ''}`}>
        <div
          className={`arena-portrait combatant-card relative h-16 w-16 overflow-hidden sm:h-[80px] sm:w-[80px] xl:h-[88px] xl:w-[88px] 2xl:h-[96px] 2xl:w-[96px] ${side === 'enemy' ? 'ring-1 ring-rose-950/70' : ''} ${side === 'hero' && attackPhase > 0 ? (attackPhase === 1 ? 'anim-attack-hero' : 'anim-attack-hero-b') : ''} ${side === 'enemy' && attackPhase > 0 ? (attackPhase === 1 ? 'anim-attack-enemy' : 'anim-attack-enemy-b') : ''}`}
          style={{
            borderColor: portraitColor,
            boxShadow: unit.alive ? `inset 0 1px rgba(255,255,255,.08), inset 0 0 0 3px rgba(0,0,0,.22), 0 18px 38px rgba(0,0,0,.42), 0 0 20px ${portraitColor}22` : 'none',
          }}
        >
          <div className={`arena-portrait-impact-layer absolute inset-0 ${hit ? 'anim-hit' : ''} overflow-hidden`}>
            {portraitSrc && !artFailed ? <img src={portraitSrc} alt="" loading="eager" decoding="sync" className="h-full w-full object-cover" style={{ ...portraitCrop, filter: unit.alive ? 'none' : 'grayscale(1)' }} onError={() => setArtFailed(true)} /> : <span className="grid h-full w-full place-items-center text-3xl sm:text-4xl select-none" style={{ filter: unit.alive ? 'none' : 'grayscale(1)' }}>{unit.icon}</span>}
            {!unit.alive && <span className="absolute inset-0 flex flex-col items-center justify-center bg-black/65"><Skull size={30} className="text-[#d9d1c3] drop-shadow-[0_0_8px_rgba(0,0,0,.9)]" />{side === 'hero' && Boolean(respawnSeconds) && <strong className="mt-0.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] tabular-nums text-rose-300">{respawnSeconds}s</strong>}<span className="sr-only">Dead</span></span>}
            {unit.alive && slash && <div className="anim-slash absolute inset-0 flex items-center justify-center text-4xl pointer-events-none">⚡</div>}
            {unit.alive && heal && <div className="anim-heal absolute inset-0 flex items-center justify-center text-3xl pointer-events-none">💚</div>}
            {side === 'hero' && heroData && <span className="battle-hero-level" aria-label={`Hero level ${heroData.level}`}>Lv {heroData.level}</span>}
            {side === 'hero' && heroData && <BattleHeroStars stars={heroData.stars} />}
            {side === 'enemy' && unit.role && <span className="enemy-role-badge">{unit.role}</span>}
            {side === 'enemy' && unit.enemyRank && <EnemyRankOrnament rank={unit.enemyRank} />}
            {side === 'enemy' && unit.eliteAffix && <EnemyAffixMark affix={unit.eliteAffix} />}
            {side === 'enemy' && (Boolean(unit.shield) || Boolean(unit.curseRemainingMs) || unit.enraged || unit.summoned) && <span className="enemy-status-badges" aria-label="Enemy combat statuses">
              {Boolean(unit.shield) && <i title="Barrier">◆</i>}{Boolean(unit.curseRemainingMs) && <i title="Curse">☾</i>}{unit.enraged && <i title="Enraged">🔥</i>}{unit.summoned && <i title="Summoned">✦</i>}
            </span>}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

function ArenaInner({ units, floaters, ownedHeroes, inventory, potionFx, respawnCountdowns, animationMode, dungeonPanelOpen, locationId, dungeonBossScene, dungeonRoom }: ArenaProps) {
  const heroes = units.filter((u) => u.side === 'hero');
  const enemies = units.filter((u) => u.side === 'enemy');
  const sharedBossActive = enemies.some((unit) => unit.uid.endsWith('-dungeon-shared') && unit.alive);
  const sharedBossUnit = dungeonBossScene?.phase === 'shared' ? enemies.find((unit) => unit.uid.endsWith('-dungeon-shared')) : undefined;
  const sharedBoss = sharedBossUnit?.alive ? sharedBossUnit : undefined;
  const laneEnemies = sharedBossUnit ? enemies.filter((unit) => unit.uid !== sharedBossUnit.uid) : enemies.filter((unit) => !unit.uid.endsWith('-dungeon-protected'));
  const bossArt = dungeonBossScene ? enemyArtSrc(`e0-${DUNGEON_BOSS_ART[dungeonBossScene.bossId] ?? 'boss-lich'}`) : null;
  const [shake, setShake] = useState(false);
  const lastShake = useRef(0);

  useEffect(() => {
    if (animationMode === 'off') { setShake(false); return undefined; }
    const recentCrit = floaters.some((f) => f.crit && performance.now() - f.born < 200);
    if (recentCrit && performance.now() - lastShake.current > 400) {
      lastShake.current = performance.now();
      setShake(true);
      const t = setTimeout(() => setShake(false), 300);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [floaters, animationMode]);

  void inventory; void potionFx;

  return (
    <div className={`arena-stage-inner arena-mode-${animationMode} ${locationId ? 'arena-location-art' : ''} ${dungeonPanelOpen ? 'dungeon-panel-open' : ''} ${dungeonRoom ? `dungeon-room dungeon-depth-${dungeonRoom.depth} dungeon-room-${dungeonRoom.room}` : ''} ${dungeonBossScene ? `dungeon-boss-phase-${dungeonBossScene.phase} dungeon-boss-${dungeonBossScene.bossId}` : ''} relative flex h-full w-full flex-col justify-end px-3 pb-4 pt-16 sm:px-6 ${shake ? 'anim-shake' : ''}`} style={locationId ? { '--location-arena-art': `url('/assets/locations/${locationId > 10 ? 'endgame' : 'standard'}/location-${locationId}.webp')` } as React.CSSProperties : undefined}>
      {animationMode === 'spectacular' && <div className="arena-spectacular-atmosphere pointer-events-none absolute inset-0" aria-hidden="true" />}
      {dungeonRoom && <div className="dungeon-route" aria-label={`Dungeon route, room ${dungeonRoom.room} of 4`}>
        {['GUARDS', 'ELITE', 'FATE', 'BOSS'].map((label, index) => <div key={label} className={index + 1 < dungeonRoom.room ? 'is-done' : index + 1 === dungeonRoom.room ? 'is-active' : ''}><i>{index + 1 < dungeonRoom.room ? '✓' : index + 1}</i><span>{label}</span></div>)}
      </div>}
      {dungeonRoom && !dungeonBossScene && <div className="dungeon-room-title"><DoorOpen size={14} /><span>DEPTH {dungeonRoom.depth} · ROOM {dungeonRoom.room}/4</span><strong>{dungeonRoom.label}</strong></div>}
      {dungeonBossScene?.phase === 'retinue' && <div className="dungeon-throne-boss" aria-label={`${dungeonBossScene.bossName}, protected behind the Retinue`}>
        <div className="dungeon-throne-haze" />
        {bossArt ? <img src={bossArt} alt="" /> : <Skull aria-hidden="true" />}
        <div className="dungeon-throne-state"><Shield size={12} /> PROTECTED BY RETINUE</div>
        <strong>{dungeonBossScene.bossName}</strong>
      </div>}
      {sharedBoss && dungeonBossScene && <div className="dungeon-shared-stage" aria-label={`${dungeonBossScene.bossName}, shared Boss target`}>
        <div className="dungeon-boss-hud">
          <span><Swords size={13} /> SHARED TARGET</span><strong>{dungeonBossScene.bossName}</strong>
          <HealthBar hp={sharedBoss.hp} maxHp={sharedBoss.maxHp} color="#b9373e" />
          <small>{formatHealth(sharedBoss.hp)} / {formatHealth(sharedBoss.maxHp)} HP</small>
          {dungeonBossScene.threshold && <i className="dungeon-threshold" style={{ left: `${100 - dungeonBossScene.threshold}%` }} title={`${dungeonBossScene.threshold}% mechanic threshold`} />}
        </div>
        {dungeonBossScene.cast && <div className={`dungeon-cast-bar ${dungeonBossScene.cast.impact ? 'is-impact' : ''}`} role="status">
          <Crosshair size={14} /><span>{dungeonBossScene.cast.name}</span><b>{dungeonBossScene.cast.impact ? 'IMPACT' : `${dungeonBossScene.cast.remaining.toFixed(1)}s`}</b>
          <i style={{ width: `${Math.max(0, Math.min(100, dungeonBossScene.cast.remaining / 3 * 100))}%` }} />
        </div>}
        <div className={`dungeon-momentum dungeon-momentum-${dungeonBossScene.momentum ?? 'even'}`} role="status">
          <span>{dungeonBossScene.momentum === 'party' ? 'PARTY ADVANTAGE' : dungeonBossScene.momentum === 'boss' ? 'BOSS ADVANTAGE' : 'BATTLE CONTESTED'}</span>
          <b>{Math.max(0, Math.round(dungeonBossScene.elapsedSeconds ?? 0))}s</b>
        </div>
        <div className="dungeon-status-row">
          <span><Timer size={10} /> {dungeonBossScene.mechanic ?? 'Heavy Strike'} </span>
          {dungeonBossScene.mechanicState && <span><Shield size={10} /> {dungeonBossScene.mechanicState}</span>}
          {Boolean(dungeonBossScene.summons) && <span><Users size={10} /> SUMMONS {dungeonBossScene.summons}</span>}
          {dungeonBossScene.enrage && <span className="is-danger"><Flame size={10} /> ENRAGED</span>}
        </div>
        <div className="dungeon-boss-floor-sigil" />
        {Boolean(dungeonBossScene.summons) && <div className="dungeon-summon-rack" aria-label={`${dungeonBossScene.summons} summoned guards protect the Boss`}>{Array.from({ length: Math.min(2, dungeonBossScene.summons ?? 0) }, (_, index) => <div key={index}><Skull size={18} /><span>SUMMON {index + 1}</span><i /></div>)}</div>}
        <UnitView unit={sharedBoss} floaters={floaters} side="enemy" opponentAlive={heroes.some((hero) => hero.alive)} animationMode={animationMode} />
      </div>}
      {dungeonBossScene?.transition && <div className="dungeon-phase-banner" role="status">{dungeonBossScene.transition}</div>}
      <div className="pointer-events-none absolute inset-x-[8%] bottom-[18%] h-16 rounded-[50%] border-b border-[#9b7540]/25 bg-[radial-gradient(ellipse,rgba(168,122,58,.13),transparent_68%)]" />
      <div className="arena-lanes relative z-10 grid grid-cols-2 items-center gap-4 sm:gap-10">
        <div className="arena-roster flex min-w-0 flex-col items-end justify-center gap-2">
          {heroes.map((u, lane) => {
            const heroData = ownedHeroes?.find((h) => h.uid === u.uid);
            return <UnitView key={u.uid} unit={u} floaters={floaters} side="hero" heroData={heroData} respawnSeconds={respawnCountdowns?.[u.uid]} opponentAlive={sharedBossActive || Boolean(laneEnemies[lane]?.alive)} animationMode={animationMode} targeted={dungeonBossScene?.targetUid === u.uid} />;
          })}
          {heroes.length === 0 && <div className="intentional-empty p-4 text-sm">Assemble a team to fight</div>}
        </div>
        <div className="arena-roster flex min-w-0 flex-col items-start justify-center gap-2">
          {laneEnemies.map((u, lane) => <UnitView key={u.uid} unit={u} floaters={floaters} side="enemy" opponentAlive={Boolean(heroes[lane]?.alive)} animationMode={animationMode} />)}
          {laneEnemies.length === 0 && !sharedBoss && <div className="intentional-empty p-4 text-sm">Enemies defeated</div>}
        </div>
      </div>
      <div className="relative z-20 mt-3 h-px bg-gradient-to-r from-transparent via-[#a78045]/35 to-transparent" />
    </div>
  );
}

export const Arena = memo(ArenaInner);
