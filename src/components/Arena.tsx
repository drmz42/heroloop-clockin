import { memo, useEffect, useRef, useState } from 'react';
import type { CombatUnit, FloatingNumber, OwnedHero, OwnedItem } from '@/game/types';
import { HERO_MAP } from '@/game/heroes';
import { heroPortraitSrc } from '@/game/portraits';
import { enemyArtSrc } from '@/game/art';

interface ArenaProps {
  units: CombatUnit[];
  floaters: FloatingNumber[];
  ownedHeroes?: OwnedHero[];
  inventory?: OwnedItem[];
  potionFx?: { uid: string; born: number } | null;
  onHeal?: () => void;
}

function HealthBar({ hp, maxHp, color }: { hp: number; maxHp: number; color: string }) {
  const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  const low = pct < 30;
  return (
    <div className="w-full h-3 bg-px-bg border border-px-border overflow-hidden" style={{ boxShadow: '1px 1px 0 #2a1504' }}>
      <div className="h-full transition-all duration-150" style={{ width: `${pct}%`, background: low ? '#c02010' : color, boxShadow: `0 0 4px ${color}aa` }} />
    </div>
  );
}

function UnitView({ unit, floaters, side, heroData }: { unit: CombatUnit; floaters: FloatingNumber[]; side: 'hero' | 'enemy'; heroData?: OwnedHero }) {
  const prevHp = useRef(unit.hp);
  const prevTimer = useRef(unit.attackTimer);
  const [attacking, setAttacking] = useState(false);
  const [hit, setHit] = useState(false);
  const [slash, setSlash] = useState(false);
  const [heal, setHeal] = useState(false);
  const myFloaters = floaters.filter((f) => f.targetUid === unit.uid);

  useEffect(() => {
    if (prevTimer.current > unit.attackTimer && unit.attackTimer < 30 && unit.alive) {
      setAttacking(true);
      const t = setTimeout(() => setAttacking(false), 360);
      return () => clearTimeout(t);
    }
    prevTimer.current = unit.attackTimer;
  }, [unit.attackTimer, unit.alive]);

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

  return (
    <div className={`relative flex flex-col items-center transition-opacity duration-300 ${unit.alive ? 'opacity-100' : 'opacity-20'}`}>
      {/* Floating damage numbers */}
      <div className="absolute -top-4 left-1/2 -translate-x-1/2 pointer-events-none z-20 w-24 h-16">
        {myFloaters.map((f) => (
          <div key={f.id} className={`anim-float absolute left-1/2 -translate-x-1/2 font-bold whitespace-nowrap font-vt ${f.heal ? 'text-px-green text-2xl' : f.crit ? 'text-px-bright text-3xl' : f.miss ? 'text-px-dim text-lg' : 'text-white text-2xl'}`} style={{ textShadow: f.crit ? '0 0 8px #f5c518, 2px 2px 0 #3d2008' : '2px 2px 0 #000' }}>
            {f.miss ? 'MISS' : f.heal ? `+${f.value}` : `-${f.value}`}{f.crit && !f.heal && f.value > 0 && <span className="ml-0.5">!</span>}
          </div>
        ))}
      </div>
      {/* Name + HP bar + HP numbers */}
      <div className="w-full max-w-[110px] mb-1">
        <div className="text-sm leading-none mb-0.5 truncate text-px-text font-vt font-bold px-0.5">{unit.name}</div>
        <HealthBar hp={unit.hp} maxHp={unit.maxHp} color={unit.color} />
        <div className="text-xs text-px-text font-vt font-bold mt-0.5 px-0.5 tabular-nums">{Math.ceil(unit.hp)}/{unit.maxHp}</div>
      </div>
      {/* Portrait */}
      <div className={`relative ${unit.alive ? 'anim-bob' : 'anim-die'}`}>
        <div
          className={`relative h-[92px] w-[92px] overflow-hidden rounded-2xl border sm:h-[112px] sm:w-[112px] ${hit ? 'anim-hit' : ''} ${attacking && side === 'hero' ? 'anim-attack-hero' : ''} ${attacking && side === 'enemy' ? 'anim-attack-enemy' : ''}`}
          style={{
            background: `radial-gradient(circle at 50% 30%, ${unit.color}55, ${unit.color}22 60%, transparent)`,
            borderColor: unit.color,
            boxShadow: unit.alive ? `0 18px 45px rgba(0,0,0,.35), 0 0 24px ${unit.color}33` : 'none',
          }}
        >
          {portraitSrc ? <img src={portraitSrc} alt="" className="w-full h-full object-cover" style={{ filter: unit.alive ? 'none' : 'grayscale(1)' }} /> : <span className="text-3xl sm:text-4xl select-none" style={{ filter: unit.alive ? 'none' : 'grayscale(1)' }}>{unit.icon}</span>}
          {slash && <div className="anim-slash absolute inset-0 flex items-center justify-center text-4xl pointer-events-none">⚡</div>}
          {heal && <div className="anim-heal absolute inset-0 flex items-center justify-center text-3xl pointer-events-none">💚</div>}
        </div>
      </div>
    </div>
  );
}

function ArenaInner({ units, floaters, ownedHeroes, inventory, potionFx, onHeal }: ArenaProps) {
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

  const anyHeroHurt = heroes.some((u) => u.alive && u.hp < u.maxHp * 0.95);

  return (
    <div className={`relative w-full h-full flex flex-col justify-between py-3 px-2 ${shake ? 'anim-shake' : ''}`}>
      <div className="flex items-start justify-center gap-3 sm:gap-4 flex-wrap min-h-[120px]">
        {enemies.map((u) => <UnitView key={u.uid} unit={u} floaters={floaters} side="enemy" />)}
        {enemies.length === 0 && <div className="text-px-dim text-lg font-vt italic pt-10">Enemies defeated!</div>}
      </div>
      <div className="flex items-center justify-center my-1 gap-2">
        <div className="h-1 flex-1 bg-gradient-to-r from-transparent via-px-gold/40 to-transparent" />
        {onHeal && (
          <button onClick={onHeal} disabled={!anyHeroHurt} className="px-3 py-1 px-btn text-sm font-bold flex items-center gap-1" title="Heal your team to full">
            💚 Heal
          </button>
        )}
        <div className="h-1 flex-1 bg-gradient-to-r from-transparent via-px-gold/40 to-transparent" />
      </div>
      <div className="flex items-end justify-center gap-3 sm:gap-4 flex-wrap min-h-[120px]">
        {heroes.map((u) => {
          const heroData = ownedHeroes?.find((h) => h.uid === u.uid);
          return <UnitView key={u.uid} unit={u} floaters={floaters} side="hero" heroData={heroData} />;
        })}
        {heroes.length === 0 && <div className="text-px-dim text-lg font-vt italic pb-10">Assemble a team!</div>}
      </div>
    </div>
  );
}

export const Arena = memo(ArenaInner);
