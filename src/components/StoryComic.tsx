import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { versionedAsset } from '@/game/assetVersion';
import { duckMusic, playSfx, vibrate } from '@/audio/gameAudio';
import type { ComicPage, ComicPanel } from '@/game/storyComic';
import '@/theme/story/story-comic.css';

// Motion comic player for the Story Box: pages of inked panels revealed one beat at a time, with
// layered parallax art, pose cuts, captions, speech balloons and lettered sound effects.
// Tap advances a beat; every beat also advances on its own. Presentation only: no game state.

const art = (src: string) => versionedAsset(src);

function Panel({ panel, shown }: { panel: ComicPanel; shown: boolean }) {
  const fx = panel.fx ?? [];
  const classes = ['cp-panel', `cam-${panel.cam ?? 'push'}`, `tone-${panel.tone ?? 'night'}`, shown ? 'is-shown' : '', ...fx.map((name) => `fx-${name}`)];
  return (
    <figure className={classes.join(' ')} style={{ gridArea: panel.area }}>
      <div className="cp-world">
        {panel.bg && <div className="cp-bg" style={{ backgroundImage: `url('${art(panel.bg)}')`, backgroundPosition: panel.bgPos ?? 'center' }} />}
        {fx.includes('gate-close') && <div className="cp-gate" style={{ backgroundImage: `url('${art('/assets/story/gate-portcullis.webp')}')` }} />}
        <div className="cp-figs">
          {panel.figs.map((fig, index) => {
            const style: CSSProperties = { left: `${fig.x}%`, bottom: `${fig.y ?? 0}%`, height: `${fig.h}%`, zIndex: fig.z ?? index + 1 };
            return (
              <img key={`${fig.src}-${index}`} className={`cp-fig ${fig.flip ? 'is-flip' : ''} ${fig.anim ? `anim-${fig.anim}` : ''} ${fig.dim ? 'is-dim' : ''}`}
                style={style} src={art(fig.src)} alt="" draggable={false} />
            );
          })}
        </div>
        {fx.includes('glow') && <span className="cp-glow" style={{ backgroundImage: `url('${art('/assets/brand/heroloop-emblem.png')}')` }} />}
        {fx.includes('dust') && <span className="cp-dust" />}
      </div>
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

export function ComicScene({ pages, onDone, objective, finale }: {
  pages: ComicPage[]; onDone: () => void; objective?: string; finale?: ReactNode;
}) {
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
    if (panel.sound) panel.sound.forEach(([name, delay]) => window.setTimeout(() => playSfx(name), delay));
    if (panel.fx?.includes('shake')) { vibrate(60); duckMusic(1400); }
    const timer = window.setTimeout(() => advanceRef.current(), panel.hold);
    return () => window.clearTimeout(timer);
  }, [page, beat, panel, ending]);

  useEffect(() => {
    if (!ending || finale) return;
    const timer = window.setTimeout(() => done.current(), 2600);
    return () => window.clearTimeout(timer);
  }, [ending, finale]);

  return (
    <section className="cp-stage" onClick={advance}>
      <div key={page} className={`cp-page ${ending ? 'is-ending' : ''}`} style={{ gridTemplateAreas: current.areas, gridTemplateRows: current.rows, gridTemplateColumns: current.cols ?? '1fr 1fr' }}>
        {current.panels.map((item, index) => <Panel key={index} panel={item} shown={index <= beat} />)}
      </div>
      {ending && objective && <div className="cp-objective"><small>Objective</small>{objective}</div>}
      {ending && finale}
      <div className="cp-progress" aria-hidden>{pages.map((_, index) => <i key={index} className={index < page ? 'is-done' : index === page ? 'is-now' : ''} />)}</div>
      <button type="button" className="sb-skip" onClick={(event) => { event.stopPropagation(); done.current(); }}>Skip</button>
      {!ending && <span className="cp-hint">Tap to continue</span>}
    </section>
  );
}
