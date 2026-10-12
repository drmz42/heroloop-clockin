import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameState, HeroClass } from '@/game/types';
import { versionedAsset } from '@/game/assetVersion';
import { heroFigureSrc } from '@/game/art';
import { duckMusic, playSfx, setMusicScene } from '@/audio/gameAudio';
import {
  CLASS_LABEL, STORY_BOX, boxPower, protagonistClass, recruitClasses, resolveBoxFight, storyBoxAccount, writeStoryBox,
  type BoxFighter, type StoryBoxStage,
} from '@/game/storyBox';
import { ComicScene } from '@/components/StoryComic';
import { awakenPages, betrayalPages, cluePages, victoryPages } from '@/game/storyComic';
import '@/theme/story/story-box.css';

// Story Box: the client-only story intro for new Seeker accounts (see src/game/storyBox.ts).

const art = (name: string) => versionedAsset(`/assets/story/${name}.webp`);
const asset = (path: string) => versionedAsset(path);
// Each scene layer falls back to existing game art while story art is missing.
const bg = (name: string, fallback: string): CSSProperties => ({ backgroundImage: `url('${art(name)}'), url('${asset(fallback)}')` });

function Figure({ src, fallback, className, alt = '' }: { src: string; fallback?: string; className: string; alt?: string }) {
  const [current, setCurrent] = useState(src);
  return <img className={className} src={current} alt={alt} draggable={false} data-fallback={current === src ? undefined : ''} onError={() => { if (fallback && current !== fallback) setCurrent(fallback); }} />;
}

type GiantPose = 'idle' | 'slam' | 'kneel';
// Morvane keeps three landmarks across all encounters: white hair, one massive arm, iron restraints.
const giantFigure = (pose: GiantPose = 'idle') => <Figure key={pose} className={`sb-giant-img is-${pose}`} src={art(`morvane-${pose}`)} fallback={asset('/assets/figures/boss-titan.webp')} />;

// ── Battle replay ──────────────────────────────────────────────────────────

const BURST_WORDS = ['SLASH!', 'CRACK!', 'THWACK!', 'SHHNK!'];

interface Floater { key: string; id: string; amount: number; crit: boolean }

function Battle({ fighters, seed, scene, fallback, title, line, onEnd }: {
  fighters: BoxFighter[]; seed: number; scene: string; fallback: string; title?: string; line?: string; onEnd: (won: boolean) => void;
}) {
  const fight = useMemo(() => resolveBoxFight(fighters, seed), [fighters, seed]);
  const [time, setTime] = useState(-1200);
  const ended = useRef(false);
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    const started = performance.now() + 1200;
    if (fighters.some((fighter) => fighter.boss)) playSfx('bossIntro');
    const timer = window.setInterval(() => {
      const now = performance.now() - started;
      setTime(now);
      if (now > fight.duration + 1400 && !ended.current) {
        ended.current = true;
        window.clearInterval(timer);
        end.current(fight.won);
      }
    }, 60);
    return () => window.clearInterval(timer);
  }, [fight, fighters]);
  const lastSound = useRef(0);
  const visible = fight.hits.filter((hit) => hit.at <= time);
  useEffect(() => {
    const latest = visible[visible.length - 1];
    if (!latest || latest.at <= lastSound.current) return;
    lastSound.current = latest.at;
    playSfx(latest.slam ? 'crit' : latest.crit ? 'crit' : 'hit');
    if (fight.deaths.some((death) => death.at === latest.at)) playSfx('death');
  }, [visible, fight.deaths]);
  const hp = (fighter: BoxFighter) => Math.max(0, fighter.hp - visible.filter((hit) => hit.to === fighter.id).reduce((sum, hit) => sum + hit.amount, 0));
  const floaters: Floater[] = visible.filter((hit) => time - hit.at < 900).map((hit, index) => ({ key: `${hit.at}-${hit.to}-${index}`, id: hit.to, amount: hit.amount, crit: hit.crit || hit.slam }));
  const attacking = new Set(visible.filter((hit) => time - hit.at < 260).map((hit) => hit.from));
  const slamming = visible.some((hit) => hit.slam && time - hit.at < 500);
  const finished = time > fight.duration + 200;
  // Comic lettering for heavy blows: crits and boss slams.
  const burst = [...visible].reverse().find((hit) => (hit.crit || hit.slam) && time - hit.at < 700);
  const burstOnHero = burst ? fighters.find((fighter) => fighter.id === burst.to)?.side === 'hero' : false;
  const unit = (fighter: BoxFighter) => {
    const current = hp(fighter);
    const dead = current <= 0;
    const src = fighter.side === 'hero' ? heroFigureSrc(fighter.heroClass ?? 'knight') : null;
    return (
      <div key={fighter.id} className={`sb-unit ${fighter.side} ${fighter.boss ? 'is-boss' : ''} ${dead ? 'is-dead' : ''} ${attacking.has(fighter.id) ? 'is-attacking' : ''}`}>
        <div className="sb-unit-figure">
          {fighter.boss ? giantFigure(slamming ? 'slam' : 'idle') : src ? <img src={src} alt="" draggable={false} /> : <Figure className="" src={art('skeleton')} fallback={asset('/assets/figures/skeleton.webp')} />}
          {floaters.filter((floater) => floater.id === fighter.id).map((floater) => <span key={floater.key} className={`sb-float ${floater.crit ? 'is-crit' : ''}`}>-{floater.amount}</span>)}
        </div>
        <div className="sb-hp"><i style={{ width: `${(current / fighter.hp) * 100}%` }} /></div>
        <small>{fighter.name}</small>
      </div>
    );
  };
  return (
    <section className={`sb-scene sb-battle ${slamming ? 'is-slam' : ''}`} style={bg(scene, fallback)}>
      {title && time < 0 && <div className="sb-banner">{title}{line && <small>{line}</small>}</div>}
      <div className="sb-lanes">
        <div className="sb-side heroes">{fighters.filter((fighter) => fighter.side === 'hero').map(unit)}</div>
        <div className="sb-side enemies">{fighters.filter((fighter) => fighter.side === 'enemy').map(unit)}</div>
      </div>
      {burst && (
        <span key={`${burst.at}-${burst.to}`} className="cp-sfx sb-burst"
          style={{ left: burstOnHero ? '6%' : '46%', top: burst.slam ? '22%' : '30%', fontSize: burst.slam ? '58px' : '44px', '--rot': `${burstOnHero ? -9 : 7}deg` } as CSSProperties}>
          {burst.slam ? 'KRA-KOOM!' : BURST_WORDS[Math.floor(burst.at / 50) % BURST_WORDS.length]}
        </span>
      )}
      {finished && <div className={`sb-result ${fight.won ? 'won' : 'lost'}`}>{fight.won ? 'Victory' : 'Defeated'}</div>}
    </section>
  );
}

// ── First fights: three skeletons, one at a time ───────────────────────────

function Waves({ hero, heroName, onNext }: { hero: HeroClass; heroName: string; onNext: () => void }) {
  const [wave, setWave] = useState(0);
  const fighters = useMemo<BoxFighter[]>(() => [
    { id: 'hero', name: heroName, side: 'hero', heroClass: hero, ...STORY_BOX.hero.start },
    { id: `skeleton-${wave}`, side: 'enemy', ...STORY_BOX.skeleton },
  ], [hero, heroName, wave]);
  return (
    <div className="sb-stack">
      <Battle key={wave} fighters={fighters} seed={11 + wave} scene="crypt-exit" fallback="/assets/locations/standard/location-3.webp"
        onEnd={() => { if (wave + 1 >= STORY_BOX.waves) onNext(); else setWave(wave + 1); }} />
      <div className="sb-hud"><span>{STORY_BOX.zones[0]}</span><b>Skeletons {Math.min(wave, STORY_BOX.waves)}/{STORY_BOX.waves}</b></div>
    </div>
  );
}

// ── Chest → item → equip → Power ───────────────────────────────────────────

function Counter({ from, to, ms = 1200 }: { from: number; to: number; ms?: number }) {
  const [value, setValue] = useState(from);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - started) / ms);
      setValue(Math.round(from + (to - from) * (1 - (1 - progress) ** 3)));
      if (progress >= 1) window.clearInterval(timer);
    }, 40);
    return () => window.clearInterval(timer);
  }, [from, to, ms]);
  return <>{value.toLocaleString('en-US')}</>;
}

function Chest({ onNext }: { onNext: () => void }) {
  const [step, setStep] = useState<'closed' | 'open' | 'equipped'>('closed');
  return (
    <section className="sb-scene sb-panel" style={bg('crypt-exit', '/assets/locations/standard/location-3.webp')}>
      <div className="sb-card">
        <small className="sb-kicker">First reward</small>
        {step === 'closed' && <>
          <h2>Standard Chest</h2>
          <img className="sb-chest" src={asset('/assets/ui/chest-ceremony-v1.webp')} alt="" />
          <p>Every fight can drop a chest. Open it to find gear for your hero.</p>
          <button type="button" className="game-control game-primary sb-cta" data-guide="open-chests" onClick={() => { playSfx('chestBurst'); duckMusic(1200); setStep('open'); }}>Open chest</button>
        </>}
        {step === 'open' && <>
          <h2>Iron Helm</h2>
          <img className="sb-item" src={asset('/assets/items/v4/helmet-uncommon.png')} alt="" />
          <p>Uncommon helmet · +HP · +Defense</p>
          <button type="button" className="game-control game-primary sb-cta" onClick={() => { playSfx('equip'); setStep('equipped'); }}>Equip</button>
        </>}
        {step === 'equipped' && <>
          <h2>Power up</h2>
          <div className="sb-power"><Counter from={boxPower(STORY_BOX.hero.start)} to={boxPower(STORY_BOX.hero.geared)} /></div>
          <p>Gear, levels and heroes raise your Power. The road leads back to the gate.</p>
          <div className="sb-objective is-inline"><small>Objective</small>Follow the grave road.</div>
          <button type="button" className="game-control game-primary sb-cta" onClick={onNext}>Approach the gate</button>
        </>}
      </div>
    </section>
  );
}

// ── Growth: summon two heroes, full squad, level montage ───────────────────

function Growth({ hero, onNext }: { hero: HeroClass; onNext: () => void }) {
  const recruits = recruitClasses(hero);
  const [step, setStep] = useState<'summon' | 'revealed' | 'squad' | 'train' | 'ready'>('summon');
  const startPower = boxPower(STORY_BOX.hero.geared);
  const finalPower = boxPower(STORY_BOX.hero.final) + 2 * boxPower(STORY_BOX.ally);
  useEffect(() => {
    if (step !== 'train') return;
    playSfx('levelUp');
    const timer = window.setTimeout(() => { playSfx('levelUp'); setStep('ready'); }, 3600);
    return () => window.clearTimeout(timer);
  }, [step]);
  return (
    <section className="sb-scene sb-panel" style={bg('grave-road', '/assets/locations/standard/location-3.webp')}>
      <div className="sb-card is-wide">
        {(step === 'summon' || step === 'revealed') && <>
          <small className="sb-kicker">Summon</small>
          <h2>{step === 'summon' ? 'Call allies to your side' : 'New heroes joined you'}</h2>
          <div className="sb-summons">
            {recruits.map((heroClass, index) => (
              <div key={heroClass} className={`sb-summon ${step === 'revealed' ? 'is-revealed' : ''}`} style={{ transitionDelay: `${index * 350}ms` }}>
                <img className="sb-scroll" src={asset('/assets/ui/summon-scroll-v1.webp')} alt="" />
                <img className="sb-recruit" src={heroFigureSrc(heroClass)} alt="" />
                <b>{CLASS_LABEL[heroClass]}</b>
              </div>
            ))}
          </div>
          {step === 'summon'
            ? <button type="button" className="game-control game-primary sb-cta" data-guide="summon" onClick={() => { playSfx('summon'); duckMusic(1500); setStep('revealed'); }}>Summon ×2</button>
            : <button type="button" className="game-control game-primary sb-cta" onClick={() => { playSfx('equip'); setStep('squad'); }}>Build the squad</button>}
        </>}
        {step === 'squad' && <>
          <small className="sb-kicker">Formation</small>
          <h2>Three heroes, one squad</h2>
          <div className="sb-squad">
            {[hero, ...recruits].map((heroClass) => <div key={heroClass} className="sb-slot"><img src={heroFigureSrc(heroClass)} alt="" /><b>{CLASS_LABEL[heroClass]}</b></div>)}
          </div>
          <button type="button" className="game-control game-primary sb-cta" onClick={() => setStep('train')}>Grow stronger</button>
        </>}
        {(step === 'train' || step === 'ready') && <>
          <small className="sb-kicker">AFK progress</small>
          <h2>Level <Counter from={STORY_BOX.levels.afterWaves} to={STORY_BOX.levels.final} ms={3400} /></h2>
          <div className="sb-zones">{STORY_BOX.zones.map((zone, index) => <span key={zone} style={{ animationDelay: `${index * 1100}ms` }}>{zone}</span>)}</div>
          <p>Fights, chests, upgrades and Gold keep your squad growing — even while you are away.</p>
          <div className="sb-power"><Counter from={startPower} to={finalPower} ms={3400} /></div>
          {step === 'ready' && <button type="button" className="game-control game-primary sb-cta" data-guide="boss" onClick={onNext}>Return to the gate</button>}
        </>}
      </div>
    </section>
  );
}

// ── S09 quest card after Elyra's trace ─────────────────────────────────────

function QuestCard({ onDone }: { onDone: () => void }) {
  return (
    <div className="sb-card sb-quest" onClick={(event) => event.stopPropagation()}>
      <small className="sb-kicker">New quest</small>
      <h2>The Mage's Trail</h2>
      <p>Elyra returned to the fortress after your death. Find out why she went to Blackthorn.</p>
      <button type="button" className="game-control game-primary sb-cta" onClick={onDone}>Continue</button>
    </div>
  );
}

// ── Flow ───────────────────────────────────────────────────────────────────

// The first tap also unlocks audio on Android WebView, so the opening plays with sound.
function TitleCard({ onStart }: { onStart: () => void }) {
  return (
    <button type="button" className="sb-scene sb-title" onClick={() => { playSfx('tap'); onStart(); }} style={bg('gate-arena', '/assets/screens/dungeon-room-1-outer-bastion-v2.webp')}>
      <img className="sb-title-mark" src={asset('/assets/brand/heroloop-wordmark.webp')} alt="HeroLoop" />
      <span className="sb-title-sub">The Last Seeker</span>
      <span className="sb-title-tap">Tap to begin</span>
    </button>
  );
}

export function StoryBox({ state, startStage, onDone }: { state: GameState; startStage: StoryBoxStage; onDone: () => void }) {
  const [stage, setStage] = useState<StoryBoxStage>(startStage);
  const [started, setStarted] = useState(startStage !== 'betrayal');
  const account = storyBoxAccount(state);
  const hero = protagonistClass(state);
  const heroName = state.username || CLASS_LABEL[hero];
  const recruits = recruitClasses(hero);
  useEffect(() => { writeStoryBox(account, stage); }, [account, stage]);
  useEffect(() => { setMusicScene('encounter'); return () => setMusicScene('main'); }, []);
  const go = (next: StoryBoxStage) => () => setStage(next);
  const finish = () => { writeStoryBox(account, 'done'); onDone(); };
  const boss: BoxFighter = { id: 'giant', side: 'enemy', boss: true, ...STORY_BOX.boss };
  const trial = useMemo<BoxFighter[]>(() => [{ id: 'hero', name: heroName, side: 'hero', heroClass: hero, ...STORY_BOX.hero.geared }, boss], [hero, heroName]); // eslint-disable-line react-hooks/exhaustive-deps
  const final = useMemo<BoxFighter[]>(() => [
    { id: 'hero', name: heroName, side: 'hero', heroClass: hero, ...STORY_BOX.hero.final },
    ...recruits.map((heroClass, index): BoxFighter => ({ id: `ally-${index}`, name: CLASS_LABEL[heroClass], side: 'hero', heroClass, ...STORY_BOX.ally })),
    boss,
  ], [hero, heroName]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="story-box" role="dialog" aria-modal="true" aria-label="Story">
      {!started && <TitleCard onStart={() => setStarted(true)} />}
      {started && <>
      {stage === 'betrayal' && <ComicScene key="betrayal" pages={betrayalPages(hero)} onDone={go('awaken')} />}
      {stage === 'awaken' && <ComicScene key="awaken" pages={awakenPages(hero, false)} objective="Fight your way out." onDone={go('waves')} />}
      {stage === 'waves' && <Waves hero={hero} heroName={heroName} onNext={go('chest')} />}
      {stage === 'chest' && <Chest onNext={go('trial')} />}
      {stage === 'trial' && <Battle fighters={trial} seed={7} scene="gate-battle" fallback="/assets/screens/dungeon-room-1-outer-bastion-v2.webp" title={STORY_BOX.boss.name} line="“You came back.”" onEnd={() => { playSfx('defeat'); setStage('awaken-again'); }} />}
      {stage === 'awaken-again' && <ComicScene key="awaken-again" pages={awakenPages(hero, true)} objective="Grow stronger. Return when you're ready." onDone={go('growth')} />}
      {stage === 'growth' && <Growth hero={hero} onNext={go('final')} />}
      {stage === 'final' && <Battle fighters={final} seed={21} scene="gate-battle" fallback="/assets/screens/dungeon-room-1-outer-bastion-v2.webp" title={STORY_BOX.boss.name} onEnd={(won) => setStage(won ? 'victory' : 'growth')} />}
      {stage === 'victory' && <ComicScene key="victory" pages={victoryPages([hero, ...recruits])} onDone={go('clue')} />}
      {stage === 'clue' && <ComicScene key="clue" pages={cluePages()} onDone={finish} finale={<QuestCard onDone={finish} />} />}
      {['waves', 'chest', 'growth'].includes(stage) && <button type="button" className="sb-skip" onClick={finish}>Skip story</button>}
      </>}
    </div>
  );
}
