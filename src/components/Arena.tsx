import { memo, useEffect, useRef, useState } from 'react';
import type { CombatUnit, FloatingNumber, OwnedHero, OwnedItem } from '@/game/types';
import { HERO_MAP, RARITY_COLORS } from '@/game/heroes';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { enemyArtSrc } from '@/game/art';
import { Skull, Star } from 'lucide-react';
import { MAX_HERO_STARS } from '@/game/state';

const STAR_COLORS = ['#fbbf24', '#a855f7', '#ef4444', '#ec4899'];

function BattleHeroStars({ stars }: { stars: number }) {
  const clamped = Math.max(0, Math.min(MAX_HERO_STARS, stars));
  const tier = clamped === 0 ? 0 : Math.floor((clamped - 1) / 5);
  const currentCount = clamped === 0 ? 0 : ((clamped - 1) % 5) + 1;
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

interface ArenaProps {
  units: CombatUnit[];
  floaters: FloatingNumber[];
  ownedHeroes?: OwnedHero[];
  inventory?: OwnedItem[];
  potionFx?: { uid: string; born: number } | null;
  respawnCountdowns?: Record<string, number>;
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

function UnitView({ unit, floaters, side, heroData, respawnSeconds }: { unit: CombatUnit; floaters: FloatingNumber[]; side: 'hero' | 'enemy'; heroData?: OwnedHero; respawnSeconds?: number }) {
  const prevHp = useRef(unit.hp);
  const prevTimer = useRef(unit.attackTimer);
  const [attacking, setAttacking] = useState(false);
  const [hit, setHit] = useState(false);
  const [slash, setSlash] = useState(false);
  const [heal, setHeal] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const myFloaters = floaters.filter((f) => f.targetUid === unit.uid);

  useEffect(() => {
    if (!unit.alive) {
      setAttacking(false); setHit(false); setSlash(false); setHeal(false);
      prevHp.current = unit.hp;
      prevTimer.current = unit.attackTimer;
      return undefined;
    }
    if (prevTimer.current > unit.attackTimer && unit.attackTimer < 30 && unit.alive) {
      setAttacking(true);
      const t = setTimeout(() => setAttacking(false), 360);
      return () => clearTimeout(t);
    }
    prevTimer.current = unit.attackTimer;
  }, [unit.attackTimer, unit.alive, unit.hp]);

  useEffect(() => {
    if (unit.hp < prevHp.current && unit.alive) {
      setHit(true); setSlash(true);
      const t1 = setTimeout(() => setHit(false), 220);
      const t2 = setTimeout(() => setSlash(false), 420);
      prevHp.current = unit.hp;
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    if (unit.hp > prevHp.current) {
      setHeal(true);
      const t = setTimeout(() => setHeal(false), 620);
      prevHp.current = unit.hp;
      return () => clearTimeout(t);
    }
    prevHp.current = unit.hp;
  }, [unit.hp, unit.alive]);

  const portraitSrc = (() => {
    if (side === 'enemy') return enemyArtSrc(unit.uid);
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

  return (
    <div className={`arena-unit relative flex items-center gap-2 transition-opacity duration-300 ${side === 'enemy' ? 'flex-row-reverse' : ''} ${unit.alive ? 'opacity-100' : 'opacity-40 grayscale'}`}>
      {/* Floating damage numbers */}
      <div className="absolute -top-4 left-1/2 -translate-x-1/2 pointer-events-none z-20 w-24 h-16">
        {myFloaters.map((f) => (
          <div key={f.id} className={`anim-float absolute left-1/2 -translate-x-1/2 font-bold whitespace-nowrap font-vt ${f.crit && !f.heal ? 'crit-floater' : f.rewardGold !== undefined ? 'text-amber-300 text-lg' : f.heal ? 'text-px-green text-2xl' : f.miss ? 'text-px-dim text-lg' : 'text-white text-2xl'}`} style={{ textShadow: f.crit ? '0 0 8px #f5c518, 2px 2px 0 #3d2008' : '2px 2px 0 #000' }}>
            {f.crit && !f.heal && f.value > 0 ? (
              <span className="crit-hit-number" aria-label={`Critical hit, ${f.value} damage`}>
                <span className="crit-blood crit-blood-a" /><span className="crit-blood crit-blood-b" /><span className="crit-blood crit-blood-c" />
                <span className="crit-label">CRIT!</span><span className="crit-damage">-{f.value}</span>
              </span>
            ) : f.rewardGold !== undefined ? `+${f.rewardGold} Gold · +${f.rewardXp} XP` : f.miss ? 'MISS' : f.heal ? `+${f.value}` : `-${f.value}`}
          </div>
        ))}
      </div>
      {/* Name + HP bar + HP numbers */}
      <div className="arena-unit-info w-[78px] shrink-0 rounded-lg border border-[#4b4234] bg-black/45 px-1.5 py-1 shadow-[0_6px_14px_rgba(0,0,0,.25)] sm:w-[104px] sm:px-2">
        <div className="mb-1 flex items-center justify-between gap-2"><span className={`truncate text-[11px] font-bold ${side === 'enemy' ? 'text-rose-200' : 'text-[#eee5d5]'}`}>{unit.name}</span><span className="text-[9px] font-semibold uppercase tracking-wider text-[#858074]">{side === 'enemy' ? 'Enemy' : 'Hero'}</span></div>
        <HealthBar hp={unit.hp} maxHp={unit.maxHp} color={unit.color} />
        <div className="mt-1 text-center text-[9px] font-bold tabular-nums text-[#bdb6a9]">{Math.ceil(unit.hp)} / {unit.maxHp}</div>
      </div>
      {/* Portrait */}
      <div className={`relative ${unit.alive ? 'anim-bob' : ''}`}>
        <div
          className={`arena-portrait combatant-card relative h-16 w-16 overflow-hidden sm:h-[80px] sm:w-[80px] xl:h-[88px] xl:w-[88px] 2xl:h-[96px] 2xl:w-[96px] ${side === 'enemy' ? 'ring-1 ring-rose-950/70' : ''} ${hit ? 'anim-hit' : ''} ${attacking && side === 'hero' ? 'anim-attack-hero' : ''} ${attacking && side === 'enemy' ? 'anim-attack-enemy' : ''}`}
          style={{
            borderColor: portraitColor,
            boxShadow: unit.alive ? `inset 0 1px rgba(255,255,255,.08), inset 0 0 0 3px rgba(0,0,0,.22), 0 18px 38px rgba(0,0,0,.42), 0 0 20px ${portraitColor}22` : 'none',
          }}
        >
          {portraitSrc && !artFailed ? <img src={portraitSrc} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" style={{ ...portraitCrop, filter: unit.alive ? 'none' : 'grayscale(1)' }} onError={() => setArtFailed(true)} /> : <span className="grid h-full w-full place-items-center text-3xl sm:text-4xl select-none" style={{ filter: unit.alive ? 'none' : 'grayscale(1)' }}>{unit.icon}</span>}
          {!unit.alive && <span className="absolute inset-0 flex flex-col items-center justify-center bg-black/65"><Skull size={30} className="text-[#d9d1c3] drop-shadow-[0_0_8px_rgba(0,0,0,.9)]" />{side === 'hero' && Boolean(respawnSeconds) && <strong className="mt-0.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] tabular-nums text-rose-300">{respawnSeconds}s</strong>}<span className="sr-only">Dead</span></span>}
          {unit.alive && slash && <div className="anim-slash absolute inset-0 flex items-center justify-center text-4xl pointer-events-none">⚡</div>}
          {unit.alive && heal && <div className="anim-heal absolute inset-0 flex items-center justify-center text-3xl pointer-events-none">💚</div>}
          {side === 'hero' && heroData && <span className="battle-hero-level" aria-label={`Hero level ${heroData.level}`}>Lv {heroData.level}</span>}
          {side === 'hero' && heroData && <BattleHeroStars stars={heroData.stars} />}
        </div>
      </div>
    </div>
  );
}

function ArenaInner({ units, floaters, ownedHeroes, inventory, potionFx, respawnCountdowns }: ArenaProps) {
  const heroes = units.filter((u) => u.side === 'hero');
  const enemies = units.filter((u) => u.side === 'enemy');
  const [shake, setShake] = useState(false);
  const lastShake = useRef(0);

  useEffect(() => {
    const recentCrit = floaters.some((f) => f.crit && performance.now() - f.born < 200);
    if (recentCrit && performance.now() - lastShake.current > 400) {
      lastShake.current = performance.now();
      setShake(true);
      const t = setTimeout(() => setShake(false), 300);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [floaters]);

  void inventory; void potionFx;

  return (
    <div className={`arena-stage-inner relative flex h-full w-full flex-col justify-end px-3 pb-4 pt-16 sm:px-6 ${shake ? 'anim-shake' : ''}`}>
      <div className="pointer-events-none absolute inset-x-[8%] bottom-[18%] h-16 rounded-[50%] border-b border-[#9b7540]/25 bg-[radial-gradient(ellipse,rgba(168,122,58,.13),transparent_68%)]" />
      <div className="arena-lanes relative z-10 grid grid-cols-2 items-center gap-4 sm:gap-10">
        <div className="arena-roster flex min-w-0 flex-col items-end justify-center gap-2">
          {heroes.map((u) => {
            const heroData = ownedHeroes?.find((h) => h.uid === u.uid);
            return <UnitView key={u.uid} unit={u} floaters={floaters} side="hero" heroData={heroData} respawnSeconds={respawnCountdowns?.[u.uid]} />;
          })}
          {heroes.length === 0 && <div className="intentional-empty p-4 text-sm">Assemble a team to fight</div>}
        </div>
        <div className="arena-roster flex min-w-0 flex-col items-start justify-center gap-2">
          {enemies.map((u) => <UnitView key={u.uid} unit={u} floaters={floaters} side="enemy" />)}
          {enemies.length === 0 && <div className="intentional-empty p-4 text-sm">Enemies defeated</div>}
        </div>
      </div>
      <div className="relative z-20 mt-3 h-px bg-gradient-to-r from-transparent via-[#a78045]/35 to-transparent" />
    </div>
  );
}

export const Arena = memo(ArenaInner);
