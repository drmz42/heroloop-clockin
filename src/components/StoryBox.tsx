import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { GameState, HeroClass } from '@/game/types';
import { versionedAsset } from '@/game/assetVersion';
import { heroFigureSrc } from '@/game/art';
import { duckMusic, playSfx, setMusicScene } from '@/audio/gameAudio';
import {
  CLASS_LABEL, STORY_BOX, boxPower, protagonistClass, recruitClasses, resolveBoxFight, storyBoxAccount, writeStoryBox,
  type BoxFighter, type StoryBoxStage,
} from '@/game/storyBox';
import '@/theme/story/story-box.css';

// Story Box: the client-only story intro for new Seeker accounts (see src/game/storyBox.ts).

const art = (name: string) => versionedAsset(`/assets/story/${name}.webp`);
const asset = (path: string) => versionedAsset(path);
// Each scene layer falls back to existing game art while story art is missing.
const bg = (name: string, fallback: string): CSSProperties => ({ backgroundImage: `url('${art(name)}'), url('${asset(fallback)}')` });
const emblem: CSSProperties = { backgroundImage: `url('${asset('/assets/brand/heroloop-emblem.png')}')` };

function Figure({ src, fallback, className, alt = '' }: { src: string; fallback?: string; className: string; alt?: string }) {
  const [current, setCurrent] = useState(src);
  return <img className={className} src={current} alt={alt} draggable={false} onError={() => { if (fallback && current !== fallback) setCurrent(fallback); }} />;
}

type GiantPose = 'idle' | 'slam' | 'kneel';
// Morvane keeps three landmarks across all encounters: white hair, one massive arm, iron restraints.
const giantFigure = (pose: GiantPose = 'idle') => <Figure key={pose} className={`sb-giant-img is-${pose}`} src={art(`morvane-${pose}`)} fallback={asset('/assets/figures/boss-titan.webp')} />;

function useTimeline(durations: number[], onDone: () => void) {
  const [beat, setBeat] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (beat >= durations.length) { done.current(); return; }
    const timer = window.setTimeout(() => setBeat((value) => value + 1), durations[beat]);
    return () => window.clearTimeout(timer);
  }, [beat, durations]);
  return beat;
}

function Skip({ onSkip }: { onSkip: () => void }) {
  return <button type="button" className="sb-skip" onClick={onSkip}>Skip</button>;
}

function Caption({ who, children }: { who?: string; children: ReactNode }) {
  return <p className="sb-caption">{who && <b>{who}</b>}{children}</p>;
}

// ── S00: betrayal and first death ──────────────────────────────────────────

const BETRAYAL_BEATS = [4200, 4600, 5000, 5600, 5200, 4400, 2600, 2200];

function Betrayal({ hero, onNext }: { hero: HeroClass; onNext: () => void }) {
  const beat = useTimeline(BETRAYAL_BEATS, onNext);
  useEffect(() => {
    if (beat === 0) playSfx('bossIntro');
    if (beat === 1) { playSfx('crit'); duckMusic(1800); }
    if (beat === 4) playSfx('bossPhase');
    if (beat === 5) { playSfx('crit'); window.setTimeout(() => playSfx('death'), 1400); }
    if (beat === 6) [0, 650, 1300].forEach((delay) => window.setTimeout(() => playSfx('tap'), delay));
  }, [beat]);
  return (
    <section className="sb-scene sb-cine sb-betrayal" data-beat={beat} style={bg('gate-arena', '/assets/screens/dungeon-room-1-outer-bastion-v2.webp')}>
      <div className="sb-layer sb-giant">{giantFigure(beat === 1 || beat === 5 ? 'slam' : 'idle')}</div>
      <div className="sb-layer sb-friends">
        <Figure className="sb-garrick" src={art('garrick')} fallback={heroFigureSrc('knight')} />
        <Figure className="sb-elyra" src={art('elyra')} fallback={heroFigureSrc('shepherd')} />
      </div>
      <div className="sb-layer sb-gate-clip"><div className="sb-portcullis" style={bg('gate-portcullis', '/assets/screens/dungeon-room-2-guard-hall-v2.webp')} /></div>
      <div className="sb-layer sb-protagonist"><img src={heroFigureSrc(hero)} alt="" draggable={false} /><span className="sb-mark" style={emblem} /></div>
      <Figure className="sb-layer sb-hollow" src={art('hollow-one')} />
      <div className="sb-flash" />
      <div className="sb-blackout"><span className="sb-emblem" style={emblem} /></div>
      {beat === 0 && <Caption>The Broken Gate</Caption>}
      {beat === 2 && <Caption who="Garrick">I'm sorry.</Caption>}
      <Skip onSkip={onNext} />
    </section>
  );
}

// ── S01 / S05: awakening at the altar ──────────────────────────────────────

function Awaken({ hero, lines, objective, reveal, onNext }: { hero: HeroClass; lines: string[]; objective: string; reveal?: boolean; onNext: () => void }) {
  const durations = useMemo(() => [1600, ...lines.map(() => 1900), reveal ? 3200 : 1800], [lines, reveal]);
  const beat = useTimeline(durations, onNext);
  const line = beat >= 1 && beat <= lines.length ? lines[beat - 1] : null;
  const showExit = reveal && beat > lines.length;
  useEffect(() => { if (beat === 0) playSfx('levelUp'); }, [beat]);
  return (
    <section className={`sb-scene sb-awaken ${showExit ? 'is-exit' : ''}`} data-beat={beat}>
      <div className="sb-layer sb-altar" style={bg('crypt-altar', '/assets/screens/dungeon-room-3-crossroads-v2.webp')}>
        <span className="sb-altar-mark" style={emblem} />
        <img className="sb-waking" src={heroFigureSrc(hero)} alt="" draggable={false} />
      </div>
      <div className="sb-layer sb-exit" style={bg('crypt-exit', '/assets/locations/standard/location-3.webp')}>
        {[0, 1, 2].map((index) => <Figure key={index} className={`sb-exit-skeleton s${index}`} src={art('skeleton')} fallback={asset('/assets/figures/skeleton.webp')} />)}
      </div>
      {line && <Caption>{line}</Caption>}
      {(showExit || (!reveal && beat > lines.length)) && <div className="sb-objective"><small>Objective</small>{objective}</div>}
      <Skip onSkip={onNext} />
    </section>
  );
}

// ── Battle replay ──────────────────────────────────────────────────────────

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

// ── S08 victory and S09 Elyra's trace ──────────────────────────────────────

function Victory({ squad, onNext }: { squad: HeroClass[]; onNext: () => void }) {
  const beat = useTimeline([1500, 1800, 2400], onNext);
  useEffect(() => {
    if (beat === 1) { playSfx('crit'); duckMusic(2600); }
    if (beat === 2) playSfx('victory');
  }, [beat]);
  return (
    <section className="sb-scene sb-cine sb-victory" data-beat={beat} style={bg('gate-arena', '/assets/screens/dungeon-room-1-outer-bastion-v2.webp')}>
      <div className="sb-layer sb-giant">{giantFigure(beat >= 1 ? 'kneel' : 'idle')}</div>
      <div className="sb-layer sb-gate-clip"><div className="sb-portcullis is-closed" style={bg('gate-portcullis', '/assets/screens/dungeon-room-2-guard-hall-v2.webp')} /></div>
      <div className="sb-layer sb-trio">{squad.map((heroClass, index) => <img key={`${heroClass}-${index}`} src={heroFigureSrc(heroClass)} alt="" draggable={false} />)}</div>
      <div className="sb-flash" />
      <Skip onSkip={onNext} />
    </section>
  );
}

function Clue({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setShown(true), 2600); return () => window.clearTimeout(timer); }, []);
  return (
    <section className="sb-scene sb-clue" style={bg('gate-arena', '/assets/screens/dungeon-room-1-outer-bastion-v2.webp')}>
      <Figure className="sb-scrap" src={art('cloak-scrap')} />
      <Caption>A scrap of Elyra's cloak, caught on the inside of the gate.</Caption>
      {shown && <div className="sb-card sb-quest">
        <small className="sb-kicker">New quest</small>
        <h2>The Mage's Trail</h2>
        <p>Find out why Elyra returned to the fortress.</p>
        <button type="button" className="game-control game-primary sb-cta" onClick={onDone}>Continue</button>
      </div>}
    </section>
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
      {stage === 'betrayal' && <Betrayal hero={hero} onNext={go('awaken')} />}
      {stage === 'awaken' && <Awaken hero={hero} reveal lines={['I died. I know I did.', '…Then why am I still here?', 'No answers. Move.']} objective="Fight your way out." onNext={go('waves')} />}
      {stage === 'waves' && <Waves hero={hero} heroName={heroName} onNext={go('chest')} />}
      {stage === 'chest' && <Chest onNext={go('trial')} />}
      {stage === 'trial' && <Battle fighters={trial} seed={7} scene="gate-battle" fallback="/assets/screens/dungeon-room-1-outer-bastion-v2.webp" title={STORY_BOX.boss.name} line="“You came back.”" onEnd={() => { playSfx('defeat'); setStage('awaken-again'); }} />}
      {stage === 'awaken-again' && <Awaken hero={hero} lines={['Again.', 'Still alive.']} objective="Grow stronger. Return when you're ready." onNext={go('growth')} />}
      {stage === 'growth' && <Growth hero={hero} onNext={go('final')} />}
      {stage === 'final' && <Battle fighters={final} seed={21} scene="gate-battle" fallback="/assets/screens/dungeon-room-1-outer-bastion-v2.webp" title={STORY_BOX.boss.name} onEnd={(won) => setStage(won ? 'victory' : 'growth')} />}
      {stage === 'victory' && <Victory squad={[hero, ...recruits]} onNext={go('clue')} />}
      {stage === 'clue' && <Clue onDone={finish} />}
      {['waves', 'chest', 'growth'].includes(stage) && <button type="button" className="sb-skip" onClick={finish}>Skip story</button>}
      </>}
    </div>
  );
}
