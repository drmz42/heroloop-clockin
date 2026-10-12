import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { versionedAsset } from '@/game/assetVersion';
import { duckMusic, playSfx, playVoice, stopVoice, vibrate } from '@/audio/gameAudio';
import { voiceSrc, type ComicPage, type ComicPanel } from '@/game/storyComic';
import '@/theme/story/story-comic.css';

// Motion comic player for the Story Box: pages of inked panels revealed one beat at a time, with
// layered parallax art, pose cuts, captions, speech balloons and lettered sound effects.
// Tap advances a beat; every beat also advances on its own. Presentation only: no game state.

const art = (src: string) => versionedAsset(src);
// Fixed ember layout so panels look the same on every replay.
const EMBERS: CSSProperties[] = Array.from({ length: 14 }, (_, index) => ({
  left: `${(index * 37) % 100}%`, animationDelay: `${(index * 530) % 3600}ms`, animationDuration: `${3200 + (index * 410) % 2400}ms`,
  '--drift': `${((index * 23) % 40) - 20}px`, width: `${2 + (index % 3)}px`, height: `${2 + (index % 3)}px`,
} as CSSProperties));
// Stone chips thrown toward the camera on impact beats (fixed layout, like the embers).
const DEBRIS: CSSProperties[] = Array.from({ length: 18 }, (_, index) => ({
  left: `${8 + (index * 41) % 84}%`, top: `${40 + (index * 17) % 30}%`, animationDelay: `${450 + (index * 37) % 220}ms`,
  '--dx': `${((index * 53) % 120) - 60}cqw`, '--dy': `${-30 - (index * 29) % 50}cqh`, '--spin': `${((index * 97) % 720) - 360}deg`,
  width: `${6 + (index * 7) % 14}px`, height: `${5 + (index * 5) % 11}px`,
} as CSSProperties));

function Panel({ panel, shown }: { panel: ComicPanel; shown: boolean }) {
  const fx = panel.fx ?? [];
  const classes = ['cp-panel', `cam-${panel.cam ?? 'push'}`, `tone-${panel.tone ?? 'night'}`, panel.art ? 'has-art' : '', shown ? 'is-shown' : '', ...fx.map((name) => `fx-${name}`)];
  return (
    <figure className={classes.join(' ')} style={{ gridArea: panel.area }}>
      <div className="cp-world">
        {panel.art && <div className="cp-bg cp-art" style={{ backgroundImage: `url('${art(panel.art)}')`, backgroundPosition: panel.artPos ?? 'center' }} />}
        {panel.bg && <div className="cp-bg" style={{ backgroundImage: `url('${art(panel.bg)}')`, backgroundPosition: panel.bgPos ?? 'center' }} />}
        {fx.includes('gate-close') && <div className="cp-gate" style={{ backgroundImage: `url('${art('/assets/story/gate-portcullis.webp')}')` }} />}
        <div className="cp-figs">
          {(panel.figs ?? []).map((fig, index) => {
            const style: CSSProperties = { left: `${fig.x}%`, bottom: `${fig.y ?? 0}%`, height: `${fig.h}%`, zIndex: fig.z ?? index + 1 };
            return (
              <img key={`${fig.src}-${index}`} className={`cp-fig ${fig.flip ? 'is-flip' : ''} ${fig.anim ? `anim-${fig.anim}` : ''} ${fig.dim ? 'is-dim' : ''}`}
                style={style} src={art(fig.src)} alt="" draggable={false} />
            );
          })}
        </div>
        {fx.includes('glow') && !panel.glow && <span className="cp-glow" style={{ backgroundImage: `url('${art('/assets/brand/heroloop-emblem.png')}')` }} />}
        {fx.includes('dust') && <span className="cp-dust" />}
        {fx.includes('debris') && <span className="cp-debris">{DEBRIS.map((rock, index) => <i key={index} style={rock} />)}</span>}
        {fx.includes('breath') && <span className="cp-breath" />}
        {fx.includes('mist') && <span className="cp-mist" />}
        {fx.includes('embers') && <span className="cp-embers">{EMBERS.map((ember, index) => <i key={index} style={ember} />)}</span>}
        {fx.includes('flicker') && <span className="cp-flicker" />}
      </div>
      {/* A placed glow sits outside the world, so a desaturated scene keeps its gold. */}
      {panel.glow && fx.includes('glow') && <span className={`cp-glow ${panel.glow.dim ? 'is-dim' : ''}`} style={{
        backgroundImage: `url('${art('/assets/brand/heroloop-emblem.png')}')`, left: `${panel.glow.x}%`, top: `${panel.glow.y}%`, width: `${panel.glow.size}%`,
        ...(panel.glow.flat ? { aspectRatio: '2.6', backgroundSize: '100% 100%' } : {}),
      }} />}
      <span className="cp-halftone" />
      {panel.word && <span className="cp-word">{panel.word}</span>}
      {panel.caption && <figcaption className={`cp-caption at-${panel.caption.at ?? 'top'}`}>{panel.caption.text}</figcaption>}
      {panel.bubbles?.map((bubble, index) => (
        <p key={index} className={`cp-bubble is-${bubble.kind ?? 'speech'} tail-${bubble.tail ?? 'down-left'}`}
          style={{ left: `${bubble.x}%`, top: `${bubble.y}%`, animationDelay: `${450 + index * 700}ms` }}>
          {bubble.who && <b>{bubble.who}</b>}{bubble.text}
        </p>
      ))}
      {panel.sfx && <span className="cp-sfx" style={{ left: `${panel.sfx.x}%`, top: `${panel.sfx.y}%`, '--rot': `${panel.sfx.rot ?? -8}deg`, fontSize: `${panel.sfx.size ?? 46}px` } as CSSProperties}>{panel.sfx.text}</span>}
      {fx.includes('flash') && <span className="cp-flash" />}
    </figure>
  );
}

export function ComicScene({ pages: initialPages, onDone, objective, finale }: {
  pages: ComicPage[]; onDone: () => void; objective?: string; finale?: ReactNode;
}) {
  // The parent rebuilds pages on every game tick; keeping the first set stops beats (and voice) restarting.
  const [pages] = useState(initialPages);
  const [page, setPage] = useState(0);
  const [beat, setBeat] = useState(0);
  const [ending, setEnding] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const current = pages[page];
  const panel = current?.panels[beat];
  const lastPage = page >= pages.length - 1;
  const lastBeat = beat >= (current?.panels.length ?? 1) - 1;

  const advance = () => {
    if (ending) { if (!finale) done.current(); return; }
    if (!lastBeat) { setBeat(beat + 1); return; }
    if (!lastPage) { setPage(page + 1); setBeat(0); return; }
    if (objective || finale) setEnding(true); else done.current();
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  useEffect(() => {
    if (!panel || ending) return;
    const timers = (panel.sound ?? []).map(([name, delay]) => window.setTimeout(() => playSfx(name), delay));
    if (panel.voice) { const [line, delay] = panel.voice; timers.push(window.setTimeout(() => playVoice(art(voiceSrc(line))), delay)); }
    if (panel.fx?.includes('shake')) { vibrate(60); duckMusic(1400); }
    timers.push(window.setTimeout(() => advanceRef.current(), panel.hold));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [page, beat, panel, ending]);

  useEffect(() => {
    if (!ending || finale) return;
    const timer = window.setTimeout(() => done.current(), 2600);
    return () => window.clearTimeout(timer);
  }, [ending, finale]);

  return (
    <section className="cp-stage" onClick={advance}>
      <div key={page} className={`cp-page ${current.rows === 'auto' ? 'is-fit' : ''} ${current.rows === 'full' ? 'is-full' : ''} ${ending ? 'is-ending' : ''}`} style={{ gridTemplateAreas: current.areas, gridTemplateRows: current.rows === 'full' ? '1fr' : current.rows, gridTemplateColumns: current.cols ?? '1fr 1fr' }}>
        {current.panels.map((item, index) => <Panel key={index} panel={item} shown={index <= beat} />)}
      </div>
      {ending && objective && <div className="cp-objective"><small>Objective</small>{objective}</div>}
      {ending && finale}
      <div className="cp-progress" aria-hidden>{pages.map((_, index) => <i key={index} className={index < page ? 'is-done' : index === page ? 'is-now' : ''} />)}</div>
      <button type="button" className="sb-skip" onClick={(event) => { event.stopPropagation(); stopVoice(); done.current(); }}>Skip</button>
      {!ending && <span className="cp-hint">Tap to continue</span>}
    </section>
  );
}
