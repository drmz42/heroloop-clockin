import { useEffect, useMemo, useRef, useState } from 'react';
import type { CombatUnit, FloatingNumber, GameState } from '@/game/types';
import { Arena } from '@/components/Arena';
import { makeUnit, ownedToUnit } from '@/game/engine';
import { playSfx, setMusicScene } from '@/audio/gameAudio';
import { versionedAsset } from '@/game/assetVersion';
import { advanceCombatFrame, combatResolution, seededCombatRandom } from '../../managed/functions/player-sync/combat-step.mjs';

// Story trial (Founder 2026-10-12): after the hero is geared, Morvane meets them on the real
// battlefield. The fight runs the game's own combat step on the hero's real stats and gear; it is
// tuned so the lone hero falls, and it writes nothing: no save, no reward, no respawn timer.

const SEED = 20261012;
const STEP_MS = 20;
const MORVANE_ID = 'e0-boss-morvane';

type StepEvent = { kind: string; attackerUid?: string; sourceUid?: string; targetUid: string; amount?: number; critical?: boolean };

function squadUnits(state: GameState): CombatUnit[] {
  return state.team
    .map((uid) => state.ownedHeroes.find((hero) => hero.uid === uid))
    .map((hero) => hero ? ownedToUnit(hero, state.inventory) : null)
    .filter((unit): unit is CombatUnit => Boolean(unit))
    .map((unit) => ({ ...unit, hp: unit.maxHp, alive: true, attackTimer: 0 }));
}

function morvane(hp: number, atk: number): CombatUnit {
  const unit = makeUnit(MORVANE_ID, 'Morvane, the Forsaken', 'enemy', hp, atk, 40, 60, '#d9d2c4', '☠️', 0.1, 1.6);
  return { ...unit, attackTimer: unit.attackInterval * 0.6 };
}

/** Runs the fight to its end; returns when the heroes fell and how much damage they dealt. */
function probe(heroes: CombatUnit[], atk: number) {
  const random = seededCombatRandom(SEED);
  let units = [...heroes, morvane(1e9, atk)];
  let elapsed = 0;
  while (elapsed < 90_000 && !combatResolution(units)) {
    units = advanceCombatFrame(units, STEP_MS, random).units;
    elapsed += STEP_MS;
  }
  const boss = units.find((unit) => unit.uid === MORVANE_ID);
  return { elapsed, dealt: boss ? 1e9 - boss.hp : 0 };
}

/** Tunes Morvane so the hero lasts about ten seconds and leaves him around two thirds of his health. */
function tuneMorvane(heroes: CombatUnit[]) {
  const toughest = Math.max(...heroes.map((unit) => unit.maxHp), 1);
  let atk = Math.round(toughest * 0.3 + Math.max(...heroes.map((unit) => unit.def), 0));
  let result = probe(heroes, atk);
  for (let attempt = 0; attempt < 8 && (result.elapsed < 7000 || result.elapsed > 14000); attempt += 1) {
    atk = Math.max(1, Math.round(atk * (result.elapsed > 14000 ? 1.6 : 0.7)));
    result = probe(heroes, atk);
  }
  return { atk, hp: Math.max(500, Math.round(result.dealt * 3)) };
}

export function StoryTrial({ state, onDone }: { state: GameState; onDone: () => void }) {
  const heroes = useMemo(() => squadUnits(state), []); // eslint-disable-line react-hooks/exhaustive-deps
  const boss = useMemo(() => tuneMorvane(heroes), [heroes]);
  const [units, setUnits] = useState<CombatUnit[]>(() => [...heroes, morvane(boss.hp, boss.atk)]);
  const [floaters, setFloaters] = useState<FloatingNumber[]>([]);
  const [phase, setPhase] = useState<'intro' | 'fight' | 'fallen'>('intro');
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    setMusicScene('encounter');
    playSfx('bossIntro');
    const timer = window.setTimeout(() => setPhase('fight'), 2200);
    return () => { window.clearTimeout(timer); setMusicScene('main'); };
  }, []);

  useEffect(() => {
    if (phase !== 'fight') return;
    const random = seededCombatRandom(SEED);
    let live = [...heroes, morvane(boss.hp, boss.atk)];
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    let floaterId = 1;
    const loop = (now: number) => {
      carry += Math.min(now - last, 100);
      last = now;
      const fresh: FloatingNumber[] = [];
      while (carry >= STEP_MS && !combatResolution(live)) {
        const step = advanceCombatFrame(live, STEP_MS, random);
        live = step.units;
        carry -= STEP_MS;
        for (const event of step.events as StepEvent[]) {
          if (event.kind === 'damage') fresh.push({ id: floaterId++, sourceUid: event.attackerUid ?? event.sourceUid, targetUid: event.targetUid, value: Math.floor(event.amount ?? 0), crit: Boolean(event.critical), heal: false, born: now });
          else if (event.kind === 'miss') fresh.push({ id: floaterId++, sourceUid: event.attackerUid ?? event.sourceUid, targetUid: event.targetUid, value: 0, crit: false, heal: false, miss: true, born: now });
        }
      }
      setUnits(live);
      if (fresh.length) setFloaters((prev) => [...prev.filter((floater) => now - floater.born < 1500), ...fresh]);
      if (combatResolution(live)) {
        playSfx('defeat');
        setPhase('fallen');
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, heroes, boss]);

  useEffect(() => {
    if (phase !== 'fallen') return;
    const timer = window.setTimeout(() => done.current(), 2600);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <section className="story-trial" role="dialog" aria-modal="true" aria-label="Morvane, the Forsaken">
      <div className="story-trial-arena" style={{ backgroundImage: `url('${versionedAsset('/assets/story/gate-battle.webp')}')` }}>
        <Arena units={units} floaters={floaters} ownedHeroes={state.ownedHeroes} inventory={state.inventory} animationMode={state.battleAnimationMode} />
      </div>
      <div className="story-trial-banner"><small>Boss</small><strong>Morvane, the Forsaken</strong></div>
      {phase === 'intro' && <p className="cp-bubble is-shout tail-down-right story-trial-line">You came back.</p>}
      {phase === 'fallen' && <div className="story-trial-result"><strong>Defeated</strong><small>Morvane is too strong for one hero.</small></div>}
    </section>
  );
}
