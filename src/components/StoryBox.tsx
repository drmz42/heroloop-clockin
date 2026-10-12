import { useEffect } from 'react';
import type { GameState } from '@/game/types';
import { installGameAudio, playSfx, primeMusic, setMusicScene } from '@/audio/gameAudio';
import { versionedAsset } from '@/game/assetVersion';
import type { StorySceneStage } from '@/game/storyBox';
import { STORY_TITLE_ART, fallenPages, gatePages, introPages, victoryPages } from '@/game/storyComic';
import { ComicScene } from '@/components/StoryComic';
import { StoryTrial } from '@/components/StoryTrial';
import '@/theme/story/story-box.css';

// Seeker story scenes (see src/game/storyBox.ts). Each scene is shown on its own, between stretches
// of the real game; real game events decide when the next one starts.

function SceneCard({ kicker, title, text, action, onAction }: { kicker: string; title: string; text: string; action: string; onAction: () => void }) {
  return (
    <div className="sb-card sb-quest" onClick={(event) => event.stopPropagation()}>
      <small className="sb-kicker">{kicker}</small>
      <h2>{title}</h2>
      <p>{text}</p>
      <button type="button" className="game-control game-primary sb-cta" onClick={onAction}>{action}</button>
    </div>
  );
}

// The first tap also unlocks audio on Android WebView, so the opening plays with sound.
function TitleCard({ onStart }: { onStart: () => void }) {
  return (
    <button type="button" className="sb-scene sb-title" onClick={() => { playSfx('tap'); onStart(); }} style={{ backgroundImage: `url('${versionedAsset(STORY_TITLE_ART)}')` }}>
      <img className="sb-title-mark" src={versionedAsset('/assets/brand/heroloop-wordmark.webp')} alt="HeroLoop" />
      <span className="sb-title-sub">The Last Seeker</span>
      <span className="sb-title-tap">Tap to begin</span>
    </button>
  );
}

export function StoryBox({ state, stage, started, onStart, onDone }: {
  state: GameState; stage: StorySceneStage; started: boolean; onStart: () => void; onDone: () => void;
}) {
  // The story replaces the game screen, so it installs the game audio itself: music runs from the title card.
  useEffect(() => {
    const stop = installGameAudio();
    setMusicScene('story');
    primeMusic();
    return () => { setMusicScene('main'); stop(); };
  }, []);
  return (
    <div className="story-box" role="dialog" aria-modal="true" aria-label="Story">
      {stage === 'intro' && !started && <TitleCard onStart={onStart} />}
      {stage === 'intro' && started && <ComicScene key="intro" pages={introPages()} objective="Fight your way out of the crypt." onDone={onDone} />}
      {stage === 'gate' && <ComicScene key="gate" pages={gatePages()} onDone={onDone}
        finale={<SceneCard kicker="Boss" title="Morvane, the Forsaken" text="He waits at the Broken Gate. You are alone." action="Face Morvane" onAction={onDone} />} />}
      {stage === 'trial' && <StoryTrial state={state} onDone={onDone} />}
      {stage === 'fallen' && <ComicScene key="fallen" pages={fallenPages()} objective="Grow stronger. Summon allies." onDone={onDone} />}
      {stage === 'victory' && <ComicScene key="victory" pages={victoryPages()} onDone={onDone}
        finale={<SceneCard kicker="New quest" title="The Mage's Trail" text="Elyra returned to the fortress after your death. Find out why she went to Blackthorn." action="Continue" onAction={onDone} />} />}
    </div>
  );
}
